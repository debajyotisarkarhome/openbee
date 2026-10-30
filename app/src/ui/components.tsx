// Shared UI primitives. Keep screens declarative: anything with a pressed state, a border or a type
// choice should live here so the screens stay consistent. See theme.ts for the design language — in
// short, rules not boxes, the accent only where it means something.
import { Ionicons } from '@expo/vector-icons';
import { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, View, ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, layout, radius, space, type } from './theme';

type IconName = keyof typeof Ionicons.glyphMap;

// ---------- surfaces ----------

/** Large left-aligned screen title, drawn in the content instead of a centred navigation header. */
export function ScreenTitle({ children, kicker }: { children: ReactNode; kicker?: string }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={{ paddingTop: insets.top + layout.section }}>
      {kicker ? <Text style={styles.kicker}>{kicker}</Text> : null}
      <Text style={styles.screenTitle}>{children}</Text>
    </View>
  );
}

/** A group of rows between two hairlines. No fill, no radius: the rules do the grouping. */
export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={StyleSheet.flatten([styles.card, style])}>{children}</View>;
}

export function SectionLabel({ children, icon }: { children: ReactNode; icon?: IconName }) {
  return (
    <View style={styles.sectionHead}>
      {icon ? <Ionicons name={icon} size={13} color={colors.faint} /> : null}
      <Text style={styles.sectionLabel}>{children}</Text>
    </View>
  );
}

export function Divider() {
  return <View style={styles.divider} />;
}

// ---------- buttons ----------

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

export function Button({
  label,
  onPress,
  variant = 'primary',
  icon,
  disabled,
  loading,
}: {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  icon?: IconName;
  disabled?: boolean;
  loading?: boolean;
}) {
  const v = BUTTON_VARIANTS[variant];
  const off = disabled || loading;
  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      style={({ pressed }) =>
        StyleSheet.flatten([styles.btn, v.box, pressed && !off && styles.btnPressed, off && styles.btnOff])
      }
    >
      {loading ? (
        <ActivityIndicator color={v.ink} />
      ) : (
        <>
          <Text style={[styles.btnText, { color: v.ink }]}>{label}</Text>
          {icon ? <Ionicons name={icon} size={18} color={v.ink} /> : null}
        </>
      )}
    </Pressable>
  );
}

const BUTTON_VARIANTS: Record<ButtonVariant, { box: ViewStyle; ink: string }> = {
  primary: { box: { backgroundColor: colors.accent }, ink: colors.accentInk },
  secondary: { box: { borderWidth: 1, borderColor: colors.borderHi }, ink: colors.text },
  danger: { box: { backgroundColor: colors.bad }, ink: '#140504' },
  ghost: { box: {}, ink: colors.dim },
};

export function IconButton({
  name,
  onPress,
  tone = colors.text,
  size = 22,
}: {
  name: IconName;
  onPress: () => void;
  tone?: string;
  size?: number;
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={10}
      style={({ pressed }) => StyleSheet.flatten([styles.iconBtn, pressed && styles.btnPressed])}
    >
      <Ionicons name={name} size={size} color={tone} />
    </Pressable>
  );
}

// ---------- selectors ----------

/** Text options over a hairline; the chosen one is lit and underlined in the accent. */
export function SegmentedControl<T extends string | number>({
  options,
  value,
  onChange,
}: {
  options: { label: string; value: T; icon?: IconName }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <View style={styles.segment}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <Pressable
            key={String(o.value)}
            onPress={() => onChange(o.value)}
            style={StyleSheet.flatten([styles.segmentItem, active && styles.segmentItemActive])}
          >
            {o.icon ? <Ionicons name={o.icon} size={16} color={active ? colors.accent : colors.faint} /> : null}
            <Text style={[styles.segmentText, active && styles.segmentTextActive]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function ToggleRow({
  icon,
  title,
  subtitle,
  value,
  onChange,
}: {
  icon?: IconName;
  title: string;
  subtitle?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <View style={styles.row}>
      {icon ? <Ionicons name={icon} size={18} color={colors.dim} style={styles.rowIcon} /> : null}
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle}>{title}</Text>
        {subtitle ? <Text style={styles.rowSub}>{subtitle}</Text> : null}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ false: colors.surfaceHi, true: colors.accent }}
        thumbColor="#FFFFFF"
        ios_backgroundColor={colors.surfaceHi}
      />
    </View>
  );
}

// ---------- rows & data ----------

