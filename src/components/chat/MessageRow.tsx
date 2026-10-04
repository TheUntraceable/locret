import { memo, useEffect } from 'react';
import { View, Text, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useThemeColor } from 'heroui-native';
import Animated, {
  Easing,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { ThinkingBlock } from '../ThinkingBlock';
import { ChunkedMarkdown } from './ChunkedMarkdown';
import { formatStats } from './format';
import type { ChatItem, TurnAction, TurnFooter } from './types';

const LONG_PRESS_MS = 350;

function Dot({ progress, offset, color }: { progress: SharedValue<number>; offset: number; color: string }) {
  const style = useAnimatedStyle(() => {
    const phase = (progress.value + offset) % 1;
    return { opacity: interpolate(phase, [0, 0.5, 1], [0.25, 1, 0.25]) };
  });
  return <Animated.View style={[{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }, style]} />;
}

/** Shown while a reply has started but no text has arrived yet (prompt processing). */
function TypingDots() {
  const [themeMuted] = useThemeColor(['muted']);
  const progress = useSharedValue(0);
  useEffect(() => {
    progress.value = withRepeat(withTiming(1, { duration: 1100, easing: Easing.linear }), -1, false);
  }, [progress]);
  return (
    <View className="flex-row items-center gap-1.5 py-2" accessibilityLabel="Generating reply">
      <Dot progress={progress} offset={0} color={themeMuted} />
      <Dot progress={progress} offset={0.66} color={themeMuted} />
      <Dot progress={progress} offset={0.33} color={themeMuted} />
    </View>
  );
}

function Chip({
  icon,
  label,
  onPress,
  disabled,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const [themeForeground] = useThemeColor(['foreground']);
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={4}
      style={{ opacity: disabled ? 0.5 : 1 }}
      className="flex-row items-center gap-1 bg-surface rounded-full px-3 py-1.5 active:opacity-70"
    >
      <Ionicons name={icon} size={13} color={themeForeground} />
      <Text className="text-foreground text-xs font-semibold">{label}</Text>
    </Pressable>
  );
}

function IconAction({
  icon,
  label,
  onPress,
  disabled,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const [themeMuted] = useThemeColor(['muted']);
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      accessibilityLabel={label}
      style={{ opacity: disabled ? 0.5 : 1 }}
      className="p-1.5 active:opacity-60"
    >
      <Ionicons name={icon} size={15} color={themeMuted} />
    </Pressable>
  );
}

function AssistantFooter({ footer, hasContent }: { footer: TurnFooter; hasContent: boolean }) {
  const [themeMuted, themeDanger] = useThemeColor(['muted', 'danger']);
  const { status, busy, onAction } = footer;
  const act = (a: TurnAction) => () => onAction(a);

  return (
    <View className="mt-1 gap-2">
      {status.kind === 'error' ? (
        <View className="flex-row items-start gap-1.5">
          <Ionicons name="alert-circle-outline" size={14} color={themeDanger} style={{ marginTop: 1 }} />
          <Text style={{ color: themeDanger }} className="text-xs leading-4 flex-1">
            {status.text}
          </Text>
        </View>
      ) : null}
      <View className="flex-row items-center gap-1">
        {status.kind === 'incomplete' ? (
          <View className="flex-row items-center gap-2 mr-1">
            <Text style={{ color: themeMuted }} className="text-xs">
              {status.label}
            </Text>
            <Chip icon="play-forward" label="Continue" onPress={act('continue')} disabled={busy} />
          </View>
        ) : null}
        {status.kind === 'error' ? (
          <View className="mr-1">
            <Chip icon="refresh" label="Retry" onPress={act('retry')} disabled={busy} />
          </View>
        ) : null}
        {hasContent ? <IconAction icon="copy-outline" label="Copy" onPress={act('copy')} /> : null}
        <IconAction icon="reload" label="Regenerate" onPress={act('regenerate')} disabled={busy} />
      </View>
    </View>
  );
}

const UserMessage = memo(function UserMessage({
  item,
  footer,
  onLongPress,
}: {
  item: ChatItem;
  footer?: TurnFooter;
  onLongPress: (item: ChatItem) => void;
}) {
  const [themeAccentForeground, themeMuted] = useThemeColor(['accent-foreground', 'muted']);
  return (
    <View className="items-end mb-3 px-4">
      <Pressable
        onLongPress={item.optimistic ? undefined : () => onLongPress(item)}
        delayLongPress={LONG_PRESS_MS}
        className="bg-accent rounded-2xl rounded-tr-sm px-4 py-2.5 max-w-[85%] active:opacity-80"
      >
        <Text style={{ color: themeAccentForeground }} className="text-sm leading-5">
          {item.message.content}
        </Text>
      </Pressable>
      {footer?.status.kind === 'no-reply' ? (
        <View className="flex-row items-center gap-2 mt-2">
          <Text style={{ color: themeMuted }} className="text-xs">
            No reply
          </Text>
          <Chip
            icon="refresh"
            label="Generate"
            onPress={() => footer.onAction('regenerate')}
            disabled={footer.busy}
          />
        </View>
      ) : null}
    </View>
  );
});

const AssistantMessage = memo(function AssistantMessage({
  item,
  footer,
  onLongPress,
}: {
  item: ChatItem;
  footer?: TurnFooter;
  onLongPress: (item: ChatItem) => void;
}) {
  const [themeMuted] = useThemeColor(['muted']);
  const { message, live, thinking } = item;
  const reasoning = message.reasoning ?? '';
  const hasContent = message.content.trim().length > 0;
  const hasReasoning = reasoning.trim().length > 0;
  const settled = !live && !item.stale;
  // The turn ended (stopped, cut off, error) while the model was still thinking.
  const stoppedThinking =
    settled && !hasContent && hasReasoning && !!message.finishReason && message.finishReason !== 'stop';

  return (
    <View className="mb-4 px-4">
      <Pressable onLongPress={() => onLongPress(item)} delayLongPress={LONG_PRESS_MS}>
        {hasReasoning || thinking ? (
          <ThinkingBlock
            messageId={message.id}
            reasoning={reasoning}
            isThinking={thinking}
            durationMs={hasReasoning && settled ? message.stats?.durationMs : undefined}
            stopped={stoppedThinking}
          />
        ) : null}
        {hasContent ? <ChunkedMarkdown content={message.content} /> : null}
        {live && !hasContent && !thinking ? <TypingDots /> : null}
      </Pressable>
      {settled && message.stats ? (
        <Text style={{ color: themeMuted }} className="text-[11px] mt-0.5" numberOfLines={1}>
          {formatStats(message.stats)}
        </Text>
      ) : null}
      {footer && footer.status.kind !== 'no-reply' ? <AssistantFooter footer={footer} hasContent={hasContent} /> : null}
    </View>
  );
});

/** A chat list row. Memo'd: only the streaming row and the last row re-render while a reply streams. */
export const MessageRow = memo(function MessageRow({
  item,
  footer,
  onLongPress,
}: {
  item: ChatItem;
  /** Only passed to the last row. */
  footer?: TurnFooter;
  onLongPress: (item: ChatItem) => void;
}) {
  return item.message.role === 'user' ? (
    <UserMessage item={item} footer={footer} onLongPress={onLongPress} />
  ) : (
    <AssistantMessage item={item} footer={footer} onLongPress={onLongPress} />
  );
});
