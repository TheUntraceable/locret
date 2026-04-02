import React, { createContext, useContext, useState, useCallback, useRef, ReactNode } from 'react';
import * as LocalAuthentication from 'expo-local-authentication';
import { randomUUID } from 'expo-crypto';
import type { Project, Secret } from '../types';
import {
  getProjects,
  addProject as addProjectToStorage,
  deleteProject as deleteProjectFromStorage,
  getSecretsByProjectId,
  addSecret as addSecretToStorage,
  updateSecret as updateSecretInStorage,
  deleteSecret as deleteSecretFromStorage,
  getEncryptionKey,
  setEncryptionKey,
  hasEncryptionKey,
  getPinHash,
  setPinHash,
  hasPin,
  clearPinRateLimitState,
  getPinRateLimitState,
  setPinRateLimitState,
  wipeAllData,
} from '../utils/storage';
import {
  generateEncryptionKey,
  encryptValue,
  decryptValue,
  hashPin,
  verifyPin,
} from '../utils/encryption';

const SESSION_TIMEOUT_MS = 60_000; // 1 minute
const PIN_BACKOFF_BASE_MS = 5_000;
const PIN_BACKOFF_MAX_MS = 3_600_000;
const PIN_LOCKOUT_THRESHOLD = 3; // Allow this many wrong attempts before lockout

interface PinVerifyResult {
  success: boolean;
  retryAfterMs: number;
  attemptsUntilLockout: number;
}

interface AppContextType {
  projects: Project[];
  secrets: Secret[];
  decryptedSecrets: Record<string, string>;
  encryptionKey: string | null;
  hasPinSetup: boolean;
  isLoading: boolean;
  loadProjects: () => Promise<void>;
  loadSecrets: (projectId: string) => Promise<void>;
  addProject: (name: string) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  addSecret: (projectId: string, name: string, description: string | undefined, value: string, expiresAt?: string) => Promise<void>;
  deleteSecret: (id: string, projectId: string) => Promise<void>;
  updateSecret: (id: string, name: string, description: string | undefined, value: string, expiresAt?: string) => Promise<void>;
  duplicateSecret: (secret: Secret, projectId: string) => Promise<void>;
  decryptSecret: (secret: Secret) => Promise<string | null>;
  decryptAllSecrets: (secrets: Secret[]) => Promise<Record<string, string> | null>;
  clearDecryptedSecrets: () => void;
  authenticate: () => Promise<boolean>;
  setupPin: (pin: string) => Promise<void>;
  verifyPinAuth: (pin: string) => Promise<PinVerifyResult>;
  getPinLockoutRemaining: () => Promise<number>;
  initializeApp: () => Promise<void>;
  markAuthenticated: () => void;
  isSessionValid: () => boolean;
  resetApp: () => Promise<void>;
  lockApp: () => void;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

export function AppProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [secrets, setSecrets] = useState<Secret[]>([]);
  const [decryptedSecrets, setDecryptedSecrets] = useState<Record<string, string>>({});
  const [encryptionKey, setEncryptionKeyState] = useState<string | null>(null);
  const [hasPinSetup, setHasPinSetup] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const lastAuthTimeRef = useRef<number | null>(null);

  const markAuthenticated = useCallback(() => {
    lastAuthTimeRef.current = Date.now();
  }, []);

  const isSessionValid = useCallback(() => {
    if (!lastAuthTimeRef.current) return false;
    return Date.now() - lastAuthTimeRef.current < SESSION_TIMEOUT_MS;
  }, []);

