import { useState, useEffect } from 'react';
import { View, Text, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useThemeColor } from 'heroui-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  withSequence,
  Easing,
} from 'react-native-reanimated';
import { MarkdownRenderer } from './MarkdownRenderer';

/** Animated "Thinking..." indicator with pulsing dots — tap to expand live thinking text. */
export function ThinkingIndicator({ thinkingText }: { thinkingText?: string }) {
  const [themeMuted, themeAccent, themeSurfaceSecondary] = useThemeColor([
    'muted', 'accent', 'surface-secondary',
  ]);
  const opacity = useSharedValue(1);
  const [dotCount, setDotCount] = useState(3);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    opacity.value = withRepeat(
      withSequence(
        withTiming(0.3, { duration: 600, easing: Easing.inOut(Easing.ease) }),
        withTiming(1, { duration: 600, easing: Easing.inOut(Easing.ease) }),
      ),
      -1,
      false,
    );
  }, [opacity]);

  useEffect(() => {
    const interval = setInterval(() => {
      setDotCount((prev) => (prev % 3) + 1);
    }, 500);
    return () => clearInterval(interval);
  }, []);

  const animStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));
  const dots = '.'.repeat(dotCount);

  return (
    <View className="mb-1.5">
      <Pressable
        onPress={() => setExpanded((prev) => !prev)}
        className="flex-row items-center gap-1.5 py-1"
      >
        <Animated.View style={animStyle} className="flex-row items-center gap-2">
          <Ionicons name="sparkles-outline" size={14} color={themeAccent} />
          <Text style={{ color: themeMuted }} className="text-xs font-medium">
            Thinking{dots}
          </Text>
        </Animated.View>
        <Ionicons
          name={expanded ? 'chevron-up' : 'chevron-down'}
          size={12}
          color={themeMuted}
        />
      </Pressable>
      {expanded && thinkingText ? (
        <View
          style={{ backgroundColor: themeSurfaceSecondary }}
          className="rounded-lg px-3 py-2 mt-1"
        >
          <MarkdownRenderer content={thinkingText} isStreaming />
        </View>
      ) : null}
    </View>
  );
}

/** Completed (or truncated) thinking block — tap to expand/collapse. */
export function ThinkingCollapsible({ content, truncated }: { content: string; truncated?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [themeMuted, themeAccent, themeSurfaceSecondary] = useThemeColor([
    'muted', 'accent', 'surface-secondary',
  ]);

  return (
    <View className="mb-1.5">
      <Pressable
        onPress={() => setExpanded((prev) => !prev)}
        className="flex-row items-center gap-1.5 py-1"
      >
        <Ionicons name="sparkles-outline" size={14} color={themeAccent} />
        <Text style={{ color: themeMuted }} className="text-xs font-medium">
          {truncated ? 'Thinking was cut off' : 'Thought for a moment'}
        </Text>
        <Ionicons
          name={expanded ? 'chevron-up' : 'chevron-down'}
          size={12}
          color={themeMuted}
        />
      </Pressable>
      {expanded && (
        <View
          style={{ backgroundColor: themeSurfaceSecondary }}
          className="rounded-lg px-3 py-2 mt-1"
        >
          <MarkdownRenderer content={content} />
        </View>
      )}
    </View>
  );
}