export function Row({
  icon,
  title,
  subtitle,
  right,
  onPress,
  onLongPress,
  tone,
}: {
  icon?: IconName;
  title: string;
  subtitle?: string;
  right?: ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  tone?: string;
}) {
  const body = (
    <>
      {icon ? <Ionicons name={icon} size={18} color={tone ?? colors.dim} style={styles.rowIcon} /> : null}
      <View style={styles.rowBody}>
        <Text style={[styles.rowTitle, tone ? { color: tone } : null]} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={styles.rowSub} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right ?? (onPress ? <Ionicons name="arrow-forward" size={16} color={colors.faint} /> : null)}
    </>
  );
  if (!onPress) return <View style={styles.row}>{body}</View>;
  return (
    <Pressable onPress={onPress} onLongPress={onLongPress} style={({ pressed }) => StyleSheet.flatten([styles.row, pressed && styles.rowPressed])}>
      {body}
    </Pressable>
  );
}

/** A labelled measurement: small label over a hairline, light tabular figures below. */
export function StatTile({
  label,
  value,
  unit,
  tone,
  icon,
}: {
  label: string;
  value: string;
  unit?: string;
  tone?: string;
  icon?: IconName;
}) {
  return (
    <View style={styles.tile}>
      <View style={styles.tileHead}>
        {icon ? <Ionicons name={icon} size={13} color={colors.faint} /> : null}
        <Text style={styles.tileLabel}>{label.toLowerCase()}</Text>
      </View>
      <Text style={[styles.tileValue, tone ? { color: tone } : null]} numberOfLines={1} adjustsFontSizeToFit>
        {value}
        {unit ? <Text style={styles.tileUnit}> {unit}</Text> : null}
      </Text>
    </View>
  );
}

/** Status as an indicator lamp: a dot and a word. `ink` lights the lamp solid. */
export function Badge({ label, tone = colors.dim, ink }: { label: string; tone?: string; ink?: string }) {
  return (
    <View style={styles.badge}>
      <View style={[styles.lamp, { borderColor: tone, backgroundColor: ink ? tone : 'transparent' }]} />
      <Text style={[styles.badgeText, { color: tone }]}>{label.toLowerCase()}</Text>
    </View>
  );
}

export function EmptyState({ icon, title, subtitle }: { icon?: IconName; title: string; subtitle?: string }) {
  return (
    <View style={styles.empty}>
      {icon ? <Ionicons name={icon} size={28} color={colors.accent} /> : null}
      <Text style={styles.emptyTitle}>{title}</Text>
      {subtitle ? <Text style={styles.emptySub}>{subtitle}</Text> : null}
    </View>
  );
}

const hairline = StyleSheet.hairlineWidth;

const styles = StyleSheet.create({
  kicker: { ...type.label, color: colors.accent, marginBottom: space.xs },
  screenTitle: { ...type.display, color: colors.text },

  card: { borderTopWidth: hairline, borderBottomWidth: hairline, borderColor: colors.borderHi },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: layout.tight },
  sectionLabel: { ...type.label, color: colors.faint },
  divider: { height: hairline, backgroundColor: colors.border },

  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
    borderRadius: radius.md,
    paddingVertical: space.lg,
    paddingHorizontal: space.lg + 2,
  },
  btnPressed: { opacity: 0.6 },
  btnOff: { opacity: 0.35 },
  btnText: { fontSize: 16, fontWeight: '600', letterSpacing: -0.1 },
  iconBtn: { padding: space.xs },

  segment: { flexDirection: 'row', borderBottomWidth: hairline, borderColor: colors.borderHi },
  segmentItem: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: space.md, borderBottomWidth: 2, borderColor: 'transparent', marginBottom: -1 },
  segmentItemActive: { borderColor: colors.accent },
  segmentText: { fontSize: 15, fontWeight: '500', color: colors.faint },
  segmentTextActive: { color: colors.text },

  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: space.md + 2, gap: space.md, minHeight: 52 },
  rowPressed: { opacity: 0.55 },
  rowIcon: { width: 18, textAlign: 'center' },
  rowBody: { flex: 1 },
  rowTitle: { ...type.body, color: colors.text },
  rowSub: { fontSize: 13, color: colors.dim, marginTop: 2 },

  tile: { flex: 1, borderTopWidth: hairline, borderColor: colors.borderHi, paddingTop: space.sm },
  tileHead: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  tileLabel: { ...type.label, color: colors.faint },
  tileValue: { ...type.readout, color: colors.text, marginTop: 2 },
  tileUnit: { ...type.label, fontSize: 12, color: colors.dim, letterSpacing: 0 },

  badge: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  lamp: { width: 7, height: 7, borderRadius: 4, borderWidth: 1.5 },
  badgeText: { ...type.label, fontSize: 12 },

  empty: { gap: layout.tight },
  emptyTitle: { ...type.title, color: colors.text },
  emptySub: { fontSize: 15, lineHeight: 21, color: colors.dim, maxWidth: 320 },
});
