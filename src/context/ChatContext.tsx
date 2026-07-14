import { randomUUID } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
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
import { AppState, type AppStateStatus } from 'react-native';
import { type LlamaContext } from 'llama.rn';
import type { ChatMessage, Conversation, ModelDefinition, ModelId, ModelState } from '../types';
import { encryptValue, decryptValue, generateEncryptionKey } from '../utils/encryption';
import * as chatStorage from '../utils/chatStorage';

export const MAX_TOKENS_PRESETS = [512, 1024, 2048, 4096] as const;
import {
  MODEL_CATALOG,
  isModelFileDownloaded,
  startDownload,
  loadModel,
  releaseModel,
  deleteModelFile,
  loadCustomModels,
  saveCustomModels,
  createCustomModel,
} from '../utils/modelManager';

const CHAT_KEY_STORE = 'chat_encryption_key';
const ACTIVE_MODEL_KEY = 'ai_active_model_id';
const SYSTEM_PROMPT = 'You are the helpful AI Assistant, R.AI. You help users with whatever it is that they need. You are free to use whatever language you want to, do NOT force anything.';

/** Returns model-appropriate params for controlling thinking. */
function getThinkingParams(
  thinkingEnabled: boolean,
  loadedModelId: ModelId | null,
): { systemPromptSuffix: string; thinking_budget: number } {
  const isQwen = loadedModelId === 'fast' || loadedModelId === 'standard';
  if (isQwen) {
    // Qwen3 uses /think / /no_think soft-prompts; thinking_budget has no effect
    return {
      systemPromptSuffix: thinkingEnabled ? ' /think' : ' /no_think',
      thinking_budget: -1,
    };
  }
  // Gemma (and future models): use thinking_budget
  return {
    systemPromptSuffix: '',
    thinking_budget: thinkingEnabled ? -1 : 0,
  };
}
const STOP_TOKENS = [
  '</s>', '<|end|>', '<|eot_id|>', '<|end_of_text|>',
  'user:', 'assistant:', '<|EOT|>', '<|END_OF_TURN_TOKEN|>',
  '<|end_of_turn|>', '<|endoftext|>', '<end_of_turn>',
];

type ModelStates = Record<ModelId, ModelState>;

const defaultModelState = (): ModelState => ({
  status: 'not_downloaded',
  progress: 0,
  errorMessage: null,
});

