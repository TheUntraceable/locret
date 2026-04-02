import { useCallback, useRef, useEffect } from 'react';
import { View, AppState, AppStateStatus } from 'react-native';
import { Stack, useRouter, useSegments } from "expo-router";
import { HeroUINativeProvider } from 'heroui-native';
import { Uniwind } from 'uniwind';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { AppProvider } from '../context/AppContext';
import { useApp } from '../context/AppContext';
import '../utils/notifications'; // Initialize notification handler
import '../../global.css';

const config = {
  textProps: {
    maxFontSizeMultiplier: 1.5,
  },
};

const AUTO_LOCK_MS = 5 * 60 * 1000; // 5 minutes

function AutoLockManager({ children }: { children: React.ReactNode }) {
  const { lockApp } = useApp();
  const router = useRouter();
  const segments = useSegments();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const appStateRef = useRef<AppStateStatus>('active');

  const triggerLock = useCallback(() => {
    lockApp();
    // Only navigate if not already on /auth
    if (segments[0] !== 'auth') {
      router.replace('/auth');
    }
  }, [lockApp, router, segments]);

  const resetTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(triggerLock, AUTO_LOCK_MS);
  }, [triggerLock]);

  // Start timer on mount, clean up on unmount
  useEffect(() => {
    resetTimer();
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [resetTimer]);

  // Lock when app goes to background
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      appStateRef.current = state;
      if (state === 'background' || state === 'inactive') {
        if (timerRef.current) clearTimeout(timerRef.current);
        triggerLock();
      } else if (state === 'active') {
        resetTimer();
      }
    });
    return () => sub.remove();
  }, [triggerLock, resetTimer]);

  return (
    <View style={{ flex: 1 }} onTouchStart={resetTimer}>
      {children}
    </View>
  );
}

export default function RootLayout() {
  useEffect(() => {
    Uniwind.setTheme('alpha-dark');
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <HeroUINativeProvider config={config}>
          <AppProvider>
            <AutoLockManager>
              <Stack
                screenOptions={{
                  headerShown: false,
                  animation: 'fade',
                }}
              >
                <Stack.Screen name="index" />
                <Stack.Screen name="auth" />
                <Stack.Screen name="(tabs)" />
                <Stack.Screen name="project/[id]" />
              </Stack>
            </AutoLockManager>
          </AppProvider>
        </HeroUINativeProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
