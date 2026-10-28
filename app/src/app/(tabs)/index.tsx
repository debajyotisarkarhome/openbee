import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { LatLon } from '../../core/geo';
import { Route } from '../../core/route';
import { Place, geocode } from '../../services/graphhopper';
import { fetchRoutes } from '../../services/routing';
import { currentPosition, ensureLocationPermission, startRide, startSimulation } from '../../services/runtime';
import { BOTTOM_BAR_CLEARANCE } from '../../ui/BottomBar';
import { Button, Card, Divider, EmptyState, IconButton, Row, SectionLabel, SegmentedControl, StatTile } from '../../ui/components';
import { useSettings } from '../../ui/hooks';
import { RouteMap } from '../../ui/RouteMap';
import { colors, fmtClock, fmtDistance, fmtDuration, radius, space, type } from '../../ui/theme';

type Mode = 'ride' | 'sim';


export default function PlanScreen() {
  const prefs = useSettings();
  const insets = useSafeAreaInsets();

  const [query, setQuery] = useState('');
  const [places, setPlaces] = useState<Place[]>([]);
  const [dest, setDest] = useState<Place | null>(null);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [picked, setPicked] = useState(0);
  const [here, setHere] = useState<LatLon | null>(null);
  const [arrivalEpochs, setArrivalEpochs] = useState<number[]>([]);
  const [mode, setMode] = useState<Mode>('ride');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const search = () =>
    run(async () => {
      if (!query.trim()) return;
      if (!(await ensureLocationPermission(false))) throw new Error('Location permission is needed to plan a route');
      const pos = await currentPosition();
      setHere(pos);
      setRoutes([]);
      setDest(null);
      setArrivalEpochs([]);
      setPlaces(await geocode(query.trim(), pos));
    });

  const pick = (p: Place) =>
    run(async () => {
      const from = here ?? (await currentPosition());
      const found = await fetchRoutes(from, p.point);
      setDest(p);
      setPlaces([]);
      setRoutes(found);
      setPicked(0);
      // Snapshot the arrival clocks now: computing them during render would be impure.
      const now = Date.now();
      setArrivalEpochs(found.map((r) => Math.round((now + r.timeMs) / 1000)));
    });

  const go = () =>
    run(async () => {
      const route = routes[picked];
      if (!route || !dest) return;
      if (mode === 'sim') startSimulation(route, dest.point, prefs.simSpeedKmh);
      else await startRide(route, dest.point);
      router.push('/ride');
    });

  const clear = () => {
    setQuery('');
    setPlaces([]);
    setDest(null);
    setRoutes([]);
    setArrivalEpochs([]);
    setError(null);
  };

  const route = routes[picked] ?? null;
  const arrival = arrivalEpochs[picked] != null ? fmtClock(arrivalEpochs[picked]) : '--:--';
  // fetchRoutes sorts by duration, so index 0 is the quick one. Call out the bendiest too: with both
  // road preferences merged into this list, turns per km is what actually distinguishes them.
  const turnsPerKm = (r: Route) => (r.lengthM > 0 ? r.instructions.length / (r.lengthM / 1000) : 0);
  const curviest =
    routes.length > 1 ? routes.indexOf(routes.reduce((a, b) => (turnsPerKm(b) > turnsPerKm(a) ? b : a))) : -1;

  return (
    <View style={styles.screen}>
      <ScrollView
        style={styles.screen}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + BOTTOM_BAR_CLEARANCE }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.searchWrap}>
          <Ionicons name="search" size={18} color={colors.faint} />
          <TextInput
            style={styles.input}
            placeholder="Where to?"
            placeholderTextColor={colors.faint}
            value={query}
            onChangeText={setQuery}
            onSubmitEditing={search}
            returnKeyType="search"
            autoCorrect={false}
          />
          {query.length > 0 ? <IconButton name="close-circle" size={18} tone={colors.faint} onPress={clear} /> : null}
        </View>

        {error ? (
          <View style={styles.error}>
            <Ionicons name="alert-circle" size={18} color={colors.bad} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        {places.length > 0 ? (
          <View>
            <SectionLabel>Results</SectionLabel>
            <Card>
              {places.map((p, i) => (
                <View key={`${p.point.lat},${p.point.lon},${i}`}>
                  {i > 0 ? <Divider /> : null}
                  <Row icon="location-outline" title={p.name} subtitle={p.detail} onPress={() => pick(p)} />
                </View>
              ))}
            </Card>
          </View>
        ) : null}

        {route && dest ? (
          <>
            {prefs.showMap ? <RouteMap route={route} position={here} /> : null}

            <Card>
              <Row icon="flag-outline" tone={colors.accent} title={dest.name} subtitle={dest.detail} />
            </Card>

            {routes.length > 1 ? (
              <View>
                <SectionLabel>{`${routes.length} routes`}</SectionLabel>
                <Card>
                  {routes.map((r, i) => (
                    <View key={i}>
                      {i > 0 ? <Divider /> : null}
                      <Row
                        icon={i === picked ? 'radio-button-on' : 'radio-button-off'}
                        tone={i === picked ? colors.accent : colors.faint}
                        title={`${fmtDistance(r.lengthM, prefs.units)} · ${fmtDuration(r.timeMs)}`}
                        subtitle={[
                          i === 0 ? 'Quickest' : null,
                          i === curviest && i !== 0 ? 'Curviest' : null,
                          `${r.instructions.length} turns`,
                          `arrives ${arrivalEpochs[i] != null ? fmtClock(arrivalEpochs[i]) : '--:--'}`,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                        onPress={() => setPicked(i)}
                        right={<Text style={styles.routeIdx}>{i + 1}</Text>}
                      />
                    </View>
                  ))}
                </Card>
              </View>
            ) : null}

            <View style={styles.tiles}>
              <StatTile label="Distance" value={fmtDistance(route.lengthM, prefs.units)} />
              <StatTile label="Time" value={fmtDuration(route.timeMs)} />
              <StatTile label="Arrive" value={arrival} />
            </View>

            <View>
              <SectionLabel>Start as</SectionLabel>
              <SegmentedControl
                value={mode}
                onChange={setMode}
                options={[
                  { label: 'Real ride', value: 'ride' as const },
                  { label: 'Simulated', value: 'sim' as const },
                ]}
              />
            </View>

            <Button
              label={mode === 'sim' ? 'Start simulation' : 'Start ride'}
              icon={mode === 'sim' ? 'play' : 'navigate'}
              onPress={go}
              loading={busy}
            />
          </>
        ) : places.length === 0 && !busy ? (
          <EmptyState
            icon="map-outline"
            title="Plan a ride"
            subtitle="Search for a destination. The phone does the routing and streams directions to your display."
          />
        ) : null}

        {busy && !route ? <EmptyState icon="hourglass-outline" title="Working…" /> : null}
      </ScrollView>

    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: space.lg, gap: space.lg },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
  },
  input: { flex: 1, ...type.body, color: colors.text, paddingVertical: space.lg },
  error: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  errorText: { flex: 1, color: colors.bad, fontSize: 14 },
  tiles: { flexDirection: 'row', gap: space.sm },
  routeIdx: { ...type.label, color: colors.faint },
});
