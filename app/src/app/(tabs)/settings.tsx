import { useSyncExternalStore } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { mediaPermission } from '../../services/media';
import { SIM_SPEED_CHOICES, settings } from '../../services/settings';
import { Card, Divider, Row, ScreenTitle, SectionLabel, SegmentedControl, ToggleRow } from '../../ui/components';
import { useSettings } from '../../ui/hooks';
import { colors, layout, speedLabel, toSpeed } from '../../ui/theme';

export default function SettingsScreen() {
  const s = useSettings();
  const media = useSyncExternalStore(mediaPermission.subscribe, mediaPermission.getView);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <ScreenTitle>Settings</ScreenTitle>

      <View>
        <SectionLabel icon="speedometer-outline">Units</SectionLabel>
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
            Distances and speeds on this phone. The handlebar display always shows metric, since the firmware
            formats those itself.
          </Text>
        </View>
      </View>

      <View>
        <SectionLabel icon="flask-outline">Simulated ride</SectionLabel>
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
      </View>

      <View>
        <SectionLabel icon="color-palette-outline">Appearance</SectionLabel>
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
            icon="navigate-circle-outline"
            title="Mirror road view"
            subtitle="Draw what the display is drawing"
            value={s.showRoadShape}
            onChange={(v) => settings.set('showRoadShape', v)}
          />
        </Card>
      </View>

      {media.supported ? (
        <View>
          <SectionLabel icon="musical-notes-outline">Media</SectionLabel>
          <Card>
            <Row
              icon="play-circle-outline"
              title="Media controls on display"
              subtitle={media.granted ? 'Allowed' : 'Tap to allow notification access'}
              onPress={() => mediaPermission.open()}
            />
          </Card>
        </View>
      ) : null}

      <View>
        <SectionLabel icon="information-circle-outline">About</SectionLabel>
        <Card>
          <Row icon="bluetooth-outline" title="Protocol" subtitle="OpenBee BLE v1" />
          <Divider />
          <Row icon="git-branch-outline" title="Routing" subtitle="Valhalla motorcycle · quick and curvy options" />
          <Divider />
          <Row icon="map-outline" title="Map streets" subtitle="OpenFreeMap vector tiles · per anchor" />
        </Card>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: layout.gutter, paddingBottom: layout.bottom, gap: layout.section },
  pad: { gap: layout.tight },
  hint: { fontSize: 13, lineHeight: 18, color: colors.dim },
});
