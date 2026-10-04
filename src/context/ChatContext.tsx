import AsyncStorage from '@react-native-async-storage/async-storage';
import { randomUUID } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import type { DownloadProgressData, DownloadResumable, FileSystemDownloadResult } from 'expo-file-system/legacy';
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
  DownloadError,
  MODEL_CATALOG,
  MODEL_N_CTX,
  NO_CONNECTION_MESSAGE,
  RESUMES_FROM_PARTIAL_FILE,
  checkModelFile,
  clearDownloadRecord,
  createCustomModel,
  createModelDownload,
  deleteModelFile,
  describeDownloadError,
  describeHttpStatus,
  downloadRecordFor,
  forgetModelSize,
  formatBytes,
  getDownloadRecord,
  getEffectiveContextSize,
  getExpectedModelSize,
  getFreeDiskSpace,
  getModelPath,
  isHuggingFaceUrl,
  isModelFileDownloaded,
  loadCustomModels,
  loadDownloadRecords,
  loadModel,
  modelStateOf,
  pauseDownload,
  probeRemoteFile,
  pruneDownloadRecords,
  reconcileModelOnDisk,
  releaseModel,
  rememberModelSize,
  requiredFreeSpace,
  saveCustomModels,
  saveDownloadRecord,
  settleWithin,
  type DownloadRecord,
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

const defaultModelState = (): ModelState => modelStateOf('not_downloaded');

/** Model download UI state is flushed at most this often. */
const DOWNLOAD_FLUSH_MS = 250;
/** A running download's record (bytes, total) is persisted at most this often. */
const DOWNLOAD_PERSIST_MS = 5000;
/** Speed: time constant of the EMA, and minimum window per sample. */
const SPEED_EMA_TAU_MS = 4000;
const SPEED_SAMPLE_MIN_MS = 500;
/** How long pause/discard wait for the native transfer to stop writing. */
const PAUSE_SETTLE_MS = 5000;

const noop = () => undefined;

