import { View, Text, Pressable, ScrollView, ActivityIndicator, TextInput } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useThemeColor, Dialog, Button } from 'heroui-native';
import Animated, { useSharedValue, withTiming, useAnimatedStyle } from 'react-native-reanimated';
import { useEffect, useState, type ComponentProps } from 'react';
import { useChat } from '../context/ChatContext';
import type { ModelDefinition, ModelState } from '../types';
import { formatBytes, formatDownloadDetails, modelStateOf, normalizeModelUrl } from '../utils/modelManager';

const EMPTY_STATE: ModelState = modelStateOf('not_downloaded');

function ProgressBar({ progress, color }: { progress: number; color: string }) {
  const width = useSharedValue(0);

  useEffect(() => {
    width.value = withTiming(progress, { duration: 200 });
  }, [progress, width]);

  const animStyle = useAnimatedStyle(() => ({
    width: `${width.value * 100}%` as any,
  }));

  return (
    <View className="h-1.5 bg-background rounded-full overflow-hidden mt-2">
      <Animated.View
        style={[animStyle, { height: '100%', borderRadius: 999, backgroundColor: color }]}
      />
    </View>
  );
}

function TagBadge({ label, variant }: { label: string; variant: ModelDefinition['tagVariant'] }) {
  const [themeAccent, themeMuted, themeSuccess] = useThemeColor(['accent', 'muted', 'success']);
  const colorMap = { accent: themeAccent, muted: themeMuted, success: themeSuccess };
  const color = colorMap[variant];

  return (
    <View
      style={{ borderColor: color, borderWidth: 1 }}
      className="px-2 py-0.5 rounded-full self-start"
    >
      <Text style={{ color }} className="text-xs font-semibold">
        {label}
      </Text>
    </View>
  );
}

type ConfirmAction = { kind: 'delete' | 'discard'; model: ModelDefinition };

function ActionButton({
  icon,
  label,
  onPress,
  color,
  filled = false,
  disabled = false,
  busy = false,
}: {
  icon: ComponentProps<typeof Ionicons>['name'];
  label: string;
  onPress: () => void;
  color: string;
  filled?: boolean;
  disabled?: boolean;
  busy?: boolean;
}) {
  const [themeAccent, themeAccentForeground] = useThemeColor(['accent', 'accent-foreground']);
  const fg = filled ? themeAccentForeground : color;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={[
        filled ? { backgroundColor: themeAccent } : { borderColor: color, borderWidth: 1 },
        { opacity: disabled ? 0.6 : 1 },
      ]}
      className="flex-row items-center gap-1.5 px-3 py-2 rounded-xl"
    >
      {busy ? <ActivityIndicator size="small" color={fg} /> : <Ionicons name={icon} size={15} color={fg} />}
      <Text style={{ color: fg }} className="text-sm font-semibold">
        {label}
      </Text>
    </Pressable>
  );
}

