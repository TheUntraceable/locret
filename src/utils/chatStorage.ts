import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ChatMessage, Conversation } from '../types';
import { decryptValue, encryptValue } from './encryption';
import { normalizeReasoning } from './thinking';

/**
 * Encrypted chat persistence.
 *
 * In memory everything is plaintext; at rest `Conversation.title`,
 * `Conversation.lastMessage`, `ChatMessage.content`, `ChatMessage.reasoning`
 * and `ChatMessage.error` are AES-GCM sealed hex (see utils/encryption.ts).
 * Every function that reads or writes user text takes the chat key.
 *
 * All read-modify-write operations on a storage key are serialised through a
 * per-key FIFO lock, so incremental streaming writes, conversation updates and
 * deletes can't clobber each other.
 */

const CONVERSATIONS_KEY = 'chat_conversations';
const MSG_KEY = (id: string) => `chat_messages_${id}`;
const UNREADABLE = '[Unable to decrypt message]';

/**
 * Stored message shape. `pending` marks an assistant message whose generation
 * has not been finalised yet; if the app dies mid-generation it is healed on
 * the next read (see loadMessages). It never leaves this module.
 */
interface StoredMessage extends ChatMessage {
  pending?: boolean;
}

/** Fields of a message that can be patched. `undefined` removes the field. */
export type MessagePatch = Partial<Pick<ChatMessage, 'content' | 'reasoning' | 'finishReason' | 'stats' | 'error'>> & {
  pending?: boolean;
};

// ── Locking ──────────────────────────────────────────────────────────────────

const locks = new Map<string, Promise<void>>();

function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(() => fn());
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  locks.set(key, tail);
  void tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return run;
}

// ── Raw IO ───────────────────────────────────────────────────────────────────

