// Street geometry from OpenFreeMap vector tiles (OpenMapTiles schema, z14, no API key).
// Replaces the Overpass corridor query as the primary source: tiles are CDN-cached, ~200 KB each, and a
// 700 m anchor needs only about four of them. See src/services/streets.ts for the fallback order.
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';

import { LatLon } from '../core/geo';
import { TileId, coveringTiles, tileKey, tileToLat, tileToLon } from '../core/tiles';

/** Pinned planet build; bump when OpenFreeMap publishes a new one (its TileJSON names the current path). */
const TILE_URL = 'https://tiles.openfreemap.org/planet/20261018_080001_pt/{z}/{x}/{y}.pbf';
const Z = 14; // OpenFreeMap's maxzoom; ~0.55 m per tile unit at mid latitudes
const LAYER = 'transportation';

/** OpenMapTiles `class` values we treat as streets. Excludes rail, ferry, path, track, aerialway, service. */
const ROAD_CLASSES = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor']);

const MAX_TILES_PER_REQUEST = 9;
const CACHE_LIMIT = 256;
const FETCH_TIMEOUT_MS = 8000;

/** Decoded streets per tile, keyed z/x/y. Tiles are immutable, so keeping them across anchors is free. */
const cache = new Map<string, LatLon[][]>();

function remember(k: string, roads: LatLon[][]) {
  cache.delete(k);
  cache.set(k, roads);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
}

// ---------- decoding ----------

/** Pull the road LineStrings out of one MVT, converted to lat/lon. Exported for tests. */
export function decodeTile(buf: ArrayBuffer, t: TileId): LatLon[][] {
  const layer = new VectorTile(new PbfReader(buf)).layers[LAYER];
  if (!layer) return [];
  const roads: LatLon[][] = [];
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i);
    if (f.type !== 2) continue; // LineString only
    if (!ROAD_CLASSES.has(String(f.properties.class))) continue;
    const extent = f.extent;
    for (const ring of f.loadGeometry()) {
      if (ring.length < 2) continue;
      roads.push(
        ring.map((p) => ({
          lat: tileToLat(t.y + p.y / extent, t.z),
          lon: tileToLon(t.x + p.x / extent, t.z),
        })),
      );
    }
  }
  return roads;
}

async function loadTile(t: TileId): Promise<LatLon[][]> {
  const k = tileKey(t);
  const hit = cache.get(k);
  if (hit) return hit;
  const url = TILE_URL.replace('{z}', String(t.z)).replace('{x}', String(t.x)).replace('{y}', String(t.y));
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  // 204/404 are normal: the planet has empty tiles (ocean, desert).
  if (res.status === 204 || res.status === 404) {
    remember(k, []);
    return [];
  }
  if (!res.ok) throw new Error(`Map tiles unavailable (${res.status})`);
  const roads = decodeTile(await res.arrayBuffer(), t);
  remember(k, roads);
  return roads;
}

/** Streets near `center`, from vector tiles. Throws only if every tile fetch fails. */
export async function fetchStreetsFromTiles(center: LatLon, radiusM: number): Promise<LatLon[][]> {
  const tiles = coveringTiles(center, radiusM, Z).slice(0, MAX_TILES_PER_REQUEST);
  const results = await Promise.allSettled(tiles.map(loadTile));
  const ok = results.filter((r) => r.status === 'fulfilled');
  if (!ok.length) {
    const why = results.find((r) => r.status === 'rejected');
    throw new Error(why && why.status === 'rejected' ? (why.reason as Error).message : 'Map tiles unavailable');
  }
  return ok.flatMap((r) => (r as PromiseFulfilledResult<LatLon[][]>).value);
}

/** Warm the cache for tiles the rider is about to reach, so a signal gap does not blank the map. */
export async function prefetchTiles(centers: LatLon[], radiusM: number): Promise<void> {
  const seen = new Set<string>();
  const todo: TileId[] = [];
  for (const c of centers) {
    for (const t of coveringTiles(c, radiusM, Z)) {
      const k = tileKey(t);
      if (seen.has(k) || cache.has(k)) continue;
      seen.add(k);
      todo.push(t);
    }
  }
  // Four at a time: polite to the CDN and leaves bandwidth for the live anchor fetch.
  for (let i = 0; i < todo.length; i += 4) {
    await Promise.allSettled(todo.slice(i, i + 4).map(loadTile));
  }
}

export { coveringTiles } from '../core/tiles';

export const __cacheSize = () => cache.size;
