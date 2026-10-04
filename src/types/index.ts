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
  sizeLabel: string;
  isCustom?: boolean;
}

export type ModelDownloadStatus = 'not_downloaded' | 'downloading' | 'downloaded' | 'error';

export interface ModelState {
  status: ModelDownloadStatus;
  progress: number; // 0–1
  errorMessage: string | null;
}
