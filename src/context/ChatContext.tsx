import AsyncStorage from '@react-native-async-storage/async-storage';
import { randomUUID } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import type { LlamaContext } from 'llama.rn';
import React, {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  ChatMessage,
  Conversation,
  FinishReason,
  MessageStats,
  ModelDefinition,
  ModelId,
  ModelState,
} from '../types';
import { useBackgroundGrace } from '../utils/appLifecycle';
import * as chatStorage from '../utils/chatStorage';
import { generateEncryptionKey } from '../utils/encryption';
import {
  SYSTEM_PROMPT,
  classifyFinish,
  describeGenerationError,
  initialSnapshot,
  preparePrompt,
  runCompletion,
  type StreamSnapshot,
} from '../utils/generationEngine';
import {
  MODEL_CATALOG,
  MODEL_N_CTX,
  createCustomModel,
  deleteModelFile,
  getEffectiveContextSize,
  isModelFileDownloaded,
  loadCustomModels,
  loadModel,
  releaseModel,
  saveCustomModels,
  startDownload,
} from '../utils/modelManager';

export const MAX_TOKENS_PRESETS = [512, 1024, 2048, 4096] as const;

const CHAT_KEY_STORE = 'chat_encryption_key';
/** Last model the user loaded; auto-restored when the chat is unlocked. */
const ACTIVE_MODEL_KEY = 'ai_active_model_id';
const THINKING_KEY = 'ai_thinking_enabled';
const MAX_TOKENS_KEY = 'ai_max_tokens';

/** UI streaming state is flushed at most this often (never per token). */
const STREAM_FLUSH_MS = 80;
/** In-flight assistant text is persisted at most this often, so a kill loses ≤ ~1 s. */
const PERSIST_INTERVAL_MS = 1000;
const PREVIEW_CHARS = 100;

/** True if `continueResponse` would act on this (last) message. */
export function canContinueMessage(message: ChatMessage | null | undefined): boolean {
  return (
    !!message &&
    message.role === 'assistant' &&
    message.finishReason !== undefined &&
    message.finishReason !== 'stop'
  );
}

export interface ContextUsage {
  conversationId: string;
  /** Prompt tokens (plus generated tokens once the turn settles). */
  usedTokens: number;
  /** Usable context window of the loaded model. */
  maxTokens: number;
  /** Oldest messages left out of the prompt to fit the window. */
  trimmedMessages: number;
}

type ModelStates = Record<ModelId, ModelState>;
type AbortReason = 'cancelled' | 'interrupted';

/** Mutable state of the one in-flight generation. Lives in a ref, never in React state. */
interface ActiveGeneration {
  conversationId: string;
  messageId: string;
  isContinuation: boolean;
  /**
   * Chat key captured when the turn started. It outlives a lock (grace expiry)
   * only until this generation is finalised, so the reply can still be saved.
   */
  key: string;
  ctx: LlamaContext;
  abortReason: AbortReason | null;
  snapshot: StreamSnapshot;
  dirty: boolean;
  lastPersistAt: number;
}

interface FinalizeInput {
  finish: FinishReason;
  content: string;
  reasoning: string;
  stats?: MessageStats;
  errorText?: string;
  usage: ContextUsage | null;
}

const defaultModelState = (): ModelState => ({
  status: 'not_downloaded',
  progress: 0,
  errorMessage: null,
});

const initialModelStates = (): ModelStates => {
  const states: ModelStates = {};
  for (const m of MODEL_CATALOG) states[m.id] = defaultModelState();
  return states;
};

function createDeferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const preview = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_CHARS);

interface ChatContextType {
  // Auth
  isChatAuthenticated: boolean;
  loadChatKey: () => Promise<void>;
  lockChat: () => void;

  // Conversations
  conversations: Conversation[];
  loadConversations: () => Promise<void>;
  createConversation: () => Promise<string>;
  deleteConversation: (id: string) => Promise<void>;

  // Messages
  getMessages: (conversationId: string) => Promise<ChatMessage[]>;
  /** Increments whenever persisted messages of any conversation change. */
  messagesVersion: number;
  sendMessage: (conversationId: string, text: string) => Promise<void>;
  continueResponse: (conversationId: string) => Promise<void>;
  regenerateResponse: (conversationId: string) => Promise<void>;
  deleteMessage: (conversationId: string, messageId: string) => Promise<void>;
  cancelGeneration: () => Promise<void>;
  /** Alias of cancelGeneration. */
  stopGeneration: () => Promise<void>;

  // Streaming
  isGenerating: boolean;
  streamingConversationId: string | null;
  streamingMessageId: string | null;
  streamingContent: string;
  streamingReasoning: string;
  isStreamingReasoning: boolean;
  generationError: string | null;
  clearGenerationError: () => void;
  contextUsage: ContextUsage | null;

