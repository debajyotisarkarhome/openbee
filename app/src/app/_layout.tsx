import '../services/runtime'; // defines the background location task at startup

import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { colors } from '../ui/theme';

export default function RootLayout() {
  return (
    <>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.bg },
          headerTintColor: colors.text,
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Screen name="index" options={{ title: 'OpenBee' }} />
        <Stack.Screen name="device" options={{ title: 'Handlebar display', presentation: 'modal' }} />
        <Stack.Screen name="ride" options={{ title: 'Riding', headerBackVisible: false, gestureEnabled: false }} />
      </Stack>
    </>
  );
}
