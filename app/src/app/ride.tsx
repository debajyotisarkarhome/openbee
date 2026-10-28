import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Maneuver, NavState } from '../core/proto';
import { isSimulating, stopRide } from '../services/runtime';
import { Badge, Button, Card, EmptyState, StatTile } from '../ui/components';
import { useLink, useSession, useSettings } from '../ui/hooks';
import { RoadShape } from '../ui/RoadShape';
import { colors, curveColors, fmtClock, fmtDistance, radius, space, speedLabel, toSpeed, type } from '../ui/theme';

const MANEUVER_TEXT: Record<Maneuver, string> = {
  [Maneuver.NONE]: '',
  [Maneuver.STRAIGHT]: 'Continue',
  [Maneuver.SLIGHT_LEFT]: 'Slight left',
  [Maneuver.LEFT]: 'Turn left',
  [Maneuver.SHARP_LEFT]: 'Sharp left',
  [Maneuver.SLIGHT_RIGHT]: 'Slight right',
  [Maneuver.RIGHT]: 'Turn right',
  [Maneuver.SHARP_RIGHT]: 'Sharp right',
  [Maneuver.UTURN_LEFT]: 'U-turn',
  [Maneuver.UTURN_RIGHT]: 'U-turn',
  [Maneuver.KEEP_LEFT]: 'Keep left',
  [Maneuver.KEEP_RIGHT]: 'Keep right',
  [Maneuver.ROUNDABOUT]: 'Roundabout',
  [Maneuver.ARRIVE]: 'Arrive',
  [Maneuver.DEPART]: 'Depart',
};

/** Arrow glyph per maneuver, mirroring the shapes draw_arrow() renders on the device. */
const MANEUVER_ICON: Partial<Record<Maneuver, keyof typeof Ionicons.glyphMap>> = {
  [Maneuver.STRAIGHT]: 'arrow-up',
  [Maneuver.SLIGHT_LEFT]: 'arrow-up',
  [Maneuver.LEFT]: 'arrow-back',
  [Maneuver.SHARP_LEFT]: 'arrow-back',
  [Maneuver.SLIGHT_RIGHT]: 'arrow-up',
  [Maneuver.RIGHT]: 'arrow-forward',
  [Maneuver.SHARP_RIGHT]: 'arrow-forward',
  [Maneuver.UTURN_LEFT]: 'return-down-back',
  [Maneuver.UTURN_RIGHT]: 'return-down-forward',
  [Maneuver.KEEP_LEFT]: 'arrow-up',
  [Maneuver.KEEP_RIGHT]: 'arrow-up',
  [Maneuver.ROUNDABOUT]: 'sync',
  [Maneuver.ARRIVE]: 'flag',
  [Maneuver.DEPART]: 'navigate',
};

const STATE_BANNER: Partial<Record<NavState, { label: string; tone: string; icon: keyof typeof Ionicons.glyphMap }>> = {
  [NavState.REROUTING]: { label: 'Rerouting…', tone: colors.warn, icon: 'refresh' },
  [NavState.GPS_LOST]: { label: 'GPS signal lost', tone: colors.bad, icon: 'warning' },
  [NavState.ARRIVED]: { label: 'You have arrived', tone: colors.ok, icon: 'checkmark-circle' },
};

const CURVE_TEXT = ['', 'Gentle', 'Medium', 'Sharp'];

