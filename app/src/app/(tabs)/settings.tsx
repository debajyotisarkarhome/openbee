import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { SIM_SPEED_CHOICES, settings } from '../../services/settings';
import { Card, Divider, Row, SectionLabel, SegmentedControl, ToggleRow } from '../../ui/components';
import { BOTTOM_BAR_CLEARANCE } from '../../ui/BottomBar';
import { useSettings } from '../../ui/hooks';
import { colors, space, speedLabel, toSpeed } from '../../ui/theme';

export default function SettingsScreen() {
  const s = useSettings();

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View>
        <SectionLabel>Units</SectionLabel>
        <Card>
          <View style={styles.pad}>
            <SegmentedControl
              value={s.units}
              onChange={(v) => settings.set('units', v)}
              options={[
                { label: 'Metric', value: 'metric' as const },
                { label: 'Imperial', value: 'imperial' as const },
              ]}
            />
            <Text style={styles.hint}>
              Distances and speeds on this phone. The handlebar display always shows metric — the firmware
              formats those itself.
            </Text>
          </View>
        </Card>
      </View>

      <View>
        <SectionLabel>Simulated ride</SectionLabel>
        <Card>
          <View style={styles.pad}>
            <SegmentedControl
              value={s.simSpeedKmh}
              onChange={(v) => settings.set('simSpeedKmh', v)}
              options={SIM_SPEED_CHOICES.map((kmh) => ({
                label: `${toSpeed(kmh, s.units)} ${speedLabel(s.units)}`,
                value: kmh,
              }))}
            />
            <Text style={styles.hint}>
              Replays a planned route with fake GPS through the full pipeline, so you can test the display
              without riding.
            </Text>
          </View>
        </Card>
      </View>

      <View>
        <SectionLabel>Appearance</SectionLabel>
        <Card>
          <ToggleRow
            icon="map-outline"
            title="Route preview"
            subtitle="Show the map when planning"
            value={s.showMap}
            onChange={(v) => settings.set('showMap', v)}
          />
          <Divider />
          <ToggleRow
            icon="navigate-outline"
            title="Mirror road view"
            subtitle="Draw what the display is drawing"
            value={s.showRoadShape}
            onChange={(v) => settings.set('showRoadShape', v)}
          />
        </Card>
      </View>

      <View>
        <SectionLabel>About</SectionLabel>
        <Card>
          <Row icon="bluetooth-outline" title="Protocol" subtitle="OpenBee BLE v1" />
          <Divider />
          <Row icon="git-branch-outline" title="Routing" subtitle="Valhalla motorcycle · quick and curvy options" />
          <Divider />
          <Row icon="information-circle-outline" title="Map streets" subtitle="OpenFreeMap vector tiles · per anchor" />
        </Card>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: space.lg, gap: space.xl, paddingBottom: space.xxl + BOTTOM_BAR_CLEARANCE },
  pad: { padding: space.lg, gap: space.md },
  hint: { fontSize: 13, lineHeight: 18, color: colors.dim },
});
