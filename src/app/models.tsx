import { View, Text, Pressable, ScrollView, ActivityIndicator, TextInput } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useThemeColor, Dialog, Button } from 'heroui-native';
import Animated, { useSharedValue, withTiming, useAnimatedStyle } from 'react-native-reanimated';
import { useEffect, useState } from 'react';
import { useChat } from '../context/ChatContext';
import type { ModelDefinition, ModelState } from '../types';

const EMPTY_STATE: ModelState = { status: 'not_downloaded', progress: 0, errorMessage: null };

function ProgressBar({ progress }: { progress: number }) {
  const [themeAccent] = useThemeColor(['accent']);
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
        style={[animStyle, { height: '100%', borderRadius: 999, backgroundColor: themeAccent }]}
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

function ModelCard({ model }: { model: ModelDefinition }) {
  const [themeAccent, themeMuted, themeDanger, themeAccentForeground, themeSurface, themeWarning] =
    useThemeColor(['accent', 'muted', 'danger', 'accent-foreground', 'surface', 'warning']);

  const {
    modelStates,
    loadedModelId,
    isModelLoading,
    startModelDownload,
    cancelModelDownload,
    initModel,
    unloadModel,
    deleteModel,
  } = useChat();

  const state = modelStates[model.id] ?? EMPTY_STATE;
  const isLoaded = loadedModelId === model.id;
  const isLoading = isModelLoading && loadedModelId === null;
  const pct = Math.round(state.progress * 100);
  const removeLabel = model.isCustom ? 'Remove' : 'Uninstall';

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

      {/* Progress bar during download */}
      {state.status === 'downloading' && (
        <ProgressBar progress={state.progress} />
      )}

      {/* Error message */}
      {state.status === 'error' && state.errorMessage && (
        <Text style={{ color: themeDanger }} className="text-xs mt-1" numberOfLines={1}>
          {state.errorMessage}
        </Text>
      )}

      {/* Action buttons */}
      <View className="flex-row gap-2 mt-3 flex-wrap">
        {state.status === 'not_downloaded' && (
          <Pressable
            onPress={() => startModelDownload(model.id)}
            style={{ backgroundColor: themeAccent }}
            className="flex-row items-center gap-1.5 px-3 py-2 rounded-xl"
          >
            <Ionicons name="cloud-download-outline" size={15} color={themeAccentForeground} />
            <Text style={{ color: themeAccentForeground }} className="text-sm font-semibold">
              Download
            </Text>
          </Pressable>
        )}

        {state.status === 'downloading' && (
          <Pressable
            onPress={() => cancelModelDownload(model.id)}
            className="flex-row items-center gap-1.5 px-3 py-2 rounded-xl border border-muted"
          >
            <Ionicons name="close-outline" size={15} color={themeMuted} />
            <Text style={{ color: themeMuted }} className="text-sm font-semibold">
              Cancel ({pct}%)
            </Text>
          </Pressable>
        )}

        {state.status === 'error' && (
          <Pressable
            onPress={() => startModelDownload(model.id)}
            style={{ borderColor: themeDanger, borderWidth: 1 }}
            className="flex-row items-center gap-1.5 px-3 py-2 rounded-xl"
          >
            <Ionicons name="refresh-outline" size={15} color={themeDanger} />
            <Text style={{ color: themeDanger }} className="text-sm font-semibold">Retry</Text>
          </Pressable>
        )}

        {state.status === 'downloaded' && !isLoaded && (
          <Pressable
            onPress={() => initModel(model.id)}
            disabled={isLoading}
            style={{ backgroundColor: themeAccent, opacity: isLoading ? 0.6 : 1 }}
            className="flex-row items-center gap-1.5 px-3 py-2 rounded-xl"
          >
            {isLoading ? (
              <ActivityIndicator size="small" color={themeAccentForeground} />
            ) : (
              <Ionicons name="play-outline" size={15} color={themeAccentForeground} />
            )}
            <Text style={{ color: themeAccentForeground }} className="text-sm font-semibold">
              {isLoading ? 'Loading…' : 'Load'}
            </Text>
          </Pressable>
        )}

        {isLoaded && (
          <Pressable
            onPress={() => unloadModel()}
            className="flex-row items-center gap-1.5 px-3 py-2 rounded-xl border border-muted"
          >
            <Ionicons name="stop-outline" size={15} color={themeMuted} />
            <Text style={{ color: themeMuted }} className="text-sm font-semibold">Unload</Text>
          </Pressable>
        )}

        {/* Remove / Uninstall — also lets you drop a custom model that isn't downloaded */}
        {(state.status === 'downloaded' ||
          state.status === 'error' ||
          (model.isCustom && state.status === 'not_downloaded')) && (
          <Pressable
            onPress={() => deleteModel(model.id)}
            className="flex-row items-center gap-1.5 px-3 py-2 rounded-xl"
            style={{ borderColor: themeDanger, borderWidth: 1 }}
          >
            <Ionicons name="trash-outline" size={15} color={themeDanger} />
            <Text style={{ color: themeDanger }} className="text-sm font-semibold">{removeLabel}</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

export default function ModelsScreen() {
  const router = useRouter();
  const [themeAccent, themeMuted, themeAccentForeground, themeDanger, themeForeground, themeSurface] =
    useThemeColor(['accent', 'muted', 'accent-foreground', 'danger', 'foreground', 'surface']);
  const { models, addCustomModel } = useChat();

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
    const trimmedUrl = url.trim();
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
          <ModelCard key={model.id} model={model} />
        ))}

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
              Paste a direct link to a GGUF model file. It downloads in the background.
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
    </View>
  );
}
