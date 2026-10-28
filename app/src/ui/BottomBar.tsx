// Floating tab bar for the plan screen, in the iOS 26 style: a glass pill hovering over the content
// with the current tab filled in behind it. Not the navigation header — iOS draws its own glass capsule
// behind header buttons, which fought our styling.
//
// expo-blur is a native module, so changing it means rebuilding and re-signing the app, not just a
// Metro reload.
import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, space } from './theme';

/**
 * Height of the bar plus its float gap, excluding the safe-area inset. Screens add this to their scroll
 * padding (plus the inset) so the bar never covers the last control.
 */
export const BOTTOM_BAR_CLEARANCE = 88;

const BAR_RADIUS = 34;
const ITEM_RADIUS = 26;

export interface BarItem {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  /** Tints the icon — used for link state. */
  tone?: string;
  /** Short pill on the icon's shoulder, e.g. a battery percentage. */
  badge?: string;
  /** Tint of that pill; defaults to the accent. */
  badgeTone?: string;
  /** The screen you are already on: gets the filled pill behind it. */
  active?: boolean;
}

export function BottomBar({ items }: { items: BarItem[] }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.wrap, { bottom: Math.max(insets.bottom, space.sm) + space.sm }]} pointerEvents="box-none">
      <View style={styles.shadow}>
        <BlurView intensity={60} tint="dark" blurMethod="dimezisBlurView" style={styles.bar}>
          {items.map((item) => (
            <Pressable
              key={item.label}
              onPress={item.onPress}
              style={({ pressed }) =>
                StyleSheet.flatten([styles.item, item.active && styles.itemActive, pressed && styles.itemPressed])
              }
            >
              <View style={styles.iconWrap}>
                <Ionicons name={item.icon} size={24} color={item.tone ?? colors.text} />
                {item.badge ? (
                  <View style={[styles.badge, { backgroundColor: item.badgeTone ?? colors.accent }]}>
                    <Text style={styles.badgeText} numberOfLines={1}>
                      {item.badge}
                    </Text>
                  </View>
                ) : null}
              </View>
              <Text style={styles.label} numberOfLines={1}>
                {item.label}
              </Text>
            </Pressable>
          ))}
        </BlurView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: space.md, right: space.md, alignItems: 'stretch' },
  // Shadow lives here: the blur layer clips its children, which would clip the shadow too.
  shadow: {
    borderRadius: BAR_RADIUS,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 18, shadowOffset: { width: 0, height: 8 } },
      default: { elevation: 12 },
    }),
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'stretch',
    // A faint tint over the blur: pure blur alone is too light for white labels on a bright map.
    backgroundColor: 'rgba(16,20,26,0.45)',
    borderRadius: BAR_RADIUS,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    overflow: 'hidden',
    padding: 5,
  },
  item: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    paddingVertical: space.sm,
    paddingHorizontal: space.xs,
    borderRadius: ITEM_RADIUS,
  },
  itemActive: { backgroundColor: 'rgba(0,0,0,0.42)' },
  itemPressed: { opacity: 0.55 },
  iconWrap: { width: 40, alignItems: 'center', justifyContent: 'center' },
  badge: {
    position: 'absolute',
    top: -6,
    right: -2,
    minWidth: 20,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 10,
    alignItems: 'center',
  },
  badgeText: { fontSize: 10, fontWeight: '800', color: colors.accentInk },
  label: { fontSize: 12, fontWeight: '600', color: colors.text, letterSpacing: 0.1 },
});
