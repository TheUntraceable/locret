import { useState } from 'react';
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
  const [name, setName] = useState('');

  const handleAdd = async () => {
    if (!name.trim()) return;
    await addProject(name.trim());
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setName('');
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
                  value={name}
                  onChangeText={setName}
                  placeholder="e.g., Work Secrets"
                  autoFocus
                />
              </TextField>
              <Button
                variant="primary"
                onPress={handleAdd}
                isDisabled={!name.trim()}
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
