import { useEffect } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { link } from '../../services/runtime';
import { Badge, Button, Card, Divider, EmptyState, Row, ScreenTitle, SectionLabel, StatTile } from '../../ui/components';
import { useLink } from '../../ui/hooks';
import { colors, layout, space, type } from '../../ui/theme';

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
        <View style={styles.titleGroup}>
          <ScreenTitle kicker="display">{v.deviceName ?? 'OpenBee'}</ScreenTitle>
          <Badge label="Connected" tone={colors.ok} ink={colors.ok} />
        </View>

        {d ? (
          <View style={styles.group}>
            <View style={styles.tiles}>
              <StatTile
                icon="battery-half-outline"
                label="Battery"
                value={`${d.battPct}`}
                unit="%"
                tone={d.battPct < 20 ? colors.bad : undefined}
              />
              <StatTile icon="flash-outline" label="Voltage" value={(d.battMv / 1000).toFixed(2)} unit="V" />
              <StatTile icon="hardware-chip-outline" label="Firmware" value={`${d.fwVer}`} />
            </View>
            {d.charging ? <Badge label="Charging" tone={colors.charge} ink={colors.charge} /> : null}
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
      <View style={styles.titleGroup}>
        <ScreenTitle kicker="display">Pair a display</ScreenTitle>
        <Text style={styles.hint}>{STATUS_HINT[v.status] ?? STATUS_HINT.idle}</Text>
      </View>

      {v.found.length > 0 ? (
        <View>
          <SectionLabel icon="radio-outline">{`${v.found.length} found`}</SectionLabel>
          <Card>
            {v.found.map((d, i) => (
              <View key={d.id}>
                {i > 0 ? <Divider /> : null}
                <Row
                  icon="bluetooth-outline"
                  title={d.name}
                  subtitle={signalLabel(d.rssi)}
                  right={<Text style={styles.rssi}>{d.rssi != null ? `${d.rssi} dBm` : '--'}</Text>}
                  onPress={() => link.connect(d.id)}
                />
              </View>
            ))}
          </Card>
        </View>
      ) : v.status === 'scanning' ? (
        <Badge label="Scanning" tone={colors.accent} />
      ) : (
        <EmptyState icon="bluetooth-outline" title="No displays yet" subtitle="Power on the display, then scan." />
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
  content: { paddingHorizontal: layout.gutter, paddingBottom: layout.bottom, gap: layout.section },
  titleGroup: { gap: layout.tight },
  group: { gap: layout.group },
  tiles: { flexDirection: 'row', gap: space.lg },
  hint: { color: colors.dim, fontSize: 15, lineHeight: 21 },
  rssi: { ...type.label, fontSize: 12, color: colors.faint },
});
