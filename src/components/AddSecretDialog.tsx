import { useState, useEffect, useMemo, memo, useRef, useCallback } from 'react';
import { View, Text, Pressable } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { Dialog, Button, TextField, Input, Label, Separator, useThemeColor } from 'heroui-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useApp } from '../context/AppContext';
import { scheduleExpiryNotifications, cancelExpiryNotifications } from '../utils/notifications';

const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const THEME_COLORS = ['accent', 'muted', 'foreground'] as const;

function isSameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
}

interface AddSecretDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  projectName?: string;
  editSecret?: {
    id: string;
    name: string;
    description?: string;
    decryptedValue: string;
    expiresAt?: string;
  } | null;
}

function AddSecretDialogComponent({ isOpen, onOpenChange, projectId, projectName, editSecret }: AddSecretDialogProps) {
  const { addSecret, updateSecret } = useApp();
  
  // Use refs for input values to avoid controlled input jank
  const nameRef = useRef('');
  const descriptionRef = useRef('');
  const valueRef = useRef('');
  const nameInputRef = useRef<any>(null);
  const descriptionInputRef = useRef<any>(null);
  const valueInputRef = useRef<any>(null);
  
  // Only use state for values that affect UI (button disabled state)
  const [canSubmit, setCanSubmit] = useState(false);
  const [showValue, setShowValue] = useState(false);
  const [expiresAt, setExpiresAt] = useState<Date | null>(null);
  const [view, setView] = useState<'form' | 'calendar'>('form');
  const [themeAccent, themeMuted, themeForeground] = useThemeColor(THEME_COLORS);
  
  // Track if we've already initialized for the current open state
  const hasInitializedRef = useRef(false);
  const prevIsOpenRef = useRef(isOpen);

  const isEditing = !!editSecret;
  
  const updateCanSubmit = useCallback(() => {
    setCanSubmit(nameRef.current.trim() !== '' && valueRef.current !== '');
  }, []);

  // Calendar state
  const today = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);

  const [viewMonth, setViewMonth] = useState(() => {
    const d = expiresAt ?? new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });

  useEffect(() => {
    // Only initialize when dialog opens (transition from closed to open)
    if (isOpen && !prevIsOpenRef.current) {
      hasInitializedRef.current = false;
    }
    
    if (isOpen && !hasInitializedRef.current) {
      if (editSecret) {
        nameRef.current = editSecret.name;
        descriptionRef.current = editSecret.description || '';
        valueRef.current = editSecret.decryptedValue;
        setExpiresAt(editSecret.expiresAt ? new Date(editSecret.expiresAt) : null);
      } else {
        nameRef.current = '';
        descriptionRef.current = '';
        valueRef.current = '';
        setExpiresAt(null);
      }
      // Update input values directly
      nameInputRef.current?.setNativeProps?.({ text: nameRef.current });
      descriptionInputRef.current?.setNativeProps?.({ text: descriptionRef.current });
      valueInputRef.current?.setNativeProps?.({ text: valueRef.current });
      
      setShowValue(false);
      setView('form');
      updateCanSubmit();
      hasInitializedRef.current = true;
    } else if (!isOpen) {
      // Reset the initialized flag when closing
      hasInitializedRef.current = false;
    }
    
    prevIsOpenRef.current = isOpen;
  }, [isOpen, editSecret, updateCanSubmit]);

  // Sync calendar view month when opening calendar
  useEffect(() => {
    if (view === 'calendar') {
      const d = expiresAt ?? new Date();
      setViewMonth({ year: d.getFullYear(), month: d.getMonth() });
    }
  }, [view, expiresAt]);

  const calendarDays = useMemo(() => {
    const { year, month } = viewMonth;
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const daysInPrevMonth = new Date(year, month, 0).getDate();
    const cells: { date: Date; inMonth: boolean }[] = [];

    for (let i = firstDay - 1; i >= 0; i--) {
      cells.push({ date: new Date(year, month - 1, daysInPrevMonth - i), inMonth: false });
    }
    for (let d = 1; d <= daysInMonth; d++) {
      cells.push({ date: new Date(year, month, d), inMonth: true });
    }
    const remaining = 42 - cells.length;
    for (let d = 1; d <= remaining; d++) {
      cells.push({ date: new Date(year, month + 1, d), inMonth: false });
    }
    return cells;
  }, [viewMonth]);

  const handleSubmit = async () => {
    const name = nameRef.current;
    const description = descriptionRef.current;
    const value = valueRef.current;
    
    if (!name.trim() || !value) return;
    const expiresAtStr = expiresAt ? expiresAt.toISOString() : undefined;
    const pName = projectName || 'Project';

    if (isEditing && editSecret) {
      await updateSecret(editSecret.id, name.trim(), description.trim() || undefined, value, expiresAtStr);
      if (expiresAt) {
        await scheduleExpiryNotifications(editSecret.id, name.trim(), pName, expiresAt);
      } else {
        await cancelExpiryNotifications(editSecret.id);
      }
    } else {
      const newSecretId = await addSecret(projectId, name.trim(), description.trim() || undefined, value, expiresAtStr);
      if (newSecretId && expiresAt) {
        await scheduleExpiryNotifications(newSecretId, name.trim(), pName, expiresAt);
      }
    }
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    onOpenChange(false);
  };

  const formatDate = (date: Date) =>
    date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

  return (
    <Dialog isOpen={isOpen} onOpenChange={(open) => {
      if (!open) setView('form');
      onOpenChange(open);
    }}>
      <Dialog.Portal>
        <Dialog.Overlay />
        <KeyboardAvoidingView behavior="padding" style={{ flex: 1, justifyContent: 'center' }}>
          <Dialog.Content>
            {view === 'form' ? (
              <View className="gap-4">
                <View className="flex-row justify-between items-center">
                  <Dialog.Title>{isEditing ? 'Edit Secret' : 'New Secret'}</Dialog.Title>
                  <Dialog.Close variant="ghost" />
                </View>
                <Dialog.Description>
                  {isEditing ? 'Update the secret details below' : 'Add a new encrypted secret to this project'}
                </Dialog.Description>
                <TextField>
                  <Label>Name</Label>
                  <Input
                    ref={nameInputRef}
                    defaultValue={nameRef.current}
                    onChangeText={(text) => {
                      nameRef.current = text;
                      updateCanSubmit();
                    }}
                    placeholder="e.g., API Key"
                    autoFocus
                    autoCorrect={false}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </TextField>
                <TextField>
                  <Label>Description (optional)</Label>
                  <Input
                    ref={descriptionInputRef}
                    defaultValue={descriptionRef.current}
                    onChangeText={(text) => {
                      descriptionRef.current = text;
                    }}
                    placeholder="e.g., Stripe production key"
                    autoCorrect={false}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </TextField>
                <TextField>
                  <Label>Secret Value</Label>
                  <View className="flex-row items-center">
                    <View className="flex-1">
                      <Input
                        ref={valueInputRef}
                        defaultValue={valueRef.current}
                        onChangeText={(text) => {
                          valueRef.current = text;
                          updateCanSubmit();
                        }}
                        placeholder="Enter the secret value"
                        secureTextEntry={!showValue}
                        autoCorrect={false}
                        autoComplete="off"
                        autoCapitalize="none"
                      />
                    </View>
                    <Pressable
                      onPress={() => setShowValue((prev) => !prev)}
                      className="pl-2 py-2"
                    >
                      <Ionicons
                        name={showValue ? 'eye-off-outline' : 'eye-outline'}
                        size={22}
                        color={themeMuted}
                      />
                    </Pressable>
                  </View>
                </TextField>

                <Separator />

                <Pressable
                  onPress={() => setView('calendar')}
                  className="flex-row items-center justify-between"
                >
                  <View className="flex-row items-center gap-3">
                    <Ionicons name="calendar-outline" size={20} color={themeAccent} />
                    <View>
                      <Text className="text-sm text-foreground">Expiry Date</Text>
                      <Text className="text-xs text-muted">
                        {expiresAt ? formatDate(expiresAt) : 'No expiry set'}
                      </Text>
                    </View>
                  </View>
                  <Ionicons name="chevron-forward" size={18} color={themeMuted} />
                </Pressable>

                <Button
                  variant="primary"
                  onPress={handleSubmit}
                  isDisabled={!canSubmit}
                >
                  <Button.Label>{isEditing ? 'Update Secret' : 'Add Secret'}</Button.Label>
                </Button>
              </View>
            ) : (
              /* Calendar view */
              <View className="gap-3">
                <View className="flex-row items-center gap-2">
                  <Pressable onPress={() => setView('form')} className="p-1">
                    <Ionicons name="arrow-back" size={22} color={themeAccent} />
                  </Pressable>
                  <Dialog.Title>Set Expiry Date</Dialog.Title>
                </View>

                {/* Month navigation */}
                <View className="flex-row items-center justify-between">
                  <Pressable
                    onPress={() => setViewMonth((prev) =>
                      prev.month === 0
                        ? { year: prev.year - 1, month: 11 }
                        : { ...prev, month: prev.month - 1 }
                    )}
                    className="p-2"
                  >
                    <Ionicons name="chevron-back" size={20} color={themeMuted} />
                  </Pressable>
                  <Text className="text-base font-semibold text-foreground">
                    {MONTHS[viewMonth.month]} {viewMonth.year}
                  </Text>
                  <Pressable
                    onPress={() => setViewMonth((prev) =>
                      prev.month === 11
                        ? { year: prev.year + 1, month: 0 }
                        : { ...prev, month: prev.month + 1 }
                    )}
                    className="p-2"
                  >
                    <Ionicons name="chevron-forward" size={20} color={themeMuted} />
                  </Pressable>
                </View>

                {/* Day-of-week headers */}
                <View className="flex-row">
                  {DAYS.map((day) => (
                    <View key={day} className="flex-1 items-center">
                      <Text className="text-xs font-semibold text-muted">{day}</Text>
                    </View>
                  ))}
                </View>

                {/* Calendar grid */}
                {Array.from({ length: 6 }).map((_, weekIndex) => (
                  <View key={weekIndex} className="flex-row">
                    {calendarDays.slice(weekIndex * 7, weekIndex * 7 + 7).map((cell, dayIndex) => {
                      const isToday = isSameDay(cell.date, today);
                      const isSelected = expiresAt ? isSameDay(cell.date, expiresAt) : false;
                      const isPast = cell.date < today && !isSameDay(cell.date, today);
                      const disabled = !cell.inMonth || isPast;

                      return (
                        <Pressable
                          key={dayIndex}
                          onPress={() => {
                            if (disabled) return;
                            setExpiresAt(cell.date);
                            setView('form');
                          }}
                          disabled={disabled}
                          className="flex-1 items-center py-1"
                        >
                          <View
                            className="items-center justify-center"
                            style={{
                              width: 36,
                              height: 36,
                              borderRadius: 18,
                              backgroundColor: isSelected ? themeAccent : 'transparent',
                              borderWidth: isToday && !isSelected ? 1.5 : 0,
                              borderColor: themeAccent,
                            }}
                          >
                            <Text
                              style={{
                                fontSize: 14,
                                color: isSelected
                                  ? '#fff'
                                  : disabled
                                  ? `${themeMuted}40`
                                  : isToday
                                  ? themeAccent
                                  : cell.inMonth
                                  ? themeForeground
                                  : `${themeMuted}60`,
                                fontWeight: isToday || isSelected ? '700' : '400',
                              }}
                            >
                              {cell.date.getDate()}
                            </Text>
                          </View>
                        </Pressable>
                      );
                    })}
                  </View>
                ))}

                {/* Actions */}
                <View className="flex-row gap-3 mt-1">
                  {expiresAt && (
                    <Button variant="ghost" size="md" onPress={() => { setExpiresAt(null); setView('form'); }} className="flex-1">
                      <Button.Label>Clear</Button.Label>
                    </Button>
                  )}
                  <Button variant="ghost" size="md" onPress={() => setView('form')} className="flex-1">
                    <Button.Label>Cancel</Button.Label>
                  </Button>
                </View>
              </View>
            )}
          </Dialog.Content>
        </KeyboardAvoidingView>
      </Dialog.Portal>
    </Dialog>
  );
}

export const AddSecretDialog = memo(AddSecretDialogComponent);
