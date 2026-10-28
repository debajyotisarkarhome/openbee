// Routing via Valhalla on the public FOSSGIS instance: motorcycle costing and route alternatives, both
// of which GraphHopper's free tier refuses ("Free packages cannot use flexible mode").
import { LatLon } from '../core/geo';
import { Route, ValhallaTrip, routeFromValhalla } from '../core/route';

// The demo UI lives on valhalla.openstreetmap.de; the API answers on the numbered host.
const URL = 'https://valhalla1.openstreetmap.de/route';
const TIMEOUT_MS = 20_000;
/** Ask for this many extras. Valhalla is best-effort: long routes often come back with none. */
const ALTERNATES = 2;

export type RoadPreference = 'fast' | 'curvy';

/**
 * 'curvy' pushes Valhalla off motorways and tolls, which is the point of a motorcycle navigator — the
 * curve badges have nothing to show on a dual carriageway. Measured on a 180 km run: 'fast' took the
 * highway at 180 km, 'curvy' produced 211 km with 54 maneuvers instead of 37.
 */
const COSTING_OPTIONS: Record<RoadPreference, Record<string, number>> = {
  fast: {},
  curvy: { use_highways: 0.0, use_tolls: 0.0 },
};

export async function fetchRoutesFromValhalla(
  from: LatLon,
  to: LatLon,
  preference: RoadPreference = 'fast',
  alternates = ALTERNATES,
): Promise<Route[]> {
  const body = {
    locations: [
      { lat: from.lat, lon: from.lon },
      { lat: to.lat, lon: to.lon },
    ],
    costing: 'motorcycle',
    costing_options: { motorcycle: COSTING_OPTIONS[preference] },
    alternates,
    directions_options: { units: 'kilometers' },
  };

  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'OpenBee/1.0 (DIY motorcycle navigator)' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Routing failed (${res.status})`);

  const data = (await res.json()) as { trip?: ValhallaTrip; alternates?: { trip: ValhallaTrip }[]; error?: string };
  if (data.error) throw new Error(data.error);
  if (!data.trip) throw new Error('No route found');

  return [data.trip, ...(data.alternates ?? []).map((a) => a.trip)]
    .filter((t) => t.legs?.length)
    .map(routeFromValhalla);
}
