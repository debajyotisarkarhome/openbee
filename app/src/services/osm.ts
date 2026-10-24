// Streets along the route corridor from OpenStreetMap (Overpass API), for the device's map view.
// See https://wiki.openstreetmap.org/wiki/Overpass_API — the public instance is free but rate limited (2 slots/IP).
import { LatLon } from '../core/geo';
import { Route, pointAt } from '../core/route';

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const CORRIDOR_M = 500;
/** Sample spacing along the route; < CORRIDOR_M so neighbouring circles overlap and cover the corridor. */
const SAMPLE_M = 400;
const SAMPLES_PER_QUERY = 25; // ≈ 10 km of route per request
/** Max route length we fetch streets for up front (keeps the first request fast on long trips). */
const MAX_ROUTE_M = 60_000;
const HIGHWAYS =
  'motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|' +
  'motorway_link|trunk_link|primary_link|secondary_link|tertiary_link';

/** Route sampled every SAMPLE_M, grouped per request. */
function sampleChunks(route: Route): LatLon[][] {
  const pts: LatLon[] = [];
  const end = Math.min(route.lengthM, MAX_ROUTE_M);
  for (let d = 0; d < end; d += SAMPLE_M) pts.push(pointAt(route, d));
  pts.push(pointAt(route, end));
  const chunks: LatLon[][] = [];
  for (let i = 0; i < pts.length; i += SAMPLES_PER_QUERY) chunks.push(pts.slice(i, i + SAMPLES_PER_QUERY));
  return chunks;
}

interface Way {
  id: number;
  geometry: LatLon[];
}

async function fetchChunk(samples: LatLon[]): Promise<Way[]> {
  // A union of point "around" filters: the polyline form of around returns nothing on overpass-api.de.
  const filter = `way["highway"~"^(${HIGHWAYS})$"]`;
  const union = samples.map((p) => `${filter}(around:${CORRIDOR_M},${p.lat.toFixed(5)},${p.lon.toFixed(5)});`).join('');
  const query = `[out:json][timeout:25];(${union});out geom;`;
  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      // overpass-api.de rejects anonymous clients (HTTP 406); identify the app as their usage policy asks.
      'User-Agent': 'OpenBee/1.0 (DIY motorcycle navigator)',
    },
    body: `data=${encodeURIComponent(query)}`,
  });
  if (!res.ok) throw new Error(`Map streets unavailable (${res.status})`);
  const body = (await res.json()) as { elements: { type: string; id: number; geometry?: { lat: number; lon: number }[] }[] };
  return body.elements
    .filter((e) => e.type === 'way' && e.geometry && e.geometry.length >= 2)
    .map((e) => ({ id: e.id, geometry: e.geometry!.map((g) => ({ lat: g.lat, lon: g.lon })) }));
}

/** All streets within CORRIDOR_M of the route (first MAX_ROUTE_M). Two requests at a time, per Overpass etiquette. */
export async function fetchRoads(route: Route): Promise<LatLon[][]> {
  const chunks = sampleChunks(route);
  const ways = new Map<number, LatLon[]>();
  for (let i = 0; i < chunks.length; i += 2) {
    const parts = await Promise.all(chunks.slice(i, i + 2).map(fetchChunk));
    for (const w of parts.flat()) ways.set(w.id, w.geometry);
  }
  return [...ways.values()];
}
