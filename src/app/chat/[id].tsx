import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { View, Text, TextInput, Pressable, KeyboardAvoidingView, Platform, ActivityIndicator } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useThemeColor, Dialog, Button } from 'heroui-native';
import { FlashList } from '@shopify/flash-list';
import { randomUUID } from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import { canContinueMessage, useChat } from '../../context/ChatContext';
import { parseThinking } from '../../utils/thinking';
import { MarkdownRenderer } from '../../components/MarkdownRenderer';
import { ThinkingIndicator, ThinkingCollapsible } from '../../components/ThinkingBlock';
import type { ChatMessage } from '../../types';

type DisplayMessage = ChatMessage | { id: 'streaming'; role: 'assistant'; content: string; createdAt: string };

function UserBubble({ content }: { content: string }) {
  const [themeAccentForeground] = useThemeColor(['accent-foreground']);
  return (
    <View className="items-end mb-3 px-4">
      <View className="bg-accent rounded-2xl rounded-tr-sm px-4 py-2.5 max-w-[80%]">
        <Text style={{ color: themeAccentForeground }} className="text-sm leading-5">{content}</Text>
      </View>
    </View>
  );
}

function AssistantBubble({ content, isStreaming }: { content: string; isStreaming?: boolean }) {
  const { thinkingEnabled } = useChat();
  const { completedBlocks, isThinking, thinkingText, visible } = useMemo(
    () => parseThinking(content, !!isStreaming),
    [content, isStreaming],
  );

  // Detect "stopped mid-thinking": saved message, thinking was enabled, no end tag
  // found, so parseThinking returned the raw thinking content as `visible`.
  // Show it as a truncated thinking block instead of raw text.
  const stoppedMidThinking =
    !isStreaming &&
    thinkingEnabled &&
    completedBlocks.length === 0 &&
    !isThinking &&
    visible.length > 0 &&
    content === visible; // visible === full content means no tags were found

  return (
    <View className="mb-4 px-4">
      {/* Completed thinking blocks — collapsible */}
      {completedBlocks.map((block, i) => (
        <ThinkingCollapsible key={i} content={block} />
      ))}

      {/* Stopped mid-thinking — show as collapsed truncated block */}
      {stoppedMidThinking && (
        <ThinkingCollapsible content={visible} truncated />
      )}

      {/* Active thinking indicator — tap to see live thinking */}
      {isThinking && <ThinkingIndicator thinkingText={thinkingText} />}

      {/* Visible response — full width, no bubble */}
      {!stoppedMidThinking && visible.length > 0 && (
        <MarkdownRenderer content={visible} isStreaming={isStreaming && !isThinking} />
      )}
    </View>
  );
}

