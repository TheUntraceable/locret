import { Platform } from 'react-native';
import {
  documentDirectory,
  getInfoAsync,
  getFreeDiskStorageAsync,
  createDownloadResumable,
  deleteAsync,
  readAsStringAsync,
  FileSystemSessionType,
  type DownloadOptions,
  type DownloadPauseState,
  type DownloadProgressData,
  type DownloadResumable,
} from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { randomUUID } from 'expo-crypto';
import { initLlama, type LlamaContext } from 'llama.rn';
import type { ModelDefinition, ModelId, ModelState } from '../types';

// Sizes are the exact Content-Length served by Hugging Face (checked 2026-10).
// If an upstream file is replaced, the size learned from the server at
// download time takes precedence (see getExpectedModelSize).
export const MODEL_CATALOG: ModelDefinition[] = [
  {
    id: 'fast',
    name: 'Qwen3.5 2B',
    tag: 'Fast',
    tagVariant: 'success',
    description: 'Smallest and quickest. Best for simple questions and low-end devices.',
    url: 'https://huggingface.co/HauhauCS/Qwen3.5-2B-Uncensored-HauhauCS-Aggressive/resolve/main/Qwen3.5-2B-Uncensored-HauhauCS-Aggressive-Q4_K_M.gguf?download=true',
    filename: 'qwen3.5-2b-q4km.gguf',
    sizeLabel: '~1.3 GB',
    sizeBytes: 1_270_808_032,
  },
  {
    id: 'standard',
    name: 'Qwen3.5 4B',
    tag: 'Standard',
    tagVariant: 'accent',
    description: 'Balanced speed and quality. Recommended for most devices.',
    url: 'https://huggingface.co/HauhauCS/Qwen3.5-4B-Uncensored-HauhauCS-Aggressive/resolve/main/Qwen3.5-4B-Uncensored-HauhauCS-Aggressive-Q4_K_M.gguf?download=true',
    filename: 'qwen3.5-4b-q4km.gguf',
    sizeLabel: '~2.7 GB',
    sizeBytes: 2_707_513_696,
  },
  {
    id: 'legacy',
    name: 'Gemma 4 E4B',
    tag: 'Legacy',
    tagVariant: 'muted',
    description: 'Previous default. May be slower on some devices.',
    url: 'https://huggingface.co/HauhauCS/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive/resolve/main/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-Q4_K_M.gguf',
    filename: 'gemma4b-q4km.gguf',
    sizeLabel: '~5.3 GB',
    sizeBytes: 5_335_285_728,
  },
];

const CUSTOM_MODELS_KEY = 'ai_custom_models';
/** Record<ModelId, DownloadRecord>: downloads that are running or paused. */
const DOWNLOADS_KEY = 'ai_model_downloads';
/** Record<ModelId, number>: model sizes learned from the server. */
const SIZES_KEY = 'ai_model_sizes';

/** Free space required on top of the remaining bytes, as a fraction of the model size. */
const FREE_SPACE_MARGIN = 0.1;
const PROBE_TIMEOUT_MS = 15_000;
/** "GGUF" in base64: every GGUF file starts with these 4 bytes. */
const GGUF_MAGIC_BASE64 = 'R0dVRg==';

/**
 * Where a partial download lives, which decides how it is resumed:
 *
 * - Android writes the response straight into the destination file and
 *   resumes with `Range: bytes=<resumeData>-`, where resumeData is just the
 *   partial file's length. So the partial file *is* the resume state: it
 *   survives a kill, and we always recompute the offset from the file size
 *   (the value pauseAsync reports can be a few KB stale because the writer
 *   coroutine may flush once more after the call is cancelled).
 * - iOS downloads into an NSURLSession temp file and only moves it to the
 *   destination when complete. The only resume state is the opaque blob from
 *   `cancelByProducingResumeData` (pauseAsync), and it is single-use. A
 *   download that was killed or failed without an explicit pause cannot be
 *   resumed and restarts from zero.
 */
export const RESUMES_FROM_PARTIAL_FILE = Platform.OS === 'android';

