import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  ActivityIndicator,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useThemeColor } from 'heroui-native';
import { FlashList, type FlashListRef, type ListRenderItemInfo } from '@shopify/flash-list';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { randomUUID } from 'expo-crypto';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { canContinueMessage, useChat } from '../../context/ChatContext';
import { ChatComposer } from '../../components/chat/ChatComposer';
import { ChatLockedView } from '../../components/chat/ChatLockedView';
import { MessageActionsSheet } from '../../components/chat/MessageActionsSheet';
import { MessageRow } from '../../components/chat/MessageRow';
import { ModelPickerDialog } from '../../components/chat/ModelPickerDialog';
import { continueReasonLabel } from '../../components/chat/format';
import type { ChatItem, TurnAction, TurnFooter } from '../../components/chat/types';
import type { ChatMessage } from '../../types';

/** Messages as last read from storage, tagged with what they belong to. */
interface LoadedMessages {
  conversationId: string;
  messages: ChatMessage[];
  /** `messagesVersion` when this read started. */
  version: number;
}

/** A sent message shown before it is persisted (instant feedback). */
interface PendingSend {
  localId: string;
  text: string;
  sentAt: number;
}

/** Last streamed state of a message, kept to bridge the end of a turn until the reload lands. */
interface LiveSnapshot {
  id: string;
  content: string;
  reasoning: string;
  /** `messagesVersion` when captured. */
  version: number;
}

/** Within this distance of the end, the list counts as "at the bottom". */
const NEAR_BOTTOM_PX = 32;
/** A user drag further than this from the end detaches auto-scroll. */
const DETACH_PX = 96;
/** After a load or a send, keep pinning to the end while item sizes settle. */
const STICK_WINDOW_MS = 800;

const messageItem = (message: ChatMessage): ChatItem => ({
  key: message.id,
  message,
  live: false,
  thinking: false,
  optimistic: false,
  stale: false,
});

