import { View, Text, Pressable, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Button, Dialog, useThemeColor } from 'heroui-native';
import type { ModelDefinition } from '../../types';

interface ModelPickerDialogProps {
  isOpen: boolean;
  onClose: () => void;
  models: ModelDefinition[];
  loadedModelId: string | null;
  loadingModelId: string | null;
  /** Switching models stops a running reply. */
  isGenerating: boolean;
  onSelect: (id: string) => void;
  onManage: () => void;
}

export function ModelPickerDialog({
  isOpen,
  onClose,
  models,
  loadedModelId,
  loadingModelId,
  isGenerating,
  onSelect,
  onManage,
}: ModelPickerDialogProps) {
  const [themeAccent, themeMuted] = useThemeColor(['accent', 'muted']);

  return (
    <Dialog isOpen={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content>
          <Dialog.Title>Select model</Dialog.Title>
          <Dialog.Description>
            {isGenerating
              ? 'Switching models stops the current reply.'
              : 'Choose a downloaded model to load for this chat.'}
          </Dialog.Description>

          <View className="mt-3 gap-2">
            {models.length === 0 ? (
              <Text className="text-muted text-sm leading-5">
                No models downloaded yet. Download one from the models screen first.
              </Text>
            ) : (
              models.map((m) => {
                const selected = m.id === loadedModelId;
                const loading = m.id === loadingModelId;
                return (
                  <Pressable
                    key={m.id}
                    onPress={() => onSelect(m.id)}
                    disabled={loading}
                    className="bg-surface rounded-xl px-4 py-3 flex-row items-center justify-between active:opacity-70"
                  >
                    <View className="flex-1 mr-3">
                      <Text className="text-foreground font-semibold text-sm">{m.name}</Text>
                      <Text className="text-muted text-xs mt-0.5">{loading ? 'Loading…' : m.tag}</Text>
                    </View>
                    {loading ? (
                      <ActivityIndicator size="small" color={themeAccent} />
                    ) : selected ? (
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
            <Button variant="ghost" onPress={onManage}>
              <Button.Label>Manage models</Button.Label>
            </Button>
            <Button variant="ghost" onPress={onClose}>
              <Button.Label>Close</Button.Label>
            </Button>
          </View>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog>
  );
}