/**
 * iOS: a background NSURLSession keeps transferring while the app is
 * suspended, waits out connectivity drops instead of failing, and resumes
 * automatically. expo-file-system creates it with a random identifier per
 * launch, so a transfer cannot be re-attached after the app is killed (it then
 * resumes from the last explicit pause, or restarts).
 * Android (SDK 55): `sessionType` is parsed but ignored. The download is an
 * OkHttp call in the app process: it continues while the process lives
 * (backgrounded included) and dies with it; resume picks up from the partial
 * file.
 */
const DOWNLOAD_OPTIONS: DownloadOptions = { sessionType: FileSystemSessionType.BACKGROUND };

export function getModelPath(def: ModelDefinition): string {
  return `${documentDirectory}${def.filename}`;
}

// ── Small persisted maps (cached in memory, written through) ────────────────

function createPersistedMap<T>(key: string) {
  let cache: Record<string, T> | null = null;
  let loading: Promise<Record<string, T>> | null = null;

  const load = async (): Promise<Record<string, T>> => {
    if (cache) return cache;
    loading ??= AsyncStorage.getItem(key)
      .then((raw) => {
        const parsed: unknown = raw ? JSON.parse(raw) : {};
        cache = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, T>) : {};
        return cache;
      })
      .catch((e: unknown) => {
        console.warn(`Failed to read ${key}:`, e);
        cache = {};
        return cache;
      });
    return loading;
  };

  // Updates the cache synchronously (after load) and persists the whole map.
  // AsyncStorage runs writes in issue order, so the last write wins.
  const write = async (mutate: (map: Record<string, T>) => Record<string, T>) => {
    const next = mutate({ ...(await load()) });
    cache = next;
    await AsyncStorage.setItem(key, JSON.stringify(next)).catch((e: unknown) =>
      console.warn(`Failed to write ${key}:`, e),
    );
  };

  return {
    load,
    get: async (id: string): Promise<T | undefined> => (await load())[id],
    set: (id: string, value: T) => write((map) => ({ ...map, [id]: value })),
    remove: (id: string) =>
      write((map) => {
        const { [id]: _removed, ...rest } = map;
        return rest;
      }),
    retain: (ids: string[]) =>
      write((map) => Object.fromEntries(Object.entries(map).filter(([id]) => ids.includes(id)))),
  };
}

/**
 * Persisted state of a running or paused download: the DownloadResumable's
 * `savable()` plus what the UI needs to show a paused download after a restart.
 * Its presence means "a download was started and has not finished".
 */
export interface DownloadRecord extends DownloadPauseState {
  bytesWritten: number;
  totalBytes: number | null;
  updatedAt: number;
}

const downloadRecords = createPersistedMap<DownloadRecord>(DOWNLOADS_KEY);
const learnedSizes = createPersistedMap<number>(SIZES_KEY);

export const loadDownloadRecords = downloadRecords.load;
export const getDownloadRecord = downloadRecords.get;
export const saveDownloadRecord = downloadRecords.set;
export const clearDownloadRecord = downloadRecords.remove;
/** Drops records of models that no longer exist. */
export const pruneDownloadRecords = downloadRecords.retain;

/** Exact expected file size: learned from the server, else the catalog value. */
export async function getExpectedModelSize(def: ModelDefinition): Promise<number | null> {
  return (await learnedSizes.get(def.id)) ?? def.sizeBytes ?? null;
}

export async function rememberModelSize(id: ModelId, bytes: number): Promise<void> {
  if ((await learnedSizes.get(id)) !== bytes) await learnedSizes.set(id, bytes);
}

export const forgetModelSize = learnedSizes.remove;

// ── Files ───────────────────────────────────────────────────────────────────

export type ModelFileCheck =
  | { kind: 'missing'; size: 0 }
  | { kind: 'complete'; size: number } // size matches (or nothing to compare against) and magic is OK
  | { kind: 'short'; size: number } // smaller than expected: a partial
  | { kind: 'invalid'; size: number; reason: 'too_large' | 'not_gguf' };

