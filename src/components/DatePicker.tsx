import { useState, useMemo } from 'react';
import { View, Text, Pressable } from 'react-native';
import { BottomSheet, Button, Separator, useThemeColor } from 'heroui-native';
import { Ionicons } from '@expo/vector-icons';

const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

interface DatePickerProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  value?: Date | null;
  onChange: (date: Date | null) => void;
  minDate?: Date;
}

function isSameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
}

export function DatePicker({ isOpen, onOpenChange, value, onChange, minDate }: DatePickerProps) {
  const [themeAccent, themeMuted, themeForeground] = useThemeColor(['accent', 'muted', 'foreground']);

  const today = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);

  const [viewMonth, setViewMonth] = useState(() => {
    const d = value ?? new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });

  const calendarDays = useMemo(() => {
    const { year, month } = viewMonth;
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const daysInPrevMonth = new Date(year, month, 0).getDate();

    const cells: { date: Date; inMonth: boolean }[] = [];

    // Previous month trailing days
    for (let i = firstDay - 1; i >= 0; i--) {
      cells.push({
        date: new Date(year, month - 1, daysInPrevMonth - i),
        inMonth: false,
      });
    }

    // Current month
    for (let d = 1; d <= daysInMonth; d++) {
      cells.push({
        date: new Date(year, month, d),
        inMonth: true,
      });
    }

    // Fill remaining to complete 6 rows
    const remaining = 42 - cells.length;
    for (let d = 1; d <= remaining; d++) {
      cells.push({
        date: new Date(year, month + 1, d),
        inMonth: false,
      });
    }

    return cells;
  }, [viewMonth]);

  const goToPrevMonth = () => {
    setViewMonth((prev) => {
      if (prev.month === 0) return { year: prev.year - 1, month: 11 };
      return { ...prev, month: prev.month - 1 };
    });
  };

  const goToNextMonth = () => {
    setViewMonth((prev) => {
      if (prev.month === 11) return { year: prev.year + 1, month: 0 };
      return { ...prev, month: prev.month + 1 };
    });
  };

  const handleSelect = (date: Date) => {
    onChange(date);
    onOpenChange(false);
  };

  const handleClear = () => {
    onChange(null);
    onOpenChange(false);
  };

  const effectiveMin = minDate ?? today;

  return (
    <BottomSheet isOpen={isOpen} onOpenChange={onOpenChange}>
      <BottomSheet.Portal>
        <BottomSheet.Overlay />
        <BottomSheet.Content enableDynamicSizing>
          <View className="px-5 pb-6">
            <View className="flex-row items-center justify-between mb-1">
              <BottomSheet.Title>Set Expiry Date</BottomSheet.Title>
              <BottomSheet.Close />
            </View>
            <BottomSheet.Description>
              Choose when this secret expires
            </BottomSheet.Description>

            <Separator className="my-4" />

            {/* Month navigation */}
            <View className="flex-row items-center justify-between mb-4">
              <Pressable onPress={goToPrevMonth} className="p-2">
                <Ionicons name="chevron-back" size={20} color={themeMuted} />
              </Pressable>
              <Text className="text-base font-semibold text-foreground">
                {MONTHS[viewMonth.month]} {viewMonth.year}
              </Text>
              <Pressable onPress={goToNextMonth} className="p-2">
                <Ionicons name="chevron-forward" size={20} color={themeMuted} />
              </Pressable>
            </View>

            {/* Day-of-week headers */}
            <View className="flex-row mb-2">
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
                  const isSelected = value ? isSameDay(cell.date, value) : false;
                  const isPast = cell.date < effectiveMin && !isSameDay(cell.date, effectiveMin);
                  const disabled = !cell.inMonth || isPast;

                  return (
                    <Pressable
                      key={dayIndex}
                      onPress={() => !disabled && handleSelect(cell.date)}
                      disabled={disabled}
                      className="flex-1 items-center py-2"
                    >
                      <View
                        className="w-9 h-9 items-center justify-center rounded-full"
                        style={{
                          backgroundColor: isSelected ? themeAccent : 'transparent',
                        }}
                      >
                        <Text
                          className="text-sm"
                          style={{
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
            <View className="flex-row gap-3 mt-4">
              {value && (
                <Button variant="ghost" size="md" onPress={handleClear} className="flex-1">
                  <Button.Label>Clear</Button.Label>
                </Button>
              )}
              <Button variant="ghost" size="md" onPress={() => onOpenChange(false)} className="flex-1">
                <Button.Label>Cancel</Button.Label>
              </Button>
            </View>
          </View>
        </BottomSheet.Content>
      </BottomSheet.Portal>
    </BottomSheet>
  );
}
