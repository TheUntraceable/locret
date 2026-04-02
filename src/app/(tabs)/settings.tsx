import { useState, useCallback, useRef, useEffect } from 'react';
import { View, Text, ScrollView, Pressable } from 'react-native';
import { Dialog, Button, useThemeColor } from 'heroui-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useApp } from '../../context/AppContext';
import { PinDots, KeypadKey } from '../../components/PinPad';

const PIN_LENGTH = 6;
const KEYPAD_BUTTON_SIZE = 68;
const KEYPAD_GAP = 16;

function formatRetryDelay(ms: number): string {
  const totalSeconds = Math.max(1, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes <= 0) return `${seconds}s`;
  if (seconds === 0) return `${minutes}m`;
  return `${minutes}m ${seconds}s`;
}

// Full-screen Change PIN flow component
interface ChangePinScreenProps {
  step: 'current' | 'new' | 'confirm' | 'success';
  error: string;
  errorShake: boolean;
  isInputLocked: boolean;
  onCurrentComplete: (pin: string) => void;
  onNewComplete: (pin: string) => void;
  onConfirmComplete: (pin: string) => void;
  onCancel: () => void;
  onErrorClear: () => void;
}

function ChangePinScreen({
  step,
  error,
  errorShake,
  isInputLocked,
  onCurrentComplete,
  onNewComplete,
  onConfirmComplete,
  onCancel,
  onErrorClear,
}: ChangePinScreenProps) {
  const [themeAccent, themeMuted, themeDanger] = useThemeColor(['accent', 'muted', 'danger']);
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState(false);
  const prevStepRef = useRef(step);
  const isLockedRef = useRef(isInputLocked);

  // Keep ref in sync
  useEffect(() => {
    isLockedRef.current = isInputLocked;
  }, [isInputLocked]);

  // Reset pin when step changes
  if (prevStepRef.current !== step) {
    prevStepRef.current = step;
    if (pin !== '' || pinError) {
      setPin('');
      setPinError(false);
    }
  }

  // Handle shake animation on error
  useEffect(() => {
    if (errorShake) {
      setPinError(true);
      const timeout = setTimeout(() => {
        setPin('');
        setPinError(false);
        onErrorClear();
      }, 600);
      return () => clearTimeout(timeout);
    }
  }, [errorShake, onErrorClear]);

  // Auto-submit when PIN is complete
  useEffect(() => {
    if (pin.length === PIN_LENGTH) {
      if (step === 'current') onCurrentComplete(pin);
      else if (step === 'new') onNewComplete(pin);
      else if (step === 'confirm') onConfirmComplete(pin);
    }
  }, [pin, step, onCurrentComplete, onNewComplete, onConfirmComplete]);

  const handleKeyPress = useCallback((key: string) => {
    if (isLockedRef.current) {
      return;
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setPinError(false);
    setPin((prev) => {
      if (prev.length >= PIN_LENGTH) return prev;
      return prev + key;
    });
  }, []);

  const handleDelete = useCallback(() => {
    if (isLockedRef.current) {
      return;
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setPin((prev) => prev.slice(0, -1));
  }, []);

  const titles: Record<string, string> = {
    current: 'Enter Current PIN',
    new: 'Enter New PIN',
    confirm: 'Confirm New PIN',
    success: 'PIN Updated',
  };

  const subtitles: Record<string, string> = {
    current: 'Verify your identity to continue',
    new: 'Choose a 6-digit PIN',
    confirm: 'Enter your new PIN again',
    success: 'Your PIN has been changed',
  };

  if (step === 'success') {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <View className="items-center gap-4">
          <Ionicons name="checkmark-circle" size={72} color="#22c55e" />
          <Text className="text-2xl font-bold text-foreground">{titles[step]}</Text>
          <Text className="text-sm text-muted">{subtitles[step]}</Text>
        </View>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <View className="flex-1 items-center justify-between pb-10">
        {/* Header */}
        <View className="items-center pt-20 gap-2">
          <View className="w-16 h-16 rounded-full bg-surface items-center justify-center mb-3">
            <Ionicons
              name={step === 'current' ? 'shield-checkmark-outline' : 'key-outline'}
              size={30}
              color={themeAccent}
            />
          </View>
          <Text className="text-2xl font-bold text-foreground">{titles[step]}</Text>
          <Text className="text-sm text-muted">{subtitles[step]}</Text>
        </View>

        {/* PIN Dots */}
        <View className="items-center gap-4">
          <PinDots count={PIN_LENGTH} filled={pin.length} error={pinError} />
          <View style={{ height: 20, justifyContent: 'center' }}>
            {(pinError || error) && (
              <Text className="text-xs font-semibold" style={{ color: themeDanger }}>{error}</Text>
            )}
          </View>
        </View>

        {/* Keypad */}
        <View className="items-center" style={{ gap: KEYPAD_GAP }}>
          {[['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9']].map((row) => (
            <View key={row.join('')} className="flex-row" style={{ gap: KEYPAD_GAP }}>
              {row.map((num) => (
                <KeypadKey key={num} size={KEYPAD_BUTTON_SIZE} onPress={() => handleKeyPress(num)} disabled={isInputLocked}>
                  <Text className="text-2xl font-semibold text-foreground">{num}</Text>
                </KeypadKey>
              ))}
            </View>
          ))}
          <View className="flex-row" style={{ gap: KEYPAD_GAP }}>
            <View style={{ width: KEYPAD_BUTTON_SIZE, height: KEYPAD_BUTTON_SIZE }} />
            <KeypadKey size={KEYPAD_BUTTON_SIZE} onPress={() => handleKeyPress('0')} disabled={isInputLocked}>
              <Text className="text-2xl font-semibold text-foreground">0</Text>
            </KeypadKey>
            {pin.length > 0 ? (
              <KeypadKey size={KEYPAD_BUTTON_SIZE} onPress={handleDelete} variant="ghost" disabled={isInputLocked}>
                <Ionicons name="backspace-outline" size={24} color={themeMuted} />
              </KeypadKey>
            ) : (
              <View style={{ width: KEYPAD_BUTTON_SIZE, height: KEYPAD_BUTTON_SIZE }} />
            )}
          </View>
        </View>

        {/* Footer */}
        <View className="items-center" style={{ minHeight: 20 }}>
          <Pressable onPress={onCancel} className="py-2 px-4">
            <Text className="text-sm text-muted">Cancel</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

export default function SettingsTab() {
  const { hasPinSetup, verifyPinAuth, setupPin, resetApp, initializeApp, projects, lockApp, getPinLockoutRemaining } = useApp();
  const [themeAccent, themeDanger, themeMuted] = useThemeColor(['accent', 'danger', 'muted']);

  const [showChangePinFlow, setShowChangePinFlow] = useState(false);
  const [showResetDialog, setShowResetDialog] = useState(false);

  // Change PIN state
  type PinStep = 'current' | 'new' | 'confirm' | 'success';
  const [pinStep, setPinStep] = useState<PinStep>('current');
  const [newPin, setNewPin] = useState('');
  const [pinError, setPinError] = useState('');
  const [pinErrorShake, setPinErrorShake] = useState(false);
  const [pinLockoutUntil, setPinLockoutUntil] = useState(0);
  const [pinLockoutRemainingMs, setPinLockoutRemainingMs] = useState(0);

  const isPinInputLocked = pinStep === 'current' && pinLockoutRemainingMs > 0;

  useEffect(() => {
    if (pinLockoutUntil <= Date.now()) {
      return;
    }

    const tick = () => {
      const remaining = Math.max(0, pinLockoutUntil - Date.now());
      setPinLockoutRemainingMs(remaining);
    };

    const intervalId = setInterval(tick, 250);
    return () => clearInterval(intervalId);
  }, [pinLockoutUntil]);

  useEffect(() => {
    if (pinStep !== 'current') return;

    if (pinLockoutRemainingMs > 0) {
      setPinError(`Try again in ${formatRetryDelay(pinLockoutRemainingMs)}`);
      setPinErrorShake(false);
    } else if (pinLockoutUntil > 0) {
      setPinLockoutUntil(0);
      setPinError('');
      setPinErrorShake(false);
    }
  }, [pinStep, pinLockoutRemainingMs, pinLockoutUntil]);

  const resetPinForm = useCallback(async () => {
    setNewPin('');
    setPinError('');
    setPinErrorShake(false);
    setPinStep('current');
    
    // Check for existing lockout
    const lockoutMs = await getPinLockoutRemaining();
    if (lockoutMs > 0) {
      setPinLockoutRemainingMs(lockoutMs);
      setPinLockoutUntil(Date.now() + lockoutMs);
    } else {
      setPinLockoutUntil(0);
      setPinLockoutRemainingMs(0);
    }
  }, [getPinLockoutRemaining]);

  const handleCurrentPinComplete = useCallback(async (enteredPin: string) => {
    const result = await verifyPinAuth(enteredPin);
    if (result.success) {
      setPinLockoutUntil(0);
      setPinLockoutRemainingMs(0);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setPinStep('new');
      setPinError('');
    } else {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      if (result.retryAfterMs > 0) {
        setPinLockoutRemainingMs(result.retryAfterMs);
        setPinLockoutUntil(Date.now() + result.retryAfterMs);
        setPinErrorShake(false);
      } else {
        setPinError('Incorrect PIN');
        setPinErrorShake(true);
      }
    }
  }, [verifyPinAuth]);

  const handleNewPinComplete = useCallback(async (enteredPin: string) => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setNewPin(enteredPin);
    setPinStep('confirm');
    setPinError('');
  }, []);

  const handleConfirmPinComplete = useCallback(async (enteredPin: string) => {
    if (enteredPin === newPin) {
      await setupPin(enteredPin);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setPinStep('success');
      setTimeout(() => {
        setShowChangePinFlow(false);
        resetPinForm();
      }, 1200);
    } else {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setPinError('PINs do not match');
      setPinErrorShake(true);
    }
  }, [newPin, setupPin, resetPinForm]);

  const handleResetApp = useCallback(async () => {
    await resetApp();
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    await initializeApp();
    setShowResetDialog(false);
  }, [resetApp, initializeApp]);

  const handleLockApp = useCallback(async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    lockApp();
    router.replace('/auth');
  }, [lockApp]);

  // Full-screen Change PIN flow
  if (showChangePinFlow) {
    return (
      <ChangePinScreen
        step={pinStep}
        error={pinError}
        errorShake={pinErrorShake}
        isInputLocked={isPinInputLocked}
        onCurrentComplete={handleCurrentPinComplete}
        onNewComplete={handleNewPinComplete}
        onConfirmComplete={handleConfirmPinComplete}
        onCancel={() => { setShowChangePinFlow(false); resetPinForm(); }}
        onErrorClear={() => setPinErrorShake(false)}
      />
    );
  }

  return (
    <View className="flex-1 bg-background">
      <View className="px-5 pt-14 pb-3">
        <Text className="text-3xl font-bold text-foreground">Settings</Text>
        <Text className="text-sm text-muted mt-1">Manage your vault</Text>
      </View>

      <ScrollView className="flex-1 px-5" showsVerticalScrollIndicator={false}>
        <View className="gap-1 pb-28">
          {/* Security Section */}
          <Text className="text-xs font-semibold text-muted uppercase tracking-wider mt-4 mb-2 px-1">Security</Text>

          <Pressable
            onPress={() => { resetPinForm(); setShowChangePinFlow(true); }}
            className="flex-row items-center justify-between bg-surface rounded-xl px-4 py-4"
          >
            <View className="flex-row items-center gap-3">
              <Ionicons name="keypad-outline" size={20} color={themeAccent} />
              <View>
                <Text className="text-base text-foreground">Change PIN</Text>
                <Text className="text-xs text-muted">Update your authentication PIN</Text>
              </View>
            </View>
            <Ionicons name="chevron-forward" size={18} color={themeMuted} />
          </Pressable>

          <View className="h-1" />

          <Pressable
            onPress={handleLockApp}
            className="flex-row items-center justify-between bg-surface rounded-xl px-4 py-4"
          >
            <View className="flex-row items-center gap-3">
              <Ionicons name="lock-closed-outline" size={20} color={themeAccent} />
              <View>
                <Text className="text-base text-foreground">Lock App</Text>
                <Text className="text-xs text-muted">Clear sensitive data from memory</Text>
              </View>
            </View>
            <Ionicons name="chevron-forward" size={18} color={themeMuted} />
          </Pressable>

          {/* Data Section */}
          <Text className="text-xs font-semibold text-muted uppercase tracking-wider mt-6 mb-2 px-1">Data</Text>

          <View className="bg-surface rounded-xl px-4 py-4">
            <View className="flex-row items-center gap-3">
              <Ionicons name="folder-outline" size={20} color={themeAccent} />
              <View>
                <Text className="text-base text-foreground">Projects</Text>
                <Text className="text-xs text-muted">{projects.length} {projects.length === 1 ? 'project' : 'projects'} in your vault</Text>
              </View>
            </View>
          </View>

          <View className="h-1" />

          <Pressable
            onPress={() => setShowResetDialog(true)}
            className="flex-row items-center justify-between bg-surface rounded-xl px-4 py-4"
          >
            <View className="flex-row items-center gap-3">
              <Ionicons name="warning-outline" size={20} color={themeDanger} />
              <View>
                <Text className="text-base" style={{ color: themeDanger }}>Reset App</Text>
                <Text className="text-xs text-muted">Erase all data and start fresh</Text>
              </View>
            </View>
            <Ionicons name="chevron-forward" size={18} color={themeMuted} />
          </Pressable>

          {/* About Section */}
          <Text className="text-xs font-semibold text-muted uppercase tracking-wider mt-6 mb-2 px-1">About</Text>

          <View className="bg-surface rounded-xl px-4 py-4 gap-3">
            <View className="flex-row items-center justify-between">
              <Text className="text-sm text-muted">Version</Text>
              <Text className="text-sm text-foreground">1.0.0</Text>
            </View>
            <View className="flex-row items-center justify-between">
              <Text className="text-sm text-muted">Encryption</Text>
              <Text className="text-sm text-foreground">AES-256-GCM</Text>
            </View>
            <View className="flex-row items-center justify-between">
              <Text className="text-sm text-muted">Key Storage</Text>
              <Text className="text-sm text-foreground">Hardware-backed</Text>
            </View>
            <View className="flex-row items-center justify-between">
              <Text className="text-sm text-muted">PIN Setup</Text>
              <Text className="text-sm text-foreground">{hasPinSetup ? 'Configured' : 'Not set'}</Text>
            </View>
          </View>
        </View>
      </ScrollView>

      {/* Reset App Dialog */}
      <Dialog isOpen={showResetDialog} onOpenChange={setShowResetDialog}>
        <Dialog.Portal>
          <Dialog.Overlay />
          <Dialog.Content>
            <View className="gap-4">
              <View className="flex-row items-center justify-between">
                <Dialog.Title>Reset App?</Dialog.Title>
                <Dialog.Close variant="ghost" />
              </View>
              <Dialog.Description>
                This will permanently erase all projects, secrets, your encryption key, and PIN. You will need to set up again from scratch. This cannot be undone.
              </Dialog.Description>
              <View className="flex-row gap-3 justify-end">
                <Button variant="ghost" size="sm" onPress={() => setShowResetDialog(false)}>
                  <Button.Label>Cancel</Button.Label>
                </Button>
                <Button variant="danger" size="sm" onPress={handleResetApp}>
                  <Button.Label>Erase Everything</Button.Label>
                </Button>
              </View>
            </View>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>
    </View>
  );
}
