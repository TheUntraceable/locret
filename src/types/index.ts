export interface Project {
  id: string;
  name: string;
  createdAt: string;
}

export interface Secret {
  id: string;
  projectId: string;
  name: string;
  description?: string;
  sealedData: string;
  expiresAt?: string;
  createdAt: string;
}

export interface DecryptedSecret extends Secret {
  decryptedValue: string;
}

export type TotpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512';

export interface TotpAccount {
  id: string;
  issuer: string;
  accountName: string;
  sealedSecret: string; // encrypted base32 secret
  algorithm: TotpAlgorithm; // SHA1, SHA256, or SHA512
  period: number; // typically 30
  digits: number; // typically 6
  createdAt: string;
}

// ── Chat ──────────────────────────────────────────────────────────────────────

export type ChatRole = 'user' | 'assistant';

/**
 * Why an assistant turn ended.
 * - 'stop'        model finished naturally (EOS / stop word)
 * - 'length'      hit the token limit (n_predict) or the context window
 * - 'cancelled'   user pressed stop
 * - 'interrupted' superseded by a new request (e.g. user sent a message mid-turn),
 *                 or the app was killed mid-generation (healed on next load)
 * - 'error'       generation threw; see ChatMessage.error
 */
export type FinishReason = 'stop' | 'length' | 'cancelled' | 'interrupted' | 'error';

export interface MessageStats {
  predictedTokens: number;
  tokensPerSecond: number;
  durationMs: number;
  model: string; // display name of the model that produced the message
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string; // plaintext in memory; encrypted hex in storage
  createdAt: string;
  /**
   * Assistant only. Undefined while the message is being generated, and on
   * messages written by older app versions (treat those as complete).
   */
  finishReason?: FinishReason;
  /** Assistant only: separated thinking text. Plaintext in memory; encrypted hex in storage. */
  reasoning?: string;
  /** Assistant only: generation timings (accumulated across continuations). */
  stats?: MessageStats;
  /** Assistant only: user-facing error when finishReason === 'error'. Encrypted at rest like content. */
  error?: string;
}

export interface Conversation {
  id: string;
  title: string;       // plaintext in memory; encrypted hex in storage
  lastMessage: string; // plaintext in memory; encrypted hex in storage
  lastMessageAt: string;
  createdAt: string;
  messageCount: number;
}

// Built-in models have fixed ids; custom (user-added) models use `custom-<uuid>`.
export type ModelId = string;

export interface ModelDefinition {
  id: ModelId;
  name: string;
  tag: string;
  tagVariant: 'muted' | 'accent' | 'success';
  description: string;
  url: string;
  filename: string;
  /** Display-only size, e.g. "~2.7 GB". */
  sizeLabel: string;
  /**
   * Exact size of the GGUF file in bytes, when known (built-in catalog, or
   * learned for custom models from the server). Used for the free-space check
   * and to verify a finished download.
   */
  sizeBytes?: number;
  isCustom?: boolean;
}

/**
 * - 'paused'  a partial download is kept and can be resumed (explicit pause,
 *             connection lost, or the app was closed mid-download)
 * - 'error'   the last attempt failed and nothing resumable is left
 */
export type ModelDownloadStatus = 'not_downloaded' | 'downloading' | 'paused' | 'downloaded' | 'error';

export interface ModelState {
  status: ModelDownloadStatus;
  progress: number; // 0–1 (0 while the total size is unknown)
  /**
   * User-facing message. Set for 'error', and may also accompany 'paused'
   * (why it stopped) or 'not_downloaded' (e.g. an interrupted download that
   * could not be kept).
   */
  errorMessage: string | null;
  /** Bytes downloaded so far ('downloaded': the file size). */
  bytesWritten: number;
  /** Expected total size in bytes, null while unknown. */
  totalBytes: number | null;
  /** Smoothed download speed (EMA) while 'downloading'; null when not measured yet. */
  bytesPerSecond: number | null;
}
