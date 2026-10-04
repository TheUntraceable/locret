import { useState } from 'react';
import { View, Text, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Button, useThemeColor } from 'heroui-native';
import { BiometricAuth } from '../BiometricAuth';

interface ChatLockedViewProps {
  onBack: () => void;
  /** Called after biometric/PIN success; should load the chat key. */
  onUnlocked: () => void | Promise<void>;
}

/**
 * Shown when the chat locks while a conversation is open (background grace
 * expired). Unlocking here keeps the user in the conversation.
 */
export function ChatLockedView({ onBack, onUnlocked }: ChatLockedViewProps) {
  const [themeAccent, themeMuted] = useThemeColor(['accent', 'muted']);
  const [showAuth, setShowAuth] = useState(false);

  return (
    <View className="flex-1 bg-background">
      <View className="flex-row items-center px-4 pt-14 pb-3">
        <Pressable onPress={onBack} className="p-1" accessibilityLabel="Back">
          <Ionicons name="chevron-back" size={24} color={themeAccent} />
        </Pressable>
      </View>
      <View className="flex-1 items-center justify-center px-6 pb-20">
        <View className="w-20 h-20 rounded-full bg-surface items-center justify-center mb-5">
          <Ionicons name="lock-closed" size={36} color={themeMuted} />
        </View>
        <Text className="text-xl font-bold text-foreground text-center">Chat locked</Text>
        <Text className="text-muted text-center mt-2 leading-5">
          The app was in the background for a while, so your conversations were locked. Unlock to pick up where you
          left off.
        </Text>
        <Button variant="primary" size="md" onPress={() => setShowAuth(true)} className="mt-6">
          <Button.Label>Unlock</Button.Label>
        </Button>
        <Button variant="ghost" size="md" onPress={onBack} className="mt-2">
          <Button.Label>Back to chats</Button.Label>
        </Button>
      </View>
      <BiometricAuth
        isOpen={showAuth}
        onOpenChange={setShowAuth}
        onSuccess={onUnlocked}
        promptMessage="Authenticate to access AI Chat"
      />
    </View>
  );
}