export default function RideScreen() {
  const v = useSession();
  const ble = useLink();
  const prefs = useSettings();
  const insets = useSafeAreaInsets();
  const s = v.snapshot;
  const banner = STATE_BANNER[v.state];

  const stop = async () => {
    await stopRide();
    router.back();
  };

  const over = s?.limitKmh != null && s.speedKmh > s.limitKmh + 5;

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xl }]}
    >
      <View style={styles.statusRow}>
        <Badge
          label={ble.status === 'connected' ? (ble.deviceName ?? 'Display') : 'No display'}
          tone={ble.status === 'connected' ? colors.ok : colors.warn}
        />
        {isSimulating() ? <Badge label="SIMULATED" tone={colors.accent} /> : null}
      </View>

      {banner ? (
        <View style={[styles.banner, { backgroundColor: banner.tone }]}>
          <Ionicons name={banner.icon} size={18} color="#FFFFFF" />
          <Text style={styles.bannerText}>{banner.label}</Text>
        </View>
      ) : null}

      {v.error ? <Text style={styles.error}>{v.error}</Text> : null}

      {s ? (
        <>
          <Card style={styles.hero}>
            <View style={styles.heroTop}>
              <View style={styles.arrowBubble}>
                <Ionicons name={MANEUVER_ICON[s.nav.maneuver as Maneuver] ?? 'navigate'} size={34} color={colors.accent} />
              </View>
              <View style={styles.heroText}>
                <Text style={styles.heroDist}>{s.nav.distM != null ? fmtDistance(s.nav.distM, prefs.units) : '--'}</Text>
                <Text style={styles.heroManeuver} numberOfLines={1}>
                  {MANEUVER_TEXT[s.nav.maneuver as Maneuver]}
                  {s.nav.maneuver === Maneuver.ROUNDABOUT && s.nav.exit ? ` · exit ${s.nav.exit}` : ''}
                </Text>
              </View>
            </View>
            {s.nav.street ? (
              <Text style={styles.street} numberOfLines={1}>
                {s.nav.street}
              </Text>
            ) : null}
            {s.nav.curveClass >= 2 && s.nav.curveDistM <= 400 ? (
              <View style={[styles.curve, { backgroundColor: curveColors[s.nav.curveClass] }]}>
                <Ionicons name={s.nav.curveDir < 0 ? 'arrow-back' : 'arrow-forward'} size={14} color="#000" />
                <Text style={styles.curveText}>
                  {CURVE_TEXT[s.nav.curveClass].toUpperCase()} in {fmtDistance(s.nav.curveDistM, prefs.units)}
                </Text>
              </View>
            ) : null}
          </Card>

          {prefs.showRoadShape ? (
            <>
              <RoadShape points={s.nav.points} maneuverIdx={s.nav.maneuverIdx} streets={v.streets} />
              {v.roadsError ? (
                <View style={styles.note}>
                  <Ionicons name="cloud-offline-outline" size={14} color={colors.warn} />
                  <Text style={styles.noteText}>{v.roadsError}</Text>
                </View>
              ) : null}
            </>
          ) : null}

          <View style={styles.tiles}>
            <StatTile
              label="Speed"
              value={`${toSpeed(s.speedKmh, prefs.units)}`}
              unit={speedLabel(prefs.units)}
              tone={over ? colors.bad : undefined}
            />
            <StatTile
              label="Limit"
              value={s.limitKmh != null ? `${toSpeed(s.limitKmh, prefs.units)}` : '–'}
              unit={s.limitKmh != null ? speedLabel(prefs.units) : undefined}
            />
          </View>
          <View style={styles.tiles}>
            <StatTile label="Arrive" value={fmtClock(s.etaEpoch)} />
            <StatTile label="Remaining" value={fmtDistance(s.remainingM, prefs.units)} />
          </View>
        </>
      ) : (
        <EmptyState icon="locate-outline" title="Waiting for GPS…" subtitle="Hold still for a moment while the first fix lands." />
      )}

      <Button label="End ride" icon="stop-circle-outline" variant="danger" onPress={stop} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: space.lg, gap: space.md },
  statusRow: { flexDirection: 'row', gap: space.sm },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    borderRadius: radius.md,
    paddingVertical: space.md,
  },
  bannerText: { color: '#FFFFFF', fontWeight: '700', fontSize: 15 },
  error: { color: colors.bad, fontSize: 14 },

  hero: { padding: space.lg, gap: space.md },
  heroTop: { flexDirection: 'row', alignItems: 'center', gap: space.lg },
  arrowBubble: {
    width: 64,
    height: 64,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceHi,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroText: { flex: 1 },
  heroDist: { ...type.hero, color: colors.text },
  heroManeuver: { ...type.heading, color: colors.dim, marginTop: -2 },
  street: { ...type.body, color: colors.text },
  curve: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs + 2,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: 5,
  },
  curveText: { color: '#000000', fontWeight: '800', fontSize: 12, letterSpacing: 0.4 },
  tiles: { flexDirection: 'row', gap: space.sm },
  note: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.xs + 2 },
  noteText: { color: colors.warn, fontSize: 12, textAlign: 'center' },
});
