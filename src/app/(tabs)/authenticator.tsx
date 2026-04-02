import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { View, Text, ScrollView, Pressable, TextInput } from 'react-native';
import { Image } from 'expo-image';
import { Button, BottomSheet, Separator, useThemeColor } from 'heroui-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { randomUUID } from 'expo-crypto';
import { useApp } from '../../context/AppContext';
import { generateTOTP, getTimeRemaining } from '../../utils/totp';
import { encryptValue, decryptValue } from '../../utils/encryption';
import {
  getTotpAccounts,
  addTotpAccount as addTotpAccountToStorage,
  updateTotpAccount as updateTotpAccountToStorage,
  deleteTotpAccount as deleteTotpAccountFromStorage,
} from '../../utils/storage';
import { AddTotpDialog } from '../../components/AddTotpDialog';
import type { TotpAccount, TotpAlgorithm } from '../../types';

const DOMAIN_EXCEPTIONS: Record<string, string> = {
  aws: 'aws.amazon.com',
  x: 'x.com',
  twitter: 'x.com',
  steam: 'steampowered.com',
  npm: 'npmjs.com',
  pypi: 'pypi.org',
  jira: 'atlassian.com',
  notion: 'notion.so',
  linear: 'linear.app',
  protonmail: 'proton.me',
  proton: 'proton.me',
  zoom: 'zoom.us',
  datadog: 'datadoghq.com',
  twitch: 'twitch.tv',
  bitbucket: 'bitbucket.org',
  epic: 'epicgames.com',
};

function getIssuerDomain(issuer: string): string {
  const lower = issuer.toLowerCase().trim();
  if (DOMAIN_EXCEPTIONS[lower]) return DOMAIN_EXCEPTIONS[lower];
  for (const [key, domain] of Object.entries(DOMAIN_EXCEPTIONS)) {
    if (lower.includes(key)) return domain;
  }
  if (lower.includes('.')) return lower;
  return `${lower.replace(/\s+/g, '')}.com`;
}

