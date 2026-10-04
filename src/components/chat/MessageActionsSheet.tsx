import { useState } from 'react';
import { View, Text, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BottomSheet, Button, Separator, useThemeColor } from 'heroui-native';
import type { ChatMessage } from '../../types';

interface MessageActionsSheetProps {
  isOpen: boolean;
  /** The long-pressed message (kept while the sheet animates closed). */
  message: ChatMessage | null;
  onClose: () => void;
  /** Visible text right now (the live text for a streaming message). */
  copyText: string;
  canRegenerate: boolean;
  onCopy: () => void;
  onRegenerate: () => void;
  onDelete: () => void;
}

function Action({
  icon,
  label,
  onPress,
  danger,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  danger?: boolean;
}) {
  const [themeAccent, themeDanger] = useThemeColor(['accent', 'danger']);
  return (
    <Pressable onPress={onPress} className="flex-row items-center gap-3 py-3 px-1 active:opacity-70">
      <Ionicons name={icon} size={20} color={danger ? themeDanger : themeAccent} />
      <Text className="text-base text-foreground" style={danger ? { color: themeDanger } : undefined}>
        {label}
      </Text>
    </Pressable>
  );
}

/** Long-press actions for a chat message (same pattern as the secret sheet in project/[id]). */
export function MessageActionsSheet({
  isOpen,
  message,
  onClose,
  copyText,
  canRegenerate,
  onCopy,
  onRegenerate,
  onDelete,
}: MessageActionsSheetProps) {
  // Keyed by message id so a new long-press never opens on the confirmation step.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const confirmingDelete = !!message && confirmDeleteId === message.id;
  const preview = (copyText || message?.reasoning || '').replace(/\s+/g, ' ').trim();

  return (
    <BottomSheet
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) {
          setConfirmDeleteId(null);
          onClose();
        }
      }}
    >
      <BottomSheet.Portal>
        <BottomSheet.Overlay />
        <BottomSheet.Content enableDynamicSizing>
          {message ? (
            <View className="px-5 pb-6">
              <View className="flex-row items-center justify-between mb-1">
                <BottomSheet.Title>{message.role === 'user' ? 'Your message' : 'Reply'}</BottomSheet.Title>
                <BottomSheet.Close />
              </View>
              {preview ? (
                <BottomSheet.Description numberOfLines={2}>{preview}</BottomSheet.Description>
              ) : null}

              <Separator className="my-4" />

              {confirmingDelete ? (
                <View className="gap-3">
                  <Text className="text-sm text-muted">
                    Delete this message? This cannot be undone.
                  </Text>
                  <View className="flex-row gap-3">
                    <Button variant="ghost" size="md" onPress={() => setConfirmDeleteId(null)} className="flex-1">
                      <Button.Label>Cancel</Button.Label>
                    </Button>
                    <Button
                      variant="danger"
                      size="md"
                      onPress={() => {
                        setConfirmDeleteId(null);
                        onDelete();
                      }}
                      className="flex-1"
                    >
                      <Ionicons name="trash-outline" size={16} />
                      <Button.Label>Delete</Button.Label>
                    </Button>
                  </View>
                </View>
              ) : (
                <View className="gap-1">
                  {copyText.trim() ? <Action icon="copy-outline" label="Copy" onPress={onCopy} /> : null}
                  {canRegenerate ? <Action icon="reload" label="Regenerate" onPress={onRegenerate} /> : null}
                  <Separator className="my-1" />
                  <Action icon="trash-outline" label="Delete" danger onPress={() => setConfirmDeleteId(message.id)} />
                </View>
              )}
            </View>
          ) : null}
        </BottomSheet.Content>
      </BottomSheet.Portal>
    </BottomSheet>
  );
}
