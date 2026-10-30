// Docked tab bar for the plan screens: a flat strip under a hairline, like the soft-key row on an
// instrument. The current tab is marked by an accent tick along the top edge and a lit label. It sits in
// the layout (not floating), so screens need no extra bottom padding to clear it.
import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, space, type } from './theme';

export interface BarItem {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  /** Tints the icon — used for link state. */
  tone?: string;
  /** Short readout after the label, e.g. a battery percentage. */
  badge?: string;
  /** Tint of that readout; defaults to dim. */
  badgeTone?: string;
  /** The screen you are already on. */
  active?: boolean;
}

export function BottomBar({ items }: { items: BarItem[] }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, space.sm) }]}>
      {items.map((item) => (
        <Pressable
          key={item.label}
          onPress={item.onPress}
          style={({ pressed }) => StyleSheet.flatten([styles.item, pressed && styles.itemPressed])}
        >
          <View style={[styles.tick, item.active && styles.tickActive]} />
          <Ionicons name={item.icon} size={20} color={item.tone ?? (item.active ? colors.text : colors.faint)} />
          <Text style={[styles.label, item.active && styles.labelActive]} numberOfLines={1}>
            {item.label.toLowerCase()}
            {item.badge ? <Text style={{ color: item.badgeTone ?? colors.dim }}> {item.badge}</Text> : null}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    backgroundColor: colors.bg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderHi,
  },
  item: { flex: 1, alignItems: 'center', gap: 4, paddingTop: space.md, paddingBottom: space.xs },
  itemPressed: { opacity: 0.55 },
  // The tick overlaps the bar's hairline so the active tab reads as a raised key.
  tick: { position: 'absolute', top: -1, height: 2, width: 28, backgroundColor: 'transparent' },
  tickActive: { backgroundColor: colors.accent },
  label: { ...type.label, color: colors.faint },
  labelActive: { color: colors.text },
});
