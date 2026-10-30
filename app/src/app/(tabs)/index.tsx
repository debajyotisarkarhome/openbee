import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Keyboard, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { LatLon } from '../../core/geo';
import { RideRecord } from '../../core/history';
import { Route } from '../../core/route';
import { Place, geocode } from '../../services/graphhopper';
import { history } from '../../services/history';
import { placePicker } from '../../services/placePicker';
import { fetchRoutes } from '../../services/routing';
import { currentPosition, ensureLocationPermission, startRide, startSimulation } from '../../services/runtime';
import {
  Button,
  Card,
  Divider,
  EmptyState,
  IconButton,
  Row,
  ScreenTitle,
  SectionLabel,
  SegmentedControl,
  StatTile,
} from '../../ui/components';
import { useHistory, useSettings } from '../../ui/hooks';
import { RouteMap } from '../../ui/RouteMap';
import { Units, colors, fmtClock, fmtDay, fmtDistance, fmtDuration, layout, space, type } from '../../ui/theme';

type Mode = 'ride' | 'sim';

function rideIcon(r: RideRecord) {
  if (r.simulated) return 'flask-outline' as const;
  return r.arrived ? ('flag-outline' as const) : ('navigate-outline' as const);
}

function rideSummary(r: RideRecord, units: Units) {
  return [
    fmtDay(r.startedMs),
    fmtDistance(r.riddenM, units),
    fmtDuration(r.endedMs - r.startedMs),
    r.simulated ? 'simulated' : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

function confirmForget(r: RideRecord) {
  Alert.alert('Remove this ride?', r.destination.name, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Remove', style: 'destructive', onPress: () => history.remove(r.id) },
  ]);
}

/** A position this recent is still a fine start point; older, and the rider has probably moved. */
const POSITION_MAX_AGE_MS = 2 * 60_000;

/** What the screen is waiting on, if anything. Each kind has its own spinner. */
type Pending = 'search' | 'route' | 'start' | null;

const PENDING_TEXT: Record<Exclude<Pending, null>, string> = {
  search: 'Searching…',
  route: 'Finding routes…',
  start: 'Starting…',
};

export default function PlanScreen() {
  const prefs = useSettings();
  const rides = useHistory();

  const [query, setQuery] = useState('');
  const [places, setPlaces] = useState<Place[]>([]);
  const [noResults, setNoResults] = useState<string | null>(null);
  const [dest, setDest] = useState<Place | null>(null);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [picked, setPicked] = useState(0);
  const [here, setHere] = useState<LatLon | null>(null);
  const [mode, setMode] = useState<Mode>('ride');
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Every request takes a ticket; only the latest may touch state, so a slow earlier answer (or one
  // that lands after Clear) is dropped instead of overwriting what the rider chose since.
  const ticket = useRef(0);
  const hereAt = useRef(0);

  // Arrival clocks are shown live, so they must not freeze at the moment the routes were fetched.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const run = async (kind: Exclude<Pending, null>, fn: (current: () => boolean) => Promise<void>) => {
    const id = ++ticket.current;
    const current = () => id === ticket.current;
    Keyboard.dismiss();
    setPending(kind);
    setError(null);
    try {
      await fn(current);
    } catch (e) {
      if (current()) setError((e as Error).message);
    } finally {
      if (current()) setPending(null);
    }
  };

  /** Where routes start from: the last fix if it is recent, otherwise a fresh one. */
  const locate = async (): Promise<LatLon> => {
    if (here && Date.now() - hereAt.current < POSITION_MAX_AGE_MS) return here;
    if (!(await ensureLocationPermission(false))) throw new Error('Location permission is needed to plan a route');
    const pos = await currentPosition();
    hereAt.current = Date.now();
    setHere(pos);
    return pos;
  };

  const search = () => {
    const q = query.trim();
    if (!q) return;
    void run('search', async (current) => {
      const found = (await geocode(q, await locate())).filter((p) => p.name);
      if (!current()) return;
      setRoutes([]);
      setDest(null);
      setPlaces(found);
      setNoResults(found.length ? null : q);
    });
  };

  const pick = (p: Place) =>
    run('route', async (current) => {
      const found = await fetchRoutes(await locate(), p.point);
      if (!current()) return;
      // Whatever led here (search, past ride, map), the field names the destination so Clear is offered.
      setQuery(p.name);
      setDest(p);
      setPlaces([]);
      setNoResults(null);
      setRoutes(found);
      setPicked(0);
      setNow(Date.now());
    });

  // A place chosen on the map picker routes exactly like a search result.
  const onMapPick = useEffectEvent((p: Place) => void pick(p));
  useEffect(() => placePicker.listen(onMapPick), []);

  const go = () =>
    run('start', async (current) => {
      const route = routes[picked];
      if (!route || !dest) return;
      if (mode === 'sim') await startSimulation(route, dest, prefs.simSpeedKmh);
      else await startRide(route, dest);
      if (current()) router.push('/ride');
    });

  const clear = () => {
    ticket.current++; // drops anything in flight
    setPending(null);
    setQuery('');
    setPlaces([]);
    setNoResults(null);
    setDest(null);
    setRoutes([]);
    setError(null);
  };

  const route = routes[picked] ?? null;
  const arriveAt = (r: Route) => fmtClock(Math.round((now + r.timeMs) / 1000));
  const showClear = query.length > 0 || places.length > 0 || dest != null || noResults != null;
  const errorText = error ? <Text style={styles.errorText}>{error}</Text> : null;
  // fetchRoutes sorts by duration, so index 0 is the quick one. Call out the bendiest too: with both
  // road preferences merged into this list, turns per km is what actually distinguishes them.
  const turnsPerKm = (r: Route) => (r.lengthM > 0 ? r.instructions.length / (r.lengthM / 1000) : 0);
  const curviest =
    routes.length > 1 ? routes.indexOf(routes.reduce((a, b) => (turnsPerKm(b) > turnsPerKm(a) ? b : a))) : -1;

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <View>
        <ScreenTitle kicker="openbee">Where to?</ScreenTitle>
        <View style={styles.searchWrap}>
          <Ionicons name="search" size={22} color={colors.faint} />
          <TextInput
            style={styles.input}
            placeholder="Search a destination"
            placeholderTextColor={colors.faint}
            selectionColor={colors.accent}
            value={query}
            onChangeText={setQuery}
            onSubmitEditing={search}
            returnKeyType="search"
            autoCorrect={false}
          />
          {showClear ? <IconButton name="close" size={20} tone={colors.faint} onPress={clear} /> : null}
        </View>
        <Pressable
          onPress={() => router.push('/pick')}
          hitSlop={8}
          style={({ pressed }) => [styles.mapLink, pressed && styles.pressed]}
        >
          <Ionicons name="map-outline" size={16} color={colors.accent} />
          <Text style={styles.mapLinkText}>Pick on map</Text>
        </Pressable>
      </View>

      {pending && pending !== 'start' ? (
        <View style={styles.status}>
          <ActivityIndicator size="small" color={colors.accent} />
          <Text style={styles.statusText}>{PENDING_TEXT[pending]}</Text>
        </View>
      ) : null}

      {/* With a route showing, errors (e.g. from Start) appear by the Start button instead. */}
      {route ? null : errorText}

      {noResults ? (
        <EmptyState icon="search-outline" title="No places found" subtitle={`Nothing matched "${noResults}". Try another name, or pick the spot on the map.`} />
      ) : null}

      {places.length > 0 ? (
        <View>
          <SectionLabel icon="list-outline">{`${places.length} results`}</SectionLabel>
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
          <View>
            <SectionLabel icon="flag-outline">destination</SectionLabel>
            <Text style={styles.destName} numberOfLines={2}>
              {dest.name}
            </Text>
            {dest.detail ? (
              <Text style={styles.destDetail} numberOfLines={1}>
                {dest.detail}
              </Text>
            ) : null}
          </View>

          {prefs.showMap ? <RouteMap route={route} position={here} /> : null}

          {routes.length > 1 ? (
            <View>
              <SectionLabel icon="git-branch-outline">{`${routes.length} routes`}</SectionLabel>
              <Card>
                {routes.map((r, i) => (
                  <View key={i}>
                    {i > 0 ? <Divider /> : null}
                    <Row
                      icon={i === 0 ? 'flash-outline' : i === curviest ? 'pulse-outline' : 'navigate-outline'}
                      tone={i === picked ? colors.accent : undefined}
                      title={`${fmtDuration(r.timeMs)}  ·  ${fmtDistance(r.lengthM, prefs.units)}`}
                      subtitle={[
                        i === 0 ? 'Quickest' : null,
                        i === curviest && i !== 0 ? 'Curviest' : null,
                        `${r.instructions.length} turns`,
                        `arrive ${arriveAt(r)}`,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                      onPress={() => setPicked(i)}
                      right={
                        <Text style={[styles.routeIdx, i === picked && styles.routeIdxActive]}>
                          {String(i + 1).padStart(2, '0')}
                        </Text>
                      }
                    />
                  </View>
                ))}
              </Card>
            </View>
          ) : null}

          <View style={styles.tiles}>
            <StatTile icon="map-outline" label="Distance" value={fmtDistance(route.lengthM, prefs.units)} />
            <StatTile icon="time-outline" label="Time" value={fmtDuration(route.timeMs)} />
            <StatTile icon="flag-outline" label="Arrive" value={arriveAt(route)} />
          </View>

          <View style={styles.startGroup}>
            <SegmentedControl
              value={mode}
              onChange={setMode}
              options={[
                { label: 'Real ride', value: 'ride' as const, icon: 'navigate-outline' as const },
                { label: 'Simulated', value: 'sim' as const, icon: 'flask-outline' as const },
              ]}
            />
            {errorText}
            <Button
              label={mode === 'sim' ? 'Start simulation' : 'Start ride'}
              icon="arrow-forward"
              onPress={go}
              loading={pending === 'start'}
              disabled={pending != null}
            />
          </View>
        </>
      ) : places.length === 0 && !noResults && !pending && rides.length > 0 ? (
        <View>
          <SectionLabel icon="time-outline">past rides</SectionLabel>
          <Card>
            {rides.map((r, i) => (
              <View key={r.id}>
                {i > 0 ? <Divider /> : null}
                <Row
                  icon={rideIcon(r)}
                  title={r.destination.name}
                  subtitle={rideSummary(r, prefs.units)}
                  onPress={() => pick(r.destination)}
                  onLongPress={() => confirmForget(r)}
                />
              </View>
            ))}
          </Card>
          <Text style={styles.hint}>Tap to ride there again. Long-press to remove.</Text>
        </View>
      ) : places.length === 0 && !noResults && !pending ? (
        <EmptyState
          icon="compass-outline"
          title="Plan a ride"
          subtitle="Search for a destination. The phone does the routing and streams directions to your display. Your rides will be listed here."
        />
      ) : null}

    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: layout.gutter, paddingBottom: layout.bottom, gap: layout.section },
  searchWrap: {
    marginTop: layout.tight,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    borderBottomWidth: 1,
    borderColor: colors.borderHi,
  },
  input: { flex: 1, ...type.title, fontWeight: '400', color: colors.text, paddingTop: space.xs, paddingBottom: space.sm },
  mapLink: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: layout.group, alignSelf: 'flex-start' },
  mapLinkText: { fontSize: 15, fontWeight: '500', color: colors.accent },
  pressed: { opacity: 0.55 },
  errorText: { color: colors.bad, fontSize: 14, lineHeight: 20 },
  destName: { ...type.title, color: colors.text },
  destDetail: { fontSize: 14, color: colors.dim, marginTop: space.xs },
  tiles: { flexDirection: 'row', gap: space.lg },
  startGroup: { gap: layout.group },
  routeIdx: { ...type.label, fontSize: 13, color: colors.faint },
  routeIdxActive: { color: colors.accent },
  status: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  statusText: { fontSize: 15, color: colors.dim },
  hint: { ...type.label, color: colors.faint, marginTop: layout.tight },
});