/** True/false if the first 4 bytes could be read, null if the read failed. */
async function hasGgufMagic(path: string): Promise<boolean | null> {
  try {
    const head = await readAsStringAsync(path, { encoding: 'base64', position: 0, length: 4 });
    return head.trim() === GGUF_MAGIC_BASE64;
  } catch {
    return null;
  }
}

export async function checkModelFile(def: ModelDefinition, expectedBytes: number | null): Promise<ModelFileCheck> {
  const path = getModelPath(def);
  const info = await getInfoAsync(path);
  if (!info.exists || info.isDirectory) return { kind: 'missing', size: 0 };
  const size = info.size;
  if (expectedBytes != null && size > expectedBytes) return { kind: 'invalid', size, reason: 'too_large' };
  if (size >= 4 && (await hasGgufMagic(path)) === false) return { kind: 'invalid', size, reason: 'not_gguf' };
  if (expectedBytes != null && size < expectedBytes) return { kind: 'short', size };
  if (size < 4) return { kind: 'short', size };
  return { kind: 'complete', size };
}

/** A complete, verified model file (size matches when known, GGUF magic OK). */
export async function isModelFileDownloaded(def: ModelDefinition): Promise<boolean> {
  try {
    return (await checkModelFile(def, await getExpectedModelSize(def))).kind === 'complete';
  } catch {
    return false;
  }
}

export async function deleteModelFile(def: ModelDefinition): Promise<void> {
  await deleteAsync(getModelPath(def), { idempotent: true });
}

/** Free bytes on the volume holding the documents directory, or null if unknown. */
export async function getFreeDiskSpace(): Promise<number | null> {
  try {
    const free = await getFreeDiskStorageAsync();
    return Number.isFinite(free) && free > 0 ? free : null;
  } catch {
    return null;
  }
}

/** Bytes that must be free to download the rest of a model, including the safety margin. */
export function requiredFreeSpace(totalBytes: number, alreadyDownloaded: number): number {
  return Math.max(0, totalBytes - alreadyDownloaded) + Math.ceil(totalBytes * FREE_SPACE_MARGIN);
}

export function modelStateOf(
  status: ModelState['status'],
  bytesWritten = 0,
  totalBytes: number | null = null,
  errorMessage: string | null = null,
): ModelState {
  return {
    status,
    progress:
      status === 'downloaded' ? 1 : totalBytes && totalBytes > 0 ? Math.min(1, bytesWritten / totalBytes) : 0,
    errorMessage,
    bytesWritten,
    totalBytes,
    bytesPerSecond: null,
  };
}

/**
 * Derives a model's state from disk + its download record, cleaning up what
 * can't be used. Never returns 'downloading' (nothing is running when this is
 * called), so it also heals a download that was in flight when the app died.
 *
 * - complete file                        → 'downloaded' (record dropped)
 * - Android partial (smaller, valid)     → 'paused', resumable from the file
 * - iOS saved resume data                → 'paused'
 * - oversized / non-GGUF file, or an iOS fragment, or a partial for a URL that
 *   has since changed                    → deleted, 'not_downloaded'
 */
