import { useState, useCallback } from 'react';
import { View, Text, Pressable } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Dialog, Button, Switch as HeroSwitch } from 'heroui-native';
import { MAX_TOKENS_PRESETS } from '../../context/ChatContext';
import { useThemeColor } from 'heroui-native';
import { FlashList } from '@shopify/flash-list';
import * as Haptics from 'expo-haptics';
import { useChat } from '../../context/ChatContext';
import { BiometricAuth } from '../../components/BiometricAuth';
import { ModelDownloadBanner } from '../../components/ModelDownloadBanner';
import type { Conversation } from '../../types';

function formatRelativeTime(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  return `${days}d ago`;
}

function ConversationRow({
  conversation,
  onPress,
  onLongPress,
}: {
  conversation: Conversation;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const [themeMuted] = useThemeColor(['muted']);
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      className="flex-row items-center px-4 py-3 gap-3 active:opacity-70"
    >
      <View className="w-10 h-10 rounded-full bg-background items-center justify-center">
        <Ionicons name="chatbubble-ellipses-outline" size={18} color={themeMuted} />
      </View>
      <View className="flex-1 min-w-0">
        <Text className="text-foreground font-semibold text-sm" numberOfLines={1}>
          {conversation.title || 'New conversation'}
        </Text>
        {conversation.lastMessage ? (
          <Text className="text-muted text-xs mt-0.5" numberOfLines={1}>
            {conversation.lastMessage}
          </Text>
        ) : null}
      </View>
      <Text className="text-muted text-xs">{formatRelativeTime(conversation.lastMessageAt)}</Text>
    </Pressable>
  );
}

