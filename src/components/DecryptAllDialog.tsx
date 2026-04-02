import { useState } from 'react';
import { View } from 'react-native';
import { Dialog, Button } from 'heroui-native';
import { BiometricAuth } from './BiometricAuth';
import { useApp } from '../context/AppContext';

interface DecryptAllDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

export function DecryptAllDialog({ isOpen, onOpenChange, onConfirm }: DecryptAllDialogProps) {
  const { isSessionValid } = useApp();
  const [showAuth, setShowAuth] = useState(false);
  const [step, setStep] = useState<'confirm' | 'auth'>('confirm');

  const handleConfirm = () => {
    if (isSessionValid()) {
      onConfirm();
      onOpenChange(false);
      return;
    }
    setStep('auth');
    setShowAuth(true);
  };

  const handleAuthSuccess = () => {
    onConfirm();
    onOpenChange(false);
    setStep('confirm');
    setShowAuth(false);
  };

  const handleClose = () => {
    onOpenChange(false);
    setStep('confirm');
    setShowAuth(false);
  };

  return (
    <>
      <Dialog isOpen={isOpen && step === 'confirm'} onOpenChange={handleClose}>
        <Dialog.Portal>
          <Dialog.Overlay />
          <Dialog.Content>
            <View className="gap-4">
              <View className="flex-row items-center justify-between">
                <Dialog.Title>Decrypt All Secrets?</Dialog.Title>
                <Dialog.Close variant="ghost" />
              </View>
              <Dialog.Description>
                Are you sure? This will reveal all the secrets in this project.
              </Dialog.Description>
              <View className="flex-row gap-3 justify-end">
                <Button variant="ghost" size="sm" onPress={handleClose}>
                  <Button.Label>Cancel</Button.Label>
                </Button>
                <Button variant="danger" size="sm" onPress={handleConfirm}>
                  <Button.Label>Confirm</Button.Label>
                </Button>
              </View>
            </View>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>

      <BiometricAuth
        isOpen={showAuth}
        onOpenChange={(open) => {
          if (!open) {
            setShowAuth(false);
            setStep('confirm');
          }
        }}
        onSuccess={handleAuthSuccess}
        promptMessage="Authenticate to decrypt all secrets"
      />
    </>
  );
}
