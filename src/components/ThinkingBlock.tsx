import { memo, useEffect, useState, type ReactNode } from 'react';
import { View, Text, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useThemeColor } from 'heroui-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { ChunkedMarkdown } from './chat/ChunkedMarkdown';
import { formatDuration } from './chat/format';

interface ThinkingBlockProps {
  /** Message id: keeps the expanded state with its message when list cells are recycled. */
  messageId: string;
  /** Thinking text so far (`message.reasoning`, or `streamingReasoning` while streaming). */
  reasoning: string;
  /** The model is currently writing reasoning (`isStreamingReasoning`). */
  isThinking: boolean;
  /** Wall-clock duration of the turn, when stats exist. */
  durationMs?: number;
  /** The turn ended before the model finished thinking (no answer was written). */
  stopped?: boolean;
}

/** Pulses its children's opacity while `active`. */
function Pulse({ active, children }: { active: boolean; children: ReactNode }) {
  const opacity = useSharedValue(1);

  useEffect(() => {
    if (active) {
      opacity.value = withRepeat(
        withSequence(
          withTiming(0.35, { duration: 700, easing: Easing.inOut(Easing.ease) }),
          withTiming(1, { duration: 700, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
        false,
      );
    } else {
      cancelAnimation(opacity);
      opacity.value = withTiming(1, { duration: 150 });
    }
    return () => cancelAnimation(opacity);
  }, [active, opacity]);

  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View style={style} className="flex-row items-center gap-1.5">
      {children}
    </Animated.View>
  );
}

/**
 * Collapsible reasoning for an assistant message. Collapsed by default; while
 * the model is thinking the header pulses ("Thinking…") and can be expanded to
 * follow the reasoning live.
 */
export const ThinkingBlock = memo(function ThinkingBlock({
  messageId,
  reasoning,
  isThinking,
  durationMs,
  stopped,
}: ThinkingBlockProps) {
  const [themeMuted, themeBorder] = useThemeColor(['muted', 'border']);
  // Keyed by message id: list cells are recycled across messages.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const expanded = expandedId === messageId;
  const hasText = reasoning.trim().length > 0;

  let label: string;
  if (isThinking) label = 'Thinking…';
  else if (stopped) label = 'Thinking stopped';
  else if (durationMs && durationMs > 0) label = `Thought for ${formatDuration(durationMs)}`;
  else label = 'Thoughts';

  return (
    <View className="mb-2">
      <Pressable
        onPress={() => setExpandedId(expanded ? null : messageId)}
        disabled={!hasText}
        hitSlop={6}
        className="flex-row items-center gap-1.5 self-start py-1 active:opacity-70"
        accessibilityRole="button"
        accessibilityState={{ expanded }}
      >
        <Pulse active={isThinking}>
          <Ionicons name="sparkles-outline" size={13} color={themeMuted} />
          <Text style={{ color: themeMuted }} className="text-xs font-medium">
            {label}
          </Text>
        </Pulse>
        {hasText ? (
          <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={12} color={themeMuted} />
        ) : null}
      </Pressable>
      {expanded && hasText ? (
        <View style={{ borderLeftColor: themeBorder }} className="border-l-2 pl-3 mt-1">
          <ChunkedMarkdown content={reasoning} tone="muted" />
        </View>
      ) : null}
    </View>
  );
});