/** The one in-flight transfer of a model. Lives in a ref, never in React state. */
interface ActiveDownload {
  def: ModelDefinition;
  resumable: DownloadResumable | null;
  /** Resolves once the native transfer has settled (no more writes to the file). */
  settled: Promise<void>;
  settle: () => void;
  /** The native transfer settled; late progress events are ignored. */
  finished: boolean;
  /** Pause/discard arrived while the transfer was still being prepared. */
  abortRequested: boolean;
  /** Android resume answered with a different total (Range ignored): partial is unusable. */
  rangeMismatch: boolean;
  resumeOffset: number;
  totalBytes: number | null;
  bytesWritten: number;
  lastFlushAt: number;
  lastPersistAt: number;
  speedSampleAt: number;
  speedSampleBytes: number | null;
  bytesPerSecond: number | null;
}

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
  /** Download, Resume and Retry: resumes from a partial download whenever possible. */
  startModelDownload: (id: ModelId) => void;
  /** Same as pauseModelDownload (keeps the partial so it can be resumed). */
  cancelModelDownload: (id: ModelId) => void;
  /** Pauses a running download, keeping the partial data (survives app restarts). */
  pauseModelDownload: (id: ModelId) => Promise<void>;
  /** Stops a download and deletes its partial data. Never deletes a completed model. */
  discardModelDownload: (id: ModelId) => Promise<void>;
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
  /** Resolved once the startup download/integrity discovery has finished. */
  const [downloadsReady] = useState(createDeferred);

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
  const downloadsRef = useRef<Partial<Record<ModelId, ActiveDownload>>>({});
  /** Per-model chain serialising download control operations (see withModelLock). */
  const modelLocksRef = useRef<Partial<Record<ModelId, Promise<void>>>>({});
  /** Per-model counter bumped by start/pause/discard: a start queued before a pause becomes a no-op. */
  const downloadSeqRef = useRef<Partial<Record<ModelId, number>>>({});

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
        // Download discovery: verify files, surface paused downloads (also
        // ones that were running when the app was killed), drop fragments.
        const all = [...MODEL_CATALOG, ...custom];
        await loadDownloadRecords();
        await pruneDownloadRecords(all.map((m) => m.id));
        await Promise.all(
          all.map(async (m) => {
            try {
              const state = await reconcileModelOnDisk(m);
              setModelStates((prev) => ({ ...prev, [m.id]: state }));
            } catch (e) {
              console.warn(`Failed to check model ${m.id}:`, e);
            }
          }),
        );
      } catch (e) {
        console.error('Failed to load model inventory:', e);
      } finally {
        customModelsReady.resolve();
        downloadsReady.resolve();
      }
    })();
  }, [customModelsReady, downloadsReady]);

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

  // ── Downloads ──────────────────────────────────────────────────────────────
  //
  // Every control operation on a model's download (start/resume, pause,
  // discard, delete, settling a finished transfer) runs under a per-model lock,
  // so they never interleave across awaits. The transfer itself runs outside
  // the lock: `downloadsRef` holds the one active transfer per model, and any
  // progress event or settle whose entry is no longer current is ignored.

  const withModelLock = useCallback(<T,>(id: ModelId, fn: () => Promise<T>): Promise<T> => {
    const run = (modelLocksRef.current[id] ?? Promise.resolve()).then(fn);
    modelLocksRef.current[id] = run.then(noop, noop);
    return run;
  }, []);

  /** Sets a model's state, unless the model was removed meanwhile. */
  const setModelState = useCallback((id: ModelId, state: ModelState) => {
    if (!modelsRef.current.some((m) => m.id === id)) return;
    setModelStates((prev) => ({ ...prev, [id]: state }));
  }, []);

  /** Persists a size learned from the server (and shows it on custom models). */
  const learnModelSize = useCallback((def: ModelDefinition, bytes: number) => {
    rememberModelSize(def.id, bytes).catch(console.warn);
    if (!def.isCustom) return;
    setCustomModels((prev) => {
      if (!prev.some((m) => m.id === def.id && m.sizeBytes !== bytes)) return prev;
      const updated = prev.map((m) =>
        m.id === def.id ? { ...m, sizeBytes: bytes, sizeLabel: formatBytes(bytes) } : m,
      );
      saveCustomModels(updated).catch(console.error);
      return updated;
    });
  }, []);

  /**
   * After a failed attempt: 'paused' (with the reason) if something resumable
   * is left on disk, otherwise 'error'.
   */
  const failDownload = useCallback(
    async (def: ModelDefinition, message: string) => {
      const state = await reconcileModelOnDisk(def).catch(() => modelStateOf('not_downloaded'));
      if (state.status === 'downloaded') setModelState(def.id, state);
      else if (state.status === 'paused') setModelState(def.id, { ...state, errorMessage: message });
      else setModelState(def.id, modelStateOf('error', 0, state.totalBytes, message));
    },
    [setModelState],
  );

  const onDownloadProgress = useCallback(
    (entry: ActiveDownload, { totalBytesWritten: written, totalBytesExpectedToWrite: expected }: DownloadProgressData) => {
      const id = entry.def.id;
      if (entry.finished || downloadsRef.current[id] !== entry) return;
      entry.bytesWritten = written;

      // A total below what's written means "unknown" (no Content-Length).
      if (expected > 0 && expected >= written && expected !== entry.totalBytes) {
        if (RESUMES_FROM_PARTIAL_FILE && entry.resumeOffset > 0 && entry.totalBytes != null) {
          // Android appends the response to the partial file. A different total
          // means the server ignored our Range header (or the file changed):
          // stop now instead of appending gigabytes of garbage.
          entry.rangeMismatch = true;
          entry.resumable?.cancelAsync().catch(noop);
          return;
        }
        entry.totalBytes = expected; // the server is authoritative over the catalog
        learnModelSize(entry.def, expected);
      }

      const now = Date.now();
      if (entry.speedSampleBytes === null) {
        entry.speedSampleBytes = written;
        entry.speedSampleAt = now;
      }
      if (now - entry.lastFlushAt < DOWNLOAD_FLUSH_MS) return;
      entry.lastFlushAt = now;

      const dt = now - entry.speedSampleAt;
      if (dt >= SPEED_SAMPLE_MIN_MS) {
        const instant = (Math.max(0, written - entry.speedSampleBytes) * 1000) / dt;
        const alpha = 1 - Math.exp(-dt / SPEED_EMA_TAU_MS); // time-weighted EMA
        entry.bytesPerSecond =
          entry.bytesPerSecond === null ? instant : entry.bytesPerSecond + alpha * (instant - entry.bytesPerSecond);
        entry.speedSampleAt = now;
        entry.speedSampleBytes = written;
      }
      setModelState(id, {
        ...modelStateOf('downloading', written, entry.totalBytes),
        bytesPerSecond: entry.bytesPerSecond,
      });

      if (now - entry.lastPersistAt >= DOWNLOAD_PERSIST_MS) {
        entry.lastPersistAt = now;
        // savable() minus resumeData: on iOS that is the single-use blob this
        // transfer was started from (stale now); on Android the partial file
        // itself is the resume state.
        saveDownloadRecord(id, downloadRecordFor(entry.def, written, entry.totalBytes)).catch(console.warn);
      }
    },
    [learnModelSize, setModelState],
  );

  /**
   * Lock body: probes the server, checks free space, works out what can be
   * resumed and starts the transfer. Returns null if nothing was started.
   */
  const launchDownload = useCallback(
    async (def: ModelDefinition): Promise<{ entry: ActiveDownload; transfer: Promise<FileSystemDownloadResult | undefined> } | null> => {
      const id = def.id;
      if (downloadsRef.current[id]) return null; // already running
      let settle: () => void = noop;
      const entry: ActiveDownload = {
        def,
        resumable: null,
        settled: new Promise<void>((resolve) => {
          settle = resolve;
        }),
        settle: () => settle(),
        finished: false,
        abortRequested: false,
        rangeMismatch: false,
        resumeOffset: 0,
        totalBytes: null,
        bytesWritten: 0,
        lastFlushAt: 0,
        lastPersistAt: 0,
        speedSampleAt: 0,
        speedSampleBytes: null,
        bytesPerSecond: null,
      };
      downloadsRef.current[id] = entry;
      setModelStates((prev) => ({
        ...prev,
        [id]: { ...(prev[id] ?? defaultModelState()), status: 'downloading', errorMessage: null, bytesPerSecond: null },
      }));

      const wanted = () => downloadsRef.current[id] === entry && !entry.abortRequested;
      /** Pause/discard arrived while preparing: hand over to it (it is queued behind us). */
      let consumedRecord: DownloadRecord | null = null;
      const abandon = async () => {
        if (consumedRecord) await saveDownloadRecord(id, consumedRecord);
        if (downloadsRef.current[id] === entry) delete downloadsRef.current[id];
        entry.finished = true;
        entry.settle();
        return null;
      };

      try {
        const probe = await probeRemoteFile(def.url);
        if (!wanted()) return await abandon();
        if (probe.offline) throw new DownloadError(NO_CONNECTION_MESSAGE);
        // HEAD can be refused by servers that allow GET (e.g. presigned URLs),
        // so only trust auth errors from Hugging Face; 404/410 are reliable.
        if (
          probe.status !== null &&
          probe.status >= 400 &&
          (isHuggingFaceUrl(def.url) || probe.status === 404 || probe.status === 410)
        ) {
          throw new DownloadError(describeHttpStatus(probe.status, def.url));
        }

        const record = (await getDownloadRecord(id)) ?? null;
        const knownSize = await getExpectedModelSize(def);
        const sameFile = !!record && record.url === def.url && record.fileUri === getModelPath(def);
        const remoteChanged = probe.size !== null && knownSize !== null && probe.size !== knownSize;
        const total = probe.size ?? knownSize ?? (sameFile ? record.totalBytes : null);
        if (probe.size !== null) learnModelSize(def, probe.size);
        const canResume = sameFile && !remoteChanged && total !== null;

        let partial = 0;
        let resumeData: string | undefined;
        if (RESUMES_FROM_PARTIAL_FILE) {
          const file = await checkModelFile(def, total);
          if (file.kind === 'complete' && total !== null) {
            // Finished before the app could record it (e.g. killed at 100 %).
            await clearDownloadRecord(id);
            delete downloadsRef.current[id];
            entry.finished = true;
            entry.settle();
            setModelState(id, modelStateOf('downloaded', file.size, file.size));
            return null;
          }
          if (file.kind === 'short' && canResume && file.size > 0) partial = file.size;
          else if (file.kind !== 'missing') await deleteModelFile(def);
          if (partial > 0) resumeData = String(partial); // Range offset = bytes on disk
        } else if (canResume && record?.resumeData) {
          partial = record.bytesWritten;
          resumeData = record.resumeData;
          consumedRecord = record;
        }
        if (!wanted()) return await abandon();

        if (total !== null) {
          const free = await getFreeDiskSpace();
          const needed = requiredFreeSpace(total, partial);
          if (free !== null && free < needed) {
            throw new DownloadError(
              `Not enough storage: ${def.name} needs ${formatBytes(needed)} free (including a 10% margin), ` +
                `but only ${formatBytes(free)} is available.`,
            );
          }
        }

        entry.resumeOffset = partial;
        entry.totalBytes = total;
        entry.bytesWritten = partial;
        // Marks the download as in flight (survives a kill). iOS resume data is
        // single-use, so it is not kept once this transfer starts from it.
        await saveDownloadRecord(id, downloadRecordFor(def, partial, total));
        if (!wanted()) return await abandon();

        setModelState(id, modelStateOf('downloading', partial, total));
        const resumable = createModelDownload(def, resumeData, (data) => onDownloadProgress(entry, data));
        entry.resumable = resumable;
        entry.lastPersistAt = Date.now();
        const transfer = resumeData ? resumable.resumeAsync() : resumable.downloadAsync();
        return { entry, transfer };
      } catch (e) {
        if (consumedRecord && !entry.resumable) await saveDownloadRecord(id, consumedRecord).catch(noop);
        if (downloadsRef.current[id] === entry) delete downloadsRef.current[id];
        entry.finished = true;
        entry.settle();
        await failDownload(def, describeDownloadError(e));
        return null;
      }
    },
    [failDownload, learnModelSize, onDownloadProgress, setModelState],
  );

  /** Lock body: verifies a settled transfer and sets the final state. */
  const settleDownload = useCallback(
    async (entry: ActiveDownload, outcome: { result?: FileSystemDownloadResult; error?: unknown }) => {
      const { def } = entry;
      const id = def.id;
      if (downloadsRef.current[id] !== entry) return; // paused/discarded: that operation owns the state
      delete downloadsRef.current[id];
      try {
        if (outcome.error !== undefined) throw outcome.error;
        const cannotResume =
          "This server can't resume downloads, so the partial file was discarded. Tap Retry to start over.";
        if (entry.rangeMismatch) {
          await deleteModelFile(def);
          await clearDownloadRecord(id);
          throw new DownloadError(cannotResume);
        }
        const result = outcome.result;
        if (!result) throw new DownloadError('The download stopped unexpectedly.');
        const ok = result.status >= 200 && result.status < 300;
        // Android writes (appends, when resuming) any response body to the file,
        // error pages included; a resumed transfer must answer 206.
        if (!ok || (RESUMES_FROM_PARTIAL_FILE && entry.resumeOffset > 0 && result.status !== 206)) {
          await deleteModelFile(def);
          await clearDownloadRecord(id);
          throw new DownloadError(ok ? cannotResume : describeHttpStatus(result.status, def.url));
        }

        const file = await checkModelFile(def, entry.totalBytes);
        if (file.kind === 'complete') {
          if (entry.totalBytes === null) learnModelSize(def, file.size);
          await clearDownloadRecord(id);
          setModelState(id, modelStateOf('downloaded', file.size, file.size));
          return;
        }
        if (file.kind === 'short' && RESUMES_FROM_PARTIAL_FILE && file.size > 0) {
          throw new DownloadError('The download ended early. Tap Resume to continue.');
        }
        await deleteModelFile(def);
        await clearDownloadRecord(id);
        throw new DownloadError(
          file.kind === 'invalid' && file.reason === 'not_gguf'
            ? "That link didn't return a GGUF model file. Check the URL."
            : 'The downloaded file was incomplete or damaged and was removed. Tap Retry to download it again.',
        );
      } catch (e) {
        await failDownload(def, describeDownloadError(e));
      }
    },
    [failDownload, learnModelSize, setModelState],
  );

  /** Starts, resumes or retries a download. Resolves when the transfer has settled. */
  const runDownload = useCallback(
    async (def: ModelDefinition) => {
      const seq = (downloadSeqRef.current[def.id] ?? 0) + 1;
      downloadSeqRef.current[def.id] = seq;
      await downloadsReady.promise;
      const launched = await withModelLock(def.id, () =>
        downloadSeqRef.current[def.id] === seq ? launchDownload(def) : Promise.resolve(null),
      );
      if (!launched) return;
      const { entry, transfer } = launched;
      let outcome: { result?: FileSystemDownloadResult; error?: unknown };
      try {
        outcome = { result: await transfer };
      } catch (error) {
        outcome = { error: error ?? new Error('Download failed') };
      }
      entry.finished = true;
      entry.settle();
      // Drops the progress listener (a finished task is not unsubscribed natively).
      entry.resumable?.cancelAsync().catch(noop);
      await withModelLock(def.id, () => settleDownload(entry, outcome));
    },
    [downloadsReady, launchDownload, settleDownload, withModelLock],
  );

  /** Download, Resume and Retry: resumes from a partial download whenever possible. */
  const startModelDownload = useCallback(
    (id: ModelId) => {
      const def = getDef(id);
      if (def) runDownload(def).catch(console.error);
    },
    [getDef, runDownload],
  );

  // Adds a user-supplied model and immediately starts downloading it in the background.
  const addCustomModel = useCallback(
    (name: string, url: string) => {
      const def = createCustomModel(name, url);
      modelsRef.current = [...modelsRef.current, def];
      setCustomModels((prev) => {
        const updated = [...prev, def];
        saveCustomModels(updated).catch(console.error);
        return updated;
      });
      setModelStates((prev) => ({ ...prev, [def.id]: modelStateOf('downloading') }));
      runDownload(def).catch(console.error);
    },
    [runDownload],
  );

  /** Pause/discard requested while a transfer is still being prepared: make it bail out. */
  const requestAbort = useCallback((id: ModelId) => {
    downloadSeqRef.current[id] = (downloadSeqRef.current[id] ?? 0) + 1;
    const pending = downloadsRef.current[id];
    if (pending) pending.abortRequested = true;
  }, []);

  /** Keeps the partial download so it can be resumed later, even after a restart. */
  const pauseModelDownload = useCallback(
    (id: ModelId): Promise<void> => {
      requestAbort(id);
      return withModelLock(id, async () => {
        const def = getDef(id);
        if (!def) return;
        const entry = downloadsRef.current[id];
        if (entry) {
          delete downloadsRef.current[id]; // from here on its callbacks and settle are ignored
          if (entry.resumable) {
            const saved = await pauseDownload(entry.resumable);
            await settleWithin(entry.settled, PAUSE_SETTLE_MS); // Android: writer has stopped
            if (!RESUMES_FROM_PARTIAL_FILE) {
              if (!saved?.resumeData) {
                // No resume data (server without Range support, or the task had just ended).
                await clearDownloadRecord(id);
                const state = await reconcileModelOnDisk(def);
                setModelState(
                  id,
                  state.status === 'downloaded'
                    ? state
                    : modelStateOf(
                        'not_downloaded',
                        0,
                        entry.totalBytes,
                        "This download couldn't be paused, so it was stopped. Download again to restart it.",
                      ),
                );
                return;
              }
              await saveDownloadRecord(
                id,
                downloadRecordFor(def, entry.bytesWritten, entry.totalBytes, saved.resumeData),
              );
            } else {
              await saveDownloadRecord(id, downloadRecordFor(def, entry.bytesWritten, entry.totalBytes));
            }
          }
        }
        setModelState(id, await reconcileModelOnDisk(def));
      });
    },
    [getDef, requestAbort, setModelState, withModelLock],
  );

  /** Lock body: stops any transfer and deletes partial data (and the model file if `includeComplete`). */
  const discardDownloadInLock = useCallback(async (def: ModelDefinition, includeComplete: boolean) => {
    const entry = downloadsRef.current[def.id];
    if (entry) {
      delete downloadsRef.current[def.id];
      if (entry.resumable) {
        await entry.resumable.cancelAsync().catch(noop);
        await settleWithin(entry.settled, PAUSE_SETTLE_MS);
      }
    }
    await clearDownloadRecord(def.id);
    const expected = await getExpectedModelSize(def);
    if (includeComplete || (await checkModelFile(def, expected)).kind !== 'complete') {
      await deleteModelFile(def).catch(console.warn);
    }
  }, []);

  /** Stops a download and deletes its partial data. Never deletes a completed model. */
  const discardModelDownload = useCallback(
    (id: ModelId): Promise<void> => {
      requestAbort(id);
      return withModelLock(id, async () => {
        const def = getDef(id);
        if (!def) return;
        await discardDownloadInLock(def, false);
        setModelState(id, await reconcileModelOnDisk(def));
      });
    },
    [discardDownloadInLock, getDef, requestAbort, setModelState, withModelLock],
  );

  /** Kept for compatibility: now pauses (keeps the partial). Use discardModelDownload to delete it. */
  const cancelModelDownload = pauseModelDownload;

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
      // Stop any download, then delete the file and any partial data.
      if (def) {
        requestAbort(id);
        await withModelLock(id, () => discardDownloadInLock(def, true));
        if (def.isCustom) await forgetModelSize(id).catch(console.warn);
      }

      // Custom models are removed entirely; built-ins just reset to "not downloaded".
      if (def?.isCustom) {
        modelsRef.current = modelsRef.current.filter((m) => m.id !== id);
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
        setModelStates((prev) => ({ ...prev, [id]: modelStateOf('not_downloaded') }));
      }
    },
    [discardDownloadInLock, getDef, requestAbort, stopAndRelease, withModelLock],
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
      pauseModelDownload,
      discardModelDownload,
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
      pauseModelDownload,
      discardModelDownload,
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
