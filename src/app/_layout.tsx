import { useCallback, useRef, useEffect } from 'react';
import { View } from 'react-native';
import { Stack, useRouter, useSegments } from "expo-router";
import { HeroUINativeProvider } from 'heroui-native';
import { Uniwind } from 'uniwind';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { AppProvider, useApp } from '../context/AppContext';
import { ChatProvider, useChat } from '../context/ChatContext';
import { useBackgroundGrace } from '../utils/appLifecycle';
import '../utils/notifications'; // Initialize notification handler
import '../../global.css';

/**
 * Background lock grace period (30 s). Lives in utils/appLifecycle so
 * ChatContext can share it without importing this route file; see the comment
 * there for why locking is not immediate.
 */
export { BACKGROUND_LOCK_GRACE_MS } from '../utils/appLifecycle';

const config = {
  textProps: {
    maxFontSizeMultiplier: 1.5,
  },
};

const AUTO_LOCK_MS = 1 * 60 * 1000; // 1 minute of foreground inactivity

/**
 * Locks the vault and routes to /auth:
 *  - after AUTO_LOCK_MS without a touch while foregrounded (paused while the
 *    AI is generating);
 *  - after BACKGROUND_LOCK_GRACE_MS in the background. 'inactive' never locks,
 *    and returning to 'active' within the grace cancels the lock, so system
 *    overlays (Circle to Search, notification shade, permission/biometric
 *    prompts) no longer kick the user out mid-reply.
 */
function AutoLockManager({ children }: { children: React.ReactNode }) {
  const { lockApp } = useApp();
  const { isGenerating } = useChat();
  const router = useRouter();
  const segments = useSegments();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isGeneratingRef = useRef(false);
  // Read through a ref so a pending timer never calls a stale triggerLock.
  const firstSegmentRef = useRef<string | undefined>(segments[0]);

  useEffect(() => {
    firstSegmentRef.current = segments[0];
  }, [segments]);

  const triggerLock = useCallback(() => {
    lockApp();
    if (firstSegmentRef.current !== 'auth') {
      router.replace('/auth');
    }
  }, [lockApp, router]);

  const clearTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const resetTimer = useCallback(() => {
    clearTimer();
    // Don't start the countdown while the AI is generating
    if (!isGeneratingRef.current) {
      timerRef.current = setTimeout(triggerLock, AUTO_LOCK_MS);
    }
  }, [clearTimer, triggerLock]);

  // Pause/resume timer as generation state changes
  useEffect(() => {
    isGeneratingRef.current = isGenerating;
    if (isGenerating) {
      clearTimer();
    } else {
      resetTimer();
    }
  }, [isGenerating, clearTimer, resetTimer]);

  // Start timer on mount, clean up on unmount
  useEffect(() => {
    resetTimer();
    return clearTimer;
  }, [resetTimer, clearTimer]);

  useBackgroundGrace({
    // The background grace replaces the inactivity countdown while away.
    onBackground: clearTimer,
    onExpire: triggerLock,
    onResume: ({ expired }) => {
      if (!expired) resetTimer();
    },
  });

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
