import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import type { BottomTabBarProps, BottomTabViewRoute } from 'expo-router/tabs';

import { BarItem, BottomBar } from '../../ui/BottomBar';
import { useLink } from '../../ui/hooks';
import { colors, type } from '../../ui/theme';

/** Link state shows as the Display tab's icon tint; the device screen spells it out in words. */
const LINK_UI: Record<string, { icon: keyof typeof Ionicons.glyphMap; tone: string }> = {
  connected: { icon: 'bluetooth', tone: colors.ok },
  connecting: { icon: 'bluetooth', tone: colors.warn },
  scanning: { icon: 'bluetooth-outline', tone: colors.warn },
  off: { icon: 'bluetooth-outline', tone: colors.bad },
  idle: { icon: 'bluetooth-outline', tone: colors.dim },
};

const TAB_ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  index: 'map',
  device: 'bluetooth-outline',
  settings: 'settings-outline',
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
      tone: isDevice ? link.tone : undefined,
      badge: isDevice && ble.devStatus ? `${ble.devStatus.battPct}%` : undefined,
      badgeTone: isDevice && ble.devStatus && ble.devStatus.battPct < 20 ? colors.bad : colors.accent,
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
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text,
        headerTitleStyle: { ...type.heading, color: colors.text },
        headerShadowVisible: false,
        sceneStyle: { backgroundColor: colors.bg },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'OpenBee' }} />
      <Tabs.Screen name="device" options={{ title: 'Handlebar display' }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings' }} />
    </Tabs>
  );
}
