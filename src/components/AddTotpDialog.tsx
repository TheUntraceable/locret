import { useState, useEffect, useRef } from 'react';
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
  const [issuer, setIssuer] = useState('');
  const [accountName, setAccountName] = useState('');
  const [secret, setSecret] = useState('');
  const [secretError, setSecretError] = useState('');
  const [scanError, setScanError] = useState('');
  const [hasScanned, setHasScanned] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const [themeAccent, themeMuted, themeDanger] = useThemeColor(['accent', 'muted', 'danger']);
  const scanLockRef = useRef(false);

  useEffect(() => {
    if (isOpen && isEditing && editAccount) {
      setIssuer(editAccount.issuer);
      setAccountName(editAccount.accountName);
      setSecret('');
      setSecretError('');
      setScanError('');
      setHasScanned(false);
      setMode('scan');
    } else if (!isOpen) {
      setMode('scan');
      setIssuer('');
      setAccountName('');
      setSecret('');
      setSecretError('');
      setScanError('');
      setHasScanned(false);
      scanLockRef.current = false;
    }
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
    setSecret(text);
    if (secretError) setSecretError('');
  };

  const handleManualSubmit = async () => {
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
              style={{ borderColor: scanError ? themeDanger : themeAccent }}
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
          Point your camera at the QR code from your account's 2FA setup page
        </Text>
      </View>
    );
  };

  const renderManualMode = () => (
    <View className="gap-4">
      <TextField>
        <Label>Service / Issuer</Label>
        <Input
          value={issuer}
          onChangeText={setIssuer}
          placeholder="e.g., GitHub, Google"
          autoFocus={isEditing}
        />
      </TextField>
      <TextField>
        <Label>Account Name</Label>
        <Input
          value={accountName}
          onChangeText={setAccountName}
          placeholder="e.g., user@example.com"
          autoCapitalize="none"
          autoFocus={!isEditing}
        />
      </TextField>
      {!isEditing && (
      <TextField isInvalid={!!secretError}>
        <Label>Secret Key</Label>
        <Input
          value={secret}
          onChangeText={handleSecretChange}
          placeholder="e.g., JBSWY3DPEHPK3PXP"
          autoCapitalize="characters"
          autoCorrect={false}
        />
        {secretError ? (
          <Label style={{ color: themeDanger, fontSize: 12, marginTop: 4 }}>
            {secretError}
          </Label>
        ) : null}
      </TextField>
      )}
      <Button
        variant="primary"
        onPress={handleManualSubmit}
        isDisabled={!issuer.trim() || !accountName.trim() || (!isEditing && !secret.trim())}
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
              <View className="flex-row bg-surface rounded-xl p-1">
                <Pressable
                  onPress={() => setMode('scan')}
                  className="flex-1 flex-row items-center justify-center gap-2 py-2.5 rounded-lg"
                  style={mode === 'scan' ? { backgroundColor: `${themeAccent}20` } : undefined}
                >
                  <Ionicons
                    name="qr-code-outline"
                    size={16}
                    color={mode === 'scan' ? themeAccent : themeMuted}
                  />
                  <Text
                    className="text-sm font-medium"
                    style={{ color: mode === 'scan' ? themeAccent : themeMuted }}
                  >
                    Scan QR
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => setMode('manual')}
                  className="flex-1 flex-row items-center justify-center gap-2 py-2.5 rounded-lg"
                  style={mode === 'manual' ? { backgroundColor: `${themeAccent}20` } : undefined}
                >
                  <Ionicons
                    name="keypad-outline"
                    size={16}
                    color={mode === 'manual' ? themeAccent : themeMuted}
                  />
                  <Text
                    className="text-sm font-medium"
                    style={{ color: mode === 'manual' ? themeAccent : themeMuted }}
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
