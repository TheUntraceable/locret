import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Conversation, ChatMessage } from '../types';

const CONVERSATIONS_KEY = 'chat_conversations';
const MSG_KEY = (id: string) => `chat_messages_${id}`;

export async function getConversations(): Promise<Conversation[]> {
  const data = await AsyncStorage.getItem(CONVERSATIONS_KEY);
  return data ? JSON.parse(data) : [];
}

export async function saveConversations(conversations: Conversation[]): Promise<void> {
  await AsyncStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(conversations));
}

export async function addConversation(conversation: Conversation): Promise<void> {
  const conversations = await getConversations();
  conversations.unshift(conversation);
  await saveConversations(conversations);
}

export async function updateConversation(updated: Conversation): Promise<void> {
  const conversations = await getConversations();
  const index = conversations.findIndex((c) => c.id === updated.id);
  if (index !== -1) {
    conversations[index] = updated;
    await saveConversations(conversations);
  }
}

export async function deleteConversation(id: string): Promise<void> {
  const conversations = await getConversations();
  await saveConversations(conversations.filter((c) => c.id !== id));
  await AsyncStorage.removeItem(MSG_KEY(id));
}

export async function getMessages(conversationId: string): Promise<ChatMessage[]> {
  const data = await AsyncStorage.getItem(MSG_KEY(conversationId));
  return data ? JSON.parse(data) : [];
}

export async function saveMessages(conversationId: string, messages: ChatMessage[]): Promise<void> {
  await AsyncStorage.setItem(MSG_KEY(conversationId), JSON.stringify(messages));
}

export async function appendMessage(conversationId: string, message: ChatMessage): Promise<void> {
  const messages = await getMessages(conversationId);
  messages.push(message);
  await saveMessages(conversationId, messages);
}

export async function updateLastMessage(conversationId: string, newContent: string): Promise<void> {
  const messages = await getMessages(conversationId);
  if (messages.length === 0) return;
  messages[messages.length - 1] = { ...messages[messages.length - 1], content: newContent };
  await saveMessages(conversationId, messages);
}

export async function deleteAllChatData(): Promise<void> {
  const allKeys = await AsyncStorage.getAllKeys();
  const chatKeys = allKeys.filter((k) => k.startsWith('chat_messages_'));
  await AsyncStorage.multiRemove([CONVERSATIONS_KEY, ...chatKeys]);
}