function getFaviconUrl(issuer: string): string {
  const domain = getIssuerDomain(issuer);
  return `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;
}

function IssuerIcon({ issuer, size, accentColor }: { issuer: string; size: number; accentColor: string }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <View
        className="items-center justify-center rounded-full"
        style={{ width: size, height: size, backgroundColor: `${accentColor}20` }}
      >
        <Text className="font-bold" style={{ color: accentColor, fontSize: size * 0.4 }}>
          {issuer.charAt(0).toUpperCase()}
        </Text>
      </View>
    );
  }

  return (
    <View
      className="items-center justify-center rounded-full overflow-hidden"
      style={{ width: size, height: size, backgroundColor: `${accentColor}10` }}
    >
      <Image
        source={{ uri: getFaviconUrl(issuer) }}
        style={{ width: size * 0.6, height: size * 0.6 }}
        contentFit="contain"
        onError={() => setFailed(true)}
      />
    </View>
  );
}

export default function AuthenticatorTab() {
  const { encryptionKey } = useApp();
  const [accounts, setAccounts] = useState<TotpAccount[]>([]);
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [accountTimers, setAccountTimers] = useState<Record<string, number>>({});
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [editingAccount, setEditingAccount] = useState<TotpAccount | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sheetAccount, setSheetAccount] = useState<TotpAccount | null>(null);
  const [showSheet, setShowSheet] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [themeAccent, themeMuted, themeDanger] = useThemeColor(['accent', 'muted', 'danger']);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadAccounts = useCallback(async () => {
    const loaded = await getTotpAccounts();
    setAccounts(loaded);
  }, []);

  const generateAllCodes = useCallback(async (accs?: TotpAccount[]) => {
    const toProcess = accs ?? accounts;
    if (!encryptionKey || toProcess.length === 0) return;
    const newCodes: Record<string, string> = {};
    for (const account of toProcess) {
      try {
        const secret = await decryptValue(account.sealedSecret, encryptionKey);
        newCodes[account.id] = generateTOTP(secret, account.period, account.digits, account.algorithm ?? 'SHA1');
      } catch {
        newCodes[account.id] = '------';
      }
    }
    setCodes(newCodes);
  }, [accounts, encryptionKey]);

  const updateTimers = useCallback(() => {
    const timers: Record<string, number> = {};
    for (const account of accounts) {
      timers[account.id] = getTimeRemaining(account.period);
    }
    setAccountTimers(timers);
    return timers;
  }, [accounts]);

  useEffect(() => { loadAccounts(); }, [loadAccounts]);

  useEffect(() => {
    generateAllCodes();
    updateTimers();
    timerRef.current = setInterval(() => {
      const timers = updateTimers();
      const needsRegen = accounts.some((a) => timers[a.id] === a.period);
      if (needsRegen) generateAllCodes();
    }, 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [generateAllCodes, updateTimers, accounts]);

  const handleAddAccount = useCallback(
    async (issuer: string, accountName: string, secret: string, period?: number, digits?: number, algorithm?: TotpAlgorithm) => {
      if (!encryptionKey) return;
      const { sealed } = await encryptValue(secret, encryptionKey);
      const newAccount: TotpAccount = {
        id: randomUUID(), issuer, accountName, sealedSecret: sealed,
        algorithm: algorithm || 'SHA1', period: period || 30, digits: digits || 6,
        createdAt: new Date().toISOString(),
      };
      await addTotpAccountToStorage(newAccount);
      const updated = [...accounts, newAccount];
      setAccounts(updated);
      generateAllCodes(updated);
    },
    [encryptionKey, accounts, generateAllCodes]
  );

  const handleEditAccount = useCallback(
    async (accountId: string, issuer: string, accountName: string) => {
      const account = accounts.find((a) => a.id === accountId);
      if (!account) return;
      const updated: TotpAccount = { ...account, issuer, accountName };
      await updateTotpAccountToStorage(updated);
      setAccounts((prev) => prev.map((a) => (a.id === accountId ? updated : a)));
      setEditingAccount(null);
    },
    [accounts]
  );

  const handleDeleteAccount = useCallback(async () => {
    if (!sheetAccount) return;
    await deleteTotpAccountFromStorage(sheetAccount.id);
    setAccounts((prev) => prev.filter((a) => a.id !== sheetAccount.id));
    setCodes((prev) => { const next = { ...prev }; delete next[sheetAccount.id]; return next; });
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setShowDeleteConfirm(false);
    setShowSheet(false);
    setSheetAccount(null);
  }, [sheetAccount]);

  const handleCopyCode = useCallback(async (accountId: string, code: string) => {
    if (code === '------') return;
    await Clipboard.setStringAsync(code);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCopiedId(accountId);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setCopiedId(null), 2000);
  }, []);

  const filteredAccounts = useMemo(() => {
    if (!searchQuery.trim()) return accounts;
    const query = searchQuery.toLowerCase();
    return accounts.filter(
      (a) => a.issuer.toLowerCase().includes(query) || a.accountName.toLowerCase().includes(query)
    );
  }, [accounts, searchQuery]);

  const formatCode = (code: string) => {
    if (code.length === 6) return `${code.slice(0, 3)} ${code.slice(3)}`;
    if (code.length === 8) return `${code.slice(0, 4)} ${code.slice(4)}`;
    return code;
  };

  const openSheet = useCallback((account: TotpAccount) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setSheetAccount(account);
    setShowSheet(true);
  }, []);

  return (
    <View className="flex-1 bg-background">
      <View className="px-5 pt-14 pb-3">
        <Text className="text-3xl font-bold text-foreground">Authenticator</Text>
        <Text className="text-sm text-muted mt-1">
          {accounts.length === 0
            ? 'Two-factor authentication codes'
            : `${accounts.length} ${accounts.length === 1 ? 'account' : 'accounts'}`}
        </Text>
      </View>

      <ScrollView className="flex-1 px-5" showsVerticalScrollIndicator={false}>
        {accounts.length === 0 ? (
          <View className="items-center justify-center px-6" style={{ minHeight: 400 }}>
            <View className="w-24 h-24 rounded-full bg-surface items-center justify-center mb-6">
              <Ionicons name="shield-checkmark-outline" size={48} color={themeAccent} />
            </View>
            <Text className="text-xl font-bold text-foreground text-center">No 2FA Accounts Yet</Text>
            <Text className="text-muted mt-2 text-center leading-5">
              Add your two-factor authentication accounts to generate time-based codes. Your secrets are encrypted with AES-256.
            </Text>

            <View className="mt-8 gap-4 w-full">
              <View className="flex-row items-center gap-4 px-2">
                <View className="w-10 h-10 rounded-full bg-surface items-center justify-center">
                  <Ionicons name="qr-code-outline" size={20} color={themeAccent} />
                </View>
                <View className="flex-1">
                  <Text className="text-sm font-semibold text-foreground">Scan QR Code</Text>
                  <Text className="text-xs text-muted">Instantly add accounts by scanning the QR code</Text>
                </View>
              </View>
              <View className="flex-row items-center gap-4 px-2">
                <View className="w-10 h-10 rounded-full bg-surface items-center justify-center">
                  <Ionicons name="time-outline" size={20} color={themeAccent} />
                </View>
                <View className="flex-1">
                  <Text className="text-sm font-semibold text-foreground">TOTP Codes</Text>
                  <Text className="text-xs text-muted">Time-based rotating codes, works offline</Text>
                </View>
              </View>
              <View className="flex-row items-center gap-4 px-2">
                <View className="w-10 h-10 rounded-full bg-surface items-center justify-center">
                  <Ionicons name="lock-closed-outline" size={20} color={themeAccent} />
                </View>
                <View className="flex-1">
                  <Text className="text-sm font-semibold text-foreground">Encrypted Storage</Text>
                  <Text className="text-xs text-muted">Same AES-256 encryption as your secrets</Text>
                </View>
              </View>
            </View>

            <Button variant="primary" size="md" onPress={() => setShowAddDialog(true)} className="mt-8">
              <Ionicons name="add" size={18} />
              <Button.Label>Add First Account</Button.Label>
            </Button>
          </View>
        ) : (
          <View className="gap-1 pb-28">
            <View className="mb-3">
              <View className="flex-row items-center bg-surface rounded-xl px-3 gap-2">
                <Ionicons name="search" size={18} color={themeMuted} />
                <TextInput
                  value={searchQuery}
                  onChangeText={setSearchQuery}
                  placeholder="Search accounts..."
                  placeholderTextColor={themeMuted}
                  className="flex-1 py-3 text-foreground"
                />
                {searchQuery.length > 0 && (
                  <Pressable onPress={() => setSearchQuery('')}>
                    <Ionicons name="close-circle" size={18} color={themeMuted} />
                  </Pressable>
                )}
              </View>
            </View>

            <Text className="text-xs font-semibold text-muted uppercase tracking-wider mt-2 mb-2 px-1">
              Accounts
            </Text>

            {filteredAccounts.length === 0 && searchQuery.trim() ? (
              <View className="items-center justify-center py-12">
                <Ionicons name="search-outline" size={36} color={themeMuted} />
                <Text className="text-sm text-muted mt-3 text-center">
                  No accounts matching &ldquo;{searchQuery}&rdquo;
                </Text>
              </View>
            ) : (
              <View className="bg-surface rounded-xl overflow-hidden">
                {filteredAccounts.map((account) => {
                  const code = codes[account.id] || '------';
                  const isCopied = copiedId === account.id;
                  const remaining = accountTimers[account.id] ?? account.period;
                  const progress = remaining / account.period;
                  const isLowTime = remaining <= 5;

                  return (
                    <Pressable
                      key={account.id}
                      onPress={() => handleCopyCode(account.id, code)}
                      onLongPress={() => openSheet(account)}
                      className="px-4 py-3"
                    >
                      <View className="flex-row items-center justify-between gap-3">
                        <View className="flex-row items-center gap-3 flex-1">
                          <IssuerIcon issuer={account.issuer} size={40} accentColor={themeAccent} />
                          <View className="flex-1">
                            <View className="flex-row items-center gap-2">
                              <Text className="text-base font-semibold text-foreground">
                                {account.issuer}
                              </Text>
                              {isCopied && (
                                <View className="flex-row items-center gap-1">
                                  <Ionicons name="checkmark-circle" size={14} color={themeAccent} />
                                  <Text className="text-xs font-medium" style={{ color: themeAccent }}>Copied</Text>
                                </View>
                              )}
                            </View>
                            <Text className="text-xs text-muted" numberOfLines={1}>
                              {account.accountName}
                            </Text>
                          </View>
                        </View>
                        <View className="items-end gap-1">
                          <Text
                            className="text-2xl font-bold tracking-widest"
                            style={{ color: isLowTime ? themeDanger : themeAccent }}
                          >
                            {formatCode(code)}
                          </Text>
                          <View className="flex-row items-center gap-1">
                            <View
                              className="h-1 rounded-full bg-background overflow-hidden"
                              style={{ width: 40 }}
                            >
                              <View
                                className="h-full rounded-full"
                                style={{
                                  width: `${progress * 100}%`,
                                  backgroundColor: isLowTime ? themeDanger : themeAccent,
                                }}
                              />
                            </View>
                            <Text
                              className="text-xs font-semibold w-6 text-right"
                              style={{ color: isLowTime ? themeDanger : themeMuted }}
                            >
                              {remaining}s
                            </Text>
                          </View>
                        </View>
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            )}
          </View>
        )}
      </ScrollView>

      {accounts.length > 0 && (
        <View className="absolute bottom-8 right-6">
          <Button variant="primary" size="lg" isIconOnly onPress={() => setShowAddDialog(true)}>
            <Ionicons name="add" size={24} />
          </Button>
        </View>
      )}

      {/* Account actions sheet */}
      <BottomSheet isOpen={showSheet} onOpenChange={(open) => {
        setShowSheet(open);
        if (!open) { setSheetAccount(null); setShowDeleteConfirm(false); }
      }}>
        <BottomSheet.Portal>
          <BottomSheet.Overlay />
          <BottomSheet.Content enableDynamicSizing>
            {sheetAccount && (
              <View className="px-5 pb-6">
                <View className="flex-row items-center justify-between mb-1">
                  <View className="flex-row items-center gap-3 flex-1">
                    <IssuerIcon issuer={sheetAccount.issuer} size={32} accentColor={themeAccent} />
                    <BottomSheet.Title>{sheetAccount.issuer}</BottomSheet.Title>
                  </View>
                  <BottomSheet.Close />
                </View>
                <BottomSheet.Description>{sheetAccount.accountName}</BottomSheet.Description>

                <Separator className="my-4" />

                {showDeleteConfirm ? (
                  <View className="gap-3">
                    <Text className="text-sm text-muted">
                      Are you sure you want to delete this 2FA account? You won&apos;t be able to generate codes for it anymore.
                    </Text>
                    <View className="flex-row gap-3">
                      <Button variant="ghost" size="md" onPress={() => setShowDeleteConfirm(false)} className="flex-1">
                        <Button.Label>Cancel</Button.Label>
                      </Button>
                      <Button variant="danger" size="md" onPress={handleDeleteAccount} className="flex-1">
                        <Ionicons name="trash-outline" size={16} />
                        <Button.Label>Delete</Button.Label>
                      </Button>
                    </View>
                  </View>
                ) : (
                  <View className="gap-1">
                    <Pressable
                      onPress={async () => {
                        const code = codes[sheetAccount.id];
                        if (code) await handleCopyCode(sheetAccount.id, code);
                        setShowSheet(false);
                      }}
                      className="flex-row items-center gap-3 py-3 px-1"
                    >
                      <Ionicons name="copy-outline" size={20} color={themeAccent} />
                      <Text className="text-base text-foreground">Copy Code</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => {
                        setEditingAccount(sheetAccount);
                        setShowSheet(false);
                      }}
                      className="flex-row items-center gap-3 py-3 px-1"
                    >
                      <Ionicons name="create-outline" size={20} color={themeAccent} />
                      <Text className="text-base text-foreground">Edit</Text>
                    </Pressable>
                    <Separator className="my-1" />
                    <Pressable
                      onPress={() => setShowDeleteConfirm(true)}
                      className="flex-row items-center gap-3 py-3 px-1"
                    >
                      <Ionicons name="trash-outline" size={20} color={themeDanger} />
                      <Text className="text-base" style={{ color: themeDanger }}>Delete</Text>
                    </Pressable>
                  </View>
                )}
              </View>
            )}
          </BottomSheet.Content>
        </BottomSheet.Portal>
      </BottomSheet>

      <AddTotpDialog
        isOpen={showAddDialog || !!editingAccount}
        onOpenChange={(open) => {
          setShowAddDialog(open);
          if (!open) setEditingAccount(null);
        }}
        onAdd={handleAddAccount}
        onEdit={handleEditAccount}
        editAccount={editingAccount ? { id: editingAccount.id, issuer: editingAccount.issuer, accountName: editingAccount.accountName } : null}
      />
    </View>
  );
}
