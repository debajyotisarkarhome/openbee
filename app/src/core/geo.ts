// Small-area geometry helpers. Lat/lon in degrees, distances in meters, bearings in degrees clockwise from north.

export interface LatLon {
  lat: number;
  lon: number;
}

const R_EARTH = 6371008.8;
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

export function haversine(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function bearing(a: LatLon, b: LatLon): number {
  const φ1 = toRad(a.lat), φ2 = toRad(b.lat), dλ = toRad(b.lon - a.lon);
  const y = Math.sin(dλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Signed smallest difference b - a in degrees, in (-180, 180]. Positive = clockwise (right turn). */
export function angleDiff(a: number, b: number): number {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** Move from p by dist meters along bearing brg. */
export function destination(p: LatLon, brg: number, dist: number): LatLon {
  const δ = dist / R_EARTH, θ = toRad(brg), φ1 = toRad(p.lat), λ1 = toRad(p.lon);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: toDeg(φ2), lon: toDeg(λ2) };
}

/** Local equirectangular projection around an origin: x east, y north, meters. Fine within a few km. */
export function toLocal(origin: LatLon, p: LatLon): { x: number; y: number } {
  const x = toRad(p.lon - origin.lon) * R_EARTH * Math.cos(toRad(origin.lat));
  const y = toRad(p.lat - origin.lat) * R_EARTH;
  return { x, y };
}

export function interpolate(a: LatLon, b: LatLon, t: number): LatLon {
  return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
}

/** Projection of p onto segment a-b: fraction t∈[0,1] and perpendicular distance in meters. */
export function projectOnSegment(p: LatLon, a: LatLon, b: LatLon): { t: number; dist: number } {
  const B = toLocal(a, b);
  const P = toLocal(a, p);
  const len2 = B.x * B.x + B.y * B.y;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (P.x * B.x + P.y * B.y) / len2));
  const dx = P.x - t * B.x, dy = P.y - t * B.y;
  return { t, dist: Math.hypot(dx, dy) };
}
