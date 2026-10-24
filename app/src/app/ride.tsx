import { router } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Maneuver, NavState } from '../core/proto';
import { isSimulating, stopRide } from '../services/runtime';
import { useLink, useSession } from '../ui/hooks';
import { RoadShape } from '../ui/RoadShape';
import { colors, curveColors, fmtClock, fmtDistance } from '../ui/theme';

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

const STATE_TEXT: Partial<Record<NavState, [string, string]>> = {
  [NavState.REROUTING]: ['Rerouting…', colors.warn],
  [NavState.GPS_LOST]: ['GPS signal lost', colors.bad],
  [NavState.ARRIVED]: ['You have arrived', colors.ok],
};

const CURVE_TEXT = ['', 'Gentle', 'Medium', 'Sharp'];

export default function RideScreen() {
  const v = useSession();
  const ble = useLink();
  const s = v.snapshot;
  const banner = STATE_TEXT[v.state];

  const stop = async () => {
    await stopRide();
    router.back();
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ gap: 14, padding: 16 }}>
      <Text style={[styles.dim, { color: ble.status === 'connected' ? colors.ok : colors.warn }]}>
        {ble.status === 'connected' ? `Display: ${ble.deviceName}` : 'Display not connected'}
        {isSimulating() ? ' · simulated ride' : ''}
      </Text>
      {banner ? <Text style={[styles.banner, { backgroundColor: banner[1] }]}>{banner[0]}</Text> : null}
      {v.error ? <Text style={{ color: colors.bad }}>{v.error}</Text> : null}

      {s ? (
        <>
          <View style={styles.card}>
            <Text style={styles.big}>{s.nav.distM != null ? fmtDistance(s.nav.distM) : '--'}</Text>
            <Text style={styles.title}>
              {MANEUVER_TEXT[s.nav.maneuver as Maneuver]}
              {s.nav.maneuver === Maneuver.ROUNDABOUT && s.nav.exit ? ` · exit ${s.nav.exit}` : ''}
            </Text>
            {s.nav.street ? <Text style={styles.dim}>{s.nav.street}</Text> : null}
            {s.nav.curveClass >= 2 && s.nav.curveDistM <= 400 ? (
              <Text style={[styles.curve, { backgroundColor: curveColors[s.nav.curveClass] }]}>
                {CURVE_TEXT[s.nav.curveClass]} {s.nav.curveDir < 0 ? 'left' : 'right'} in {fmtDistance(s.nav.curveDistM)}
              </Text>
            ) : null}
          </View>
          <RoadShape points={s.nav.points} maneuverIdx={s.nav.maneuverIdx} />
          <View style={styles.row}>
            <Stat label="Speed" value={`${s.speedKmh}`} unit="km/h" warn={s.limitKmh != null && s.speedKmh > s.limitKmh + 5} />
            <Stat label="Limit" value={s.limitKmh != null ? `${s.limitKmh}` : '–'} />
            <Stat label="ETA" value={fmtClock(s.etaEpoch)} />
            <Stat label="Left" value={fmtDistance(s.remainingM)} />
          </View>
        </>
      ) : (
        <Text style={styles.dim}>Waiting for GPS…</Text>
      )}

      <Pressable style={styles.stop} onPress={stop}>
        <Text style={styles.stopText}>End ride</Text>
      </Pressable>
    </ScrollView>
  );
}

function Stat({ label, value, unit, warn }: { label: string; value: string; unit?: string; warn?: boolean }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.dim}>{label}</Text>
      <Text style={[styles.statValue, warn && { color: colors.bad }]}>
        {value}
        {unit ? <Text style={styles.dim}> {unit}</Text> : null}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  card: { backgroundColor: colors.card, borderRadius: 16, padding: 16, gap: 4 },
  big: { color: colors.text, fontSize: 44, fontWeight: '800' },
  title: { color: colors.text, fontSize: 20, fontWeight: '600' },
  dim: { color: colors.dim },
  banner: { color: '#fff', fontWeight: '700', textAlign: 'center', borderRadius: 10, paddingVertical: 10, overflow: 'hidden' },
  curve: { alignSelf: 'flex-start', marginTop: 8, color: '#000', fontWeight: '700', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4, overflow: 'hidden' },
  row: { flexDirection: 'row', gap: 8 },
  stat: { flex: 1, backgroundColor: colors.card, borderRadius: 12, padding: 10 },
  statValue: { color: colors.text, fontSize: 18, fontWeight: '700', marginTop: 2 },
  stop: { backgroundColor: colors.bad, borderRadius: 12, paddingVertical: 16, alignItems: 'center', marginTop: 8 },
  stopText: { color: '#fff', fontWeight: '700', fontSize: 17 },
});
