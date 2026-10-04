import { View, TextInput, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useThemeColor } from 'heroui-native';
import { useKeyboardState } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface ChatComposerProps {
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
  /** Send is shown whenever there is text; enabled when this is true. */
  canSend: boolean;
  onSend: () => void;
  /** Show the Stop button (a reply is streaming in this conversation). */
  showStop: boolean;
  onStop: () => void;
}

/**
 * Message input. Always editable: while a reply streams both Stop and (with
 * text) Send are shown; sending interrupts the reply and continues with the
 * new message in context.
 */
export function ChatComposer({ value, onChangeText, placeholder, canSend, onSend, showStop, onStop }: ChatComposerProps) {
  const [themeAccent, themeMuted, themeForeground] = useThemeColor(['accent', 'muted', 'foreground']);
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardState((s) => s.isVisible);
  const hasText = value.trim().length > 0;
  const showSend = hasText || !showStop;

  return (
    <View
      style={{ paddingBottom: keyboardVisible ? 8 : Math.max(insets.bottom, 8) }}
      className="px-3 pt-2"
    >
      <View className="flex-row items-end bg-surface rounded-3xl pl-4 pr-1.5 py-1.5 gap-1">
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={themeMuted}
          multiline
          accessibilityLabel="Message"
          style={{
            flex: 1,
            maxHeight: 140,
            minHeight: 36,
            color: themeForeground,
            fontSize: 15,
            paddingTop: 8,
            paddingBottom: 8,
          }}
        />
        {showStop ? (
          <Pressable
            onPress={onStop}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel="Stop generating"
            className="active:opacity-70"
          >
            <Ionicons name="stop-circle" size={34} color={themeAccent} />
          </Pressable>
        ) : null}
        {showSend ? (
          <Pressable
            onPress={onSend}
            disabled={!canSend}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel={showStop ? 'Send and interrupt the reply' : 'Send'}
            accessibilityState={{ disabled: !canSend }}
            className="active:opacity-70"
          >
            <Ionicons name="arrow-up-circle" size={34} color={canSend ? themeAccent : themeMuted} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