export async function reconcileModelOnDisk(def: ModelDefinition): Promise<ModelState> {
  let record = (await getDownloadRecord(def.id)) ?? null;
  const urlChanged = !!record && (record.url !== def.url || record.fileUri !== getModelPath(def));
  if (urlChanged) {
    await clearDownloadRecord(def.id);
    record = null;
  }
  const total = (await getExpectedModelSize(def)) ?? record?.totalBytes ?? null;
  const file = await checkModelFile(def, total);

  if (file.kind === 'complete') {
    // Size unknown + an unfinished record on Android: it's a partial we can't measure.
    if (total == null && record && RESUMES_FROM_PARTIAL_FILE) {
      return modelStateOf('paused', file.size, null);
    }
    if (record) await clearDownloadRecord(def.id);
    return modelStateOf('downloaded', file.size, file.size);
  }

  if (file.kind === 'short' && RESUMES_FROM_PARTIAL_FILE && !urlChanged && file.size > 0) {
    if (!record) {
      // A truncated file from an older app version (or a lost record): adopt it.
      await saveDownloadRecord(def.id, {
        url: def.url,
        fileUri: getModelPath(def),
        options: DOWNLOAD_OPTIONS,
        bytesWritten: file.size,
        totalBytes: total,
        updatedAt: Date.now(),
      });
    }
    return modelStateOf('paused', file.size, total);
  }

  let removedMessage: string | null = null;
  if (file.kind !== 'missing') {
    await deleteModelFile(def);
    removedMessage =
      file.kind === 'invalid'
        ? 'The downloaded file was damaged and has been removed.'
        : 'An incomplete download was removed.';
  }

  if (!RESUMES_FROM_PARTIAL_FILE && record?.resumeData) {
    return modelStateOf('paused', record.bytesWritten, record.totalBytes ?? total);
  }
  if (record) {
    await clearDownloadRecord(def.id);
    return modelStateOf(
      'not_downloaded',
      0,
      total,
      removedMessage ?? 'The download was interrupted before it could be saved. Download again to restart it.',
    );
  }
  return modelStateOf('not_downloaded', 0, total, removedMessage);
}

// ── Network ─────────────────────────────────────────────────────────────────

export interface RemoteProbe {
  /** Final HTTP status after redirects, null if the request failed. */
  status: number | null;
  /** Content-Length of the final response when it is a 2xx. */
  size: number | null;
  /** The request failed for lack of connectivity (not a timeout). */
  offline: boolean;
}

/** HEAD request to learn the file size and catch auth / 404 errors before downloading. */
export async function probeRemoteFile(url: string): Promise<RemoteProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'HEAD', signal: controller.signal });
    const length = Number(res.headers.get('content-length'));
    const size = res.ok && Number.isFinite(length) && length > 0 ? length : null;
    return { status: res.status, size, offline: false };
  } catch (e) {
    const offline = !controller.signal.aborted && /network request failed/i.test(String(e));
    return { status: null, size: null, offline };
  } finally {
    clearTimeout(timer);
  }
}

export function isHuggingFaceUrl(url: string): boolean {
  return /^https?:\/\/([a-z0-9-]+\.)*(huggingface\.co|hf\.co)\//i.test(url.trim());
}

/** Turns a Hugging Face file *page* link (`/blob/`) into its download link (`/resolve/`). */
export function normalizeModelUrl(url: string): string {
  const trimmed = url.trim();
  if (!isHuggingFaceUrl(trimmed)) return trimmed;
  return trimmed.replace(/^(https?:\/\/[^/]+\/(?:(?:datasets|spaces)\/)?[^/?#]+\/[^/?#]+\/)blob\//i, '$1resolve/');
}

export function createModelDownload(
  def: ModelDefinition,
  resumeData: string | undefined,
  onProgress: (data: DownloadProgressData) => void,
): DownloadResumable {
  return createDownloadResumable(def.url, getModelPath(def), DOWNLOAD_OPTIONS, onProgress, resumeData);
}

export function downloadRecordFor(
  def: ModelDefinition,
  bytesWritten: number,
  totalBytes: number | null,
  resumeData?: string,
): DownloadRecord {
  return {
    url: def.url,
    fileUri: getModelPath(def),
    options: DOWNLOAD_OPTIONS,
    ...(resumeData ? { resumeData } : {}),
    bytesWritten,
    totalBytes,
    updatedAt: Date.now(),
  };
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Pauses a running download and returns its savable state, or null if it could
 * not be paused (then it is cancelled so it never keeps running unobserved).
 * Retries briefly: right after start the native task may not be registered yet.
 */
export async function pauseDownload(resumable: DownloadResumable): Promise<DownloadPauseState | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await resumable.pauseAsync();
    } catch {
      await delay(250);
    }
  }
  await resumable.cancelAsync().catch(() => undefined);
  return null;
}

/** Resolves when `promise` settles or after `ms`, whichever is first. Never rejects. */
export function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  return Promise.race([promise.then(() => undefined, () => undefined), delay(ms)]);
}

