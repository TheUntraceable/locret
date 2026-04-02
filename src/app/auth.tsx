import { useState, useCallback, useEffect } from 'react';
import { View, Text, Pressable } from 'react-native';
import { router } from 'expo-router';
import { Button, useThemeColor } from 'heroui-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as LocalAuthentication from 'expo-local-authentication';
import { useApp } from '../context/AppContext';
import { PinDots, KeypadKey } from '../components/PinPad';

const PIN_LENGTH = 6;
const KEYPAD_BUTTON_SIZE = 68;
const KEYPAD_GAP = 16;

export default function AuthScreen() {
  const {
    authenticate, hasPinSetup, verifyPinAuth, setupPin,
    markAuthenticated, initializeApp, loadProjects, resetApp,
  } = useApp();
  const [themeAccent, themeMuted, themeDanger] = useThemeColor(['accent', 'muted', 'danger']);

  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [mode, setMode] = useState<'loading' | 'auth' | 'pin-setup' | 'pin-confirm' | 'forgot-pin'>('loading');
  const [error, setError] = useState('');
  const [pinError, setPinError] = useState(false);
  const [biometricsAvailable, setBiometricsAvailable] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);

  const displayLength = mode === 'pin-confirm' ? confirmPin.length : pin.length;

  useEffect(() => {
    (async () => {
      await initializeApp();
      setIsInitialized(true);
    })();
  }, [initializeApp]);

  const handleSuccess = useCallback(async () => {
    markAuthenticated();
    await loadProjects();
    router.replace('/(tabs)');
  }, [markAuthenticated, loadProjects]);

  const attemptBiometric = useCallback(async () => {
    try {
      const success = await authenticate();
      if (success) {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        handleSuccess();
      }
    } catch {
      // User can fall back to PIN
    }
  }, [authenticate, handleSuccess]);

  useEffect(() => {
    if (!isInitialized) return;
    (async () => {
      const hasHardware = await LocalAuthentication.hasHardwareAsync();
      const isEnrolled = await LocalAuthentication.isEnrolledAsync();
      setBiometricsAvailable(hasHardware && isEnrolled);

      if (!hasPinSetup) {
        setMode('pin-setup');
      } else {
        setMode('auth');
        if (hasHardware && isEnrolled) {
          attemptBiometric();
        }
      }
    })();
  }, [isInitialized, hasPinSetup, attemptBiometric]);

  const handlePinComplete = useCallback(async (enteredPin: string) => {
    if (mode === 'auth') {
      const success = await verifyPinAuth(enteredPin);
      if (success) {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        handleSuccess();
      } else {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setPinError(true);
        setError('Incorrect PIN');
        setTimeout(() => {
          setPin('');
          setPinError(false);
          setError('');
        }, 600);
      }
    } else if (mode === 'pin-setup') {
      if (enteredPin.length !== PIN_LENGTH) {
        setError(`PIN must be ${PIN_LENGTH} digits`);
        return;
      }
      setConfirmPin('');
      setMode('pin-confirm');
      setError('');
    } else if (mode === 'pin-confirm') {
      if (enteredPin !== pin) {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setPinError(true);
        setError('PINs do not match');
        setTimeout(() => {
          setConfirmPin('');
          setPinError(false);
          setError('');
        }, 600);
        return;
      }
      await setupPin(enteredPin);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      handleSuccess();
    }
  }, [mode, pin, verifyPinAuth, setupPin, handleSuccess]);

  const handleKeyPress = useCallback((key: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setError('');
    setPinError(false);

    if (mode === 'pin-confirm') {
      setConfirmPin((prev) => {
        if (prev.length >= PIN_LENGTH) return prev;
        return prev + key;
      });
    } else {
      setPin((prev) => {
        if (prev.length >= PIN_LENGTH) return prev;
        return prev + key;
      });
    }
  }, [mode]);

  useEffect(() => {
    if (pin.length === PIN_LENGTH) {
      if (mode === 'auth' || mode === 'pin-setup') {
        handlePinComplete(pin);
      }
    }
  }, [pin, mode, handlePinComplete]);

  useEffect(() => {
    if (mode === 'pin-confirm' && confirmPin.length === PIN_LENGTH) {
      handlePinComplete(confirmPin);
    }
  }, [confirmPin, mode, handlePinComplete]);

  const handleDelete = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (mode === 'pin-confirm') {
      setConfirmPin((prev) => prev.slice(0, -1));
    } else {
      setPin((prev) => prev.slice(0, -1));
    }
  }, [mode]);

  const handleResetApp = useCallback(async () => {
    await resetApp();
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    await initializeApp();
    setPin('');
    setConfirmPin('');
    setError('');
    setMode('pin-setup');
  }, [resetApp, initializeApp]);

  if (!isInitialized) {
    return <View className="flex-1 bg-background" />;
  }

  const title = mode === 'pin-setup'
    ? 'Create a PIN'
    : mode === 'pin-confirm'
    ? 'Confirm PIN'
    : mode === 'forgot-pin'
    ? 'Forgot PIN'
    : 'Welcome Back';

  const subtitle = mode === 'pin-setup'
    ? 'Choose a PIN to protect your vault'
    : mode === 'pin-confirm'
    ? 'Enter your PIN once more'
    : mode === 'forgot-pin'
    ? ''
    : 'Enter your PIN to unlock';

  const dotCount = PIN_LENGTH;

  return (
    <View className="flex-1 bg-background">
      {mode === 'forgot-pin' ? (
        <View className="flex-1 px-5">
          {/* Same header pattern as settings */}
          <View className="pt-14 pb-3">
            <Text className="text-3xl font-bold text-foreground">{title}</Text>
            <Text className="text-sm text-muted mt-1">Reset your vault</Text>
          </View>

          <View className="gap-1 mt-4">
            <Text className="text-xs font-semibold text-muted uppercase tracking-wider mb-2 px-1">Warning</Text>

            <View className="bg-surface rounded-xl px-4 py-4 gap-3">
              <View className="flex-row items-center gap-3">
                <Ionicons name="warning-outline" size={20} color={themeDanger} />
                <Text className="text-base font-semibold" style={{ color: themeDanger }}>
                  This cannot be undone
                </Text>
              </View>
              <Text className="text-sm text-muted leading-5">
                This will permanently erase all projects, secrets, your encryption key, and PIN. You will need to set up the app again from scratch.
              </Text>
            </View>

            <View className="mt-6 gap-3">
              <Button
                variant="danger"
                size="md"
                onPress={handleResetApp}
              >
                <Ionicons name="trash-outline" size={16} />
                <Button.Label>Erase All Data & Reset</Button.Label>
              </Button>
              <Button
                variant="ghost"
                size="md"
                onPress={() => { setMode('auth'); setPin(''); setError(''); }}
              >
                <Button.Label>Go Back</Button.Label>
              </Button>
            </View>
          </View>
        </View>
      ) : (
        <View className="flex-1 items-center justify-between pb-10">
          {/* Header */}
          <View className="items-center pt-20 gap-2">
            <View className="w-16 h-16 rounded-full bg-surface items-center justify-center mb-3">
              <Ionicons
                name={mode === 'pin-setup' || mode === 'pin-confirm' ? 'key-outline' : 'shield-checkmark-outline'}
                size={30}
                color={themeAccent}
              />
            </View>
            <Text className="text-2xl font-bold text-foreground">{title}</Text>
            <Text className="text-sm text-muted">{subtitle}</Text>
          </View>

          {/* PIN Dots */}
          <View className="items-center gap-4">
            <PinDots count={dotCount} filled={displayLength} error={pinError} />
            <View style={{ height: 20, justifyContent: 'center' }}>
              {error ? (
                <Text className="text-xs font-semibold" style={{ color: themeDanger }}>{error}</Text>
              ) : null}
            </View>
          </View>

          {/* Keypad */}
          <View className="items-center" style={{ gap: KEYPAD_GAP }}>
            {[['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9']].map((row) => (
              <View key={row.join('')} className="flex-row" style={{ gap: KEYPAD_GAP }}>
                {row.map((num) => (
                  <KeypadKey key={num} size={KEYPAD_BUTTON_SIZE} onPress={() => handleKeyPress(num)}>
                    <Text className="text-2xl font-semibold text-foreground">{num}</Text>
                  </KeypadKey>
                ))}
              </View>
            ))}
            <View className="flex-row" style={{ gap: KEYPAD_GAP }}>
              {/* Bottom-left */}
              {mode === 'auth' && biometricsAvailable ? (
                <KeypadKey size={KEYPAD_BUTTON_SIZE} onPress={attemptBiometric} variant="accent">
                  <Ionicons name="finger-print" size={26} color={themeAccent} />
                </KeypadKey>
              ) : (
                <View style={{ width: KEYPAD_BUTTON_SIZE, height: KEYPAD_BUTTON_SIZE }} />
              )}

              <KeypadKey size={KEYPAD_BUTTON_SIZE} onPress={() => handleKeyPress('0')}>
                <Text className="text-2xl font-semibold text-foreground">0</Text>
              </KeypadKey>

              {/* Bottom-right: delete */}
              {displayLength > 0 ? (
                <KeypadKey size={KEYPAD_BUTTON_SIZE} onPress={handleDelete} variant="ghost">
                  <Ionicons name="backspace-outline" size={24} color={themeMuted} />
                </KeypadKey>
              ) : (
                <View style={{ width: KEYPAD_BUTTON_SIZE, height: KEYPAD_BUTTON_SIZE }} />
              )}
            </View>
          </View>

          {/* Footer */}
          <View className="items-center" style={{ minHeight: 20 }}>
            {mode === 'auth' && (
              <Pressable onPress={() => setMode('forgot-pin')} className="py-2 px-4">
                <Text className="text-sm text-muted">Forgot PIN?</Text>
              </Pressable>
            )}
            {mode === 'pin-confirm' && (
              <Pressable
                onPress={() => { setMode('pin-setup'); setPin(''); setConfirmPin(''); setError(''); }}
                className="py-2 px-4"
              >
                <Text className="text-sm text-muted">Start over</Text>
              </Pressable>
            )}
          </View>
        </View>
      )}
    </View>
  );
}
