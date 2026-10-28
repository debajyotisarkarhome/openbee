import { useEffect } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { link } from '../../services/runtime';
import { Badge, Button, Card, Divider, EmptyState, Row, SectionLabel, StatTile } from '../../ui/components';
import { BOTTOM_BAR_CLEARANCE } from '../../ui/BottomBar';
import { useLink } from '../../ui/hooks';
import { colors, space } from '../../ui/theme';

/** RSSI is roughly -40 (touching) to -100 (far). Map it to four bars for a readable hint. */
function signalLabel(rssi: number | null): string {
  if (rssi == null) return 'signal unknown';
  if (rssi >= -55) return 'excellent signal';
  if (rssi >= -70) return 'good signal';
  if (rssi >= -85) return 'fair signal';
  return 'weak signal';
}

const STATUS_HINT: Record<string, string> = {
  off: 'Turn on Bluetooth to find your display.',
  connecting: 'Connecting to the display…',
  scanning: 'Looking for OpenBee displays nearby…',
  idle: 'Power on the display, then scan.',
};

export default function DeviceScreen() {
  const v = useLink();

  useEffect(() => {
    if (v.status === 'idle') void link.scan();
    return () => link.stopScan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (v.status === 'connected') {
    const d = v.devStatus;
    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <Card>
          <Row
            icon="bluetooth"
            tone={colors.ok}
            title={v.deviceName ?? 'OpenBee display'}
            subtitle="Connected"
            right={<Badge label="LIVE" tone={colors.ok} />}
          />
        </Card>

        {d ? (
          <View>
            <SectionLabel>Device</SectionLabel>
            <View style={styles.tiles}>
              <StatTile
                label="Battery"
                value={`${d.battPct}`}
                unit="%"
                tone={d.battPct < 20 ? colors.bad : undefined}
              />
              <StatTile label="Voltage" value={(d.battMv / 1000).toFixed(2)} unit="V" />
              <StatTile label="Firmware" value={`v${d.fwVer}`} />
            </View>
            {d.charging ? (
              <View style={styles.chargeRow}>
                <Badge label="CHARGING" tone={colors.ok} ink={colors.ok} />
              </View>
            ) : null}
          </View>
        ) : (
          <Text style={styles.hint}>Waiting for the first status frame…</Text>
        )}

        <Button label="Forget display" icon="close-circle-outline" variant="secondary" onPress={() => link.disconnect()} />
      </ScrollView>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.hint}>{STATUS_HINT[v.status] ?? STATUS_HINT.idle}</Text>

      {v.found.length > 0 ? (
        <View>
          <SectionLabel>Found</SectionLabel>
          <Card>
            {v.found.map((d, i) => (
              <View key={d.id}>
                {i > 0 ? <Divider /> : null}
                <Row
                  icon="hardware-chip-outline"
                  title={d.name}
                  subtitle={signalLabel(d.rssi)}
                  right={<Badge label={d.rssi != null ? `${d.rssi} dBm` : '–'} />}
                  onPress={() => link.connect(d.id)}
                />
              </View>
            ))}
          </Card>
        </View>
      ) : v.status === 'scanning' ? (
        <EmptyState icon="bluetooth-outline" title="Scanning…" subtitle="Make sure the display is powered on and nearby." />
      ) : (
        <EmptyState icon="hardware-chip-outline" title="No displays yet" subtitle="Power on the display, then scan." />
      )}

      <Button
        label={v.status === 'scanning' ? 'Scanning…' : 'Scan again'}
        icon="refresh"
        variant="secondary"
        onPress={() => link.scan()}
        disabled={v.status === 'scanning' || v.status === 'off'}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: space.lg, gap: space.lg, paddingBottom: space.lg + BOTTOM_BAR_CLEARANCE },
  tiles: { flexDirection: 'row', gap: space.sm },
  chargeRow: { marginTop: space.md },
  hint: { color: colors.dim, fontSize: 14, lineHeight: 20 },
});
