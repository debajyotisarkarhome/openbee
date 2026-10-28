// Where the device's map streets come from: vector tiles first, Overpass as a fallback.
import { LatLon } from '../core/geo';
import { Route, pointAt } from '../core/route';

import { fetchStreetsFromOverpass } from './osm';
import { fetchStreetsFromTiles, prefetchTiles } from './tiles';

/** Streets within radiusM of center, for one ROADS anchor. */
export async function fetchStreets(center: LatLon, radiusM: number): Promise<LatLon[][]> {
  try {
    return await fetchStreetsFromTiles(center, radiusM);
  } catch (tileError) {
    try {
      return await fetchStreetsFromOverpass(center, radiusM);
    } catch {
      // Report the tile failure: it is the primary source, so its reason is the useful one.
      throw tileError;
    }
  }
}

/** How far ahead of the rider to warm the tile cache, so a signal gap does not blank the map. */
export const PREFETCH_AHEAD_M = 15_000;
const PREFETCH_STEP_M = 1_000;

/**
 * Warm the tile cache along the route, starting at fromM. Fire-and-forget: failures are ignored because
 * the live per-anchor fetch will retry the same tiles anyway.
 */
export function prefetchAlongRoute(route: Route, fromM = 0, radiusM = 700): Promise<void> {
  const end = Math.min(route.lengthM, fromM + PREFETCH_AHEAD_M);
  const centers: LatLon[] = [];
  for (let d = fromM; d <= end; d += PREFETCH_STEP_M) centers.push(pointAt(route, d));
  return prefetchTiles(centers, radiusM).catch(() => {});
}