export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [themeAccent, themeMuted, themeDanger, themeWarning] = useThemeColor([
    'accent',
    'muted',
    'danger',
    'warning',
  ]);

  const {
    isChatAuthenticated,
    loadChatKey,
    conversations,
    loadConversations,
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
    modelStates,
    loadedModelId,
    isModelLoaded,
    isModelLoading,
    loadingModelId,
    modelLoadError,
    initModel,
  } = useChat();

  const [loaded, setLoaded] = useState<LoadedMessages | null>(null);
  const [pending, setPending] = useState<PendingSend[]>([]);
  const [lastLive, setLastLive] = useState<LiveSnapshot | null>(null);
  const [inputText, setInputText] = useState('');
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [actionTarget, setActionTarget] = useState<ChatItem | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [busyCount, setBusyCount] = useState(0);
  const [detached, setDetached] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const listRef = useRef<FlashListRef<ChatItem>>(null);
  const draggingRef = useRef(false);
  const atBottomRef = useRef(true);
  const stickUntilRef = useRef(0);
  /** Conversation whose messages were last read (null after a lock): its first read pins to the end. */
  const loadedForRef = useRef<string | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isThisStreaming = isGenerating && streamingConversationId === id;
  const liveId = isThisStreaming ? streamingMessageId : null;

  // ── Derived state adjusted during render (React's "store info from previous renders" pattern) ──
  // Locked: drop every decrypted copy this screen holds.
  if (!isChatAuthenticated && (loaded !== null || pending.length > 0 || lastLive !== null || actionTarget !== null)) {
    setLoaded(null);
    setPending([]);
    setLastLive(null);
    setActionTarget(null);
    setSheetOpen(false);
  }
  // Remember the latest streamed text: when the turn ends the streaming fields
  // clear before the reload brings the finalised message, and the stored copy
  // may be up to ~1 s old. Without this the reply would visibly shrink and regrow.
  if (
    isChatAuthenticated &&
    liveId &&
    (lastLive?.id !== liveId ||
      lastLive.content !== streamingContent ||
      lastLive.reasoning !== streamingReasoning ||
      lastLive.version !== messagesVersion)
  ) {
    setLastLive({ id: liveId, content: streamingContent, reasoning: streamingReasoning, version: messagesVersion });
  }

  // ── Loading ─────────────────────────────────────────────────────────────────
  // Reload on mount, on unlock and whenever persisted messages change. A newer
  // read supersedes an older one still in flight.
  useEffect(() => {
    if (!isChatAuthenticated || !id) {
      loadedForRef.current = null;
      return;
    }
    let cancelled = false;
    const version = messagesVersion;
    getMessages(id)
      .then((messages) => {
        if (cancelled) return;
        if (loadedForRef.current !== id) {
          // First read (mount, unlock): start at the end once laid out.
          loadedForRef.current = id;
          stickUntilRef.current = Date.now() + STICK_WINDOW_MS;
        }
        setLoaded({ conversationId: id, messages, version });
      })
      .catch((e: unknown) => console.warn('Failed to load messages:', e));
    return () => {
      cancelled = true;
    };
  }, [id, isChatAuthenticated, messagesVersion, getMessages]);

  useEffect(
    () => () => {
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    },
    [],
  );

  const isLoadingMessages = loaded?.conversationId !== id;

  // Stored messages + optimistic sends. Recomputed only when storage is re-read
  // or a send starts/settles, so stored rows keep their identity (and their
  // memo'd render) across streaming flushes.
  const baseItems = useMemo<ChatItem[]>(() => {
    const messages = loaded && loaded.conversationId === id ? loaded.messages : [];
    const items = messages.map(messageItem);
    // An optimistic bubble disappears once its persisted twin is loaded.
    const matched = new Set<string>();
    for (const p of pending) {
      const twin = messages.find(
        (m) =>
          m.role === 'user' && !matched.has(m.id) && m.content === p.text && Date.parse(m.createdAt) >= p.sentAt,
      );
      if (twin) {
        matched.add(twin.id);
        continue;
      }
      items.push({
        key: p.localId,
        message: { id: p.localId, role: 'user', content: p.text, createdAt: new Date(p.sentAt).toISOString() },
        live: false,
        thinking: false,
        optimistic: true,
        stale: false,
      });
    }
    return items;
  }, [loaded, pending, id]);

  const loadedVersion = loaded?.version ?? -1;
  const held = !liveId ? lastLive : null;

  // Swap in the live message (streaming fields) and the held snapshot. Only the
  // affected row gets a new object.
  const items = useMemo<ChatItem[]>(() => {
    const liveItem = (base: ChatMessage): ChatItem => ({
      key: base.id,
      message: { ...base, content: streamingContent, reasoning: streamingReasoning, finishReason: undefined },
      live: true,
      thinking: isStreamingReasoning,
      optimistic: false,
      stale: false,
    });
    const out: ChatItem[] = [];
    let liveFound = false;
    for (const item of baseItems) {
      const m = item.message;
      if (liveId && m.id === liveId) {
        liveFound = true;
        out.push(liveItem(m));
      } else if (held && m.id === held.id && (m.finishReason === undefined || loadedVersion <= held.version)) {
        // The stored copy predates the end of the turn we streamed: show what we streamed.
        out.push({
          ...item,
          message: { ...m, content: held.content, reasoning: held.reasoning, finishReason: undefined },
          stale: true,
        });
      } else {
        out.push(item);
      }
    }
    // The turn has started but the reload with its placeholder hasn't landed yet.
    if (liveId && !liveFound) {
      out.push(liveItem({ id: liveId, role: 'assistant', content: '', createdAt: new Date(0).toISOString() }));
    }
    return out;
  }, [baseItems, liveId, streamingContent, streamingReasoning, isStreamingReasoning, held, loadedVersion]);

  const lastItem = items.length > 0 ? items[items.length - 1] : null;
  const lastMessage = lastItem?.message ?? null;
  const busy = busyCount > 0;

  // ── Actions ─────────────────────────────────────────────────────────────────
  const flashNotice = useCallback((text: string) => {
    setNotice(text);
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => setNotice(null), 1500);
  }, []);

  const followEnd = useCallback(() => {
    setDetached(false);
    stickUntilRef.current = Date.now() + STICK_WINDOW_MS;
    listRef.current?.scrollToEnd({ animated: true });
  }, []);

  /** Runs an engine action; while it is pending, turn controls are disabled. */
  const runAction = useCallback(
    (op: () => Promise<void>) => {
      setBusyCount((c) => c + 1);
      followEnd();
      op()
        .catch((e: unknown) => console.warn('Chat action failed:', e))
        .finally(() => setBusyCount((c) => c - 1));
    },
    [followEnd],
  );

  const copyText = useCallback(
    async (text: string) => {
      if (!text.trim()) return;
      await Clipboard.setStringAsync(text);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      flashNotice('Copied');
    },
    [flashNotice],
  );

  const canSend =
    inputText.trim().length > 0 && isChatAuthenticated && !!id && (isModelLoaded || isModelLoading);

  const handleSend = () => {
    const text = inputText.trim();
    if (!text || !canSend) return;
    const entry: PendingSend = { localId: `local-${randomUUID()}`, text, sentAt: Date.now() };
    setInputText('');
    setPending((prev) => [...prev, entry]);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    followEnd();
    // Mid-reply this interrupts the running turn; the engine keeps the partial in context.
    sendMessage(id, text)
      .catch((e: unknown) => console.warn('Send failed:', e))
      .finally(() => setPending((prev) => prev.filter((p) => p.localId !== entry.localId)));
  };

  const handleStop = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    void cancelGeneration();
  };

  const handleTurnAction = useCallback(
    (action: TurnAction) => {
      if (!lastMessage) return;
      switch (action) {
        case 'continue':
          runAction(() => continueResponse(id));
          break;
        case 'retry':
          // Keep partial text when there is some; otherwise start over.
          runAction(() => (lastMessage.content.trim() ? continueResponse(id) : regenerateResponse(id)));
          break;
        case 'regenerate':
          runAction(() => regenerateResponse(id));
          break;
        case 'copy':
          void copyText(lastMessage.content);
          break;
      }
    },
    [lastMessage, runAction, continueResponse, regenerateResponse, copyText, id],
  );

  // Controls under the last message, only while nothing is generating.
  let footerStatus: TurnFooter['status'] | null = null;
  if (!isGenerating && lastItem && !lastItem.live && !lastItem.stale && !lastItem.optimistic && pending.length === 0) {
    const m = lastItem.message;
    if (m.role === 'user') footerStatus = { kind: 'no-reply' };
    else if (m.finishReason === 'error') footerStatus = { kind: 'error', text: m.error || 'Something went wrong while generating.' };
    else if (canContinueMessage(m)) footerStatus = { kind: 'incomplete', label: continueReasonLabel(m.finishReason) };
    else footerStatus = { kind: 'complete' };
  }
  const footerKind = footerStatus?.kind ?? null;
  const footerText =
    footerStatus?.kind === 'error' ? footerStatus.text : footerStatus?.kind === 'incomplete' ? footerStatus.label : '';
  const footer = useMemo<TurnFooter | undefined>(() => {
    if (!footerKind) return undefined;
    const status: TurnFooter['status'] =
      footerKind === 'error'
        ? { kind: 'error', text: footerText }
        : footerKind === 'incomplete'
          ? { kind: 'incomplete', label: footerText }
          : { kind: footerKind };
    return { status, busy, onAction: handleTurnAction };
  }, [footerKind, footerText, busy, handleTurnAction]);

  const handleLongPress = useCallback((item: ChatItem) => {
    if (item.optimistic) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setActionTarget(item);
    setSheetOpen(true);
  }, []);

  // The sheet follows the live text of the message it was opened on.
  const sheetMessage = actionTarget
    ? (items.find((it) => it.message.id === actionTarget.message.id)?.message ?? actionTarget.message)
    : null;
  const sheetCanRegenerate =
    !!sheetMessage && sheetMessage.role === 'assistant' && sheetMessage.id === lastMessage?.id;

  // The target is kept while the sheet animates out; it is replaced on the next long-press.
  const closeSheet = useCallback(() => setSheetOpen(false), []);

  const handleSheetCopy = () => {
    if (sheetMessage) void copyText(sheetMessage.content);
    setSheetOpen(false);
  };
  const handleSheetRegenerate = () => {
    setSheetOpen(false);
    runAction(() => regenerateResponse(id));
  };
  const handleSheetDelete = () => {
    const target = sheetMessage;
    setSheetOpen(false);
    if (!target) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    // Deleting the streaming message stops it first (engine).
    setBusyCount((c) => c + 1);
    deleteMessage(id, target.id)
      .catch((e: unknown) => console.warn('Delete failed:', e))
      .finally(() => setBusyCount((c) => c - 1));
  };

  const handleSelectModel = (modelId: string) => {
    setShowModelPicker(false);
    if (modelId === loadedModelId && !isModelLoading) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    void initModel(modelId);
  };

  const handleUnlocked = useCallback(async () => {
    await loadChatKey();
    await loadConversations();
  }, [loadChatKey, loadConversations]);

  // ── Scrolling ───────────────────────────────────────────────────────────────
  const scrollToEndIfFollowing = () => {
    if (draggingRef.current) return;
    if (Date.now() < stickUntilRef.current || (isThisStreaming && !detached)) {
      listRef.current?.scrollToEnd({ animated: false });
    }
  };

  const handleScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const distance = contentSize.height - layoutMeasurement.height - contentOffset.y;
    atBottomRef.current = distance <= NEAR_BOTTOM_PX;
    if (atBottomRef.current) {
      if (detached) setDetached(false);
    } else if (draggingRef.current && distance > DETACH_PX && !detached) {
      setDetached(true);
    }
  };

  const handleListLayout = () => {
    // Keyboard opened/closed: stay at the end if we were there.
    if (atBottomRef.current && !draggingRef.current) listRef.current?.scrollToEnd({ animated: false });
  };

  const renderItem = ({ item, index }: ListRenderItemInfo<ChatItem>) => (
    <MessageRow
      item={item}
      footer={index === items.length - 1 ? footer : undefined}
      onLongPress={handleLongPress}
    />
  );

  // ── Render ──────────────────────────────────────────────────────────────────
  if (!isChatAuthenticated) {
    return <ChatLockedView onBack={() => router.back()} onUnlocked={handleUnlocked} />;
  }

  const conversation = conversations.find((c) => c.id === id);
  const downloadedModels = models.filter((m) => modelStates[m.id]?.status === 'downloaded');
  const loadedModel = models.find((m) => m.id === loadedModelId) ?? null;
  const loadingModel = models.find((m) => m.id === loadingModelId) ?? null;

  const usage = contextUsage && contextUsage.conversationId === id ? contextUsage : null;
  const contextPct =
    usage && usage.maxTokens > 0 ? Math.min(100, Math.round((usage.usedTokens / usage.maxTokens) * 100)) : null;
  const trimmedMessages = usage?.trimmedMessages ?? 0;

  // Errors of other chats are not shown here (null = not tied to a chat).
  const chatError =
    generationError && (generationError.conversationId === null || generationError.conversationId === id)
      ? generationError.message
      : null;
  // The failed message already shows this error inline with Retry.
  const errorShownInline =
    !isGenerating && lastMessage?.finishReason === 'error' && lastMessage.error === chatError;
  const showErrorBanner = !!chatError && !errorShownInline;
  const otherChatGenerating = isGenerating && !isThisStreaming;

  let placeholder = 'Message…';
  if (isThisStreaming) placeholder = 'Send to interrupt…';
  else if (!isModelLoaded && !isModelLoading) placeholder = 'Choose a model to chat…';

  return (
    <View className="flex-1 bg-background">
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        {/* Header */}
        <View className="flex-row items-center px-4 pt-14 pb-2 gap-2">
          <Pressable onPress={() => router.back()} className="p-1" accessibilityLabel="Back">
            <Ionicons name="chevron-back" size={24} color={themeAccent} />
          </Pressable>
          <View className="flex-1 min-w-0">
            <Text className="text-foreground font-semibold text-base" numberOfLines={1}>
              {conversation?.title || 'Chat'}
            </Text>
            {contextPct !== null ? (
              <View className="flex-row items-center gap-1.5 mt-0.5">
                <View className="h-[3px] w-8 rounded-full bg-surface overflow-hidden">
                  <View
                    style={{ width: `${contextPct}%`, backgroundColor: contextPct >= 90 ? themeWarning : themeMuted }}
                    className="h-full rounded-full"
                  />
                </View>
                <Text style={{ color: themeMuted }} className="text-[11px]">
                  {contextPct}% of context
                </Text>
              </View>
            ) : null}
          </View>
          <Pressable
            onPress={() => setShowModelPicker(true)}
            className="flex-row items-center gap-1 px-2.5 py-1.5 rounded-full bg-surface active:opacity-70"
            accessibilityLabel="Select model"
          >
            {isModelLoading ? (
              <ActivityIndicator size="small" color={themeMuted} style={{ transform: [{ scale: 0.7 }] }} />
            ) : (
              <Ionicons name="hardware-chip-outline" size={14} color={themeAccent} />
            )}
            <Text className="text-xs font-semibold text-foreground" numberOfLines={1} style={{ maxWidth: 110 }}>
              {isModelLoading ? (loadingModel?.name ?? 'Loading…') : (loadedModel?.name ?? 'Select model')}
            </Text>
            <Ionicons name="chevron-down" size={12} color={themeMuted} />
          </Pressable>
        </View>

        {/* Model status */}
        {modelLoadError ? (
          <Pressable
            onPress={() => setShowModelPicker(true)}
            className="mx-4 mb-2 bg-surface rounded-xl px-4 py-2.5 flex-row items-center gap-2 active:opacity-70"
          >
            <Ionicons name="alert-circle-outline" size={16} color={themeDanger} />
            <Text style={{ color: themeDanger }} className="text-xs flex-1" numberOfLines={3}>
              {modelLoadError}
            </Text>
            <Text className="text-foreground text-xs font-semibold">Choose</Text>
          </Pressable>
        ) : isModelLoading && !isModelLoaded ? (
          <View className="mx-4 mb-2 bg-surface rounded-xl px-4 py-2.5 flex-row items-center gap-2">
            <ActivityIndicator size="small" color={themeMuted} style={{ transform: [{ scale: 0.8 }] }} />
            <Text className="text-muted text-xs flex-1">
              Loading {loadingModel?.name ?? 'model'}… Messages you send will wait for it.
            </Text>
          </View>
        ) : !isModelLoaded ? (
          <Pressable
            onPress={() => setShowModelPicker(true)}
            className="mx-4 mb-2 bg-surface rounded-xl px-4 py-2.5 flex-row items-center gap-2 active:opacity-70"
          >
            <Ionicons name="information-circle-outline" size={16} color={themeMuted} />
            <Text className="text-muted text-xs flex-1">No model loaded.</Text>
            <Text className="text-foreground text-xs font-semibold">Choose model</Text>
          </Pressable>
        ) : null}

        {/* Messages */}
        <View className="flex-1" onLayout={handleListLayout}>
          {isLoadingMessages ? (
            <View className="flex-1 items-center justify-center">
              <ActivityIndicator color={themeMuted} />
            </View>
          ) : items.length === 0 ? (
            <View className="flex-1 items-center justify-center px-8">
              <Ionicons name="chatbubble-outline" size={40} color={themeMuted} />
              <Text className="text-muted text-center mt-3 text-sm leading-5">
                {isModelLoaded || isModelLoading
                  ? 'Send a message to start the conversation.\nEverything stays on this device.'
                  : 'Choose a model to start chatting.'}
              </Text>
            </View>
          ) : (
            <FlashList
              ref={listRef}
              data={items}
              keyExtractor={(item) => item.key}
              getItemType={(item) => item.message.role}
              renderItem={renderItem}
              extraData={footer}
              maintainVisibleContentPosition={{ startRenderingFromBottom: true }}
              contentContainerStyle={{ paddingTop: 12, paddingBottom: 12 }}
              keyboardDismissMode="interactive"
              keyboardShouldPersistTaps="handled"
              scrollEventThrottle={16}
              onScroll={handleScroll}
              onScrollBeginDrag={() => {
                draggingRef.current = true;
              }}
              onScrollEndDrag={() => {
                draggingRef.current = false;
              }}
              onMomentumScrollBegin={() => {
                draggingRef.current = true;
              }}
              onMomentumScrollEnd={() => {
                draggingRef.current = false;
              }}
              onContentSizeChange={scrollToEndIfFollowing}
            />
          )}

          {detached && items.length > 0 ? (
            <View pointerEvents="box-none" className="absolute bottom-3 left-0 right-0 items-center">
              <Pressable
                onPress={followEnd}
                accessibilityLabel="Scroll to latest"
                className="w-9 h-9 rounded-full bg-surface items-center justify-center shadow-md active:opacity-70"
              >
                <Ionicons name="arrow-down" size={18} color={themeAccent} />
              </Pressable>
            </View>
          ) : null}
        </View>

        {/* Notices above the input */}
        <View className="px-4 gap-1.5">
          {notice ? (
            <View className="self-center bg-surface rounded-full px-3 py-1">
              <Text className="text-foreground text-xs font-medium">{notice}</Text>
            </View>
          ) : null}
          {showErrorBanner ? (
            <View className="bg-surface rounded-xl pl-3 pr-1.5 py-2 flex-row items-center gap-2">
              <Ionicons name="alert-circle-outline" size={16} color={themeDanger} />
              <Text style={{ color: themeDanger }} className="text-xs flex-1 leading-4">
                {chatError}
              </Text>
              <Pressable onPress={clearGenerationError} hitSlop={8} className="p-1 active:opacity-70" accessibilityLabel="Dismiss">
                <Ionicons name="close" size={16} color={themeMuted} />
              </Pressable>
            </View>
          ) : null}
          {otherChatGenerating ? (
            <View className="bg-surface rounded-xl pl-3 pr-1.5 py-2 flex-row items-center gap-2">
              <ActivityIndicator size="small" color={themeMuted} style={{ transform: [{ scale: 0.7 }] }} />
              <Text className="text-muted text-xs flex-1 leading-4">
                Another chat is still replying. Sending here will stop it.
              </Text>
              <Pressable onPress={handleStop} className="px-2 py-1 active:opacity-70">
                <Text className="text-foreground text-xs font-semibold">Stop</Text>
              </Pressable>
            </View>
          ) : null}
          {trimmedMessages > 0 ? (
            <View className="flex-row items-center justify-center gap-1.5 py-0.5">
              <Ionicons name="information-circle-outline" size={12} color={themeMuted} />
              <Text style={{ color: themeMuted }} className="text-[11px]">
                Older messages are no longer in the model&apos;s context
              </Text>
            </View>
          ) : null}
        </View>

        <ChatComposer
          value={inputText}
          onChangeText={setInputText}
          placeholder={placeholder}
          canSend={canSend}
          onSend={handleSend}
          showStop={isThisStreaming}
          onStop={handleStop}
        />

        <ModelPickerDialog
          isOpen={showModelPicker}
          onClose={() => setShowModelPicker(false)}
          models={downloadedModels}
          loadedModelId={loadedModelId}
          loadingModelId={loadingModelId}
          isGenerating={isGenerating}
          onSelect={handleSelectModel}
          onManage={() => {
            setShowModelPicker(false);
            router.push('/models');
          }}
        />

        <MessageActionsSheet
          isOpen={sheetOpen && !!sheetMessage}
          message={sheetMessage}
          onClose={closeSheet}
          copyText={sheetMessage?.content ?? ''}
          canRegenerate={sheetCanRegenerate}
          onCopy={handleSheetCopy}
          onRegenerate={handleSheetRegenerate}
          onDelete={handleSheetDelete}
        />
      </KeyboardAvoidingView>
    </View>
  );
}
