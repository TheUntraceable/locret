import { useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { Dialog, Button, TextField, Input, Label, useThemeColor } from 'heroui-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { isValidBase32, parseOtpAuthUri } from '../utils/totp';
import type { TotpAlgorithm } from '../types';

type Mode = 'scan' | 'manual';

interface AddTotpDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (issuer: string, accountName: string, secret: string, period?: number, digits?: number, algorithm?: TotpAlgorithm) => Promise<void>;
  onEdit?: (accountId: string, issuer: string, accountName: string) => Promise<void>;
  editAccount?: { id: string; issuer: string; accountName: string } | null;
}

export function AddTotpDialog({ isOpen, onOpenChange, onAdd, onEdit, editAccount }: AddTotpDialogProps) {
  const isEditing = !!editAccount;
  const [mode, setMode] = useState<Mode>('scan');
  const issuerRef = useRef('');
  const accountNameRef = useRef('');
  const secretRef = useRef('');
  const issuerInputRef = useRef<any>(null);
  const accountNameInputRef = useRef<any>(null);
  const secretInputRef = useRef<any>(null);
  const [secretError, setSecretError] = useState('');
  const [scanError, setScanError] = useState('');
  const [hasScanned, setHasScanned] = useState(false);
  const [canManualSubmit, setCanManualSubmit] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const [themeFg, themeMuted, themeDanger] = useThemeColor(['foreground', 'muted', 'danger']);
  const scanLockRef = useRef(false);
  const hasInitializedRef = useRef(false);
  const prevIsOpenRef = useRef(isOpen);
  const prevEditIdRef = useRef<string | null>(editAccount?.id ?? null);

  const updateCanManualSubmit = useCallback(() => {
    const hasIssuer = issuerRef.current.trim() !== '';
    const hasAccountName = accountNameRef.current.trim() !== '';
    const hasSecret = secretRef.current.trim() !== '';
    setCanManualSubmit(hasIssuer && hasAccountName && (isEditing || hasSecret));
  }, [isEditing]);

  useEffect(() => {
    const currentEditId = editAccount?.id ?? null;
    const openedNow = isOpen && !prevIsOpenRef.current;
    const changedEditTargetWhileOpen = isOpen && currentEditId !== prevEditIdRef.current;

    if (openedNow || changedEditTargetWhileOpen) {
      hasInitializedRef.current = false;
    }

    if (isOpen && !hasInitializedRef.current) {
      if (isEditing && editAccount) {
        issuerRef.current = editAccount.issuer;
        accountNameRef.current = editAccount.accountName;
        secretRef.current = '';
        issuerInputRef.current?.setNativeProps?.({ text: issuerRef.current });
        accountNameInputRef.current?.setNativeProps?.({ text: accountNameRef.current });
        secretInputRef.current?.setNativeProps?.({ text: '' });
        setCanManualSubmit(true);
      } else {
        issuerRef.current = '';
        accountNameRef.current = '';
        secretRef.current = '';
        issuerInputRef.current?.setNativeProps?.({ text: '' });
        accountNameInputRef.current?.setNativeProps?.({ text: '' });
        secretInputRef.current?.setNativeProps?.({ text: '' });
        setCanManualSubmit(false);
      }

      setSecretError('');
      setScanError('');
      setHasScanned(false);
      setMode('scan');
      hasInitializedRef.current = true;
    } else if (!isOpen) {
      hasInitializedRef.current = false;
      scanLockRef.current = false;
    }

    prevIsOpenRef.current = isOpen;
    prevEditIdRef.current = currentEditId;
  }, [isOpen, isEditing, editAccount]);

  useEffect(() => {
    if (isOpen && mode === 'scan' && !permission?.granted) {
      requestPermission();
    }
  }, [isOpen, mode, permission, requestPermission]);

  const handleBarCodeScanned = async ({ data }: { data: string }) => {
    if (scanLockRef.current) return;
    scanLockRef.current = true;

    const parsed = parseOtpAuthUri(data);
    if (!parsed) {
      setScanError('Not a valid 2FA QR code');
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setTimeout(() => {
        setScanError('');
        scanLockRef.current = false;
      }, 2000);
      return;
    }

    setHasScanned(true);
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    await onAdd(parsed.issuer, parsed.accountName, parsed.secret, parsed.period, parsed.digits, parsed.algorithm);
    onOpenChange(false);
  };

  const handleSecretChange = (text: string) => {
    secretRef.current = text;
    if (secretError) setSecretError('');
    updateCanManualSubmit();
  };

  const handleManualSubmit = async () => {
    const issuer = issuerRef.current;
    const accountName = accountNameRef.current;
    const secret = secretRef.current;

    if (!issuer.trim() || !accountName.trim()) return;

    if (isEditing && editAccount && onEdit) {
      await onEdit(editAccount.id, issuer.trim(), accountName.trim());
    } else {
      const cleanedSecret = secret.replace(/\s/g, '');
      if (!isValidBase32(cleanedSecret)) {
        setSecretError('Invalid base32 secret key');
        return;
      }
      await onAdd(issuer.trim(), accountName.trim(), cleanedSecret.toUpperCase());
    }

    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    onOpenChange(false);
  };

  const renderScanMode = () => {
    if (!permission?.granted) {
      return (
        <View className="items-center justify-center py-12 gap-4">
          <View className="w-16 h-16 rounded-full bg-surface items-center justify-center">
            <Ionicons name="camera-outline" size={32} color={themeMuted} />
          </View>
          <Text className="text-base font-semibold text-foreground text-center">
            Camera Access Required
          </Text>
          <Text className="text-sm text-muted text-center leading-5">
            Allow camera access to scan QR codes from your 2FA setup pages.
          </Text>
          <Button variant="primary" size="md" onPress={requestPermission}>
            <Button.Label>Grant Permission</Button.Label>
          </Button>
        </View>
      );
    }

    return (
      <View className="gap-4">
        <View className="rounded-2xl overflow-hidden" style={styles.cameraContainer}>
          {!hasScanned && (
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={handleBarCodeScanned}
            />
          )}
          {/* Scan overlay */}
          <View style={StyleSheet.absoluteFill} className="items-center justify-center">
            <View
              className="w-52 h-52 rounded-2xl border-2"
              style={{ borderColor: scanError ? themeDanger : 'rgba(255,255,255,0.8)' }}
            />
          </View>
          {scanError ? (
            <View
              style={StyleSheet.absoluteFill}
              className="items-center justify-end pb-6"
            >
              <View className="bg-danger/90 rounded-lg px-4 py-2">
                <Text className="text-white text-sm font-medium">{scanError}</Text>
              </View>
            </View>
          ) : null}
        </View>
        <Text className="text-sm text-muted text-center">
          Point your camera at the QR code from your account&apos;s 2FA setup page
        </Text>
      </View>
    );
  };

  const renderManualMode = () => (
    <View className="gap-4">
      <TextField>
        <Label>Service / Issuer</Label>
        <Input
          ref={issuerInputRef}
          defaultValue={issuerRef.current}
          onChangeText={(text) => {
            issuerRef.current = text;
            updateCanManualSubmit();
          }}
          placeholder="e.g., GitHub, Google"
          autoFocus={isEditing}
        />
      </TextField>
      <TextField>
        <Label>Account Name</Label>
        <Input
          ref={accountNameInputRef}
          defaultValue={accountNameRef.current}
          onChangeText={(text) => {
            accountNameRef.current = text;
            updateCanManualSubmit();
          }}
          placeholder="e.g., user@example.com"
          autoCapitalize="none"
          autoFocus={!isEditing}
        />
      </TextField>
      {!isEditing && (
      <TextField isInvalid={!!secretError}>
        <Label>Secret Key</Label>
        <Input
          ref={secretInputRef}
          defaultValue={secretRef.current}
          onChangeText={handleSecretChange}
          placeholder="e.g., JBSWY3DPEHPK3PXP"
          autoCapitalize="characters"
          autoCorrect={false}
          className="font-mono"
        />
        {secretError ? (
          <Text className="text-xs mt-1" style={{ color: themeDanger }}>
            {secretError}
          </Text>
        ) : null}
      </TextField>
      )}
      <Button
        variant="primary"
        onPress={handleManualSubmit}
        isDisabled={!canManualSubmit}
      >
        <Button.Label>{isEditing ? 'Save Changes' : 'Add Account'}</Button.Label>
      </Button>
    </View>
  );

  return (
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay />
        <KeyboardAvoidingView behavior="padding" style={{ flex: 1, justifyContent: 'center' }}>
          <Dialog.Content>
            <View className="gap-4">
              <View className="flex-row justify-between items-center">
                <Dialog.Title>{isEditing ? 'Edit Account' : 'Add Account'}</Dialog.Title>
                <Dialog.Close variant="ghost" />
              </View>

              {!isEditing && (
              /* Mode toggle */
              <View className="flex-row border border-border rounded-lg p-1">
                <Pressable
                  onPress={() => setMode('scan')}
                  className={`flex-1 flex-row items-center justify-center gap-2 py-2 rounded-md ${mode === 'scan' ? 'bg-surface-secondary' : ''}`}
                >
                  <Ionicons
                    name="qr-code-outline"
                    size={15}
                    color={mode === 'scan' ? themeFg : themeMuted}
                  />
                  <Text
                    className={`text-sm font-medium ${mode === 'scan' ? 'text-foreground' : 'text-muted'}`}
                  >
                    Scan QR
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => setMode('manual')}
                  className={`flex-1 flex-row items-center justify-center gap-2 py-2 rounded-md ${mode === 'manual' ? 'bg-surface-secondary' : ''}`}
                >
                  <Ionicons
                    name="keypad-outline"
                    size={15}
                    color={mode === 'manual' ? themeFg : themeMuted}
                  />
                  <Text
                    className={`text-sm font-medium ${mode === 'manual' ? 'text-foreground' : 'text-muted'}`}
                  >
                    Enter Key
                  </Text>
                </Pressable>
              </View>
              )}

              {isEditing ? renderManualMode() : (mode === 'scan' ? renderScanMode() : renderManualMode())}
            </View>
          </Dialog.Content>
        </KeyboardAvoidingView>
      </Dialog.Portal>
    </Dialog>
  );
}

const styles = StyleSheet.create({
  cameraContainer: {
    height: 280,
    backgroundColor: '#000',
  },
});
