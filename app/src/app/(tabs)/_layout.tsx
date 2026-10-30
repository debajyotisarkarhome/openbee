import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import type { BottomTabBarProps, BottomTabViewRoute } from 'expo-router/tabs';

import { BarItem, BottomBar } from '../../ui/BottomBar';
import { useLink } from '../../ui/hooks';
import { colors } from '../../ui/theme';

/** Link state shows as the Display tab's icon tint; the device screen spells it out in words. */
const LINK_UI: Record<string, { icon: keyof typeof Ionicons.glyphMap; tone: string }> = {
  connected: { icon: 'bluetooth', tone: colors.ok },
  connecting: { icon: 'bluetooth', tone: colors.warn },
  scanning: { icon: 'bluetooth-outline', tone: colors.warn },
  off: { icon: 'bluetooth-outline', tone: colors.bad },
  idle: { icon: 'bluetooth-outline', tone: colors.faint },
};

const TAB_ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  index: 'navigate-outline',
  device: 'bluetooth-outline',
  settings: 'options-outline',
};

const TAB_LABELS: Record<string, string> = { index: 'Plan', device: 'Display', settings: 'Settings' };

/** Maps the navigator's state onto the presentational BottomBar, so the bar stays free of routing. */
function AppTabBar({ state, navigateToTab }: BottomTabBarProps) {
  const ble = useLink();
  const link = LINK_UI[ble.status] ?? LINK_UI.idle;

  const items: BarItem[] = state.routes.map((route: BottomTabViewRoute, i: number) => {
    const isDevice = route.name === 'device';
    return {
      icon: isDevice ? link.icon : (TAB_ICONS[route.name] ?? 'ellipse-outline'),
      label: TAB_LABELS[route.name] ?? route.name,
      // Idle link keeps the default active/inactive tint; any live state lights the icon.
      tone: isDevice && ble.status !== 'idle' ? link.tone : undefined,
      badge: isDevice && ble.devStatus ? `${ble.devStatus.battPct}%` : undefined,
      badgeTone: isDevice && ble.devStatus && ble.devStatus.battPct < 20 ? colors.bad : undefined,
      active: state.index === i,
      onPress: () => navigateToTab(route.key),
    };
  });

  return <BottomBar items={items} />;
}

export default function TabsLayout() {
  return (
    <Tabs
      tabBar={(props) => <AppTabBar {...props} />}
      // Each screen draws its own large ScreenTitle; no centred navigation header.
      screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: colors.bg } }}
    >
      <Tabs.Screen name="index" options={{ title: 'Plan' }} />
      <Tabs.Screen name="device" options={{ title: 'Display' }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings' }} />
    </Tabs>
  );
}