export default function AITab() {
  const router = useRouter();
  const [themeAccent, themeMuted, themeAccentForeground, themeSurface] = useThemeColor([
    'accent', 'muted', 'accent-foreground', 'surface',
  ]);
  const {
    isChatAuthenticated,
    loadChatKey,
    conversations,
    loadConversations,
    createConversation,
    deleteConversation,
    models,
    modelStates,
    loadedModelId,
    isModelLoading,
    thinkingEnabled,
    setThinkingEnabled,
    maxTokens,
    setMaxTokens,
  } = useChat();

  const [showAuthDialog, setShowAuthDialog] = useState(false);
  const [convToDelete, setConvToDelete] = useState<Conversation | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [showConfigDialog, setShowConfigDialog] = useState(false);

  useFocusEffect(
    useCallback(() => {
      if (!isChatAuthenticated) {
        setShowAuthDialog(true);
      } else {
        loadConversations();
      }
    }, [isChatAuthenticated, loadConversations]),
  );

  const handleAuthSuccess = useCallback(async () => {
    await loadChatKey();
  }, [loadChatKey]);

  const handleNewChat = useCallback(async () => {
    if (!isChatAuthenticated || isCreating) return;
    setIsCreating(true);
    try {
      const id = await createConversation();
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      router.push({ pathname: '/chat/[id]', params: { id } });
    } finally {
      setIsCreating(false);
    }
  }, [isChatAuthenticated, isCreating, createConversation, router]);

  const handleDelete = useCallback(async () => {
    if (!convToDelete) return;
    await deleteConversation(convToDelete.id);
    setConvToDelete(null);
  }, [convToDelete, deleteConversation]);

  const isModelLoaded = loadedModelId !== null;

  return (
    <View className="flex-1 bg-background">
      {/* Header */}
      <View className="px-5 pt-14 pb-4">
        <View className="flex-row items-center justify-between">
          <View>
            <Text className="text-3xl font-bold text-foreground">AI Assistant</Text>
            {isChatAuthenticated && (
              <Text className="text-muted text-sm mt-1">
                {conversations.length === 0
                  ? 'No conversations yet'
                  : `${conversations.length} conversation${conversations.length !== 1 ? 's' : ''}`}
              </Text>
            )}
          </View>
          {isModelLoaded && (
            <Pressable
              onPress={() => setShowConfigDialog(true)}
              className="p-2 active:opacity-70"
            >
              <Ionicons name="settings-outline" size={20} color={themeMuted} />
            </Pressable>
          )}
        </View>
      </View>

      {isChatAuthenticated ? (
        <>
          {/* Model banner → navigates to models page */}
          <ModelDownloadBanner
            models={models}
            modelStates={modelStates}
            loadedModelId={loadedModelId}
            isModelLoading={isModelLoading}
            onManage={() => router.push('/models')}
          />

          {/* Conversation list */}
          {conversations.length === 0 ? (
            <View className="flex-1 items-center justify-center px-6">
              <View className="w-20 h-20 rounded-full bg-surface items-center justify-center mb-5">
                <Ionicons name="chatbubble-ellipses-outline" size={40} color={themeAccent} />
              </View>
              <Text className="text-xl font-bold text-foreground text-center">Start a conversation</Text>
              <Text className="text-muted text-center mt-2 leading-5">
                {!isModelLoaded
                  ? 'Load an AI model above, then tap the compose button to begin.'
                  : 'Tap the compose button to start chatting with the AI.'}
              </Text>
            </View>
          ) : (
            <FlashList
              data={conversations}
              keyExtractor={(item) => item.id}
              estimatedItemSize={64}
              renderItem={({ item, index }) => (
                <View>
                  <ConversationRow
                    conversation={item}
                    onPress={() => router.push({ pathname: '/chat/[id]', params: { id: item.id } })}
                    onLongPress={async () => {
                      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                      setConvToDelete(item);
                    }}
                  />
                  {index < conversations.length - 1 && (
                    <View className="ml-16 mr-4 h-px bg-background" />
                  )}
                </View>
              )}
              contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 120 }}
            />
          )}

          {/* FAB */}
          <View className="absolute bottom-8 right-6">
            <Pressable
              onPress={handleNewChat}
              disabled={isCreating}
              style={{ backgroundColor: themeAccent, opacity: isCreating ? 0.6 : 1 }}
              className="w-14 h-14 rounded-full items-center justify-center shadow-lg"
            >
              <Ionicons name="create-outline" size={24} color={themeAccentForeground} />
            </Pressable>
          </View>
        </>
      ) : (
        <View className="flex-1 items-center justify-center px-6">
          <View className="w-20 h-20 rounded-full bg-surface items-center justify-center mb-5">
            <Ionicons name="lock-closed" size={36} color={themeMuted} />
          </View>
          <Text className="text-xl font-bold text-foreground text-center">AI Chat is locked</Text>
          <Text className="text-muted text-center mt-2 leading-5">
            Authenticate to access your conversations
          </Text>
          <Button variant="primary" size="md" onPress={() => setShowAuthDialog(true)} className="mt-6">
            <Button.Label>Unlock</Button.Label>
          </Button>
        </View>
      )}

      {/* Auth dialog */}
      <BiometricAuth
        isOpen={showAuthDialog}
        onOpenChange={setShowAuthDialog}
        onSuccess={handleAuthSuccess}
        promptMessage="Authenticate to access AI Chat"
      />

      {/* Configure dialog */}
      <Dialog isOpen={showConfigDialog} onOpenChange={(open) => { if (!open) setShowConfigDialog(false); }}>
        <Dialog.Portal>
          <Dialog.Overlay />
          <Dialog.Content>
            <Dialog.Title>Model settings</Dialog.Title>
            <Dialog.Description>Adjust how the AI behaves during generation.</Dialog.Description>
            <View style={{ backgroundColor: themeSurface }} className="rounded-xl px-4 py-3 mt-3 flex-row items-center justify-between">
              <View className="flex-1 mr-4">
                <Text className="text-foreground font-semibold text-sm">Thinking</Text>
                <Text className="text-muted text-xs mt-0.5">
                  Model reasons before responding. Slower but more accurate.
                </Text>
              </View>
              <HeroSwitch isSelected={thinkingEnabled} onSelectedChange={setThinkingEnabled} className="w-[50px] h-[28px]">
                <HeroSwitch.Thumb className="w-[24px] h-[24px]" />
              </HeroSwitch>
            </View>
            {/* Max tokens */}
            <View className="mt-3">
              <Text className="text-foreground font-semibold text-sm mb-2">Max response length</Text>
              <View className="flex-row gap-2">
                {MAX_TOKENS_PRESETS.map((preset) => (
                  <Pressable
                    key={preset}
                    onPress={() => setMaxTokens(preset)}
                    style={{
                      flex: 1,
                      backgroundColor: maxTokens === preset ? themeAccent : themeSurface,
                      borderRadius: 10,
                      paddingVertical: 8,
                      alignItems: 'center',
                    }}
                  >
                    <Text
                      style={{ color: maxTokens === preset ? themeAccentForeground : themeMuted }}
                      className="text-xs font-semibold"
                    >
                      {preset}
                    </Text>
                  </Pressable>
                ))}
              </View>
              <Text className="text-muted text-xs mt-1.5">tokens (~{Math.round(maxTokens * 0.75)} words)</Text>
            </View>

            <Button variant="ghost" onPress={() => setShowConfigDialog(false)} className="mt-3">
              <Button.Label>Done</Button.Label>
            </Button>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>

      {/* Delete confirmation dialog */}
      <Dialog isOpen={!!convToDelete} onOpenChange={(open) => { if (!open) setConvToDelete(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay />
          <Dialog.Content>
            <Dialog.Title>Delete conversation?</Dialog.Title>
            <Dialog.Description>
              "{convToDelete?.title}" and all its messages will be permanently deleted.
            </Dialog.Description>
            <View className="gap-3 mt-2">
              <Button variant="danger" onPress={handleDelete}>
                <Button.Label>Delete</Button.Label>
              </Button>
              <Button variant="ghost" onPress={() => setConvToDelete(null)}>
                <Button.Label>Cancel</Button.Label>
              </Button>
            </View>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>
    </View>
  );
}
