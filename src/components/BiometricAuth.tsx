import { useState, useCallback, useEffect } from 'react';
import { View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { Dialog, Button, Input, Label, TextField } from 'heroui-native';
import * as LocalAuthentication from 'expo-local-authentication';
import * as Haptics from 'expo-haptics';
import { useApp } from '../context/AppContext';

const PIN_LENGTH = 6;

interface BiometricAuthProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  promptMessage?: string;
}

export function BiometricAuth({
  isOpen,
  onOpenChange,
  onSuccess,
  promptMessage = 'Authenticate to continue',
}: BiometricAuthProps) {
  const { authenticate, hasPinSetup, verifyPinAuth, setupPin, markAuthenticated, resetApp, initializeApp } = useApp();
  const [mode, setMode] = useState<'choose' | 'biometric' | 'pin' | 'pin-setup' | 'forgot-pin'>('choose');
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [pinError, setPinError] = useState('');
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [biometricsAvailable, setBiometricsAvailable] = useState(false);

  useEffect(() => {
    if (isOpen) {
      (async () => {
        const hasHardware = await LocalAuthentication.hasHardwareAsync();
        const isEnrolled = await LocalAuthentication.isEnrolledAsync();
        setBiometricsAvailable(hasHardware && isEnrolled);

        if (!hasPinSetup) {
          setMode('pin-setup');
        } else if (hasHardware && isEnrolled) {
          setMode('biometric');
        } else {
          setMode('pin');
        }
      })();
    }
  }, [isOpen, hasPinSetup]);

  const handleBiometricAuth = useCallback(async () => {
    setIsAuthenticating(true);
    try {
      const success = await authenticate();
      if (success) {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        markAuthenticated();
        onSuccess();
        onOpenChange(false);
      } else {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setMode('pin');
      }
    } finally {
      setIsAuthenticating(false);
    }
  }, [authenticate, onSuccess, onOpenChange, markAuthenticated]);

  const handlePinAuth = useCallback(async () => {
    if (!pin) return;
    setIsAuthenticating(true);
    try {
      const success = await verifyPinAuth(pin);
      if (success) {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        markAuthenticated();
        onSuccess();
        onOpenChange(false);
        setPin('');
        setPinError('');
      } else {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setPinError('Incorrect PIN');
      }
    } finally {
      setIsAuthenticating(false);
    }
  }, [pin, verifyPinAuth, onSuccess, onOpenChange, markAuthenticated]);

  const handlePinSetup = useCallback(async () => {
    if (pin.length !== PIN_LENGTH) {
      setPinError(`PIN must be ${PIN_LENGTH} digits`);
      return;
    }
    if (mode === 'pin-setup' && confirmPin !== pin) {
      setPinError('PINs do not match');
      return;
    }
    if (mode === 'pin-setup' && confirmPin === pin) {
      await setupPin(pin);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      markAuthenticated();
      onSuccess();
      onOpenChange(false);
      setPin('');
      setConfirmPin('');
      setPinError('');
      return;
    }
    setPinError('');
  }, [pin, confirmPin, mode, setupPin, onSuccess, onOpenChange, markAuthenticated]);

  const handleResetApp = useCallback(async () => {
    await resetApp();
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    await initializeApp();
    setMode('pin-setup');
    setPin('');
    setConfirmPin('');
    setPinError('');
  }, [resetApp, initializeApp]);

  return (
    <Dialog isOpen={isOpen} onOpenChange={() => {}}>
      <Dialog.Portal>
        <Dialog.Overlay />
        <KeyboardAvoidingView behavior="padding" style={{ flex: 1, justifyContent: 'center' }}>
          <Dialog.Content>
            <View className="gap-4">
              <Dialog.Title>{promptMessage}</Dialog.Title>

              {mode === 'biometric' && (
                <>
                  <Dialog.Description>
                    Use your fingerprint or face to continue
                  </Dialog.Description>
                  <Button
                    variant="primary"
                    onPress={handleBiometricAuth}
                    isDisabled={isAuthenticating}
                  >
                    <Button.Label>Use Biometrics</Button.Label>
                  </Button>
                  {hasPinSetup && (
                    <Button
                      variant="ghost"
                      onPress={() => setMode('pin')}
                    >
                      <Button.Label>Use PIN instead</Button.Label>
                    </Button>
                  )}
                </>
              )}

              {mode === 'pin' && (
                <>
                  <Dialog.Description>
                    Enter your PIN to continue
                  </Dialog.Description>
                  <TextField isInvalid={!!pinError}>
                    <Label>PIN</Label>
                    <Input
                      value={pin}
                      onChangeText={(t) => { setPin(t); setPinError(''); }}
                      secureTextEntry
                      keyboardType="number-pad"
                      placeholder="Enter your PIN"
                      autoFocus
                    />
                    {pinError && <Label>{pinError}</Label>}
                  </TextField>
                  <Button
                    variant="primary"
                    onPress={handlePinAuth}
                    isDisabled={isAuthenticating || !pin}
                  >
                    <Button.Label>Verify PIN</Button.Label>
                  </Button>
                  <View className="flex-row justify-between">
                    {biometricsAvailable && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onPress={() => setMode('biometric')}
                      >
                        <Button.Label>Use Biometrics</Button.Label>
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onPress={() => setMode('forgot-pin')}
                    >
                      <Button.Label>Forgot PIN?</Button.Label>
                    </Button>
                  </View>
                </>
              )}

              {mode === 'pin-setup' && (
                <>
                  <Dialog.Description>
                    Set up a PIN as a backup for when biometrics are not available
                  </Dialog.Description>
                  <TextField isInvalid={!!pinError}>
                    <Label>PIN</Label>
                    <Input
                      value={pin}
                      onChangeText={(t) => { setPin(t); setPinError(''); }}
                      secureTextEntry
                      keyboardType="number-pad"
                        placeholder={`Enter ${PIN_LENGTH}-digit PIN`}
                      autoFocus
                    />
                  </TextField>
                  <TextField isInvalid={!!pinError}>
                    <Label>Confirm PIN</Label>
                    <Input
                      value={confirmPin}
                      onChangeText={(t) => { setConfirmPin(t); setPinError(''); }}
                      secureTextEntry
                      keyboardType="number-pad"
                      placeholder="Confirm your PIN"
                    />
                    {pinError && <Label>{pinError}</Label>}
                  </TextField>
                  <Button
                    variant="primary"
                    onPress={handlePinSetup}
                    isDisabled={isAuthenticating || !pin || !confirmPin}
                  >
                    <Button.Label>Set PIN</Button.Label>
                  </Button>
                </>
              )}

              {mode === 'forgot-pin' && (
                <>
                  <Dialog.Description>
                    Resetting your PIN will erase all projects and secrets. This cannot be undone.
                  </Dialog.Description>
                  <Button
                    variant="danger"
                    onPress={handleResetApp}
                  >
                    <Button.Label>Erase All Data & Reset PIN</Button.Label>
                  </Button>
                  <Button
                    variant="ghost"
                    onPress={() => { setMode('pin'); setPinError(''); }}
                  >
                    <Button.Label>Go Back</Button.Label>
                  </Button>
                </>
              )}
            </View>
          </Dialog.Content>
        </KeyboardAvoidingView>
      </Dialog.Portal>
    </Dialog>
  );
}
