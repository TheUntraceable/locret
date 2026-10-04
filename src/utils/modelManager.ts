import {
  documentDirectory,
  getInfoAsync,
  createDownloadResumable,
  deleteAsync,
  FileSystemSessionType,
  type DownloadResumable,
} from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { randomUUID } from 'expo-crypto';
import { initLlama, type LlamaContext } from 'llama.rn';
import type { ModelDefinition } from '../types';

export const MODEL_CATALOG: ModelDefinition[] = [
  {
    id: 'fast',
    name: 'Qwen3.5 2B',
    tag: 'Fast',
    tagVariant: 'success',
    description: 'Smallest and quickest. Best for simple questions and low-end devices.',
    url: 'https://huggingface.co/HauhauCS/Qwen3.5-2B-Uncensored-HauhauCS-Aggressive/resolve/main/Qwen3.5-2B-Uncensored-HauhauCS-Aggressive-Q4_K_M.gguf?download=true',
    filename: 'qwen3.5-2b-q4km.gguf',
    sizeLabel: '~1.5 GB',
  },
  {
    id: 'standard',
    name: 'Qwen3.5 4B',
    tag: 'Standard',
    tagVariant: 'accent',
    description: 'Balanced speed and quality. Recommended for most devices.',
    url: 'https://huggingface.co/HauhauCS/Qwen3.5-4B-Uncensored-HauhauCS-Aggressive/resolve/main/Qwen3.5-4B-Uncensored-HauhauCS-Aggressive-Q4_K_M.gguf?download=true',
    filename: 'qwen3.5-4b-q4km.gguf',
    sizeLabel: '~2.5 GB',
  },
  {
    id: 'legacy',
    name: 'Gemma 4 E4B',
    tag: 'Legacy',
    tagVariant: 'muted',
    description: 'Previous default. May be slower on some devices.',
    url: 'https://huggingface.co/HauhauCS/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive/resolve/main/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-Q4_K_M.gguf',
    filename: 'gemma4b-q4km.gguf',
    sizeLabel: '~2.5 GB',
  },
];

const CUSTOM_MODELS_KEY = 'ai_custom_models';

export function getModelPath(def: ModelDefinition): string {
  return `${documentDirectory}${def.filename}`;
}

export async function isModelFileDownloaded(def: ModelDefinition): Promise<boolean> {
  const info = await getInfoAsync(getModelPath(def));
  return info.exists;
}

export function startDownload(
  def: ModelDefinition,
  onProgress: (progress: number) => void,
): DownloadResumable {
  return createDownloadResumable(
    def.url,
    getModelPath(def),
    { sessionType: FileSystemSessionType.BACKGROUND },
    ({ totalBytesWritten, totalBytesExpectedToWrite }) => {
      if (totalBytesExpectedToWrite > 0) {
        onProgress(totalBytesWritten / totalBytesExpectedToWrite);
      }
    },
  );
}

/**
 * Context window requested for every model. The chat engine trims history to
 * fit `effective context - n_predict - margin` (see generationEngine.ts).
 */
export const MODEL_N_CTX = 4096;

const BASE_CONTEXT_PARAMS = {
  n_ctx: MODEL_N_CTX,
  // One sequence only: llama.cpp splits n_ctx across n_parallel sequences when
  // the KV cache isn't unified, and we never use llama.rn's parallel mode.
  n_parallel: 1,
  use_mlock: true,
} as const;

/**
 * Loads a GGUF model. Tries GPU offload first; initLlama throws ("Failed to
 * load model") rather than silently falling back when GPU init fails (e.g. an
 * OpenCL/Metal allocation failure), so retry once CPU-only.
 */
export async function loadModel(def: ModelDefinition): Promise<LlamaContext> {
  const model = getModelPath(def);
  try {
    return await initLlama({ model, ...BASE_CONTEXT_PARAMS, n_gpu_layers: 99 });
  } catch (gpuError) {
    console.warn(`GPU load failed for ${def.id}, retrying on CPU:`, gpuError);
    return initLlama({ model, ...BASE_CONTEXT_PARAMS, n_gpu_layers: 0, no_gpu_devices: true });
  }
}

/**
 * Usable context size for a loaded model: MODEL_N_CTX capped by the model's
 * training context (GGUF `<arch>.context_length`), so small custom models are
 * never prompted past what they were trained on.
 */
export function getEffectiveContextSize(context: LlamaContext): number {
  const metadata = (context.model?.metadata ?? {}) as Record<string, unknown>;
  const arch = metadata['general.architecture'];
  const trained = typeof arch === 'string' ? Number(metadata[`${arch}.context_length`]) : NaN;
  return Number.isFinite(trained) && trained > 0 ? Math.min(MODEL_N_CTX, trained) : MODEL_N_CTX;
}

export async function releaseModel(context: LlamaContext): Promise<void> {
  await context.release();
}

export async function deleteModelFile(def: ModelDefinition): Promise<void> {
  const path = getModelPath(def);
  const info = await getInfoAsync(path);
  if (info.exists) {
    await deleteAsync(path, { idempotent: true });
  }
}

// ── Custom (user-added) models ──────────────────────────────────────────────

export async function loadCustomModels(): Promise<ModelDefinition[]> {
  try {
    const raw = await AsyncStorage.getItem(CUSTOM_MODELS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ModelDefinition[]) : [];
  } catch (e) {
    console.error('Failed to load custom models:', e);
    return [];
  }
}

export async function saveCustomModels(models: ModelDefinition[]): Promise<void> {
  await AsyncStorage.setItem(CUSTOM_MODELS_KEY, JSON.stringify(models));
}

/** Builds a custom model definition from a user-supplied name + URL. */
export function createCustomModel(name: string, url: string): ModelDefinition {
  const id = `custom-${randomUUID()}`;
  return {
    id,
    name: name.trim() || 'Custom model',
    tag: 'Custom',
    tagVariant: 'accent',
    description: 'Custom model added by you.',
    url: url.trim(),
    filename: `${id}.gguf`,
    sizeLabel: 'Custom',
    isCustom: true,
  };
}
