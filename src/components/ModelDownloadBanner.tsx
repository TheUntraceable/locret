import { View, Text, Pressable, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useThemeColor } from 'heroui-native';
import type { ModelDefinition, ModelId, ModelState } from '../types';
import { formatDownloadDetails } from '../utils/modelManager';

interface Props {
  models: ModelDefinition[];
  modelStates: Record<ModelId, ModelState>;
  loadedModelId: ModelId | null;
  isModelLoading: boolean;
  onManage: () => void;
}

export function ModelDownloadBanner({ models, modelStates, loadedModelId, isModelLoading, onManage }: Props) {
  const [themeAccent, themeMuted, themeWarning] = useThemeColor(['accent', 'muted', 'warning']);

  const downloadingModel = models.find((m) => modelStates[m.id]?.status === 'downloading');
  const pausedModel = models.find((m) => modelStates[m.id]?.status === 'paused');
  const loadedModel = loadedModelId ? models.find((m) => m.id === loadedModelId) : null;
  const anyDownloaded = models.some((m) => modelStates[m.id]?.status === 'downloaded');

  const renderLeft = () => {
    if (isModelLoading) {
      return (
        <>
          <ActivityIndicator size="small" color={themeAccent} style={{ marginRight: 12 }} />
          <View className="flex-1">
            <Text className="text-foreground font-semibold text-sm">Loading model…</Text>
            <Text style={{ color: themeWarning }} className="text-xs mt-0.5">This may take a moment</Text>
          </View>
        </>
      );
    }

    if (loadedModel) {
      return (
        <>
          <View className="w-2 h-2 rounded-full bg-success mr-3 mt-0.5" />
          <View className="flex-1">
            <Text className="text-foreground font-semibold text-sm">
              {loadedModel.name} loaded
            </Text>
            <Text style={{ color: themeMuted }} className="text-xs mt-0.5">Tap to manage models</Text>
          </View>
        </>
      );
    }

    if (downloadingModel) {
      const state = modelStates[downloadingModel.id];
      const pct = state.totalBytes ? ` ${Math.round(state.progress * 100)}%` : '';
      return (
        <>
          <Ionicons name="cloud-download-outline" size={20} color={themeAccent} style={{ marginRight: 12 }} />
          <View className="flex-1">
            <Text className="text-foreground font-semibold text-sm" numberOfLines={1}>
              Downloading {downloadingModel.name}…{pct}
            </Text>
            <Text style={{ color: themeMuted }} className="text-xs mt-0.5" numberOfLines={1}>
              {formatDownloadDetails(state)}
            </Text>
          </View>
        </>
      );
    }

    if (pausedModel) {
      const state = modelStates[pausedModel.id];
      const pct = state.totalBytes ? ` at ${Math.round(state.progress * 100)}%` : '';
      return (
        <>
          <Ionicons name="pause-circle-outline" size={20} color={themeWarning} style={{ marginRight: 12 }} />
          <View className="flex-1">
            <Text className="text-foreground font-semibold text-sm" numberOfLines={1}>
              {pausedModel.name} paused{pct}
            </Text>
            <Text style={{ color: themeMuted }} className="text-xs mt-0.5" numberOfLines={1}>
              {state.errorMessage ?? 'Tap to resume or manage'}
            </Text>
          </View>
        </>
      );
    }

    if (anyDownloaded) {
      return (
        <>
          <Ionicons name="cube-outline" size={20} color={themeAccent} style={{ marginRight: 12 }} />
          <View className="flex-1">
            <Text className="text-foreground font-semibold text-sm">Model ready</Text>
            <Text style={{ color: themeMuted }} className="text-xs mt-0.5">Tap to load or manage</Text>
          </View>
        </>
      );
    }

    return (
      <>
        <Ionicons name="cloud-download-outline" size={20} color={themeAccent} style={{ marginRight: 12 }} />
        <View className="flex-1">
          <Text className="text-foreground font-semibold text-sm">No model installed</Text>
          <Text style={{ color: themeMuted }} className="text-xs mt-0.5">Tap to browse and download</Text>
        </View>
      </>
    );
  };

  return (
    <Pressable
      onPress={onManage}
      className="mx-5 mb-4 bg-surface rounded-xl p-4 flex-row items-center active:opacity-70"
    >
      {renderLeft()}
      <Ionicons name="chevron-forward" size={16} color={themeMuted} />
    </Pressable>
  );
}
