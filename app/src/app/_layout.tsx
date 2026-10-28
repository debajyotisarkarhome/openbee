import '../services/runtime'; // defines the background location task at startup

import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { settings } from '../services/settings';
import { colors, type } from '../ui/theme';

export default function RootLayout() {
  useEffect(() => {
    void settings.load();
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.bg },
          headerTintColor: colors.text,
          headerTitleStyle: { ...type.heading, color: colors.text },
          headerShadowVisible: false,
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        {/* The tabs own their own headers. */}
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        {/* Riding sits above the tabs: no tab bar to fat-finger at speed. */}
        <Stack.Screen name="ride" options={{ title: 'Riding', headerBackVisible: false, gestureEnabled: false }} />
      </Stack>
    </SafeAreaProvider>
  );
}
