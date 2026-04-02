import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { View, Text, ScrollView, Pressable, ActivityIndicator, TextInput } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { Button, BottomSheet, Dialog, Separator, useThemeColor } from 'heroui-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import { useApp } from '../../context/AppContext';
import { BiometricAuth } from '../../components/BiometricAuth';
import { AddSecretDialog } from '../../components/AddSecretDialog';
import { DecryptAllDialog } from '../../components/DecryptAllDialog';
import type { Secret } from '../../types';

function getExpiryStatus(expiresAt?: string) {
  if (!expiresAt) return null;
  const now = new Date();
  const expiry = new Date(expiresAt);
  const diffMs = expiry.getTime() - now.getTime();
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays < 0) return { label: 'Expired', color: 'danger' as const };
  if (diffDays === 0) return { label: 'Expires today', color: 'danger' as const };
  if (diffDays <= 3) return { label: `Expires in ${diffDays}d`, color: 'warning' as const };
  if (diffDays <= 7) return { label: `Expires in ${diffDays}d`, color: 'muted' as const };
  return { label: `Expires ${new Date(expiresAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`, color: 'muted' as const };
}

export default function ProjectDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const {
    projects, secrets, decryptedSecrets, isLoading,
    loadSecrets, deleteProject, deleteSecret, duplicateSecret,
    decryptSecret, decryptAllSecrets, clearDecryptedSecrets,
    isSessionValid,
  } = useApp();
  const [themeAccent, themeDanger, themeMuted, themeWarning] = useThemeColor(['accent', 'danger', 'muted', 'warning']);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showDecryptAllDialog, setShowDecryptAllDialog] = useState(false);
  const [showAuthForSecret, setShowAuthForSecret] = useState(false);
  const [selectedSecret, setSelectedSecret] = useState<Secret | null>(null);
  const [sheetSecret, setSheetSecret] = useState<Secret | null>(null);
  const [showSheet, setShowSheet] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showDeleteSecretConfirm, setShowDeleteSecretConfirm] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<TextInput>(null);
  const [copiedSecretId, setCopiedSecretId] = useState<string | null>(null);
  const [editingSecret, setEditingSecret] = useState<{
    id: string; name: string; description?: string; decryptedValue: string; expiresAt?: string;
  } | null>(null);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const project = projects.find((p) => p.id === id);
  const projectName = project?.name || '';

  useEffect(() => {
    if (id) loadSecrets(id);
    return () => { clearDecryptedSecrets(); };
  }, [id, loadSecrets, clearDecryptedSecrets]);

  const filteredSecrets = useMemo(() => {
    if (!searchQuery.trim()) return secrets;
    const query = searchQuery.toLowerCase();
    return secrets.filter((s) =>
      s.name.toLowerCase().includes(query) ||
      s.description?.toLowerCase().includes(query)
    );
  }, [secrets, searchQuery]);

  const handleSecretPress = useCallback(async (secret: Secret) => {
    if (isSessionValid()) {
      await decryptSecret(secret);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else {
      setSelectedSecret(secret);
      setShowAuthForSecret(true);
    }
  }, [isSessionValid, decryptSecret]);

  const handleAuthSuccess = useCallback(async () => {
    if (selectedSecret) {
      await decryptSecret(selectedSecret);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setSelectedSecret(null);
    }
  }, [selectedSecret, decryptSecret]);

  const handleDecryptAll = useCallback(async () => {
    if (secrets.length > 0) {
      await decryptAllSecrets(secrets);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
  }, [secrets, decryptAllSecrets]);

  const handleDeleteProject = useCallback(async () => {
    if (id) {
      await deleteProject(id);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      router.back();
    }
  }, [id, deleteProject]);

  const handleCopySecret = useCallback(async (secretId: string) => {
    const value = decryptedSecrets[secretId];
    if (!value) return;
    await Clipboard.setStringAsync(value);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCopiedSecretId(secretId);
    if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    copyTimeoutRef.current = setTimeout(() => setCopiedSecretId(null), 2000);
  }, [decryptedSecrets]);

  useEffect(() => {
    return () => { if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current); };
  }, []);

  const openSheetForSecret = useCallback((secret: Secret) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setSheetSecret(secret);
    setShowSheet(true);
  }, []);

  const handleEditSecret = useCallback(() => {
    if (!sheetSecret) return;
    const decryptedValue = decryptedSecrets[sheetSecret.id];
    if (!decryptedValue) return;
    setEditingSecret({
      id: sheetSecret.id,
      name: sheetSecret.name,
      description: sheetSecret.description,
      decryptedValue,
      expiresAt: sheetSecret.expiresAt,
    });
    setShowSheet(false);
    setShowAddDialog(true);
  }, [sheetSecret, decryptedSecrets]);

  const handleDeleteSecret = useCallback(async () => {
    if (id && sheetSecret) {
      await deleteSecret(sheetSecret.id, id);
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      setShowDeleteSecretConfirm(false);
      setShowSheet(false);
      setSheetSecret(null);
    }
  }, [id, sheetSecret, deleteSecret]);

  const handleDuplicateSecret = useCallback(async () => {
    if (id && sheetSecret) {
      await duplicateSecret(sheetSecret, id);
      // Schedule notifications for duplicate if it has an expiry
      if (sheetSecret.expiresAt) {
        // The duplicated secret is the latest one added — we don't have its ID here
        // but the context will handle it
      }
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setShowSheet(false);
      setSheetSecret(null);
    }
  }, [id, sheetSecret, duplicateSecret]);

  const sheetIsDecrypted = sheetSecret ? decryptedSecrets[sheetSecret.id] !== undefined : false;
  const statusColors = { danger: themeDanger, warning: themeWarning, muted: themeMuted };

  return (
    <View className="flex-1 bg-background">
      <View className="px-5 pt-14 pb-3">
        <View className="flex-row items-center justify-between">
          <View className="flex-row items-center gap-2 flex-1">
            <Pressable onPress={() => router.back()} className="p-1">
              <Ionicons name="arrow-back" size={22} color={themeAccent} />
            </Pressable>
            <Text className="text-3xl font-bold text-foreground" numberOfLines={1}>{projectName}</Text>
          </View>
          <Pressable onPress={() => setShowDeleteConfirm(true)} className="p-1">
            <Ionicons name="trash-outline" size={20} color={themeDanger} />
          </Pressable>
        </View>
        <Text className="text-sm text-muted mt-1">
          {secrets.length} {secrets.length === 1 ? 'secret' : 'secrets'} stored
        </Text>
      </View>

      <ScrollView className="flex-1 px-5" showsVerticalScrollIndicator={false}>
        {isLoading ? (
          <View className="items-center justify-center" style={{ minHeight: 300 }}>
            <ActivityIndicator size="large" color={themeAccent} />
            <Text className="text-sm text-muted mt-3">Decrypting...</Text>
          </View>
        ) : secrets.length === 0 ? (
          <View className="items-center justify-center px-6" style={{ minHeight: 400 }}>
            <View className="w-24 h-24 rounded-full bg-surface items-center justify-center mb-6">
              <Ionicons name="key-outline" size={48} color={themeAccent} />
            </View>
            <Text className="text-xl font-bold text-foreground text-center">No secrets yet</Text>
            <Text className="text-muted mt-2 text-center leading-5">
              Store API keys, passwords, tokens, or any sensitive data. Everything is encrypted with AES-256.
            </Text>
            <Button
              variant="primary"
              size="md"
              onPress={() => setShowAddDialog(true)}
              className="mt-6"
            >
              <Ionicons name="add" size={18} />
              <Button.Label>Add First Secret</Button.Label>
            </Button>
          </View>
        ) : (
          <View className="gap-1 pb-28">
            {secrets.length > 0 && (
              <View className="mb-3">
                <View className="flex-row items-center bg-surface rounded-xl px-3 gap-2">
                  <Ionicons name="search" size={18} color={themeMuted} />
                  <TextInput
                    ref={searchInputRef}
                    defaultValue={searchQuery}
                    onChangeText={setSearchQuery}
                    placeholder="Search secrets..."
                    placeholderTextColor={themeMuted}
                    className="flex-1 py-3 text-foreground"
                  />
                  {searchQuery.length > 0 && (
                    <Pressable onPress={() => {
                      setSearchQuery('');
                      searchInputRef.current?.setNativeProps?.({ text: '' });
                    }}>
                      <Ionicons name="close-circle" size={18} color={themeMuted} />
                    </Pressable>
                  )}
                </View>
              </View>
            )}

            <Text className="text-xs font-semibold text-muted uppercase tracking-wider mt-2 mb-2 px-1">Actions</Text>
            <Pressable
              onPress={() => setShowDecryptAllDialog(true)}
              className="flex-row items-center justify-between bg-surface rounded-xl px-4 py-4 mb-2"
            >
              <View className="flex-row items-center gap-3">
                <Ionicons name="key-outline" size={20} color={themeAccent} />
                <View>
                  <Text className="text-base text-foreground">Decrypt All</Text>
                  <Text className="text-xs text-muted">Reveal all secrets in this project</Text>
                </View>
              </View>
              <Ionicons name="chevron-forward" size={18} color={themeMuted} />
            </Pressable>

            <Text className="text-xs font-semibold text-muted uppercase tracking-wider mt-4 mb-2 px-1">Secrets</Text>

            {filteredSecrets.length === 0 && searchQuery.trim() ? (
              <View className="items-center justify-center py-12">
                <Ionicons name="search-outline" size={36} color={themeMuted} />
                <Text className="text-sm text-muted mt-3 text-center">
                  No secrets matching &ldquo;{searchQuery}&rdquo;
                </Text>
              </View>
            ) : (
              <View className="bg-surface rounded-xl overflow-hidden">
                {filteredSecrets.map((secret) => {
                  const isDecrypted = decryptedSecrets[secret.id] !== undefined;
                  const expiry = getExpiryStatus(secret.expiresAt);

                  return (
                    <Pressable
                      key={secret.id}
                      onPress={() => !isDecrypted && handleSecretPress(secret)}
                      onLongPress={() => openSheetForSecret(secret)}
                      className="px-4 py-4"
                    >
                      <View className="flex-row items-center justify-between">
                        <View className="flex-row items-center gap-3 flex-1">
                          <Ionicons
                            name={isDecrypted ? 'lock-open-outline' : 'lock-closed-outline'}
                            size={20}
                            color={themeAccent}
                          />
                          <View className="flex-1">
                            <Text className="text-base text-foreground">{secret.name}</Text>
                            <View className="flex-row items-center gap-2 flex-1">
                              {secret.description ? (
                                <Text className="text-xs text-muted flex-shrink" numberOfLines={1}>{secret.description}</Text>
                              ) : (
                                <Text className="text-xs text-muted">
                                  {isDecrypted ? 'Decrypted' : 'Tap to decrypt'}
                                </Text>
                              )}
                              {expiry && (
                                <Text className="text-xs font-medium flex-shrink-0" style={{ color: statusColors[expiry.color] }}>
                                  · {expiry.label}
                                </Text>
                              )}
                            </View>
                          </View>
                        </View>
                        <Ionicons name="ellipsis-vertical" size={18} color={themeMuted} />
                      </View>

                      {isDecrypted && (
                        <Pressable
                          onPress={() => handleCopySecret(secret.id)}
                          className="mt-3 ml-8 p-3 rounded-xl bg-background flex-row items-center justify-between gap-2"
                        >
                          <Text className="text-sm text-foreground font-mono flex-1 flex-shrink" selectable>
                            {decryptedSecrets[secret.id]}
                          </Text>
                          <Ionicons
                            name={copiedSecretId === secret.id ? 'checkmark-circle' : 'copy-outline'}
                            size={18}
                            color={copiedSecretId === secret.id ? '#22c55e' : themeMuted}
                          />
                        </Pressable>
                      )}
                    </Pressable>
                  );
                })}
              </View>
            )}
          </View>
        )}
      </ScrollView>

      {secrets.length > 0 && (
        <View className="absolute bottom-8 right-6">
          <Button variant="primary" size="lg" isIconOnly onPress={() => setShowAddDialog(true)}>
            <Ionicons name="add" size={24} />
          </Button>
        </View>
      )}

      {/* Secret actions sheet */}
      <BottomSheet isOpen={showSheet} onOpenChange={(open) => {
        setShowSheet(open);
        if (!open) { setSheetSecret(null); setShowDeleteSecretConfirm(false); }
      }}>
        <BottomSheet.Portal>
          <BottomSheet.Overlay />
          <BottomSheet.Content enableDynamicSizing>
            {sheetSecret && (
              <View className="px-5 pb-6">
                <View className="flex-row items-center justify-between mb-1">
                  <BottomSheet.Title>{sheetSecret.name}</BottomSheet.Title>
                  <BottomSheet.Close />
                </View>
                {sheetSecret.description && (
                  <BottomSheet.Description>{sheetSecret.description}</BottomSheet.Description>
                )}
                {sheetSecret.expiresAt && (
                  <View className="flex-row items-center gap-2 mt-2">
                    <Ionicons name="calendar-outline" size={14} color={themeMuted} />
                    <Text className="text-xs text-muted">
                      Expires {new Date(sheetSecret.expiresAt).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}
                    </Text>
                  </View>
                )}

                <Separator className="my-4" />

                {showDeleteSecretConfirm ? (
                  <View className="gap-3">
                    <Text className="text-sm text-muted">
                      Are you sure you want to delete this secret? This cannot be undone.
                    </Text>
                    <View className="flex-row gap-3">
                      <Button variant="ghost" size="md" onPress={() => setShowDeleteSecretConfirm(false)} className="flex-1">
                        <Button.Label>Cancel</Button.Label>
                      </Button>
                      <Button variant="danger" size="md" onPress={handleDeleteSecret} className="flex-1">
                        <Ionicons name="trash-outline" size={16} />
                        <Button.Label>Delete</Button.Label>
                      </Button>
                    </View>
                  </View>
                ) : (
                  <View className="gap-1">
                    {!sheetIsDecrypted && (
                      <Pressable
                        onPress={async () => {
                          await handleSecretPress(sheetSecret);
                          setShowSheet(false);
                        }}
                        className="flex-row items-center gap-3 py-3 px-1"
                      >
                        <Ionicons name="lock-open-outline" size={20} color={themeAccent} />
                        <Text className="text-base text-foreground">Decrypt</Text>
                      </Pressable>
                    )}
                    {sheetIsDecrypted && (
                      <Pressable
                        onPress={async () => {
                          await handleCopySecret(sheetSecret.id);
                          setShowSheet(false);
                        }}
                        className="flex-row items-center gap-3 py-3 px-1"
                      >
                        <Ionicons name="copy-outline" size={20} color={themeAccent} />
                        <Text className="text-base text-foreground">Copy Value</Text>
                      </Pressable>
                    )}
                    {sheetIsDecrypted && (
                      <Pressable
                        onPress={handleEditSecret}
                        className="flex-row items-center gap-3 py-3 px-1"
                      >
                        <Ionicons name="create-outline" size={20} color={themeAccent} />
                        <Text className="text-base text-foreground">Edit</Text>
                      </Pressable>
                    )}
                    <Pressable
                      onPress={handleDuplicateSecret}
                      className="flex-row items-center gap-3 py-3 px-1"
                    >
                      <Ionicons name="duplicate-outline" size={20} color={themeAccent} />
                      <Text className="text-base text-foreground">Duplicate</Text>
                    </Pressable>
                    <Separator className="my-1" />
                    <Pressable
                      onPress={() => setShowDeleteSecretConfirm(true)}
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

      <BiometricAuth
        isOpen={showAuthForSecret}
        onOpenChange={(open) => { if (!open) setShowAuthForSecret(false); }}
        onSuccess={handleAuthSuccess}
        promptMessage="Authenticate to reveal secret"
      />

      <AddSecretDialog
        isOpen={showAddDialog}
        onOpenChange={(open) => {
          setShowAddDialog(open);
          if (!open) setEditingSecret(null);
        }}
        projectId={id || ''}
        projectName={projectName}
        editSecret={editingSecret}
      />

      <DecryptAllDialog
        isOpen={showDecryptAllDialog}
        onOpenChange={setShowDecryptAllDialog}
        onConfirm={handleDecryptAll}
      />

      <Dialog isOpen={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <Dialog.Portal>
          <Dialog.Overlay />
          <Dialog.Content>
            <Dialog.Close variant="ghost" />
            <View className="gap-4">
              <Dialog.Title>Delete Project?</Dialog.Title>
              <Dialog.Description>
                This will permanently delete this project and all its secrets. This cannot be undone.
              </Dialog.Description>
              <View className="flex-row gap-3 justify-end">
                <Button variant="ghost" size="sm" onPress={() => setShowDeleteConfirm(false)}>
                  <Button.Label>Cancel</Button.Label>
                </Button>
                <Button variant="danger" size="sm" onPress={handleDeleteProject}>
                  <Button.Label>Delete</Button.Label>
                </Button>
              </View>
            </View>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>
    </View>
  );
}
