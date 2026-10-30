import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Maneuver, NavState } from '../core/proto';
import { isSimulating, stopRide } from '../services/runtime';
import { Badge, Button, EmptyState, StatTile } from '../ui/components';
import { useLink, useSession, useSettings } from '../ui/hooks';
import { RoadShape } from '../ui/RoadShape';
import { colors, curveColors, fmtClock, fmtDistance, layout, radius, space, speedLabel, toSpeed, type } from '../ui/theme';

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
  [NavState.REROUTING]: { label: 'rerouting…', tone: colors.warn, icon: 'refresh' },
  [NavState.GPS_LOST]: { label: 'gps signal lost', tone: colors.bad, icon: 'warning' },
  [NavState.ARRIVED]: { label: 'you have arrived', tone: colors.ok, icon: 'checkmark' },
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
      contentContainerStyle={[styles.content, { paddingTop: insets.top + layout.section, paddingBottom: insets.bottom + layout.bottom }]}
    >
      <View style={styles.statusRow}>
        <Badge
          label={ble.status === 'connected' ? (ble.deviceName ?? 'Display') : 'No display'}
          tone={ble.status === 'connected' ? colors.ok : colors.bad}
          ink={ble.status === 'connected' ? colors.ok : undefined}
        />
        {isSimulating() ? <Badge label="Simulated" tone={colors.accent} /> : null}
      </View>

      {banner ? (
        <View style={[styles.banner, { backgroundColor: banner.tone }]}>
          <Ionicons name={banner.icon} size={16} color={colors.accentInk} />
          <Text style={styles.bannerText}>{banner.label}</Text>
        </View>
      ) : null}

      {v.error ? <Text style={styles.error}>{v.error}</Text> : null}

      {s ? (
        <>
          <View style={styles.hero}>
            <View style={styles.heroTop}>
              <Ionicons name={MANEUVER_ICON[s.nav.maneuver as Maneuver] ?? 'navigate'} size={52} color={colors.accent} />
              <Text style={styles.heroDist} numberOfLines={1} adjustsFontSizeToFit>
                {s.nav.distM != null ? fmtDistance(s.nav.distM, prefs.units) : '--'}
              </Text>
            </View>
            <Text style={styles.heroManeuver} numberOfLines={1}>
              {MANEUVER_TEXT[s.nav.maneuver as Maneuver]}
              {s.nav.maneuver === Maneuver.ROUNDABOUT && s.nav.exit ? `, exit ${s.nav.exit}` : ''}
              {s.nav.street ? <Text style={styles.street}>{`  ${s.nav.street}`}</Text> : null}
            </Text>
            {s.nav.curveClass >= 2 && s.nav.curveDistM <= 400 ? (
              <View style={[styles.curve, { backgroundColor: curveColors[s.nav.curveClass] }]}>
                <Ionicons name={s.nav.curveDir < 0 ? 'arrow-back' : 'arrow-forward'} size={14} color="#000" />
                <Text style={styles.curveText}>
                  {CURVE_TEXT[s.nav.curveClass].toLowerCase()} curve in {fmtDistance(s.nav.curveDistM, prefs.units)}
                </Text>
              </View>
            ) : null}
          </View>

          {prefs.showRoadShape ? (
            <View style={styles.hero}>
              <RoadShape points={s.nav.points} maneuverIdx={s.nav.maneuverIdx} streets={v.streets} />
              {v.roadsError ? <Text style={styles.noteText}>{v.roadsError}</Text> : null}
            </View>
          ) : null}

          <View style={styles.readouts}>
            <View style={styles.tiles}>
              <StatTile
                icon="speedometer-outline"
                label="Speed"
                value={`${toSpeed(s.speedKmh, prefs.units)}`}
                unit={speedLabel(prefs.units)}
                tone={over ? colors.bad : undefined}
              />
              <StatTile
                icon="alert-circle-outline"
                label="Limit"
                value={s.limitKmh != null ? `${toSpeed(s.limitKmh, prefs.units)}` : '--'}
                unit={s.limitKmh != null ? speedLabel(prefs.units) : undefined}
              />
            </View>
            <View style={styles.tiles}>
              <StatTile icon="flag-outline" label="Arrive" value={fmtClock(s.etaEpoch)} />
              <StatTile icon="map-outline" label="Remaining" value={fmtDistance(s.remainingM, prefs.units)} />
            </View>
          </View>
        </>
      ) : (
        <EmptyState icon="locate-outline" title="Waiting for GPS…" subtitle="Hold still for a moment while the first fix lands." />
      )}

      <Button label="End ride" icon="stop" variant="danger" onPress={stop} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: layout.gutter, gap: layout.section },
  statusRow: { flexDirection: 'row', gap: space.lg },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    borderRadius: radius.sm,
    paddingVertical: space.sm + 2,
    paddingHorizontal: space.md,
  },
  bannerText: { ...type.label, fontSize: 13, color: colors.accentInk },
  error: { color: colors.bad, fontSize: 14 },

  hero: { gap: layout.tight },
  heroTop: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  heroDist: { ...type.hero, color: colors.text, flex: 1 },
  heroManeuver: { ...type.title, color: colors.text },
  street: { color: colors.dim, fontWeight: '400' },
  curve: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs + 2,
    borderRadius: radius.sm,
    paddingHorizontal: space.sm + 2,
    paddingVertical: 5,
    marginTop: space.xs,
  },
  curveText: { ...type.label, fontSize: 12, color: '#000000' },
  readouts: { gap: layout.group },
  tiles: { flexDirection: 'row', gap: space.lg },
  noteText: { ...type.label, color: colors.warn, textAlign: 'center' },
});