function ModelCard({ model, onConfirm }: { model: ModelDefinition; onConfirm: (action: ConfirmAction) => void }) {
  const [themeAccent, themeMuted, themeDanger, themeSurface, themeWarning] = useThemeColor([
    'accent',
    'muted',
    'danger',
    'surface',
    'warning',
  ]);

  const {
    modelStates,
    loadedModelId,
    isModelLoading,
    startModelDownload,
    pauseModelDownload,
    initModel,
    unloadModel,
  } = useChat();

  const state = modelStates[model.id] ?? EMPTY_STATE;
  const isLoaded = loadedModelId === model.id;
  const isLoading = isModelLoading && loadedModelId === null;
  const pct = Math.round(state.progress * 100);
  const removeLabel = model.isCustom ? 'Remove' : 'Uninstall';
  const inProgress = state.status === 'downloading' || state.status === 'paused';
  const messageColor =
    state.status === 'error' ? themeDanger : state.status === 'paused' ? themeWarning : themeMuted;

  return (
    <View style={{ backgroundColor: themeSurface }} className="rounded-2xl p-4 mb-3">
      {/* Header row */}
      <View className="flex-row items-start justify-between mb-2">
        <View className="flex-1 mr-3">
          <View className="flex-row items-center gap-2 mb-1.5 flex-wrap">
            <TagBadge label={model.tag} variant={model.tagVariant} />
            {isLoaded && (
              <View className="flex-row items-center gap-1">
                <View className="w-1.5 h-1.5 rounded-full bg-success" />
                <Text className="text-xs" style={{ color: themeWarning }}>Loaded</Text>
              </View>
            )}
          </View>
          <Text className="text-foreground font-bold text-base">{model.name}</Text>
          <Text className="text-muted text-xs mt-0.5 leading-4">{model.description}</Text>
          {model.isCustom && (
            <Text className="text-muted text-[10px] mt-1 leading-4" numberOfLines={1}>
              {model.url}
            </Text>
          )}
        </View>
        <Text style={{ color: themeMuted }} className="text-xs mt-1">{model.sizeLabel}</Text>
      </View>

      {/* Progress while downloading or paused */}
      {inProgress && (
        <>
          <ProgressBar progress={state.progress} color={state.status === 'paused' ? themeMuted : themeAccent} />
          <Text style={{ color: themeMuted }} className="text-xs mt-1.5">
            {state.status === 'paused' ? `Paused · ${formatDownloadDetails(state)}` : formatDownloadDetails(state)}
          </Text>
        </>
      )}

      {/* Error / status message */}
      {state.errorMessage && state.status !== 'downloaded' && state.status !== 'downloading' && (
        <Text style={{ color: messageColor }} className="text-xs mt-1 leading-4" numberOfLines={3}>
          {state.errorMessage}
        </Text>
      )}

      {/* Action buttons */}
      <View className="flex-row gap-2 mt-3 flex-wrap">
        {state.status === 'not_downloaded' && (
          <ActionButton
            icon="cloud-download-outline"
            label="Download"
            color={themeAccent}
            filled
            onPress={() => startModelDownload(model.id)}
          />
        )}

        {state.status === 'downloading' && (
          <ActionButton
            icon="pause-outline"
            label={state.totalBytes ? `Pause (${pct}%)` : 'Pause'}
            color={themeMuted}
            onPress={() => pauseModelDownload(model.id).catch(console.error)}
          />
        )}

        {state.status === 'paused' && (
          <ActionButton
            icon="play-outline"
            label="Resume"
            color={themeAccent}
            filled
            onPress={() => startModelDownload(model.id)}
          />
        )}

        {inProgress && (
          <ActionButton
            icon="close-outline"
            label="Remove"
            color={themeDanger}
            onPress={() => onConfirm({ kind: 'discard', model })}
          />
        )}

        {state.status === 'error' && (
          <ActionButton
            icon="refresh-outline"
            label="Retry"
            color={themeDanger}
            onPress={() => startModelDownload(model.id)}
          />
        )}

        {state.status === 'downloaded' && !isLoaded && (
          <ActionButton
            icon="play-outline"
            label={isLoading ? 'Loading…' : 'Load'}
            color={themeAccent}
            filled
            busy={isLoading}
            disabled={isLoading}
            onPress={() => initModel(model.id)}
          />
        )}

        {isLoaded && (
          <ActionButton icon="stop-outline" label="Unload" color={themeMuted} onPress={() => unloadModel()} />
        )}

        {/* Remove / Uninstall — also lets you drop a custom model that isn't downloaded */}
        {(state.status === 'downloaded' ||
          state.status === 'error' ||
          (model.isCustom && state.status === 'not_downloaded')) && (
          <ActionButton
            icon="trash-outline"
            label={removeLabel}
            color={themeDanger}
            onPress={() => onConfirm({ kind: 'delete', model })}
          />
        )}
      </View>
    </View>
  );
}

function confirmCopy({ kind, model }: ConfirmAction, state: ModelState) {
  if (kind === 'discard') {
    return {
      title: 'Discard download?',
      body: `This deletes the ${formatBytes(state.bytesWritten)} of ${model.name} downloaded so far. You'll have to start over.`,
      action: 'Discard',
    };
  }
  const file = state.status === 'downloaded' ? ` (${formatBytes(state.bytesWritten)})` : '';
  return model.isCustom
    ? {
        title: `Remove ${model.name}?`,
        body: `This removes the model from the list and deletes its file${file}.`,
        action: 'Remove',
      }
    : {
        title: `Uninstall ${model.name}?`,
        body: `This deletes the downloaded file${file}. You can download it again later.`,
        action: 'Uninstall',
      };
}

