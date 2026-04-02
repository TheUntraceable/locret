import { useEffect } from 'react';
import { Stack } from "expo-router";
import { HeroUINativeProvider } from 'heroui-native';
import { Uniwind } from 'uniwind';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { AppProvider } from '../context/AppContext';
import '../utils/notifications'; // Initialize notification handler
import '../../global.css';

const config = {
  textProps: {
    maxFontSizeMultiplier: 1.5,
  },
};

export default function RootLayout() {
  useEffect(() => {
    Uniwind.setTheme('alpha-dark');
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <HeroUINativeProvider config={config}>
          <AppProvider>
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
          </AppProvider>
        </HeroUINativeProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