  const initializeApp = useCallback(async () => {
    setIsLoading(true);
    try {
      const hasKey = await hasEncryptionKey();
      if (!hasKey) {
        const newKey = await generateEncryptionKey();
        await setEncryptionKey(newKey);
        setEncryptionKeyState(newKey);
      } else {
        const key = await getEncryptionKey();
        setEncryptionKeyState(key);
      }

      const pinExists = await hasPin();
      setHasPinSetup(pinExists);

      const loadedProjects = await getProjects();
      setProjects(loadedProjects);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const loadProjects = useCallback(async () => {
    const loadedProjects = await getProjects();
    setProjects(loadedProjects);
  }, []);

  const loadSecrets = useCallback(async (projectId: string) => {
    setIsLoading(true);
    try {
      const loadedSecrets = await getSecretsByProjectId(projectId);
      setSecrets(loadedSecrets);
      setDecryptedSecrets({});
    } finally {
      setIsLoading(false);
    }
  }, []);

  const addProject = useCallback(async (name: string) => {
    const newProject: Project = {
      id: randomUUID(),
      name,
      createdAt: new Date().toISOString(),
    };
    await addProjectToStorage(newProject);
    setProjects((prev) => [...prev, newProject]);
  }, []);

  const deleteProject = useCallback(async (id: string) => {
    await deleteProjectFromStorage(id);
    setProjects((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const resolveEncryptionKey = useCallback(async (): Promise<string | null> => {
    if (encryptionKey) return encryptionKey;
    const existingKey = await getEncryptionKey();
    if (existingKey) {
      setEncryptionKeyState(existingKey);
      return existingKey;
    }
    return null;
  }, [encryptionKey]);

  const resolveOrCreateEncryptionKey = useCallback(async (): Promise<string> => {
    const existingKey = await resolveEncryptionKey();
    if (existingKey) return existingKey;
    const newKey = await generateEncryptionKey();
    await setEncryptionKey(newKey);
    setEncryptionKeyState(newKey);
    return newKey;
  }, [resolveEncryptionKey]);

  const addSecret = useCallback(async (
    projectId: string,
    name: string,
    description: string | undefined,
    value: string,
    expiresAt?: string,
  ): Promise<string | undefined> => {
    const key = await resolveOrCreateEncryptionKey();

    const { sealed } = await encryptValue(value, key);

    const newSecret: Secret = {
      id: randomUUID(),
      projectId,
      name,
      description,
      sealedData: sealed,
      expiresAt,
      createdAt: new Date().toISOString(),
    };

    await addSecretToStorage(newSecret);
    setSecrets((prev) => [...prev, newSecret]);
    return newSecret.id;
  }, [resolveOrCreateEncryptionKey]);

  const deleteSecret = useCallback(async (id: string, projectId: string) => {
    await deleteSecretFromStorage(id);
    setSecrets((prev) => prev.filter((s) => s.id !== id));
    setDecryptedSecrets((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const updateSecret = useCallback(async (
    id: string,
    name: string,
    description: string | undefined,
    value: string,
    expiresAt?: string,
  ) => {
    const key = await resolveEncryptionKey();
    if (!key) return;
    
    const existing = secrets.find((s) => s.id === id);
    if (!existing) return;

    const { sealed } = await encryptValue(value, key);
    const updated: Secret = { ...existing, name, description, sealedData: sealed, expiresAt };

    await updateSecretInStorage(updated);
    setSecrets((prev) => prev.map((s) => s.id === id ? updated : s));
    setDecryptedSecrets((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, [resolveEncryptionKey, secrets]);

  const duplicateSecret = useCallback(async (secret: Secret, projectId: string) => {
    const newSecret: Secret = {
      ...secret,
      id: randomUUID(),
      projectId,
      name: `${secret.name} (copy)`,
      createdAt: new Date().toISOString(),
    };
    await addSecretToStorage(newSecret);
    setSecrets((prev) => [...prev, newSecret]);
  }, []);

  const decryptSecret = useCallback(async (secret: Secret): Promise<string | null> => {
    const key = await resolveEncryptionKey();
    if (!key) return null;
    
    try {
      const decrypted = await decryptValue(
        secret.sealedData,
        key
      );
      setDecryptedSecrets((prev) => ({ ...prev, [secret.id]: decrypted }));
      return decrypted;
    } catch (e) {
      console.error('Decrypt single secret failed:', e);
      return null;
    }
  }, [resolveEncryptionKey]);

  const decryptAllSecrets = useCallback(async (secretsToDecrypt: Secret[]): Promise<Record<string, string> | null> => {
    const key = await resolveEncryptionKey();
    if (!key) return null;
    
    setIsLoading(true);
    try {
      const results: Record<string, string> = {};
      for (const secret of secretsToDecrypt) {
        try {
          const decrypted = await decryptValue(
            secret.sealedData,
            key
          );
          results[secret.id] = decrypted;
        } catch (e) {
          console.error('Decrypt secret failed:', secret.name, e);
          results[secret.id] = 'Decryption failed';
        }
      }
      setDecryptedSecrets(results);
      return results;
    } finally {
      setIsLoading(false);
    }
  }, [resolveEncryptionKey]);

  const clearDecryptedSecrets = useCallback(() => {
    setDecryptedSecrets({});
  }, []);

  const authenticate = useCallback(async (): Promise<boolean> => {
    const hasHardware = await LocalAuthentication.hasHardwareAsync();
    const isEnrolled = await LocalAuthentication.isEnrolledAsync();

    if (hasHardware && isEnrolled) {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Authenticate to view secrets',
        cancelLabel: 'Cancel',
        disableDeviceFallback: true,
      });
      return result.success;
    }
    return false;
  }, []);

  const setupPin = useCallback(async (pin: string) => {
    const hash = await hashPin(pin);
    await setPinHash(hash);
    await clearPinRateLimitState();
    setHasPinSetup(true);
  }, []);

  const verifyPinAuth = useCallback(async (pin: string): Promise<PinVerifyResult> => {
    const hash = await getPinHash();
    if (!hash) {
      return { success: false, retryAfterMs: 0, attemptsUntilLockout: 0 };
    }

    const now = Date.now();
    const rateLimitState = await getPinRateLimitState();

    if (rateLimitState.lockoutUntil > now) {
      return {
        success: false,
        retryAfterMs: rateLimitState.lockoutUntil - now,
        attemptsUntilLockout: 0,
      };
    }

    const valid = await verifyPin(pin, hash);
    if (valid) {
      await clearPinRateLimitState();
      return { success: true, retryAfterMs: 0, attemptsUntilLockout: PIN_LOCKOUT_THRESHOLD };
    }

    const failedAttempts = rateLimitState.failedAttempts + 1;

    if (failedAttempts < PIN_LOCKOUT_THRESHOLD) {
      await setPinRateLimitState({ failedAttempts, lockoutUntil: 0 });
      return {
        success: false,
        retryAfterMs: 0,
        attemptsUntilLockout: PIN_LOCKOUT_THRESHOLD - failedAttempts,
      };
    }

    const lockoutAttempts = failedAttempts - PIN_LOCKOUT_THRESHOLD + 1;
    const backoffMs = Math.min(
      PIN_BACKOFF_MAX_MS,
      PIN_BACKOFF_BASE_MS * 2 ** (lockoutAttempts - 1),
    );

    await setPinRateLimitState({ failedAttempts, lockoutUntil: now + backoffMs });

    return {
      success: false,
      retryAfterMs: backoffMs,
      attemptsUntilLockout: 0,
    };
  }, []);

  const getPinLockoutRemaining = useCallback(async (): Promise<number> => {
    const rateLimitState = await getPinRateLimitState();
    const now = Date.now();
    if (rateLimitState.lockoutUntil > now) {
      return rateLimitState.lockoutUntil - now;
    }
    return 0;
  }, []);

  const resetApp = useCallback(async () => {
    await wipeAllData();
    setProjects([]);
    setSecrets([]);
    setDecryptedSecrets({});
    setEncryptionKeyState(null);
    setHasPinSetup(false);
    lastAuthTimeRef.current = null;
  }, []);

  const lockApp = useCallback(() => {
    // Clear all sensitive data from memory
    setSecrets([]);
    setDecryptedSecrets({});
    setEncryptionKeyState(null);
    setProjects([]);
    lastAuthTimeRef.current = null;
  }, []);

  return (
    <AppContext.Provider
      value={{
        projects,
        secrets,
        decryptedSecrets,
        encryptionKey,
        hasPinSetup,
        isLoading,
        loadProjects,
        loadSecrets,
        addProject,
        deleteProject,
        addSecret,
        deleteSecret,
        updateSecret,
        duplicateSecret,
        decryptSecret,
        decryptAllSecrets,
        clearDecryptedSecrets,
        authenticate,
        setupPin,
        verifyPinAuth,
        getPinLockoutRemaining,
        initializeApp,
        markAuthenticated,
        isSessionValid,
        resetApp,
        lockApp,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be used within AppProvider');
  }
  return context;
}
