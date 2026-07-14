import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import type { Project, Secret, TotpAccount } from '../types';

const PROJECTS_KEY = 'projects';
const SECRETS_KEY = 'secrets';
const TOTP_ACCOUNTS_KEY = 'totp_accounts';
const ENCRYPTION_KEY = 'encryption_key';
const PIN_HASH_KEY = 'pin_hash';
const PIN_RATE_LIMIT_KEY = 'pin_rate_limit';

interface PinRateLimitState {
  failedAttempts: number;
  lockoutUntil: number;
}

export async function getProjects(): Promise<Project[]> {
  const data = await AsyncStorage.getItem(PROJECTS_KEY);
  return data ? JSON.parse(data) : [];
}

export async function saveProjects(projects: Project[]): Promise<void> {
  await AsyncStorage.setItem(PROJECTS_KEY, JSON.stringify(projects));
}

export async function addProject(project: Project): Promise<void> {
  const projects = await getProjects();
  projects.push(project);
  await saveProjects(projects);
}

export async function deleteProject(projectId: string): Promise<void> {
  const projects = await getProjects();
  const filtered = projects.filter((p) => p.id !== projectId);
  await saveProjects(filtered);
  const secrets = await getSecrets();
  const filteredSecrets = secrets.filter((s) => s.projectId !== projectId);
  await saveSecrets(filteredSecrets);
}

export async function getSecrets(): Promise<Secret[]> {
  const data = await AsyncStorage.getItem(SECRETS_KEY);
  return data ? JSON.parse(data) : [];
}

export async function getSecretsByProjectId(projectId: string): Promise<Secret[]> {
  const secrets = await getSecrets();
  return secrets.filter((s) => s.projectId === projectId);
}

export async function saveSecrets(secrets: Secret[]): Promise<void> {
  await AsyncStorage.setItem(SECRETS_KEY, JSON.stringify(secrets));
}

export async function addSecret(secret: Secret): Promise<void> {
  const secrets = await getSecrets();
  secrets.push(secret);
  await saveSecrets(secrets);
}

export async function updateSecret(updated: Secret): Promise<void> {
  const secrets = await getSecrets();
  const index = secrets.findIndex((s) => s.id === updated.id);
  if (index !== -1) {
    secrets[index] = updated;
    await saveSecrets(secrets);
  }
}

export async function deleteSecret(secretId: string): Promise<void> {
  const secrets = await getSecrets();
  const filtered = secrets.filter((s) => s.id !== secretId);
  await saveSecrets(filtered);
}

export async function getEncryptionKey(): Promise<string | null> {
  return SecureStore.getItemAsync(ENCRYPTION_KEY);
}

export async function setEncryptionKey(key: string): Promise<void> {
  await SecureStore.setItemAsync(ENCRYPTION_KEY, key);
}

export async function hasEncryptionKey(): Promise<boolean> {
  const key = await getEncryptionKey();
  return key !== null;
}

export async function getPinHash(): Promise<string | null> {
  return SecureStore.getItemAsync(PIN_HASH_KEY);
}

export async function setPinHash(hash: string): Promise<void> {
  await SecureStore.setItemAsync(PIN_HASH_KEY, hash);
}

export async function hasPin(): Promise<boolean> {
  const hash = await getPinHash();
  return hash !== null;
}

export async function removePin(): Promise<void> {
  await SecureStore.deleteItemAsync(PIN_HASH_KEY);
}

export async function getPinRateLimitState(): Promise<PinRateLimitState> {
  const raw = await SecureStore.getItemAsync(PIN_RATE_LIMIT_KEY);
  if (!raw) {
    return { failedAttempts: 0, lockoutUntil: 0 };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<PinRateLimitState>;
    const failedAttempts = Number.isFinite(parsed.failedAttempts) ? Math.max(0, Math.floor(parsed.failedAttempts as number)) : 0;
    const lockoutUntil = Number.isFinite(parsed.lockoutUntil) ? Math.max(0, Math.floor(parsed.lockoutUntil as number)) : 0;
    return { failedAttempts, lockoutUntil };
  } catch {
    return { failedAttempts: 0, lockoutUntil: 0 };
  }
}

export async function setPinRateLimitState(state: PinRateLimitState): Promise<void> {
  await SecureStore.setItemAsync(PIN_RATE_LIMIT_KEY, JSON.stringify(state));
}

export async function clearPinRateLimitState(): Promise<void> {
  await SecureStore.deleteItemAsync(PIN_RATE_LIMIT_KEY);
}

// TOTP Account storage
export async function getTotpAccounts(): Promise<TotpAccount[]> {
  const data = await AsyncStorage.getItem(TOTP_ACCOUNTS_KEY);
  return data ? JSON.parse(data) : [];
}

export async function saveTotpAccounts(accounts: TotpAccount[]): Promise<void> {
  await AsyncStorage.setItem(TOTP_ACCOUNTS_KEY, JSON.stringify(accounts));
}

export async function addTotpAccount(account: TotpAccount): Promise<void> {
  const accounts = await getTotpAccounts();
  accounts.push(account);
  await saveTotpAccounts(accounts);
}

export async function updateTotpAccount(updated: TotpAccount): Promise<void> {
  const accounts = await getTotpAccounts();
  const index = accounts.findIndex((a) => a.id === updated.id);
  if (index !== -1) {
    accounts[index] = updated;
    await saveTotpAccounts(accounts);
  }
}

export async function deleteTotpAccount(accountId: string): Promise<void> {
  const accounts = await getTotpAccounts();
  const filtered = accounts.filter((a) => a.id !== accountId);
  await saveTotpAccounts(filtered);
}

export async function wipeAllData(): Promise<void> {
  // Main data
  await AsyncStorage.removeItem(PROJECTS_KEY);
  await AsyncStorage.removeItem(SECRETS_KEY);
  await AsyncStorage.removeItem(TOTP_ACCOUNTS_KEY);
  await SecureStore.deleteItemAsync(ENCRYPTION_KEY);
  await SecureStore.deleteItemAsync(PIN_HASH_KEY);
  await SecureStore.deleteItemAsync(PIN_RATE_LIMIT_KEY);

  // Chat data
  const allKeys = await AsyncStorage.getAllKeys();
  const chatKeys = allKeys.filter((k) => k === 'chat_conversations' || k.startsWith('chat_messages_'));
  if (chatKeys.length > 0) {
    await AsyncStorage.multiRemove(chatKeys);
  }
  await SecureStore.deleteItemAsync('chat_encryption_key').catch(() => {});
}
