import { useState, useRef, useEffect, useCallback } from 'react';
import { View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { Dialog, Button, TextField, Input, Label } from 'heroui-native';
import * as Haptics from 'expo-haptics';
import { useApp } from '../context/AppContext';

interface AddProjectDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AddProjectDialog({ isOpen, onOpenChange }: AddProjectDialogProps) {
  const { addProject } = useApp();
  const nameRef = useRef('');
  const nameInputRef = useRef<any>(null);
  const [canSubmit, setCanSubmit] = useState(false);

  const updateCanSubmit = useCallback(() => {
    setCanSubmit(nameRef.current.trim() !== '');
  }, []);

  useEffect(() => {
    if (isOpen) {
      nameRef.current = '';
      nameInputRef.current?.setNativeProps?.({ text: '' });
      setCanSubmit(false);
    }
  }, [isOpen]);

  const handleAdd = async () => {
    const name = nameRef.current;
    if (!name.trim()) return;
    await addProject(name.trim());
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    nameRef.current = '';
    nameInputRef.current?.setNativeProps?.({ text: '' });
    setCanSubmit(false);
    onOpenChange(false);
  };

  return (
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay />
        <KeyboardAvoidingView behavior="padding" style={{ flex: 1, justifyContent: 'center' }}>
          <Dialog.Content>
            <View className="gap-4">
              <View className="flex-row items-center justify-between">
                <Dialog.Title>New Project</Dialog.Title>
                <Dialog.Close variant="ghost" />
              </View>
              <Dialog.Description>
                Create a new project to store your secrets
              </Dialog.Description>
              <TextField>
                <Label>Project Name</Label>
                <Input
                  ref={nameInputRef}
                  defaultValue={nameRef.current}
                  onChangeText={(text) => {
                    nameRef.current = text;
                    updateCanSubmit();
                  }}
                  placeholder="e.g., Work Secrets"
                  autoFocus
                />
              </TextField>
              <Button
                variant="primary"
                onPress={handleAdd}
                isDisabled={!canSubmit}
              >
                <Button.Label>Create Project</Button.Label>
              </Button>
            </View>
          </Dialog.Content>
        </KeyboardAvoidingView>
      </Dialog.Portal>
    </Dialog>
  );
}
