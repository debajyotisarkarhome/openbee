// Route lookup. Both road preferences are queried together and merged into one list, so the plan
// screen's picker *is* the choice between a quick motorway run and a curvier back-road one — there is
// no preference setting to get out of sync with what you actually picked.
//
// GraphHopper stays as a single-route fallback: keeping a second provider is deliberate, since the
// Overpass outage showed what one public endpoint is worth.
import { LatLon } from '../core/geo';
import { Route } from '../core/route';

import { fetchRoute as fetchRouteFromGraphHopper } from './graphhopper';
import { fetchRoutesFromValhalla } from './valhalla';

/** Keeps the picker readable; Valhalla rarely returns this many distinct routes anyway. */
const MAX_OPTIONS = 4;

/** Same length, duration and shape size means Valhalla handed back the same road under both costings. */
const identity = (r: Route) => `${r.lengthM}:${r.timeMs}:${r.points.length}`;

/** Every distinct route option for a trip, quickest first. Never empty: it throws instead. */
export async function fetchRoutes(from: LatLon, to: LatLon): Promise<Route[]> {
  const settled = await Promise.allSettled([
    fetchRoutesFromValhalla(from, to, 'fast'),
    fetchRoutesFromValhalla(from, to, 'curvy'),
  ]);
  const found = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));

  if (found.length) {
    const seen = new Set<string>();
    const unique: Route[] = [];
    for (const r of found) {
      const k = identity(r);
      if (seen.has(k)) continue;
      seen.add(k);
      unique.push(r);
    }
    return unique.sort((a, b) => a.timeMs - b.timeMs).slice(0, MAX_OPTIONS);
  }

  try {
    // Car-only and single-route, but a worse route beats no route.
    return [await fetchRouteFromGraphHopper(from, to)];
  } catch {
    const why = settled.find((r) => r.status === 'rejected');
    throw why && why.status === 'rejected' ? (why.reason as Error) : new Error('No route found');
  }
}

/**
 * Single route for mid-ride rerouting, where there is nothing to choose between. Asks for no
 * alternatives and prefers the quick way: a reroute should get you back on track, not hand you a
 * 20 km/h back road because of a preference you set hours ago.
 */
export async function fetchRoute(from: LatLon, to: LatLon): Promise<Route> {
  try {
    const routes = await fetchRoutesFromValhalla(from, to, 'fast', 0);
    if (routes.length) return routes[0];
    throw new Error('No route found');
  } catch (e) {
    try {
      return await fetchRouteFromGraphHopper(from, to);
    } catch {
      throw e;
    }
  }
}
