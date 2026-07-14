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

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string; // plaintext in memory; encrypted hex in storage
  createdAt: string;
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
