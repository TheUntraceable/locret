import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useThemeColor } from 'heroui-native';

export default function TabLayout() {
  const [themeAccent, themeMuted, themeBg, themeSurface] = useThemeColor([
    'accent', 'muted', 'background', 'surface',
  ]);

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: themeAccent,
        tabBarInactiveTintColor: themeMuted,
        tabBarStyle: {
          backgroundColor: themeSurface,
          borderTopColor: themeBg,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Secrets',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="key-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="authenticator"
        options={{
          title: '2FA',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="shield-checkmark-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="settings-outline" size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
