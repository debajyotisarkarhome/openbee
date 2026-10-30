// Pick a destination on the map: drag the map under a fixed pin (or tap to jump there), then confirm.
// The place under the pin is named by reverse geocoding; the chosen Place goes back to the plan screen
// through placePicker, which routes to it.
import { Ionicons } from '@expo/vector-icons';
import { Camera, CameraRef, Map } from '@maplibre/maplibre-react-native';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { LatLon } from '../core/geo';
import { Place, reverseGeocode } from '../services/graphhopper';
import { placePicker } from '../services/placePicker';
import { currentPosition, ensureLocationPermission } from '../services/runtime';
import { Button, IconButton } from '../ui/components';
import { BASE_MAP_STYLE } from '../ui/RouteMap';
import { colors, layout, space, type } from '../ui/theme';

const PIN_SIZE = 44;
const START_ZOOM = 15;

export default function PickScreen() {
  const insets = useSafeAreaInsets();
  const camera = useRef<CameraRef>(null);
  // undefined: still locating. null: no location, start zoomed out.
  const [start, setStart] = useState<LatLon | null | undefined>(undefined);
  const [here, setHere] = useState<LatLon | null>(null);
  const [center, setCenter] = useState<LatLon | null>(null);
  const [place, setPlace] = useState<Place | null>(null);
  // Lookups return the exact point they were asked about, so a stale name is one for another point.
  const naming = center != null && place?.point !== center;

  useEffect(() => {
    void (async () => {
      try {
        if (!(await ensureLocationPermission(false))) throw new Error();
        const p = await currentPosition();
        setHere(p);
        setStart(p);
        setCenter(p);
      } catch {
        setStart(null);
      }
    })();
  }, []);

  // Name whatever is under the pin once the map settles. Only the latest lookup may land.
  useEffect(() => {
    if (!center) return;
    let current = true;
    const fallback: Place = { name: 'Dropped pin', detail: `${center.lat.toFixed(5)}, ${center.lon.toFixed(5)}`, point: center };
    void reverseGeocode(center)
      .catch(() => fallback)
      .then((p) => {
        if (current) setPlace(p);
      });
    return () => {
      current = false;
    };
  }, [center]);

  const confirm = () => {
    if (!place) return;
    placePicker.emit(place);
    router.back();
  };

  return (
    <View style={styles.screen}>
      <View style={[styles.top, { paddingTop: insets.top + space.sm }]}>
        <IconButton name="close" onPress={() => router.back()} />
        <Text style={styles.title}>Pick on map</Text>
        <IconButton
          name="locate-outline"
          tone={here ? colors.accent : colors.faint}
          onPress={() => here && camera.current?.easeTo({ center: [here.lon, here.lat], duration: 400 })}
        />
      </View>

      <View style={styles.mapWrap}>
        {start === undefined ? (
          <ActivityIndicator style={styles.loading} color={colors.accent} />
        ) : (
          <Map
            style={StyleSheet.absoluteFill}
            mapStyle={BASE_MAP_STYLE}
            onRegionDidChange={(e) => {
              const [lon, lat] = e.nativeEvent.center;
              setCenter({ lat, lon });
            }}
            onPress={(e) => {
              const [lon, lat] = e.nativeEvent.lngLat;
              camera.current?.easeTo({ center: [lon, lat], duration: 250 });
            }}
          >
            <Camera
              ref={camera}
              initialViewState={start ? { center: [start.lon, start.lat], zoom: START_ZOOM } : { zoom: 1 }}
            />
          </Map>
        )}
        {/* The pin's tip marks the map centre; the dot shows the exact spot. */}
        <View style={styles.pinLayer} pointerEvents="none">
          <View style={styles.pinShadow} />
          <Ionicons name="location" size={PIN_SIZE} color={colors.accent} style={styles.pin} />
        </View>
      </View>

      <View style={[styles.sheet, { paddingBottom: insets.bottom + space.lg }]}>
        <View style={styles.placeRow}>
          <Ionicons name="flag-outline" size={18} color={colors.dim} />
          <View style={styles.placeText}>
            <Text style={styles.placeName} numberOfLines={1}>
              {place?.name ?? (start === null ? 'Move the map to your destination' : 'Locating…')}
            </Text>
            <Text style={styles.placeDetail} numberOfLines={1}>
              {naming ? 'Looking up this spot…' : (place?.detail ?? 'Drag the map or tap to place the pin')}
            </Text>
          </View>
        </View>
        <Button label="Route here" icon="arrow-forward" onPress={confirm} disabled={!place || naming} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: layout.gutter - space.xs,
    paddingBottom: space.sm,
  },
  title: { ...type.heading, color: colors.text },
  mapWrap: { flex: 1, backgroundColor: colors.surface },
  loading: { flex: 1 },
  pinLayer: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  // Lift the glyph by its own height so its tip, not its middle, sits on the centre.
  pin: { position: 'absolute', top: '50%', left: '50%', marginTop: -PIN_SIZE, marginLeft: -PIN_SIZE / 2 },
  pinShadow: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.text },
  sheet: {
    paddingHorizontal: layout.gutter,
    paddingTop: layout.section,
    gap: layout.section,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderHi,
  },
  placeRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  placeText: { flex: 1 },
  placeName: { ...type.title, color: colors.text },
  placeDetail: { fontSize: 14, color: colors.dim, marginTop: space.xs },
});
