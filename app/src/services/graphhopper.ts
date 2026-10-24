// GraphHopper Routing + Geocoding (free tier). Key from EXPO_PUBLIC_GRAPHHOPPER_KEY (app/.env.local, git-ignored).
import { LatLon } from '../core/geo';
import { GhPath, Route, routeFromGraphHopper } from '../core/route';

const BASE = 'https://graphhopper.com/api/1';
export const GRAPHHOPPER_KEY = process.env.EXPO_PUBLIC_GRAPHHOPPER_KEY ?? '';

export interface Place {
  name: string;
  detail: string;
  point: LatLon;
}

function requireKey() {
  if (!GRAPHHOPPER_KEY) throw new Error('Set EXPO_PUBLIC_GRAPHHOPPER_KEY in app/.env.local');
}

export async function geocode(q: string, near?: LatLon): Promise<Place[]> {
  requireKey();
  const params = new URLSearchParams({ q, limit: '8', locale: 'en', key: GRAPHHOPPER_KEY });
  if (near) params.set('point', `${near.lat},${near.lon}`);
  const res = await fetch(`${BASE}/geocode?${params}`);
  if (!res.ok) throw new Error(`Geocoding failed (${res.status})`);
  const body = (await res.json()) as {
    hits: { point: { lat: number; lng: number }; name: string; street?: string; city?: string; state?: string; country?: string }[];
  };
  return body.hits.map((h) => ({
    name: h.name,
    detail: [h.street, h.city, h.state, h.country].filter(Boolean).join(', '),
    point: { lat: h.point.lat, lon: h.point.lng },
  }));
}

export async function fetchRoute(from: LatLon, to: LatLon): Promise<Route> {
  requireKey();
  const res = await fetch(`${BASE}/route?key=${encodeURIComponent(GRAPHHOPPER_KEY)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      points: [[from.lon, from.lat], [to.lon, to.lat]],
      profile: 'car',
      locale: 'en',
      instructions: true,
      points_encoded: false,
      details: ['max_speed', 'street_name'],
    }),
  });
  if (!res.ok) {
    const msg = await res.json().then((b: { message?: string }) => b.message).catch(() => undefined);
    throw new Error(msg ?? `Routing failed (${res.status})`);
  }
  const body = (await res.json()) as { paths: GhPath[] };
  if (!body.paths?.length) throw new Error('No route found');
  return routeFromGraphHopper(body.paths[0]);
}