async function readArray<T>(key: string): Promise<T[]> {
  const data = await AsyncStorage.getItem(key);
  if (!data) return [];
  try {
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch (e) {
    console.warn(`chatStorage: corrupt JSON in ${key}`, e);
    return [];
  }
}

async function writeArray<T>(key: string, value: T[]): Promise<void> {
  await AsyncStorage.setItem(key, JSON.stringify(value));
}

// ── Crypto helpers ───────────────────────────────────────────────────────────

async function seal(plain: string, key: string): Promise<string> {
  return (await encryptValue(plain, key)).sealed;
}

async function open(sealed: string, key: string): Promise<string> {
  return decryptValue(sealed, key);
}

async function openOr(sealed: string | undefined, key: string, fallback: string): Promise<string> {
  if (sealed === undefined) return fallback;
  try {
    return await open(sealed, key);
  } catch (e) {
    console.warn('chatStorage: decrypt failed', e);
    return UNREADABLE;
  }
}

async function sealPatch(patch: MessagePatch, key: string): Promise<MessagePatch> {
  const out: MessagePatch = { ...patch };
  if (patch.content !== undefined) out.content = await seal(patch.content, key);
  if ('reasoning' in patch) out.reasoning = patch.reasoning ? await seal(patch.reasoning, key) : undefined;
  if ('error' in patch) out.error = patch.error ? await seal(patch.error, key) : undefined;
  return out;
}

async function sealMessage(msg: ChatMessage, key: string, pending: boolean): Promise<StoredMessage> {
  const sealed = (await sealPatch(
    { content: msg.content, reasoning: msg.reasoning, error: msg.error },
    key,
  )) as Pick<ChatMessage, 'content' | 'reasoning' | 'error'>;
  return { ...msg, ...sealed, ...(pending ? { pending: true } : {}) };
}

async function openMessage(stored: StoredMessage, key: string): Promise<ChatMessage & { pending?: boolean }> {
  const content = await openOr(stored.content, key, '');
  const reasoning = await openOr(stored.reasoning, key, '');
  const error = stored.error !== undefined ? await openOr(stored.error, key, '') : undefined;
  const msg: ChatMessage & { pending?: boolean } = { ...stored, content, error };
  if (stored.role === 'assistant' && stored.finishReason === undefined && !stored.pending) {
    // Older app versions stored raw thinking markup inside `content` (and never
    // wrote finishReason). Messages from this engine already have reasoning
    // separated, and their content may legitimately contain "<think>" (e.g. a
    // reply explaining chat templates), so they are never re-split.
    const norm = normalizeReasoning(content, reasoning);
    msg.content = norm.content;
    msg.reasoning = norm.reasoning || undefined;
  } else if (stored.role === 'assistant') {
    msg.reasoning = reasoning || undefined;
  } else {
    msg.reasoning = undefined;
  }
  if (msg.error === undefined) delete msg.error;
  if (msg.reasoning === undefined) delete msg.reasoning;
  return msg;
}

function stripPending(msg: ChatMessage & { pending?: boolean }): ChatMessage {
  const { pending: _pending, ...rest } = msg;
  return rest;
}

// ── Conversations ────────────────────────────────────────────────────────────

export async function loadConversations(key: string): Promise<Conversation[]> {
  const raw = await readArray<Conversation>(CONVERSATIONS_KEY);
  return Promise.all(
    raw.map(async (c) => ({
      ...c,
      title: await openOr(c.title, key, ''),
      lastMessage: await openOr(c.lastMessage, key, ''),
    })),
  );
}

export async function hasConversation(id: string): Promise<boolean> {
  return (await readArray<Conversation>(CONVERSATIONS_KEY)).some((c) => c.id === id);
}

/** A conversation's creation time (stored in plaintext), or null if it doesn't exist. */
export async function getConversationCreatedAt(id: string): Promise<string | null> {
  return (await readArray<Conversation>(CONVERSATIONS_KEY)).find((c) => c.id === id)?.createdAt ?? null;
}

/** `conversation` is plaintext. */
export function addConversation(conversation: Conversation, key: string): Promise<void> {
  return withLock(CONVERSATIONS_KEY, async () => {
    const stored: Conversation = {
      ...conversation,
      title: await seal(conversation.title, key),
      lastMessage: await seal(conversation.lastMessage, key),
    };
    const all = await readArray<Conversation>(CONVERSATIONS_KEY);
    all.unshift(stored);
    await writeArray(CONVERSATIONS_KEY, all);
  });
}

/**
 * Patches a conversation (plaintext values). Returns false if it doesn't exist
 * (e.g. deleted while a generation was finishing).
 */
export function updateConversation(
  id: string,
  patch: Partial<Omit<Conversation, 'id'>>,
  key: string,
): Promise<boolean> {
  return withLock(CONVERSATIONS_KEY, async () => {
    const all = await readArray<Conversation>(CONVERSATIONS_KEY);
    const index = all.findIndex((c) => c.id === id);
    if (index === -1) return false;
    const sealed: Partial<Conversation> = { ...patch };
    if (patch.title !== undefined) sealed.title = await seal(patch.title, key);
    if (patch.lastMessage !== undefined) sealed.lastMessage = await seal(patch.lastMessage, key);
    all[index] = { ...all[index], ...sealed };
    await writeArray(CONVERSATIONS_KEY, all);
    return true;
  });
}

/**
 * Removes the conversation entry first, then its messages under the messages
 * lock. appendMessage(requireConversation) checks for the entry inside that
 * same lock, so an append racing this delete either runs before the removal
 * (and is removed with it) or sees the conversation gone and writes nothing:
 * no orphaned messages key is left behind.
 */
export async function deleteConversation(id: string): Promise<void> {
  await withLock(CONVERSATIONS_KEY, async () => {
    const all = await readArray<Conversation>(CONVERSATIONS_KEY);
    await writeArray(
      CONVERSATIONS_KEY,
      all.filter((c) => c.id !== id),
    );
  });
  await withLock(MSG_KEY(id), () => AsyncStorage.removeItem(MSG_KEY(id)));
}

// ── Messages ─────────────────────────────────────────────────────────────────

/**
 * Loads and decrypts a conversation's messages.
 *
 * Repair step: an assistant message still marked pending that is not the
 * message currently being generated (`activeMessageId`) was orphaned by an app
 * kill / crash mid-generation. It is healed to finishReason 'interrupted', or
 * deleted if it holds no text. `healed` reports whether storage changed.
 */
export function loadMessages(
  conversationId: string,
  key: string,
  activeMessageId: string | null = null,
): Promise<{ messages: ChatMessage[]; healed: boolean }> {
  return withLock(MSG_KEY(conversationId), async () => {
    const stored = await readArray<StoredMessage>(MSG_KEY(conversationId));
    const keptStored: StoredMessage[] = [];
    const messages: ChatMessage[] = [];
    let healed = false;

    for (const s of stored) {
      const msg = await openMessage(s, key);
      if (s.pending && s.id !== activeMessageId) {
        healed = true;
        if (!msg.content.trim() && !(msg.reasoning ?? '').trim()) continue; // drop empty orphan
        keptStored.push({ ...s, pending: undefined, finishReason: 'interrupted' });
        messages.push(stripPending({ ...msg, finishReason: 'interrupted' }));
        continue;
      }
      keptStored.push(s);
      messages.push(stripPending(msg));
    }

    if (healed) await writeArray(MSG_KEY(conversationId), keptStored);
    return { messages, healed };
  });
}

export async function getMessageCount(conversationId: string): Promise<number> {
  return (await readArray<StoredMessage>(MSG_KEY(conversationId))).length;
}

/**
 * Appends a plaintext message and returns the new message count.
 * `pending` marks an in-flight assistant message. With `requireConversation`
 * nothing is written (and null is returned) if the conversation was deleted.
 */
export function appendMessage(
  conversationId: string,
  message: ChatMessage,
  key: string,
  { pending = false, requireConversation = false }: { pending?: boolean; requireConversation?: boolean } = {},
): Promise<number | null> {
  return withLock(MSG_KEY(conversationId), async () => {
    if (requireConversation && !(await hasConversation(conversationId))) return null;
    const stored = await sealMessage(message, key, pending);
    const all = await readArray<StoredMessage>(MSG_KEY(conversationId));
    all.push(stored);
    await writeArray(MSG_KEY(conversationId), all);
    return all.length;
  });
}

/**
 * Patches a message by id (plaintext values; `undefined` removes a field).
 * Returns false if the message no longer exists.
 */
export function updateMessage(
  conversationId: string,
  messageId: string,
  patch: MessagePatch,
  key: string,
): Promise<boolean> {
  return withLock(MSG_KEY(conversationId), async () => {
    const all = await readArray<StoredMessage>(MSG_KEY(conversationId));
    const index = all.findIndex((m) => m.id === messageId);
    if (index === -1) return false;
    const sealed = await sealPatch(patch, key);
    all[index] = { ...all[index], ...sealed } as StoredMessage;
    await writeArray(MSG_KEY(conversationId), all);
    return true;
  });
}

/** Deletes a message by id. Returns the remaining message count, or null if not found. */
export function deleteMessage(conversationId: string, messageId: string): Promise<number | null> {
  return withLock(MSG_KEY(conversationId), async () => {
    const all = await readArray<StoredMessage>(MSG_KEY(conversationId));
    const next = all.filter((m) => m.id !== messageId);
    if (next.length === all.length) return null;
    await writeArray(MSG_KEY(conversationId), next);
    return next.length;
  });
}

export async function deleteAllChatData(): Promise<void> {
  const allKeys = await AsyncStorage.getAllKeys();
  const chatKeys = allKeys.filter((k) => k.startsWith('chat_messages_'));
  await AsyncStorage.multiRemove([CONVERSATIONS_KEY, ...chatKeys]);
}