const initialModelStates = (): ModelStates => {
  const states: ModelStates = {};
  for (const m of MODEL_CATALOG) {
    states[m.id] = defaultModelState();
  }
  return states;
};

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
  sendMessage: (conversationId: string, text: string) => Promise<void>;

  // Streaming
  streamingConversationId: string | null;
  streamingContent: string;
  continuingMessageId: string | null;
  isGenerating: boolean;
  cancelGeneration: () => void;
  stoppedLimitConvId: string | null;
  continueResponse: (conversationId: string) => Promise<void>;

  // Multi-model management
  models: ModelDefinition[]; // built-in catalog + custom models
  customModels: ModelDefinition[];
  modelStates: ModelStates;
  loadedModelId: ModelId | null;
  isModelLoaded: boolean;
  isModelLoading: boolean;
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
  const [chatEncryptionKey, setChatEncryptionKey] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [customModels, setCustomModels] = useState<ModelDefinition[]>([]);
  const [modelStates, setModelStates] = useState<ModelStates>(initialModelStates);
  const [loadedModelId, setLoadedModelId] = useState<ModelId | null>(null);
  const [isModelLoaded, setIsModelLoaded] = useState(false);
  const [isModelLoading, setIsModelLoading] = useState(false);
  const [streamingConversationId, setStreamingConversationId] = useState<string | null>(null);
  const [streamingContent, setStreamingContent] = useState('');
  const [continuingMessageId, setContinuingMessageId] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [stoppedLimitConvId, setStoppedLimitConvId] = useState<string | null>(null);
  const [thinkingEnabled, setThinkingEnabledState] = useState(true);
  const [maxTokens, setMaxTokensState] = useState(1024);

  const llamaContextRef = useRef<LlamaContext | null>(null);
  const downloadResumablesRef = useRef<Partial<Record<ModelId, ReturnType<typeof startDownload>>>>({});
  const abortGenerationRef = useRef(false);
  const isChatAuthenticated = chatEncryptionKey !== null;

  // Combined list of built-in + custom models. A ref mirrors it so the download
  // callbacks can resolve a definition without going stale.
  const models = useMemo(() => [...MODEL_CATALOG, ...customModels], [customModels]);
  const modelsRef = useRef<ModelDefinition[]>(models);
  useEffect(() => {
    modelsRef.current = models;
  }, [models]);

  const getDef = useCallback(
    (id: ModelId): ModelDefinition | undefined => modelsRef.current.find((m) => m.id === id),
    [],
  );

  // Load persisted settings + check which models are already downloaded
  useEffect(() => {
    AsyncStorage.getItem('ai_thinking_enabled').then((val) => {
      if (val !== null) setThinkingEnabledState(val === 'true');
    });
    AsyncStorage.getItem('ai_max_tokens').then((val) => {
      if (val !== null) setMaxTokensState(Number(val));
    });

    (async () => {
      // Load persisted custom models and seed their states
      const custom = await loadCustomModels();
      if (custom.length > 0) {
        setCustomModels(custom);
        setModelStates((prev) => {
          const next = { ...prev };
          for (const m of custom) {
            if (!next[m.id]) next[m.id] = defaultModelState();
          }
          return next;
        });
      }

      // Check download status for every model (built-in + custom)
      const all = [...MODEL_CATALOG, ...custom];
      await Promise.all(
        all.map(async (m) => {
          const downloaded = await isModelFileDownloaded(m);
          if (downloaded) {
            setModelStates((prev) => ({
              ...prev,
              [m.id]: { status: 'downloaded', progress: 1, errorMessage: null },
            }));
          }
        }),
      );
    })();
  }, []);

  const setThinkingEnabled = useCallback((val: boolean) => {
    setThinkingEnabledState(val);
    AsyncStorage.setItem('ai_thinking_enabled', String(val));
  }, []);

  const setMaxTokens = useCallback((val: number) => {
    setMaxTokensState(val);
    AsyncStorage.setItem('ai_max_tokens', String(val));
  }, []);

  // Lock chat + release model on background
  useEffect(() => {
    const handleAppState = (state: AppStateStatus) => {
      if (state === 'background' || state === 'inactive') {
        setChatEncryptionKey(null);
        if (llamaContextRef.current) {
          releaseModel(llamaContextRef.current).catch(console.error);
          llamaContextRef.current = null;
          setIsModelLoaded(false);
          setLoadedModelId(null);
        }
      }
    };
    const sub = AppState.addEventListener('change', handleAppState);
    return () => sub.remove();
  }, []);

  const loadChatKey = useCallback(async () => {
    try {
      let key = await SecureStore.getItemAsync(CHAT_KEY_STORE);
      if (!key) {
        key = await generateEncryptionKey();
        await SecureStore.setItemAsync(CHAT_KEY_STORE, key);
      }
      setChatEncryptionKey(key);
    } catch (e) {
      console.error('Failed to load chat encryption key:', e);
    }
  }, []);

  const lockChat = useCallback(() => {
    setChatEncryptionKey(null);
    if (llamaContextRef.current) {
      releaseModel(llamaContextRef.current).catch(console.error);
      llamaContextRef.current = null;
      setIsModelLoaded(false);
      setLoadedModelId(null);
    }
  }, []);

  const encryptField = useCallback(
    async (plaintext: string): Promise<string> => {
      if (!chatEncryptionKey) throw new Error('Chat not authenticated');
      const { sealed } = await encryptValue(plaintext, chatEncryptionKey);
      return sealed;
    },
    [chatEncryptionKey],
  );

  const decryptField = useCallback(
    async (sealed: string): Promise<string> => {
      if (!chatEncryptionKey) throw new Error('Chat not authenticated');
      return decryptValue(sealed, chatEncryptionKey);
    },
    [chatEncryptionKey],
  );

  const decryptConversation = useCallback(
    async (conv: Conversation): Promise<Conversation> => ({
      ...conv,
      title: await decryptField(conv.title),
      lastMessage: await decryptField(conv.lastMessage),
    }),
    [decryptField],
  );

  const loadConversations = useCallback(async () => {
    if (!chatEncryptionKey) return;
    const raw = await chatStorage.getConversations();
    const decrypted = await Promise.all(raw.map(decryptConversation));
    setConversations(decrypted);
  }, [chatEncryptionKey, decryptConversation]);

  const createConversation = useCallback(async (): Promise<string> => {
    if (!chatEncryptionKey) throw new Error('Chat not authenticated');
    const placeholder = 'New conversation';
    const id = randomUUID();
    const now = new Date().toISOString();
    const stored: Conversation = {
      id,
      title: await encryptField(placeholder),
      lastMessage: await encryptField(''),
      lastMessageAt: now,
      createdAt: now,
      messageCount: 0,
    };
    await chatStorage.addConversation(stored);
    setConversations((prev) => [{ ...stored, title: placeholder, lastMessage: '' }, ...prev]);
    return id;
  }, [chatEncryptionKey, encryptField]);

  const deleteConversation = useCallback(async (id: string) => {
    await chatStorage.deleteConversation(id);
    setConversations((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const getMessages = useCallback(
    async (conversationId: string): Promise<ChatMessage[]> => {
      if (!chatEncryptionKey) return [];
      const raw = await chatStorage.getMessages(conversationId);
      return Promise.all(
        raw.map(async (msg) => ({ ...msg, content: await decryptField(msg.content) })),
      );
    },
    [chatEncryptionKey, decryptField],
  );

  const sendMessage = useCallback(
    async (conversationId: string, text: string) => {
      if (!chatEncryptionKey || !llamaContextRef.current) return;
      if (isGenerating) return;

      const userMsg: ChatMessage = {
        id: randomUUID(),
        role: 'user',
        content: text,
        createdAt: new Date().toISOString(),
      };
      await chatStorage.appendMessage(conversationId, {
        ...userMsg,
        content: await encryptField(text),
      });

      const rawConvs = await chatStorage.getConversations();
      const conv = rawConvs.find((c) => c.id === conversationId);
      const isFirst = conv ? conv.messageCount === 0 : false;
      const newTitle = isFirst ? text.slice(0, 60) : undefined;

      const updatedConv: Conversation = {
        ...(conv ?? {
          id: conversationId,
          title: await encryptField(newTitle ?? 'Conversation'),
          lastMessage: await encryptField(''),
          lastMessageAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          messageCount: 0,
        }),
        lastMessage: await encryptField(text),
        lastMessageAt: new Date().toISOString(),
        messageCount: (conv?.messageCount ?? 0) + 1,
        ...(newTitle ? { title: await encryptField(newTitle) } : {}),
      };
      await chatStorage.updateConversation(updatedConv);
      setConversations((prev) =>
        prev.map((c) =>
          c.id === conversationId
            ? {
                ...c,
                lastMessage: text,
                lastMessageAt: updatedConv.lastMessageAt,
                messageCount: updatedConv.messageCount,
                ...(newTitle ? { title: newTitle } : {}),
              }
            : c,
        ),
      );

      const history = await getMessages(conversationId);

      setIsGenerating(true);
      setStreamingConversationId(conversationId);
      setStreamingContent('');
      setStoppedLimitConvId(null);
      abortGenerationRef.current = false;

      let tokenBuffer = '';
      let fullResponse = '';

      const flushInterval = setInterval(() => {
        if (tokenBuffer) {
          const chunk = tokenBuffer;
          tokenBuffer = '';
          fullResponse += chunk;
          setStreamingContent((prev) => prev + chunk);
        }
      }, 50);

      try {
        const { systemPromptSuffix, thinking_budget } = getThinkingParams(thinkingEnabled, loadedModelId);
        const result = await llamaContextRef.current.completion(
          {
            messages: [
              { role: 'system', content: SYSTEM_PROMPT + systemPromptSuffix },
              ...history.map((m) => ({ role: m.role, content: m.content })),
            ],
            n_predict: maxTokens,
            temperature: 0.7,
            thinking_budget,
            stop: STOP_TOKENS,
          },
          ({ token }: { token: string }) => {
            if (!abortGenerationRef.current) tokenBuffer += token;
          },
        );
        if ((result as any)?.stopped_limit) {
          setStoppedLimitConvId(conversationId);
        }
      } catch (e) {
        if (!abortGenerationRef.current) console.error('Completion error:', e);
      } finally {
        clearInterval(flushInterval);
        if (tokenBuffer) {
          fullResponse += tokenBuffer;
          setStreamingContent((prev) => prev + tokenBuffer);
        }
      }

      if (fullResponse.trim()) {
        const assistantMsg: ChatMessage = {
          id: randomUUID(),
          role: 'assistant',
          content: fullResponse,
          createdAt: new Date().toISOString(),
        };
        await chatStorage.appendMessage(conversationId, {
          ...assistantMsg,
          content: await encryptField(fullResponse),
        });

        const finalConvs = await chatStorage.getConversations();
        const finalConv = finalConvs.find((c) => c.id === conversationId);
        if (finalConv) {
          // Strip Qwen thinking (everything up to </think>) or Gemma thinking (<|channel>...<channel|>)
          const visibleText = fullResponse
            .replace(/^[\s\S]*?<\/think>/, '')
            .replace(/<\|channel>[\s\S]*?<channel\|>/, '')
            .trim();
          const preview = (visibleText || fullResponse).slice(0, 100);
          const updated: Conversation = {
            ...finalConv,
            lastMessage: await encryptField(preview),
            lastMessageAt: new Date().toISOString(),
            messageCount: finalConv.messageCount + 1,
          };
          await chatStorage.updateConversation(updated);
          setConversations((prev) =>
            prev.map((c) =>
              c.id === conversationId
                ? { ...c, lastMessage: preview, lastMessageAt: updated.lastMessageAt, messageCount: updated.messageCount }
                : c,
            ),
          );
        }
      }

      setIsGenerating(false);
      setStreamingConversationId(null);
      setStreamingContent('');
    },
    [chatEncryptionKey, isGenerating, thinkingEnabled, loadedModelId, encryptField, getMessages],
  );

  const cancelGeneration = useCallback(() => {
    abortGenerationRef.current = true;
    try {
      const result = llamaContextRef.current?.stopCompletion?.();
      if (result && typeof result.then === 'function') result.catch(console.error);
    } catch (e) {
      console.error('Error stopping completion:', e);
    }
  }, []);

  const continueResponse = useCallback(async (conversationId: string) => {
    if (!chatEncryptionKey || !llamaContextRef.current || isGenerating) return;

    const history = await getMessages(conversationId);
    if (history.length === 0) return;
    const lastMsg = history[history.length - 1];
    if (lastMsg.role !== 'assistant') return;

    // Strip thinking tags to get only the visible response portion.
    // This is what we pass back to the model — passing raw thinking confuses it
    // into generating a fresh response instead of continuing.
    const strippedVisible = lastMsg.content
      .replace(/^[\s\S]*?<\/think>/, '')   // Qwen: remove everything up to </think>
      .replace(/<\|channel>[\s\S]*?<channel\|>/, '') // Gemma: remove thinking block
      .trim();

    // Build history for the model: all messages up to (but not including) the
    // last assistant message, then re-add it with only its visible content.
    const historyWithoutLast = history.slice(0, -1);
    const messagesForModel = [
      { role: 'system' as const, content: SYSTEM_PROMPT },
      ...historyWithoutLast.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      // If stopped mid-thinking (no visible content), omit the partial message
      // entirely so the model regenerates cleanly.
      ...(strippedVisible
        ? [{ role: 'assistant' as const, content: strippedVisible }]
        : []),
    ];

    setStoppedLimitConvId(null);
    setIsGenerating(true);
    setStreamingConversationId(conversationId);
    // Seed the streaming view with what we already have so it reads seamlessly
    setStreamingContent(lastMsg.content);
    setContinuingMessageId(lastMsg.id);
    abortGenerationRef.current = false;

    let tokenBuffer = '';
    let additionalContent = '';

    const flushInterval = setInterval(() => {
      if (tokenBuffer) {
        const chunk = tokenBuffer;
        tokenBuffer = '';
        additionalContent += chunk;
        setStreamingContent((prev) => prev + chunk);
      }
    }, 50);

    try {
      const { systemPromptSuffix: contSuffix, thinking_budget: contBudget } = getThinkingParams(thinkingEnabled, loadedModelId);
      // Patch the system message in messagesForModel with the correct suffix
      if (messagesForModel[0]?.role === 'system') {
        messagesForModel[0].content = SYSTEM_PROMPT + contSuffix;
      }
      const result = await llamaContextRef.current.completion(
        {
          messages: messagesForModel,
          n_predict: maxTokens,
          temperature: 0.7,
          thinking_budget: contBudget,
          stop: STOP_TOKENS,
        },
        ({ token }: { token: string }) => {
          if (!abortGenerationRef.current) tokenBuffer += token;
        },
      );
      if ((result as any)?.stopped_limit) {
        setStoppedLimitConvId(conversationId);
      }
    } catch (e) {
      if (!abortGenerationRef.current) console.error('Continue error:', e);
    } finally {
      clearInterval(flushInterval);
      if (tokenBuffer) {
        additionalContent += tokenBuffer;
        setStreamingContent((prev) => prev + tokenBuffer);
      }
    }

    if (additionalContent.trim()) {
      // Append the continuation to the original content (preserving thinking tags)
      const fullContent = lastMsg.content + additionalContent;
      await chatStorage.updateLastMessage(conversationId, await encryptField(fullContent));
    }

    setIsGenerating(false);
    setStreamingConversationId(null);
    setStreamingContent('');
    setContinuingMessageId(null);
  }, [chatEncryptionKey, isGenerating, maxTokens, thinkingEnabled, loadedModelId, encryptField, getMessages]);

  // Kicks off (or restarts) a background download for a resolved definition.
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

    resumable.downloadAsync().then(() => {
      setModelStates((prev) => ({
        ...prev,
        [id]: { status: 'downloaded', progress: 1, errorMessage: null },
      }));
    }).catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : 'Download failed';
      if (!msg.includes('aborted') && !msg.includes('cancelled') && !msg.includes('paused')) {
        setModelStates((prev) => ({
          ...prev,
          [id]: { status: 'error', progress: 0, errorMessage: msg },
        }));
      }
    }).finally(() => {
      delete downloadResumablesRef.current[id];
    });
  }, []);

  const startModelDownload = useCallback((id: ModelId) => {
    const def = getDef(id);
    if (def) runDownload(def);
  }, [getDef, runDownload]);

  // Adds a user-supplied model and immediately starts downloading it in the background.
  const addCustomModel = useCallback((name: string, url: string) => {
    const def = createCustomModel(name, url);
    setCustomModels((prev) => {
      const updated = [...prev, def];
      saveCustomModels(updated).catch(console.error);
      return updated;
    });
    runDownload(def);
  }, [runDownload]);

  const cancelModelDownload = useCallback(async (id: ModelId) => {
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
  }, [getDef]);

  const initModel = useCallback(async (id: ModelId) => {
    if (isModelLoading) return;
    const def = getDef(id);
    if (!def) return;
    // Unload current model first if different
    if (llamaContextRef.current) {
      await releaseModel(llamaContextRef.current).catch(console.error);
      llamaContextRef.current = null;
      setIsModelLoaded(false);
      setLoadedModelId(null);
    }
    setIsModelLoading(true);
    try {
      const ctx = await loadModel(def);
      llamaContextRef.current = ctx;
      setIsModelLoaded(true);
      setLoadedModelId(id);
      AsyncStorage.setItem(ACTIVE_MODEL_KEY, id);
    } catch (e) {
      console.error('Failed to load model:', e);
    } finally {
      setIsModelLoading(false);
    }
  }, [isModelLoading, getDef]);

  const unloadModel = useCallback(async () => {
    if (llamaContextRef.current) {
      await releaseModel(llamaContextRef.current).catch(console.error);
      llamaContextRef.current = null;
      setIsModelLoaded(false);
      setLoadedModelId(null);
    }
  }, []);

  const deleteModel = useCallback(async (id: ModelId) => {
    const def = getDef(id);
    // Unload first if this model is loaded
    if (loadedModelId === id && llamaContextRef.current) {
      await releaseModel(llamaContextRef.current).catch(console.error);
      llamaContextRef.current = null;
      setIsModelLoaded(false);
      setLoadedModelId(null);
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
  }, [loadedModelId, getDef]);

  return (
    <ChatContext.Provider
      value={{
        isChatAuthenticated,
        loadChatKey,
        lockChat,
        conversations,
        loadConversations,
        createConversation,
        deleteConversation,
        getMessages,
        sendMessage,
        streamingConversationId,
        streamingContent,
        continuingMessageId,
        isGenerating,
        cancelGeneration,
        stoppedLimitConvId,
        continueResponse,
        models,
        customModels,
        modelStates,
        loadedModelId,
        isModelLoaded,
        isModelLoading,
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
      }}
    >
      {children}
    </ChatContext.Provider>
  );
}

export function useChat() {
  const context = useContext(ChatContext);
  if (!context) throw new Error('useChat must be used within ChatProvider');
  return context;
}
