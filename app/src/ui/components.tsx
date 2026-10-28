// Shared UI primitives. Keep screens declarative: anything with a pressed state, a border radius or a
// type choice should live here so the three screens stay consistent.
import { Ionicons } from '@expo/vector-icons';
import { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, View, ViewStyle } from 'react-native';

import { colors, radius, space, type } from './theme';

type IconName = keyof typeof Ionicons.glyphMap;

// ---------- surfaces ----------

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={StyleSheet.flatten([styles.card, style])}>{children}</View>;
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return <Text style={styles.sectionLabel}>{String(children).toUpperCase()}</Text>;
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
          {icon ? <Ionicons name={icon} size={18} color={v.ink} /> : null}
          <Text style={[styles.btnText, { color: v.ink }]}>{label}</Text>
        </>
      )}
    </Pressable>
  );
}

const BUTTON_VARIANTS: Record<ButtonVariant, { box: ViewStyle; ink: string }> = {
  primary: { box: { backgroundColor: colors.accent }, ink: colors.accentInk },
  secondary: { box: { backgroundColor: colors.surfaceHi, borderWidth: 1, borderColor: colors.borderHi }, ink: colors.text },
  danger: { box: { backgroundColor: colors.bad }, ink: '#FFFFFF' },
  ghost: { box: { backgroundColor: 'transparent' }, ink: colors.dim },
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

export function SegmentedControl<T extends string | number>({
  options,
  value,
  onChange,
}: {
  options: { label: string; value: T }[];
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
  icon: IconName;
  title: string;
  subtitle?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <View style={styles.row}>
      <Ionicons name={icon} size={20} color={colors.dim} style={styles.rowIcon} />
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
  tone,
}: {
  icon?: IconName;
  title: string;
  subtitle?: string;
  right?: ReactNode;
  onPress?: () => void;
  tone?: string;
}) {
  const body = (
    <>
      {icon ? <Ionicons name={icon} size={20} color={tone ?? colors.dim} style={styles.rowIcon} /> : null}
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
      {right ?? (onPress ? <Ionicons name="chevron-forward" size={18} color={colors.faint} /> : null)}
    </>
  );
  if (!onPress) return <View style={styles.row}>{body}</View>;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => StyleSheet.flatten([styles.row, pressed && styles.rowPressed])}>
      {body}
    </Pressable>
  );
}

export function StatTile({ label, value, unit, tone }: { label: string; value: string; unit?: string; tone?: string }) {
  return (
    <View style={styles.tile}>
      <Text style={styles.tileLabel}>{label.toUpperCase()}</Text>
      <Text style={[styles.tileValue, tone ? { color: tone } : null]} numberOfLines={1} adjustsFontSizeToFit>
        {value}
        {unit ? <Text style={styles.tileUnit}> {unit}</Text> : null}
      </Text>
    </View>
  );
}

export function Badge({ label, tone = colors.dim, ink }: { label: string; tone?: string; ink?: string }) {
  return (
    <View style={[styles.badge, { backgroundColor: ink ? tone : 'transparent', borderColor: tone }]}>
      <Text style={[styles.badgeText, { color: ink ?? tone }]}>{label}</Text>
    </View>
  );
}

export function EmptyState({ icon, title, subtitle }: { icon: IconName; title: string; subtitle?: string }) {
  return (
    <View style={styles.empty}>
      <View style={styles.emptyIcon}>
        <Ionicons name={icon} size={28} color={colors.faint} />
      </View>
      <Text style={styles.emptyTitle}>{title}</Text>
      {subtitle ? <Text style={styles.emptySub}>{subtitle}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  sectionLabel: { ...type.label, color: colors.faint, marginBottom: space.sm, marginLeft: space.xs },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginLeft: 48 },

  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    borderRadius: radius.md,
    paddingVertical: space.lg,
    paddingHorizontal: space.lg,
  },
  btnPressed: { opacity: 0.6 },
  btnOff: { opacity: 0.4 },
  btnText: { fontSize: 16, fontWeight: '700' },
  iconBtn: { padding: space.xs, borderRadius: radius.pill },

  segment: { flexDirection: 'row', backgroundColor: colors.surfaceAlt, borderRadius: radius.md, padding: 3, gap: 3 },
  segmentItem: { flex: 1, alignItems: 'center', paddingVertical: space.sm + 2, borderRadius: radius.sm },
  segmentItemActive: { backgroundColor: colors.surfaceHi },
  segmentText: { ...type.label, color: colors.dim },
  segmentTextActive: { color: colors.text },

  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: space.md + 2, paddingHorizontal: space.lg, gap: space.md },
  rowPressed: { backgroundColor: colors.surfaceAlt },
  rowIcon: { width: 20, textAlign: 'center' },
  rowBody: { flex: 1 },
  rowTitle: { ...type.body, color: colors.text },
  rowSub: { fontSize: 13, color: colors.dim, marginTop: 2 },

  tile: { flex: 1, backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: space.md },
  tileLabel: { fontSize: 10, fontWeight: '700', letterSpacing: 0.6, color: colors.faint },
  tileValue: { fontSize: 20, fontWeight: '700', color: colors.text, marginTop: 4 },
  tileUnit: { fontSize: 12, fontWeight: '600', color: colors.dim },

  badge: { alignSelf: 'flex-start', borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: 4 },
  badgeText: { fontSize: 12, fontWeight: '700', letterSpacing: 0.3 },

  empty: { alignItems: 'center', paddingVertical: space.xxl, gap: space.sm },
  emptyIcon: {
    width: 56,
    height: 56,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.xs,
  },
  emptyTitle: { ...type.heading, color: colors.text },
  emptySub: { fontSize: 14, color: colors.dim, textAlign: 'center', paddingHorizontal: space.xl },
});
