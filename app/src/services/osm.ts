// Overpass fallback for street geometry, used only when vector tiles fail (see src/services/streets.ts).
// One cheap `around` query per anchor: the old 60 km corridor prefetch pulled ~865 KB per request and
// burned the "regular application" quota (10k/day ÷ 100) in a handful of rides.
import { LatLon } from '../core/geo';

/**
 * Tried in order. overpass-api.de is listed last on purpose: it is chronically overloaded and answers
 * 502 within a second when its dispatcher has no free slots.
 */
const ENDPOINTS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass-api.de/api/interpreter',
];

const HIGHWAYS =
  'motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|' +
  'motorway_link|trunk_link|primary_link|secondary_link|tertiary_link';

const TIMEOUT_MS = 12_000;

interface OverpassBody {
  elements: { type: string; geometry?: { lat: number; lon: number }[] }[];
}

/** Streets within radiusM of center. Throws only when every endpoint fails. */
export async function fetchStreetsFromOverpass(center: LatLon, radiusM: number): Promise<LatLon[][]> {
  const query =
    `[out:json][timeout:20];way["highway"~"^(${HIGHWAYS})$"]` +
    `(around:${Math.round(radiusM)},${center.lat.toFixed(5)},${center.lon.toFixed(5)});out geom;`;

  let lastError = 'Map streets unavailable';
  for (const url of ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          // overpass-api.de rejects anonymous clients (HTTP 406); identify the app as their policy asks.
          'User-Agent': 'OpenBee/1.0 (DIY motorcycle navigator)',
        },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        lastError = `Map streets unavailable (${res.status})`;
        continue;
      }
      const body = (await res.json()) as OverpassBody;
      return body.elements
        .filter((e) => e.type === 'way' && e.geometry && e.geometry.length >= 2)
        .map((e) => e.geometry!.map((g) => ({ lat: g.lat, lon: g.lon })));
    } catch (e) {
      lastError = (e as Error).name === 'TimeoutError' ? 'Map streets timed out' : (e as Error).message;
    }
  }
  throw new Error(lastError);
}