export default function ModelsScreen() {
  const router = useRouter();
  const [themeAccent, themeMuted, themeAccentForeground, themeDanger, themeForeground, themeSurface] =
    useThemeColor(['accent', 'muted', 'accent-foreground', 'danger', 'foreground', 'surface']);
  const { models, modelStates, addCustomModel, deleteModel, discardModelDownload } = useChat();
  // `confirm` outlives `confirmOpen` so the dialog keeps its text while closing.
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const requestConfirm = (action: ConfirmAction) => {
    setConfirm(action);
    setConfirmOpen(true);
  };

  const [showAddDialog, setShowAddDialog] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);

  const resetForm = () => {
    setName('');
    setUrl('');
    setError(null);
  };

  const handleAdd = () => {
    const trimmedName = name.trim();
    // Hugging Face page links (/blob/) become download links (/resolve/).
    const trimmedUrl = normalizeModelUrl(url);
    if (!trimmedName) {
      setError('Give the model a name.');
      return;
    }
    if (!/^https?:\/\/.+/i.test(trimmedUrl)) {
      setError('Enter a valid download URL (https://…).');
      return;
    }
    if (!/\.gguf(\?.*)?$/i.test(trimmedUrl)) {
      setError('URL should point to a .gguf model file.');
      return;
    }
    addCustomModel(trimmedName, trimmedUrl);
    setShowAddDialog(false);
    resetForm();
  };

  // Bytes on disk: finished files plus partial downloads.
  const storageUsed = models.reduce((sum, m) => {
    const st = modelStates[m.id];
    return st && st.status !== 'not_downloaded' && st.status !== 'error' ? sum + st.bytesWritten : sum;
  }, 0);

  const confirmState = confirm ? (modelStates[confirm.model.id] ?? EMPTY_STATE) : null;
  const copy = confirm && confirmState ? confirmCopy(confirm, confirmState) : null;

  const handleConfirm = () => {
    if (!confirm) return;
    const { kind, model } = confirm;
    setConfirmOpen(false);
    (kind === 'discard' ? discardModelDownload(model.id) : deleteModel(model.id)).catch(console.error);
  };

  return (
    <View className="flex-1 bg-background">
      {/* Header */}
      <View className="flex-row items-center px-4 pt-14 pb-3 gap-3">
        <Pressable onPress={() => router.back()} className="p-1">
          <Ionicons name="chevron-back" size={24} color={themeAccent} />
        </Pressable>
        <View className="flex-1">
          <Text className="text-foreground font-bold text-xl">AI Models</Text>
          <Text className="text-muted text-xs mt-0.5">Download, load, and manage models</Text>
        </View>
        <Pressable
          onPress={() => { resetForm(); setShowAddDialog(true); }}
          style={{ backgroundColor: themeAccent }}
          className="flex-row items-center gap-1 px-3 py-2 rounded-xl active:opacity-80"
        >
          <Ionicons name="add" size={16} color={themeAccentForeground} />
          <Text style={{ color: themeAccentForeground }} className="text-sm font-semibold">Add Model</Text>
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 48 }}
        showsVerticalScrollIndicator={false}
      >
        {models.map((model) => (
          <ModelCard key={model.id} model={model} onConfirm={requestConfirm} />
        ))}

        {storageUsed > 0 && (
          <Text className="text-muted text-xs text-center mt-1 mb-2">
            Storage used by models: {formatBytes(storageUsed)}
          </Text>
        )}

        <Text className="text-muted text-xs text-center mt-2 leading-4">
          Only one model can be loaded at a time. Loading a different model will automatically unload the current one.
        </Text>
      </ScrollView>

      {/* Add custom model dialog */}
      <Dialog isOpen={showAddDialog} onOpenChange={(open) => { if (!open) { setShowAddDialog(false); resetForm(); } }}>
        <Dialog.Portal>
          <Dialog.Overlay />
          <Dialog.Content>
            <Dialog.Title>Add a model</Dialog.Title>
            <Dialog.Description>
              Paste a direct link to a GGUF model file (Hugging Face page links work too). It downloads in the
              background and can be paused.
            </Dialog.Description>

            <View className="mt-3">
              <Text className="text-foreground font-semibold text-sm mb-1.5">Name</Text>
              <TextInput
                value={name}
                onChangeText={(t) => { setName(t); setError(null); }}
                placeholder="My model"
                placeholderTextColor={themeMuted}
                style={{
                  backgroundColor: themeSurface,
                  color: themeForeground,
                  borderRadius: 12,
                  paddingHorizontal: 14,
                  paddingVertical: 12,
                  fontSize: 15,
                }}
              />
            </View>

            <View className="mt-3">
              <Text className="text-foreground font-semibold text-sm mb-1.5">Model URL (.gguf)</Text>
              <TextInput
                value={url}
                onChangeText={(t) => { setUrl(t); setError(null); }}
                placeholder="https://huggingface.co/…/model.gguf"
                placeholderTextColor={themeMuted}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                multiline
                style={{
                  backgroundColor: themeSurface,
                  color: themeForeground,
                  borderRadius: 12,
                  paddingHorizontal: 14,
                  paddingVertical: 12,
                  fontSize: 14,
                  minHeight: 56,
                }}
              />
            </View>

            {error && (
              <Text style={{ color: themeDanger }} className="text-xs mt-2">{error}</Text>
            )}

            <View className="gap-3 mt-4">
              <Button variant="primary" onPress={handleAdd}>
                <Button.Label>Add & Download</Button.Label>
              </Button>
              <Button variant="ghost" onPress={() => { setShowAddDialog(false); resetForm(); }}>
                <Button.Label>Cancel</Button.Label>
              </Button>
            </View>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>

      {/* Delete / discard confirmation */}
      <Dialog isOpen={confirmOpen} onOpenChange={setConfirmOpen}>
        <Dialog.Portal>
          <Dialog.Overlay />
          <Dialog.Content>
            <View className="gap-4">
              <View className="flex-row items-center justify-between">
                <Dialog.Title>{copy?.title}</Dialog.Title>
                <Dialog.Close variant="ghost" />
              </View>
              <Dialog.Description>{copy?.body}</Dialog.Description>
              <View className="flex-row gap-3 justify-end">
                <Button variant="ghost" size="sm" onPress={() => setConfirmOpen(false)}>
                  <Button.Label>Cancel</Button.Label>
                </Button>
                <Button variant="danger" size="sm" onPress={handleConfirm}>
                  <Button.Label>{copy?.action ?? 'Delete'}</Button.Label>
                </Button>
              </View>
            </View>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>
    </View>
  );
}
