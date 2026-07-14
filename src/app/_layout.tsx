import { useCallback, useRef, useEffect } from 'react';
import { View, AppState, AppStateStatus } from 'react-native';
import { Stack, useRouter, useSegments } from "expo-router";
import { HeroUINativeProvider } from 'heroui-native';
import { Uniwind } from 'uniwind';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { AppProvider } from '../context/AppContext';
import { useApp } from '../context/AppContext';
import { ChatProvider, useChat } from '../context/ChatContext';
import '../utils/notifications'; // Initialize notification handler
import '../../global.css';

const config = {
  textProps: {
    maxFontSizeMultiplier: 1.5,
  },
};

const AUTO_LOCK_MS = 1 * 60 * 1000; // 1 minute

function AutoLockManager({ children }: { children: React.ReactNode }) {
  const { lockApp } = useApp();
  const { isGenerating } = useChat();
  const router = useRouter();
  const segments = useSegments();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isGeneratingRef = useRef(false);

  const triggerLock = useCallback(() => {
    lockApp();
    if (segments[0] !== 'auth') {
      router.replace('/auth');
    }
  }, [lockApp, router, segments]);

  const resetTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    // Don't start the countdown while the AI is generating
    if (!isGeneratingRef.current) {
      timerRef.current = setTimeout(triggerLock, AUTO_LOCK_MS);
    }
  }, [triggerLock]);

  // Pause/resume timer as generation state changes
  useEffect(() => {
    isGeneratingRef.current = isGenerating;
    if (isGenerating) {
      // Pause: clear any running countdown
      if (timerRef.current) clearTimeout(timerRef.current);
    } else {
      // Resume: start a fresh countdown once generation finishes
      resetTimer();
    }
  }, [isGenerating, resetTimer]);

  // Start timer on mount, clean up on unmount
  useEffect(() => {
    resetTimer();
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [resetTimer]);

  // Lock immediately when app goes to background (even if generating)
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
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
            <ChatProvider>
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
                  <Stack.Screen name="chat/[id]" />
                </Stack>
              </AutoLockManager>
            </ChatProvider>
          </AppProvider>
        </HeroUINativeProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