// ── Errors ──────────────────────────────────────────────────────────────────

/** An error whose message is already user-facing. */
export class DownloadError extends Error {}

export function describeHttpStatus(status: number, url: string): string {
  if (status === 401 || status === 403) {
    return isHuggingFaceUrl(url)
      ? 'This model needs a Hugging Face login; use a direct public link.'
      : `Access denied (HTTP ${status}). Use a direct, public download link.`;
  }
  if (status === 404 || status === 410) {
    return `File not found (HTTP ${status}). Check that the link points to an existing .gguf file.`;
  }
  if (status === 416) return 'The server refused to resume this download. Remove it and download again.';
  if (status === 429) return 'Too many requests (HTTP 429). Wait a few minutes and try again.';
  if (status >= 500) return `The server had a problem (HTTP ${status}). Try again later.`;
  return `Download failed (HTTP ${status}).`;
}

export const OUT_OF_SPACE_MESSAGE = 'Not enough free storage on this device. Free up space and try again.';
export const NO_CONNECTION_MESSAGE = 'No internet connection, or it dropped. Check your network and try again.';

/** Maps a native download/fetch failure to user-facing text. */
export function describeDownloadError(error: unknown): string {
  if (error instanceof DownloadError) return error.message;
  const raw = error instanceof Error ? error.message : String(error ?? '');
  if (/ENOSPC|no space|not enough space|space left|disk.*full|POSIXErrorDomain Code=28|Code=-3000|Code=-3003/i.test(raw)) {
    return OUT_OF_SPACE_MESSAGE;
  }
  if (/timed? ?out|Code=-1001|SocketTimeout/i.test(raw)) {
    return 'The connection timed out. Try again on a stronger network.';
  }
  if (
    /network request failed|offline|Unable to resolve host|UnknownHost|Failed to connect|Network is unreachable|ENETUNREACH|Connection reset|ECONNRESET|connection (was )?lost|connection abort|unexpected end of stream|stream was reset|Code=-100[3-9]|Code=-1020|SSL|SocketException/i.test(
      raw,
    )
  ) {
    return NO_CONNECTION_MESSAGE;
  }
  const brief = raw.replace(/^Unable to download file:\s*/i, '').split('\n')[0].trim();
  return brief ? `Download failed: ${brief.slice(0, 140)}` : 'Download failed.';
}

// ── Formatting ──────────────────────────────────────────────────────────────

/** Decimal units, matching how Hugging Face reports sizes. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1000) return `${Math.max(0, Math.round(bytes || 0))} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = -1;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value.toFixed(value < 100 && unit >= 1 ? 1 : 0)} ${units[unit]}`;
}

function formatEta(seconds: number): string {
  if (seconds < 60) return 'under a minute left';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `~${minutes} min left`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `~${h} h ${m} min left` : `~${h} h left`;
}

/** e.g. "1.2 GB of 2.7 GB · 8.3 MB/s · ~3 min left" (speed/ETA only while downloading). */
export function formatDownloadDetails(state: ModelState): string {
  const { status, bytesWritten, totalBytes, bytesPerSecond } = state;
  if (status === 'downloading' && bytesWritten === 0 && !bytesPerSecond) return 'Starting…';
  const parts = [totalBytes ? `${formatBytes(bytesWritten)} of ${formatBytes(totalBytes)}` : formatBytes(bytesWritten)];
  if (status === 'downloading' && bytesPerSecond && bytesPerSecond > 0) {
    parts.push(`${formatBytes(bytesPerSecond)}/s`);
    if (totalBytes && totalBytes > bytesWritten) parts.push(formatEta((totalBytes - bytesWritten) / bytesPerSecond));
  }
  return parts.join(' · ');
}

// ── Loading ─────────────────────────────────────────────────────────────────

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
    url: normalizeModelUrl(url),
    filename: `${id}.gguf`,
    sizeLabel: 'Custom',
    isCustom: true,
  };
}