  // Multi-model management
  models: ModelDefinition[]; // built-in catalog + custom models
  customModels: ModelDefinition[];
  modelStates: ModelStates;
  loadedModelId: ModelId | null;
  isModelLoaded: boolean;
  isModelLoading: boolean;
  loadingModelId: ModelId | null;
  modelLoadError: string | null;
  startModelDownload: (id: ModelId) => void;
  cancelModelDownload: (id: ModelId) => void;
  addCustomModel: (name: string, url: string) => void;
  initModel: (id: ModelId) => Promise<void>;
  unloadModel: () => Promise<void>;
  deleteModel: (id: ModelId) => Promise<void>;

  // Settings
  thinkingEnabled: boolean;
  setThinkingEnabled: (val: boolean) => void;
  maxTokens: number;
  setMaxTokens: (val: number) => void;
}

const ChatContext = createContext<ChatContextType | undefined>(undefined);

export function ChatProvider({ children }: { children: ReactNode }) {
  // ── React state (render only) ──────────────────────────────────────────────
  const [chatKey, setChatKey] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [customModels, setCustomModels] = useState<ModelDefinition[]>([]);
  const [modelStates, setModelStates] = useState<ModelStates>(initialModelStates);
  const [loadedModelId, setLoadedModelId] = useState<ModelId | null>(null);
  const [isModelLoaded, setIsModelLoaded] = useState(false);
  const [isModelLoading, setIsModelLoading] = useState(false);
  const [loadingModelId, setLoadingModelId] = useState<ModelId | null>(null);
  const [modelLoadError, setModelLoadError] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [streamingConversationId, setStreamingConversationId] = useState<string | null>(null);
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null);
  const [streamingContent, setStreamingContent] = useState('');
  const [streamingReasoning, setStreamingReasoning] = useState('');
  const [isStreamingReasoning, setIsStreamingReasoning] = useState(false);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
  const [messagesVersion, setMessagesVersion] = useState(0);
  const [thinkingEnabled, setThinkingEnabledState] = useState(true);
  const [maxTokens, setMaxTokensState] = useState(1024);
  const [customModelsReady] = useState(createDeferred);

  // ── Refs (source of truth for anything async code reads) ───────────────────
  const chatKeyRef = useRef<string | null>(null);
  /** Bumped on every lock, so a model load that straddles a lock can undo itself. */
  const lockEpochRef = useRef(0);
  const llamaRef = useRef<LlamaContext | null>(null);
  const loadedModelIdRef = useRef<ModelId | null>(null);
  const loadingModelIdRef = useRef<ModelId | null>(null);
  const nCtxRef = useRef(MODEL_N_CTX);
  const pendingModelLoadsRef = useRef(0);
  const modelRequestSeqRef = useRef(0);
  const genRef = useRef<ActiveGeneration | null>(null);
  /** Bumped by every send/continue/regenerate/cancel; queued turns that were superseded skip generation. */
  const requestSeqRef = useRef(0);
  /**
   * Serialises everything that touches the llama context (turns, model
   * load/unload) so there is never more than one completion and never a
   * release under a running completion. Always resolves (errors are caught).
   */
  const opChainRef = useRef<Promise<void>>(Promise.resolve());
  const thinkingRef = useRef(true);
  const maxTokensRef = useRef(1024);
  const downloadResumablesRef = useRef<Partial<Record<ModelId, ReturnType<typeof startDownload>>>>({});

  const isChatAuthenticated = chatKey !== null;

  // Combined list of built-in + custom models. A ref mirrors it so async code
  // can resolve a definition without going stale.
  const models = useMemo(() => [...MODEL_CATALOG, ...customModels], [customModels]);
  const modelsRef = useRef<ModelDefinition[]>(models);
  useEffect(() => {
    modelsRef.current = models;
  }, [models]);

  const getDef = useCallback(
    (id: ModelId | null): ModelDefinition | undefined =>
      id ? modelsRef.current.find((m) => m.id === id) : undefined,
    [],
  );

  // ── Settings + model inventory ─────────────────────────────────────────────
  useEffect(() => {
    AsyncStorage.getItem(THINKING_KEY)
      .then((val) => {
        if (val === null) return;
        thinkingRef.current = val === 'true';
        setThinkingEnabledState(thinkingRef.current);
      })
      .catch(console.warn);
    AsyncStorage.getItem(MAX_TOKENS_KEY)
      .then((val) => {
        const n = Number(val);
        if (val === null || !Number.isFinite(n) || n <= 0) return;
        maxTokensRef.current = n;
        setMaxTokensState(n);
      })
      .catch(console.warn);

    (async () => {
      try {
        const custom = await loadCustomModels();
        modelsRef.current = [...MODEL_CATALOG, ...custom];
        if (custom.length > 0) {
          setCustomModels(custom);
          setModelStates((prev) => {
            const next = { ...prev };
            for (const m of custom) if (!next[m.id]) next[m.id] = defaultModelState();
            return next;
          });
        }
        customModelsReady.resolve();
        await Promise.all(
          [...MODEL_CATALOG, ...custom].map(async (m) => {
            if (await isModelFileDownloaded(m)) {
              setModelStates((prev) => ({
                ...prev,
                [m.id]: { status: 'downloaded', progress: 1, errorMessage: null },
              }));
            }
          }),
        );
      } catch (e) {
        console.error('Failed to load model inventory:', e);
      } finally {
        customModelsReady.resolve();
      }
    })();
  }, [customModelsReady]);

  const setThinkingEnabled = useCallback((val: boolean) => {
    thinkingRef.current = val;
    setThinkingEnabledState(val);
    AsyncStorage.setItem(THINKING_KEY, String(val)).catch(console.warn);
  }, []);

  const setMaxTokens = useCallback((val: number) => {
    maxTokensRef.current = val;
    setMaxTokensState(val);
    AsyncStorage.setItem(MAX_TOKENS_KEY, String(val)).catch(console.warn);
  }, []);

  // ── Core helpers ───────────────────────────────────────────────────────────

  const enqueue = useCallback((op: () => Promise<void>): Promise<void> => {
    const run = opChainRef.current.then(op);
    opChainRef.current = run.catch((e: unknown) => {
      console.error('Chat operation failed:', e);
      setGenerationError(describeGenerationError(e));
    });
    return opChainRef.current;
  }, []);

  const bumpMessages = useCallback(() => setMessagesVersion((v) => v + 1), []);

  const applyConversationPatch = useCallback((id: string, patch: Partial<Conversation>) => {
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }, []);

  /** Requests the in-flight completion to stop. Safe to call at any time. */
  const interruptActive = useCallback((reason: AbortReason) => {
    const g = genRef.current;
    if (!g || g.abortReason) return;
    g.abortReason = reason;
    try {
      // Synchronous natively (sets is_interrupted); the queued turn awaits the
      // completion promise settling before anything else touches the context.
      void Promise.resolve(g.ctx.stopCompletion()).catch(() => undefined);
    } catch (e) {
      console.warn('stopCompletion failed:', e);
    }
  }, []);

  /** Must run inside the op queue. */
  const releaseCurrentModel = useCallback(async () => {
    const ctx = llamaRef.current;
    if (!ctx) return;
    llamaRef.current = null;
    loadedModelIdRef.current = null;
    setIsModelLoaded(false);
    setLoadedModelId(null);
    await releaseModel(ctx).catch((e: unknown) => console.error('Failed to release model:', e));
  }, []);

  /**
   * Lifecycle rule: while the chat is locked, the model is unloaded as soon as
   * no generation is in flight (memory hygiene + the original security posture).
   */
  const releaseModelIfLockedAndIdle = useCallback(() => {
    if (chatKeyRef.current || genRef.current || !llamaRef.current) return;
    void enqueue(async () => {
      if (chatKeyRef.current || genRef.current) return; // re-unlocked meanwhile
      await releaseCurrentModel();
    });
  }, [enqueue, releaseCurrentModel]);

  // ── Lock / background lifecycle ────────────────────────────────────────────

  const lockChat = useCallback(() => {
    chatKeyRef.current = null;
    lockEpochRef.current++;
    setChatKey(null);
    setConversations([]);
    // An in-flight generation keeps its own captured key and the model until
    // it finishes (then finalizeGeneration releases the model).
    releaseModelIfLockedAndIdle();
  }, [releaseModelIfLockedAndIdle]);

  // Lock only after BACKGROUND_LOCK_GRACE_MS in the background ('inactive' never
  // locks). Brief overlays and the in-app biometric prompt fall inside the grace.
  // checkBackgroundExpiry() is also called from token-driven code, because
  // Android doesn't run JS timers while the app is in the background.
  const checkBackgroundExpiry = useBackgroundGrace({ onExpire: lockChat });

  const flushStream = useCallback(() => {
    const g = genRef.current;
    if (!g || !g.dirty) return;
    g.dirty = false;
    setStreamingContent(g.snapshot.content);
    setStreamingReasoning(g.snapshot.reasoning);
    setIsStreamingReasoning(g.snapshot.isReasoning);
  }, []);

  /**
   * Throttled from the token callback itself rather than a timer: Android
   * pauses JS timers in the background, but token callbacks keep arriving.
   */
  const persistProgress = useCallback((g: ActiveGeneration) => {
    const now = Date.now();
    if (now - g.lastPersistAt < PERSIST_INTERVAL_MS) return;
    g.lastPersistAt = now;
    const { content, reasoning } = g.snapshot;
    chatStorage
      .updateMessage(g.conversationId, g.messageId, { content, reasoning: reasoning || undefined }, g.key)
      .catch((e: unknown) => console.warn('Failed to persist streaming progress:', e));
    // Long background generation: lock the chat key on time (model stays loaded).
    checkBackgroundExpiry();
  }, [checkBackgroundExpiry]);

  const finalizeGeneration = useCallback(
    async (g: ActiveGeneration, r: FinalizeInput) => {
      const { conversationId, messageId, key } = g;
      const empty = !r.content.trim() && !r.reasoning.trim();
      const drop = empty && !g.isContinuation && (r.finish === 'cancelled' || r.finish === 'interrupted');
      try {
        if (drop) {
          await chatStorage.deleteMessage(conversationId, messageId);
        } else {
          await chatStorage.updateMessage(
            conversationId,
            messageId,
            {
              content: r.content,
              reasoning: r.reasoning || undefined,
              finishReason: r.finish,
              stats: r.stats,
              error: r.errorText,
              pending: undefined,
            },
            key,
          );
        }
        const patch: Partial<Conversation> = {
          messageCount: await chatStorage.getMessageCount(conversationId),
        };
        if (!drop && r.content.trim()) {
          patch.lastMessage = preview(r.content);
          patch.lastMessageAt = new Date().toISOString();
        }
        if (await chatStorage.updateConversation(conversationId, patch, key)) {
          applyConversationPatch(conversationId, patch);
        }
      } catch (e) {
        console.error('Failed to finalise generation:', e);
      } finally {
        if (genRef.current === g) genRef.current = null;
        setIsGenerating(false);
        setStreamingConversationId(null);
        setStreamingMessageId(null);
        setStreamingContent('');
        setStreamingReasoning('');
        setIsStreamingReasoning(false);
        if (r.usage) setContextUsage(r.usage);
        if (r.finish === 'error' && r.errorText) setGenerationError(r.errorText);
        bumpMessages();
        // Finished in the background past the grace period: lock now. Either
        // way, if the chat is locked the model is released now that we're idle.
        checkBackgroundExpiry();
        releaseModelIfLockedAndIdle();
      }
    },
    [applyConversationPatch, bumpMessages, checkBackgroundExpiry, releaseModelIfLockedAndIdle],
  );

  /**
   * Runs one assistant turn. Must run inside the op queue (no other completion
   * in flight). `history` ends with the user turn being answered;
   * `continueFrom` is the assistant message being extended in place.
   */
  const generate = useCallback(
    async (req: {
      conversationId: string;
      key: string;
      history: ChatMessage[];
      continueFrom: ChatMessage | null;
    }) => {
      const ctx = llamaRef.current;
      if (!ctx) {
        setGenerationError('No model is loaded. Load a model to chat.');
        return;
      }
      const { conversationId, key, history, continueFrom } = req;
      const modelName = getDef(loadedModelIdRef.current)?.name ?? loadedModelIdRef.current ?? 'Unknown model';
      const partial = continueFrom
        ? { content: continueFrom.content, reasoning: continueFrom.reasoning ?? '' }
        : null;

      const g: ActiveGeneration = {
        conversationId,
        messageId: continueFrom?.id ?? randomUUID(),
        isContinuation: !!continueFrom,
        key,
        ctx,
        abortReason: null,
        snapshot: { content: partial?.content ?? '', reasoning: partial?.reasoning ?? '', isReasoning: false, tokens: 0 },
        dirty: false,
        lastPersistAt: Date.now(),
      };
      // Register before touching storage so getMessages() never heals this message.
      genRef.current = g;
      setIsGenerating(true);
      setStreamingConversationId(conversationId);
      setStreamingMessageId(g.messageId);
      setStreamingContent(g.snapshot.content);
      setStreamingReasoning(g.snapshot.reasoning);
      setIsStreamingReasoning(false);

      const result: FinalizeInput = {
        finish: 'error',
        content: g.snapshot.content,
        reasoning: g.snapshot.reasoning,
        stats: continueFrom?.stats,
        usage: null,
      };
      const flushTimer = setInterval(flushStream, STREAM_FLUSH_MS);
      try {
        if (continueFrom) {
          await chatStorage.updateMessage(
            conversationId,
            g.messageId,
            { pending: true, finishReason: undefined, error: undefined },
            key,
          );
        } else {
          await chatStorage.appendMessage(
            conversationId,
            { id: g.messageId, role: 'assistant', content: '', createdAt: new Date().toISOString() },
            key,
            { pending: true },
          );
        }
        bumpMessages();

        const prepared = await preparePrompt(ctx, {
          systemPrompt: SYSTEM_PROMPT,
          history,
          partial,
          thinkingEnabled: thinkingRef.current,
          nCtx: nCtxRef.current,
          maxTokens: maxTokensRef.current,
        });
        result.usage = {
          conversationId,
          usedTokens: prepared.promptTokens,
          maxTokens: prepared.nCtx,
          trimmedMessages: prepared.trimmedTurns,
        };
        setContextUsage(result.usage);
        // The resume mode may discard an unusable partial (e.g. thinking that can't be reopened).
        g.snapshot = initialSnapshot(prepared);
        g.dirty = true;

        const outcome = await runCompletion(
          ctx,
          prepared,
          () => g.abortReason !== null,
          (snap) => {
            g.snapshot = snap;
            g.dirty = true;
            persistProgress(g);
          },
        );
        result.finish = classifyFinish(outcome, g.abortReason);
        result.content = outcome.content;
        result.reasoning = outcome.reasoning;
        if (result.finish === 'error') result.errorText = describeGenerationError(outcome.error);
        if (!outcome.skipped) {
          const prev = continueFrom?.stats;
          const predictedTokens = (prev?.predictedTokens ?? 0) + outcome.predictedTokens;
          result.stats = {
            predictedTokens,
            durationMs: (prev?.durationMs ?? 0) + outcome.durationMs,
            tokensPerSecond:
              prev && predictedTokens > 0
                ? (prev.tokensPerSecond * prev.predictedTokens + outcome.tokensPerSecond * outcome.predictedTokens) /
                  predictedTokens
                : outcome.tokensPerSecond,
            model: modelName,
          };
          result.usage = { ...result.usage, usedTokens: prepared.promptTokens + outcome.predictedTokens };
        }
        if (result.finish === 'stop' && !g.isContinuation && !result.content.trim() && !result.reasoning.trim()) {
          result.finish = 'error';
          result.errorText = 'The model returned an empty reply.';
        }
      } catch (e) {
        result.finish = g.abortReason ?? 'error';
        if (result.finish === 'error') result.errorText = describeGenerationError(e);
        result.content = g.snapshot.content;
        result.reasoning = g.snapshot.reasoning;
      } finally {
        clearInterval(flushTimer);
      }
      await finalizeGeneration(g, result);
    },
    [bumpMessages, finalizeGeneration, flushStream, getDef, persistProgress],
  );

  // ── Models ─────────────────────────────────────────────────────────────────

  const beginModelLoading = useCallback((id: ModelId) => {
    pendingModelLoadsRef.current++;
    loadingModelIdRef.current = id;
    setIsModelLoading(true);
    setLoadingModelId(id);
    setModelLoadError(null);
  }, []);

  /**
   * Op-queue body of a model load. `seq` is the model request it belongs to: a
   * newer load/unload request makes it a no-op. `epoch` detects a lock that
   * happened while loading.
   */
  const loadModelInQueue = useCallback(
    async (def: ModelDefinition, seq: number, epoch: number) => {
      try {
        if (seq !== modelRequestSeqRef.current) return;
        if (llamaRef.current && loadedModelIdRef.current === def.id) return;
        await releaseCurrentModel();
        const ctx = await loadModel(def);
        llamaRef.current = ctx;
        loadedModelIdRef.current = def.id;
        nCtxRef.current = getEffectiveContextSize(ctx);
        setLoadedModelId(def.id);
        setIsModelLoaded(true);
        AsyncStorage.setItem(ACTIVE_MODEL_KEY, def.id).catch(console.warn);
      } catch (e) {
        console.error('Failed to load model:', e);
        const msg = e instanceof Error ? e.message : String(e);
        setModelLoadError(`Couldn't load ${def.name}${msg ? `: ${msg}` : ''}`);
      } finally {
        pendingModelLoadsRef.current--;
        if (pendingModelLoadsRef.current === 0) {
          loadingModelIdRef.current = null;
          setIsModelLoading(false);
          setLoadingModelId(null);
        }
        // Locked while loading (e.g. auto-restore, then backgrounded): undo.
        if (lockEpochRef.current !== epoch) releaseModelIfLockedAndIdle();
      }
    },
    [releaseCurrentModel, releaseModelIfLockedAndIdle],
  );

  const initModel = useCallback(
    (id: ModelId): Promise<void> => {
      const def = getDef(id);
      if (!def) return Promise.resolve();
      if (genRef.current) {
        // Switching models cancels the current reply (its text is kept).
        requestSeqRef.current++;
        interruptActive('cancelled');
      }
      const seq = ++modelRequestSeqRef.current;
      const epoch = lockEpochRef.current;
      beginModelLoading(id);
      return enqueue(() => loadModelInQueue(def, seq, epoch));
    },
    [beginModelLoading, enqueue, getDef, interruptActive, loadModelInQueue],
  );

  /**
   * Reloads the last-used model (ACTIVE_MODEL_KEY) if nothing is loaded and it
   * is downloaded. Runs entirely inside the op queue, so a message sent right
   * after unlocking is queued behind the load instead of failing with "no
   * model". Not awaited by callers: it never blocks the UI.
   */
  const autoRestoreModel = useCallback(() => {
    const seq = modelRequestSeqRef.current; // any explicit load/unload supersedes the restore
    const epoch = lockEpochRef.current;
    void enqueue(async () => {
      await customModelsReady.promise;
      if (llamaRef.current || !chatKeyRef.current || seq !== modelRequestSeqRef.current) return;
      const def = getDef(await AsyncStorage.getItem(ACTIVE_MODEL_KEY));
      if (!def || !(await isModelFileDownloaded(def))) return;
      beginModelLoading(def.id);
      await loadModelInQueue(def, seq, epoch);
    });
  }, [beginModelLoading, customModelsReady, enqueue, getDef, loadModelInQueue]);

  const loadChatKey = useCallback(async () => {
    try {
      let key = await SecureStore.getItemAsync(CHAT_KEY_STORE);
      if (!key) {
        key = await generateEncryptionKey();
        await SecureStore.setItemAsync(CHAT_KEY_STORE, key);
      }
      chatKeyRef.current = key;
      setChatKey(key);
    } catch (e) {
      console.error('Failed to load chat encryption key:', e);
      return;
    }
    autoRestoreModel();
  }, [autoRestoreModel]);

  // ── Conversations ──────────────────────────────────────────────────────────

  const loadConversations = useCallback(async () => {
    const key = chatKeyRef.current;
    if (!key) return;
    const loaded = await chatStorage.loadConversations(key);
    if (chatKeyRef.current !== key) return; // locked meanwhile
    setConversations(loaded);
  }, []);

  const createConversation = useCallback(async (): Promise<string> => {
    const key = chatKeyRef.current;
    if (!key) throw new Error('Chat not authenticated');
    const now = new Date().toISOString();
    const conv: Conversation = {
      id: randomUUID(),
      title: 'New conversation',
      lastMessage: '',
      lastMessageAt: now,
      createdAt: now,
      messageCount: 0,
    };
    await chatStorage.addConversation(conv, key);
    setConversations((prev) => [conv, ...prev]);
    return conv.id;
  }, []);

  const deleteConversation = useCallback(
    async (id: string) => {
      if (genRef.current?.conversationId === id) {
        requestSeqRef.current++;
        interruptActive('cancelled');
        await enqueue(async () => undefined); // wait for the turn to settle
      }
      await chatStorage.deleteConversation(id);
      setConversations((prev) => prev.filter((c) => c.id !== id));
      bumpMessages();
    },
    [bumpMessages, enqueue, interruptActive],
  );

  // ── Messages ───────────────────────────────────────────────────────────────

  const getMessages = useCallback(
    async (conversationId: string): Promise<ChatMessage[]> => {
      const key = chatKeyRef.current;
      if (!key) return [];
      const { messages, healed } = await chatStorage.loadMessages(
        conversationId,
        key,
        genRef.current?.messageId ?? null,
      );
      if (healed) bumpMessages();
      return messages;
    },
    [bumpMessages],
  );

  /** Appends a user message and updates the conversation summary. False if the conversation is gone. */
  const persistUserMessage = useCallback(
    async (conversationId: string, text: string, key: string): Promise<boolean> => {
      if (!(await chatStorage.hasConversation(conversationId))) return false;
      const now = new Date().toISOString();
      const count = await chatStorage.appendMessage(
        conversationId,
        { id: randomUUID(), role: 'user', content: text, createdAt: now },
        key,
      );
      const patch: Partial<Conversation> = { lastMessage: preview(text), lastMessageAt: now, messageCount: count };
      if (count === 1) patch.title = text.slice(0, 60);
      if (await chatStorage.updateConversation(conversationId, patch, key)) {
        applyConversationPatch(conversationId, patch);
      }
      bumpMessages();
      return true;
    },
    [applyConversationPatch, bumpMessages],
  );

  const sendMessage = useCallback(
    (conversationId: string, text: string): Promise<void> => {
      const key = chatKeyRef.current;
      const trimmed = text.trim();
      if (!key || !trimmed) return Promise.resolve();
      setGenerationError(null);
      const reqId = ++requestSeqRef.current;
      // Interrupt-with-new-message: the running turn stops, settles and is
      // finalised as 'interrupted' (or dropped if empty) by its own queued op;
      // this op then appends the user message and answers with the partial in
      // the history. Later calls win: superseded ops still save their user
      // message but skip generation, so there is never more than one reply.
      interruptActive('interrupted');
      return enqueue(async () => {
        if (!(await persistUserMessage(conversationId, trimmed, key))) return;
        if (reqId !== requestSeqRef.current) return;
        const { messages } = await chatStorage.loadMessages(conversationId, key);
        await generate({ conversationId, key, history: messages, continueFrom: null });
      });
    },
    [enqueue, generate, interruptActive, persistUserMessage],
  );

  const continueResponse = useCallback(
    (conversationId: string): Promise<void> => {
      const key = chatKeyRef.current;
      if (!key) return Promise.resolve();
      setGenerationError(null);
      const reqId = ++requestSeqRef.current;
      interruptActive('interrupted');
      return enqueue(async () => {
        if (reqId !== requestSeqRef.current) return;
        const { messages } = await chatStorage.loadMessages(conversationId, key);
        const last = messages[messages.length - 1];
        if (!canContinueMessage(last)) return;
        await generate({ conversationId, key, history: messages.slice(0, -1), continueFrom: last });
      });
    },
    [enqueue, generate, interruptActive],
  );

  const regenerateResponse = useCallback(
    (conversationId: string): Promise<void> => {
      const key = chatKeyRef.current;
      if (!key) return Promise.resolve();
      setGenerationError(null);
      const reqId = ++requestSeqRef.current;
      interruptActive('interrupted');
      return enqueue(async () => {
        if (reqId !== requestSeqRef.current) return;
        const { messages } = await chatStorage.loadMessages(conversationId, key);
        let history = messages;
        const last = messages[messages.length - 1];
        if (last?.role === 'assistant') {
          await chatStorage.deleteMessage(conversationId, last.id);
          history = messages.slice(0, -1);
          bumpMessages();
        }
        if (history[history.length - 1]?.role !== 'user') return;
        await generate({ conversationId, key, history, continueFrom: null });
      });
    },
    [bumpMessages, enqueue, generate, interruptActive],
  );

  const cancelGeneration = useCallback((): Promise<void> => {
    requestSeqRef.current++; // also drops turns queued but not yet started
    interruptActive('cancelled');
    return opChainRef.current;
  }, [interruptActive]);

  const deleteMessage = useCallback(
    async (conversationId: string, messageId: string) => {
      const key = chatKeyRef.current;
      if (!key) return;
      const g = genRef.current;
      if (g && g.conversationId === conversationId && g.messageId === messageId) {
        requestSeqRef.current++;
        interruptActive('cancelled');
        await enqueue(async () => undefined); // wait for the turn to settle
      }
      if ((await chatStorage.deleteMessage(conversationId, messageId)) !== null) {
        const { messages } = await chatStorage.loadMessages(conversationId, key, genRef.current?.messageId ?? null);
        const lastWithText = [...messages].reverse().find((m) => m.content.trim());
        const patch: Partial<Conversation> = {
          messageCount: messages.length,
          lastMessage: preview(lastWithText?.content ?? ''),
        };
        if (await chatStorage.updateConversation(conversationId, patch, key)) {
          applyConversationPatch(conversationId, patch);
        }
      }
      bumpMessages();
    },
    [applyConversationPatch, bumpMessages, enqueue, interruptActive],
  );

  const clearGenerationError = useCallback(() => setGenerationError(null), []);

  // ── Downloads (unchanged behaviour) ────────────────────────────────────────

  const runDownload = useCallback((def: ModelDefinition) => {
    const id = def.id;
    setModelStates((prev) => ({
      ...prev,
      [id]: { status: 'downloading', progress: 0, errorMessage: null },
    }));

    const resumable = startDownload(def, (progress) => {
      setModelStates((prev) => ({
        ...prev,
        [id]: { ...(prev[id] ?? defaultModelState()), status: 'downloading', progress },
      }));
    });
    downloadResumablesRef.current[id] = resumable;

    resumable
      .downloadAsync()
      .then(() => {
        setModelStates((prev) => ({
          ...prev,
          [id]: { status: 'downloaded', progress: 1, errorMessage: null },
        }));
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : 'Download failed';
        if (!msg.includes('aborted') && !msg.includes('cancelled') && !msg.includes('paused')) {
          setModelStates((prev) => ({
            ...prev,
            [id]: { status: 'error', progress: 0, errorMessage: msg },
          }));
        }
      })
      .finally(() => {
        delete downloadResumablesRef.current[id];
      });
  }, []);

  const startModelDownload = useCallback(
    (id: ModelId) => {
      const def = getDef(id);
      if (def) runDownload(def);
    },
    [getDef, runDownload],
  );

  // Adds a user-supplied model and immediately starts downloading it in the background.
  const addCustomModel = useCallback(
    (name: string, url: string) => {
      const def = createCustomModel(name, url);
      setCustomModels((prev) => {
        const updated = [...prev, def];
        saveCustomModels(updated).catch(console.error);
        return updated;
      });
      runDownload(def);
    },
    [runDownload],
  );

  const cancelModelDownload = useCallback(
    async (id: ModelId) => {
      const resumable = downloadResumablesRef.current[id];
      if (resumable) {
        await resumable.pauseAsync().catch(console.error);
        delete downloadResumablesRef.current[id];
      }
      const def = getDef(id);
      if (def) await deleteModelFile(def);
      setModelStates((prev) => ({
        ...prev,
        [id]: { status: 'not_downloaded', progress: 0, errorMessage: null },
      }));
    },
    [getDef],
  );

  // ── Model unload / delete ──────────────────────────────────────────────────

  /** Cancels any reply and pending load, then releases the model (inside the queue). */
  const stopAndRelease = useCallback(async () => {
    if (genRef.current) {
      requestSeqRef.current++;
      interruptActive('cancelled');
    }
    modelRequestSeqRef.current++; // pending loads become no-ops
    await enqueue(releaseCurrentModel);
  }, [enqueue, interruptActive, releaseCurrentModel]);

  const unloadModel = useCallback(async () => {
    // An explicit unload means "don't auto-restore this next time".
    AsyncStorage.removeItem(ACTIVE_MODEL_KEY).catch(console.warn);
    await stopAndRelease();
  }, [stopAndRelease]);

  const deleteModel = useCallback(
    async (id: ModelId) => {
      const def = getDef(id);
      if (loadedModelIdRef.current === id || loadingModelIdRef.current === id) {
        await stopAndRelease();
      }
      if ((await AsyncStorage.getItem(ACTIVE_MODEL_KEY).catch(() => null)) === id) {
        AsyncStorage.removeItem(ACTIVE_MODEL_KEY).catch(console.warn);
      }
      // Cancel any in-progress download
      const resumable = downloadResumablesRef.current[id];
      if (resumable) {
        await resumable.pauseAsync().catch(console.error);
        delete downloadResumablesRef.current[id];
      }
      if (def) await deleteModelFile(def);

      // Custom models are removed entirely; built-ins just reset to "not downloaded".
      if (def?.isCustom) {
        setCustomModels((prev) => {
          const updated = prev.filter((m) => m.id !== id);
          saveCustomModels(updated).catch(console.error);
          return updated;
        });
        setModelStates((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
      } else {
        setModelStates((prev) => ({
          ...prev,
          [id]: { status: 'not_downloaded', progress: 0, errorMessage: null },
        }));
      }
    },
    [getDef, stopAndRelease],
  );

  const value = useMemo<ChatContextType>(
    () => ({
      isChatAuthenticated,
      loadChatKey,
      lockChat,
      conversations,
      loadConversations,
      createConversation,
      deleteConversation,
      getMessages,
      messagesVersion,
      sendMessage,
      continueResponse,
      regenerateResponse,
      deleteMessage,
      cancelGeneration,
      stopGeneration: cancelGeneration,
      isGenerating,
      streamingConversationId,
      streamingMessageId,
      streamingContent,
      streamingReasoning,
      isStreamingReasoning,
      generationError,
      clearGenerationError,
      contextUsage,
      models,
      customModels,
      modelStates,
      loadedModelId,
      isModelLoaded,
      isModelLoading,
      loadingModelId,
      modelLoadError,
      startModelDownload,
      cancelModelDownload,
      addCustomModel,
      initModel,
      unloadModel,
      deleteModel,
      thinkingEnabled,
      setThinkingEnabled,
      maxTokens,
      setMaxTokens,
    }),
    [
      isChatAuthenticated,
      loadChatKey,
      lockChat,
      conversations,
      loadConversations,
      createConversation,
      deleteConversation,
      getMessages,
      messagesVersion,
      sendMessage,
      continueResponse,
      regenerateResponse,
      deleteMessage,
      cancelGeneration,
      isGenerating,
      streamingConversationId,
      streamingMessageId,
      streamingContent,
      streamingReasoning,
      isStreamingReasoning,
      generationError,
      clearGenerationError,
      contextUsage,
      models,
      customModels,
      modelStates,
      loadedModelId,
      isModelLoaded,
      isModelLoading,
      loadingModelId,
      modelLoadError,
      startModelDownload,
      cancelModelDownload,
      addCustomModel,
      initModel,
      unloadModel,
      deleteModel,
      thinkingEnabled,
      setThinkingEnabled,
      maxTokens,
      setMaxTokens,
    ],
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat() {
  const context = useContext(ChatContext);
  if (!context) throw new Error('useChat must be used within ChatProvider');
  return context;
}
