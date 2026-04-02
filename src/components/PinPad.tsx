import { useRef, useEffect } from 'react';
import { View, Pressable, Animated } from 'react-native';
import { useThemeColor } from 'heroui-native';

const DOT_SIZE = 13;

export function PinDots({
  count = 6,
  filled,
  error,
}: {
  count?: number;
  filled: number;
  error: boolean;
}) {
  const [themeAccent, themeMuted, themeDanger] = useThemeColor(['accent', 'muted', 'danger']);
  const shakeAnim = useRef(new Animated.Value(0)).current;
  const dotScales = useRef(Array.from({ length: count }, () => new Animated.Value(0))).current;

  useEffect(() => {
    if (error) {
      Animated.sequence([
        Animated.timing(shakeAnim, { toValue: 14, duration: 40, useNativeDriver: true }),
        Animated.timing(shakeAnim, { toValue: -14, duration: 40, useNativeDriver: true }),
        Animated.timing(shakeAnim, { toValue: 10, duration: 40, useNativeDriver: true }),
        Animated.timing(shakeAnim, { toValue: -10, duration: 40, useNativeDriver: true }),
        Animated.timing(shakeAnim, { toValue: 4, duration: 40, useNativeDriver: true }),
        Animated.timing(shakeAnim, { toValue: 0, duration: 40, useNativeDriver: true }),
      ]).start();
    }
  }, [error, shakeAnim]);

  useEffect(() => {
    dotScales.forEach((scale, i) => {
      Animated.spring(scale, {
        toValue: i < filled ? 1 : 0,
        friction: 6,
        tension: 300,
        useNativeDriver: true,
      }).start();
    });
  }, [filled, dotScales]);

  const activeColor = error ? themeDanger : themeAccent;

  return (
    <Animated.View
      className="flex-row items-center justify-center"
      style={{ gap: 14, transform: [{ translateX: shakeAnim }] }}
    >
      {Array.from({ length: count }, (_, i) => `dot-${i + 1}`).map((dotKey, i) => (
        <View key={dotKey} className="items-center justify-center" style={{ width: DOT_SIZE, height: DOT_SIZE }}>
          <View
            className="absolute rounded-full"
            style={{
              width: DOT_SIZE,
              height: DOT_SIZE,
              borderWidth: 1.5,
              borderColor: i < filled ? activeColor : `${themeMuted}50`,
            }}
          />
          <Animated.View
            className="rounded-full"
            style={{
              width: DOT_SIZE,
              height: DOT_SIZE,
              backgroundColor: activeColor,
              transform: [{ scale: dotScales[i] }],
            }}
          />
        </View>
      ))}
    </Animated.View>
  );
}

export function KeypadKey({
  onPress,
  children,
  size,
  variant = 'default',
  disabled = false,
}: {
  onPress: () => void;
  children: React.ReactNode;
  size: number;
  variant?: 'default' | 'accent' | 'ghost';
  disabled?: boolean;
}) {
  const [themeAccent, themeSurface] = useThemeColor(['accent', 'surface']);

  const handlePress = () => {
    if (disabled) return;
    onPress();
  };

  return (
    <Pressable
      onPress={handlePress}
      disabled={disabled}
      className="items-center justify-center rounded-2xl"
      style={({ pressed }) => ({
        width: size,
        height: size,
        opacity: disabled ? 0.45 : 1,
        backgroundColor: variant === 'ghost'
          ? (pressed && !disabled ? `${themeSurface}80` : 'transparent')
          : variant === 'accent'
          ? (pressed && !disabled ? `${themeAccent}30` : `${themeAccent}15`)
          : (pressed && !disabled ? `${themeSurface}` : `${themeSurface}90`),
      })}
    >
      {children}
    </Pressable>
  );
}
