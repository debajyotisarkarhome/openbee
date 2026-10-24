import { Link, router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { LatLon } from '../core/geo';
import { Route } from '../core/route';
import { Place, fetchRoute, geocode } from '../services/graphhopper';
import { currentPosition, ensureLocationPermission, startRide, startSimulation } from '../services/runtime';
import { useLink } from '../ui/hooks';
import { RouteMap } from '../ui/RouteMap';
import { colors, fmtDistance, fmtDuration } from '../ui/theme';

export default function PlanScreen() {
  const ble = useLink();
  const [query, setQuery] = useState('');
  const [places, setPlaces] = useState<Place[]>([]);
  const [dest, setDest] = useState<Place | null>(null);
  const [route, setRoute] = useState<Route | null>(null);
  const [here, setHere] = useState<LatLon | null>(null);
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
      if (!(await ensureLocationPermission(false))) throw new Error('Location permission is needed to plan a route');
      const pos = await currentPosition();
      setHere(pos);
      setRoute(null);
      setDest(null);
      setPlaces(await geocode(query.trim(), pos));
    });

  const pick = (p: Place) =>
    run(async () => {
      const from = here ?? (await currentPosition());
      setDest(p);
      setPlaces([]);
      setRoute(await fetchRoute(from, p.point));
    });

  const go = (simulate: boolean) =>
    run(async () => {
      if (!route || !dest) return;
      if (simulate) startSimulation(route, dest.point);
      else await startRide(route, dest.point);
      router.push('/ride');
    });

  const linkLabel =
    ble.status === 'connected' ? `● ${ble.deviceName}` : ble.status === 'off' ? 'Bluetooth off' : 'Connect display';

  return (
    <View style={styles.screen}>
      <Link href="/device" asChild>
        <Pressable style={[styles.chip, ble.status === 'connected' && { borderColor: colors.ok }]}>
          <Text style={[styles.chipText, ble.status === 'connected' && { color: colors.ok }]}>{linkLabel}</Text>
        </Pressable>
      </Link>

      <TextInput
        style={styles.input}
        placeholder="Where to?"
        placeholderTextColor={colors.dim}
        value={query}
        onChangeText={setQuery}
        onSubmitEditing={search}
        returnKeyType="search"
      />
      {busy ? <ActivityIndicator color={colors.accent} style={{ marginVertical: 12 }} /> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}

      {places.length > 0 ? (
        <FlatList
          data={places}
          keyExtractor={(p, i) => `${p.point.lat},${p.point.lon},${i}`}
          renderItem={({ item }) => (
            <Pressable style={styles.place} onPress={() => pick(item)}>
              <Text style={styles.placeName}>{item.name}</Text>
              <Text style={styles.placeDetail}>{item.detail}</Text>
            </Pressable>
          )}
        />
      ) : null}

      {route && dest ? (
        <View style={{ gap: 12 }}>
          <RouteMap route={route} position={here} />
          <View style={styles.summary}>
            <Text style={styles.placeName}>{dest.name}</Text>
            <Text style={styles.placeDetail}>
              {fmtDistance(route.lengthM)} · {fmtDuration(route.timeMs)}
            </Text>
          </View>
          <Pressable style={styles.primary} onPress={() => go(false)} disabled={busy}>
            <Text style={styles.primaryText}>Start ride</Text>
          </Pressable>
          <Pressable style={styles.secondary} onPress={() => go(true)} disabled={busy}>
            <Text style={styles.secondaryText}>Simulate ride</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 16, gap: 12, backgroundColor: colors.bg },
  chip: { alignSelf: 'flex-start', borderWidth: 1, borderColor: colors.border, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 6 },
  chipText: { color: colors.dim, fontWeight: '600' },
  input: { backgroundColor: colors.card, color: colors.text, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 14, fontSize: 17 },
  error: { color: colors.bad },
  place: { paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  placeName: { color: colors.text, fontSize: 16, fontWeight: '600' },
  placeDetail: { color: colors.dim, marginTop: 2 },
  summary: { backgroundColor: colors.card, borderRadius: 12, padding: 14 },
  primary: { backgroundColor: colors.accent, borderRadius: 12, paddingVertical: 16, alignItems: 'center' },
  primaryText: { color: '#00141A', fontWeight: '700', fontSize: 17 },
  secondary: { borderColor: colors.border, borderWidth: 1, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  secondaryText: { color: colors.text, fontWeight: '600' },
});
