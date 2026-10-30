import { Camera, GeoJSONSource, Layer, Map, StyleSpecification } from '@maplibre/maplibre-react-native';
import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';

import { LatLon } from '../core/geo';
import { Route } from '../core/route';
import { colors, radius } from './theme';

// OpenStreetMap raster tiles: fine for light personal use; see https://operations.osmfoundation.org/policies/tiles/
export const BASE_MAP_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors',
      maxzoom: 19,
    },
  },
  // Desaturated and inverted (brightness min/max swapped) so the light OSM style becomes a quiet dark
  // base map under the blue route, matching the rest of the app.
  layers: [
    {
      id: 'osm',
      type: 'raster',
      source: 'osm',
      paint: { 'raster-saturation': -1, 'raster-brightness-min': 0.92, 'raster-brightness-max': 0.06 },
    },
  ],
};

export function RouteMap({ route, position }: { route: Route; position?: LatLon | null }) {
  const line = useMemo<GeoJSON.Feature>(
    () => ({
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: route.points.map((p) => [p.lon, p.lat]) },
    }),
    [route],
  );
  const bounds = useMemo(() => {
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const p of route.points) {
      w = Math.min(w, p.lon); e = Math.max(e, p.lon);
      s = Math.min(s, p.lat); n = Math.max(n, p.lat);
    }
    return [w, s, e, n] as [number, number, number, number];
  }, [route]);

  return (
    <View style={styles.wrap}>
      <Map style={StyleSheet.absoluteFill} mapStyle={BASE_MAP_STYLE}>
        <Camera key={bounds.join(',')} initialViewState={{ bounds, padding: { top: 40, bottom: 40, left: 40, right: 40 } }} />
        <GeoJSONSource id="route" data={line}>
          <Layer
            id="route-casing"
            type="line"
            paint={{ 'line-color': colors.routeCasing, 'line-width': 9 }}
            layout={{ 'line-cap': 'round', 'line-join': 'round' }}
          />
          <Layer
            id="route-line"
            type="line"
            paint={{ 'line-color': colors.route, 'line-width': 5 }}
            layout={{ 'line-cap': 'round', 'line-join': 'round' }}
          />
        </GeoJSONSource>
        {position ? (
          <GeoJSONSource id="me" data={{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [position.lon, position.lat] } }}>
            <Layer
              id="me-dot"
              type="circle"
              paint={{
                'circle-radius': 7,
                'circle-color': colors.text,
                'circle-stroke-color': colors.bg,
                'circle-stroke-width': 3,
              }}
            />
          </GeoJSONSource>
        ) : null}
      </Map>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { height: 240, borderRadius: radius.lg, overflow: 'hidden', backgroundColor: colors.surface },
});