export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [themeAccent, themeMuted, themeSurface, themeForeground] = useThemeColor([
    'accent', 'muted', 'surface', 'foreground',
  ]);

  const {
    isChatAuthenticated,
    conversations,
    getMessages,
    sendMessage,
    streamingConversationId,
    streamingContent,
    streamingMessageId,
    isGenerating,
    cancelGeneration,
    continueResponse,
    isModelLoaded,
    models,
    modelStates,
    loadedModelId,
    initModel,
    isModelLoading,
  } = useChat();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [isLoadingMessages, setIsLoadingMessages] = useState(true);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const hasLoadedRef = useRef(false);
  const flashListRef = useRef<FlashList<DisplayMessage>>(null);
  const userScrolledUpRef = useRef(false);

  const conversation = conversations.find((c) => c.id === id);
  const isThisStreaming = streamingConversationId === id;
  const canContinue = !isGenerating && canContinueMessage(messages[messages.length - 1]);

  const loadedModel = models.find((m) => m.id === loadedModelId) ?? null;
  const downloadedModels = models.filter((m) => modelStates[m.id]?.status === 'downloaded');

  const displayMessages: DisplayMessage[] = isThisStreaming && streamingContent
    ? [
        // During continuation, hide the original message so streaming replaces it seamlessly
        ...messages.filter((m) => m.id !== streamingMessageId),
        { id: 'streaming', role: 'assistant', content: streamingContent, createdAt: new Date().toISOString() },
      ]
    : messages;

  // Initial message load
  useEffect(() => {
    if (!isChatAuthenticated || !id) return;
    hasLoadedRef.current = false;
    (async () => {
      setIsLoadingMessages(true);
      try {
        const loaded = await getMessages(id);
        setMessages(loaded);
        hasLoadedRef.current = true;
      } finally {
        setIsLoadingMessages(false);
      }
    })();
  }, [id, isChatAuthenticated, getMessages]);

  // Refresh messages after generation completes (skip if initial load hasn't happened)
  useEffect(() => {
    if (!hasLoadedRef.current) return;
    if (!isThisStreaming && !isGenerating && isChatAuthenticated && id) {
      getMessages(id).then(setMessages).catch(console.error);
    }
  }, [isThisStreaming, isGenerating, isChatAuthenticated, id, getMessages]);

  // Reset the "scrolled up" flag when a new generation starts
  useEffect(() => {
    if (isThisStreaming) {
      userScrolledUpRef.current = false;
    }
  }, [isThisStreaming]);

  // Auto-scroll to bottom while streaming, unless the user scrolled up
  useEffect(() => {
    if (isThisStreaming && !userScrolledUpRef.current && displayMessages.length > 0) {
      flashListRef.current?.scrollToEnd({ animated: false });
    }
  }, [streamingContent, isThisStreaming, displayMessages.length]);

  const handleSend = useCallback(async () => {
    const text = inputText.trim();
    if (!text || !isModelLoaded || isGenerating || !isChatAuthenticated) return;
    setInputText('');

    // Optimistically add user message to local state immediately
    const optimisticMsg: ChatMessage = {
      id: randomUUID(),
      role: 'user',
      content: text,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimisticMsg]);

    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await sendMessage(id, text);
  }, [inputText, isModelLoaded, isGenerating, isChatAuthenticated, sendMessage, id]);

  const handleCancel = useCallback(async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    cancelGeneration();
  }, [cancelGeneration]);

  const handleSelectModel = useCallback(async (modelId: string) => {
    if (isModelLoading) return;
    if (modelId === loadedModelId) {
      setShowModelPicker(false);
      return;
    }
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setShowModelPicker(false);
    await initModel(modelId);
  }, [isModelLoading, loadedModelId, initModel]);

  if (!isChatAuthenticated) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <Text className="text-muted">Session expired. Return to the AI tab to re-authenticate.</Text>
        <Pressable onPress={() => router.back()} className="mt-4">
          <Text style={{ color: themeAccent }} className="font-semibold">Go back</Text>
        </Pressable>
      </View>
    );
  }

  const canSend = inputText.trim().length > 0 && isModelLoaded && !isGenerating;
  const modelNotLoaded = !isModelLoaded;

  return (
    <KeyboardAvoidingView
      behavior="padding"
      className="flex-1 bg-background"
      keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 24}
    >
      {/* Header */}
      <View className="flex-row items-center px-4 pt-14 pb-3 gap-2">
        <Pressable onPress={() => router.back()} className="p-1">
          <Ionicons name="chevron-back" size={24} color={themeAccent} />
        </Pressable>
        <Text className="flex-1 text-foreground font-semibold text-base" numberOfLines={1}>
          {conversation?.title || 'Chat'}
        </Text>
        {/* Model selector */}
        <Pressable
          onPress={() => setShowModelPicker(true)}
          style={{ backgroundColor: themeSurface }}
          className="flex-row items-center gap-1 px-2.5 py-1.5 rounded-full active:opacity-70"
        >
          {isModelLoading ? (
            <ActivityIndicator size="small" color={themeAccent} />
          ) : (
            <Ionicons name="hardware-chip-outline" size={14} color={themeAccent} />
          )}
          <Text
            className="text-xs font-semibold"
            numberOfLines={1}
            style={{ color: themeForeground, maxWidth: 100 }}
          >
            {loadedModel?.name ?? 'Select model'}
          </Text>
          <Ionicons name="chevron-down" size={12} color={themeMuted} />
        </Pressable>
      </View>

      {/* Model not loaded warning */}
      {modelNotLoaded && (
        <View className="mx-4 mb-2 bg-surface rounded-xl px-4 py-2.5 flex-row items-center gap-2">
          <Ionicons name="information-circle-outline" size={16} color={themeMuted} />
          <Text className="text-muted text-xs flex-1">
            Model not loaded — go to the AI tab to download or load it.
          </Text>
        </View>
      )}

      {/* Messages */}
      <View className="flex-1">
        {isLoadingMessages ? (
          <View className="flex-1 items-center justify-center">
            <Text className="text-muted text-sm">Loading messages…</Text>
          </View>
        ) : displayMessages.length === 0 ? (
          <View className="flex-1 items-center justify-center px-8">
            <Ionicons name="chatbubble-outline" size={40} color={themeMuted} />
            <Text className="text-muted text-center mt-3 text-sm leading-5">
              {isModelLoaded
                ? 'Send a message to start the conversation'
                : 'Load the AI model from the AI tab to start chatting'}
            </Text>
          </View>
        ) : (
          <FlashList
            ref={flashListRef}
            data={displayMessages}
            keyExtractor={(item) => item.id}
            estimatedItemSize={72}
            renderItem={({ item }) => {
              if (item.role === 'user') {
                return <UserBubble content={item.content} />;
              }
              return (
                <AssistantBubble
                  content={item.content}
                  isStreaming={item.id === 'streaming'}
                />
              );
            }}
            contentContainerStyle={{ paddingTop: 12, paddingBottom: 8 }}
            onScrollBeginDrag={() => {
              userScrolledUpRef.current = true;
            }}
            onScrollEndDrag={({ nativeEvent }) => {
              const { contentOffset, contentSize, layoutMeasurement } = nativeEvent;
              const distanceFromBottom = contentSize.height - layoutMeasurement.height - contentOffset.y;
              if (distanceFromBottom < 40) {
                userScrolledUpRef.current = false;
              }
            }}
          />
        )}
      </View>

      {/* Continue banner — shown when last response was cut off by token limit */}
      {canContinue && (
        <Pressable
          onPress={() => continueResponse(id)}
          style={{ backgroundColor: themeSurface }}
          className="mx-4 mb-2 px-4 py-2.5 rounded-xl flex-row items-center gap-2 border border-muted active:opacity-70"
        >
          <Ionicons name="arrow-down-circle-outline" size={16} color={themeAccent} />
          <Text style={{ color: themeAccent }} className="text-sm font-semibold flex-1">
            Response was cut off — tap to continue
          </Text>
          <Ionicons name="chevron-forward" size={14} color={themeMuted} />
        </Pressable>
      )}

      {/* Input bar */}
      <View style={{ backgroundColor: themeSurface }} className="flex-row items-end px-3 py-2 gap-2 border-t border-background">
        <TextInput
          value={inputText}
          onChangeText={setInputText}
          placeholder={isModelLoaded ? 'Message AI…' : 'Load model to chat…'}
          placeholderTextColor={themeMuted}
          multiline
          editable={!isGenerating && isModelLoaded}
          style={{
            flex: 1,
            maxHeight: 120,
            color: themeForeground,
            fontSize: 15,
            paddingVertical: 8,
            paddingHorizontal: 4,
          }}
          onSubmitEditing={handleSend}
          blurOnSubmit={false}
        />
        {isGenerating ? (
          <Pressable onPress={handleCancel} className="p-2 mb-0.5">
            <Ionicons name="stop-circle" size={30} color={themeAccent} />
          </Pressable>
        ) : (
          <Pressable onPress={handleSend} disabled={!canSend} className="p-2 mb-0.5">
            <Ionicons
              name="send"
              size={22}
              color={canSend ? themeAccent : themeMuted}
            />
          </Pressable>
        )}
      </View>

      {/* Model picker */}
      <Dialog isOpen={showModelPicker} onOpenChange={(open) => { if (!open) setShowModelPicker(false); }}>
        <Dialog.Portal>
          <Dialog.Overlay />
          <Dialog.Content>
            <Dialog.Title>Select model</Dialog.Title>
            <Dialog.Description>
              Choose a downloaded model to load for this chat.
            </Dialog.Description>

            <View className="mt-3 gap-2">
              {downloadedModels.length === 0 ? (
                <Text className="text-muted text-sm leading-5">
                  No models downloaded yet. Download one from the models screen first.
                </Text>
              ) : (
                downloadedModels.map((m) => {
                  const selected = m.id === loadedModelId;
                  return (
                    <Pressable
                      key={m.id}
                      onPress={() => handleSelectModel(m.id)}
                      disabled={isModelLoading}
                      style={{ backgroundColor: themeSurface, opacity: isModelLoading && !selected ? 0.5 : 1 }}
                      className="rounded-xl px-4 py-3 flex-row items-center justify-between active:opacity-70"
                    >
                      <View className="flex-1 mr-3">
                        <Text className="text-foreground font-semibold text-sm">{m.name}</Text>
                        <Text className="text-muted text-xs mt-0.5">{m.tag}</Text>
                      </View>
                      {selected ? (
                        <Ionicons name="checkmark-circle" size={20} color={themeAccent} />
                      ) : (
                        <Ionicons name="ellipse-outline" size={20} color={themeMuted} />
                      )}
                    </Pressable>
                  );
                })
              )}
            </View>

            <View className="gap-3 mt-4">
              <Button variant="ghost" onPress={() => { setShowModelPicker(false); router.push('/models'); }}>
                <Button.Label>Manage models</Button.Label>
              </Button>
              <Button variant="ghost" onPress={() => setShowModelPicker(false)}>
                <Button.Label>Close</Button.Label>
              </Button>
            </View>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>
    </KeyboardAvoidingView>
  );
}
