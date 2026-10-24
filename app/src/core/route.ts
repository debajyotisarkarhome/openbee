// Route model + GraphHopper response parsing. Pure TS.
import { LatLon, bearing, haversine, interpolate } from './geo';
import { Maneuver } from './proto';

export interface Instruction {
  /** Distance along the route (m) where this instruction's maneuver happens. */
  atM: number;
  maneuver: Maneuver;
  exit: number;
  street: string;
  text: string;
  /** Duration (ms) of travel covered by this instruction (until the next one). */
  timeMs: number;
  /** Length (m) of travel covered by this instruction. */
  distanceM: number;
}

export interface Route {
  points: LatLon[];
  /** cum[i] = distance along route to points[i]. */
  cum: number[];
  lengthM: number;
  timeMs: number;
  instructions: Instruction[];
  /** Speed limit spans in route meters. */
  maxSpeed: { fromM: number; toM: number; kmh: number | null }[];
}

/** GraphHopper "sign" → protocol maneuver. https://docs.graphhopper.com/#operation/postRoute */
export function maneuverFromGhSign(sign: number): Maneuver {
  switch (sign) {
    case -98: return Maneuver.UTURN_LEFT;
    case -8: return Maneuver.UTURN_LEFT;
    case -7: return Maneuver.KEEP_LEFT;
    case -6: return Maneuver.ROUNDABOUT; // leave roundabout
    case -3: return Maneuver.SHARP_LEFT;
    case -2: return Maneuver.LEFT;
    case -1: return Maneuver.SLIGHT_LEFT;
    case 0: return Maneuver.STRAIGHT;
    case 1: return Maneuver.SLIGHT_RIGHT;
    case 2: return Maneuver.RIGHT;
    case 3: return Maneuver.SHARP_RIGHT;
    case 4: return Maneuver.ARRIVE;
    case 5: return Maneuver.STRAIGHT; // via point reached
    case 6: return Maneuver.ROUNDABOUT;
    case 7: return Maneuver.KEEP_RIGHT;
    case 8: return Maneuver.UTURN_RIGHT;
    default: return Maneuver.STRAIGHT;
  }
}

export function cumulative(points: LatLon[]): number[] {
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + haversine(points[i - 1], points[i]));
  return cum;
}

interface GhInstruction {
  distance: number;
  time: number;
  sign: number;
  interval: [number, number];
  text: string;
  street_name?: string;
  exit_number?: number;
}

export interface GhPath {
  distance: number;
  time: number;
  points: { coordinates: [number, number][] };
  instructions: GhInstruction[];
  details?: { max_speed?: [number, number, number | null][] };
}

/** Parse one path of a GraphHopper /route response requested with points_encoded=false. */
export function routeFromGraphHopper(path: GhPath): Route {
  const points = path.points.coordinates.map(([lon, lat]) => ({ lat, lon }));
  const cum = cumulative(points);
  const instructions: Instruction[] = path.instructions.map((ins, i) => ({
    atM: cum[ins.interval[0]],
    // The first instruction is "continue onto X" from the start; report it as DEPART.
    maneuver: i === 0 ? Maneuver.DEPART : maneuverFromGhSign(ins.sign),
    exit: ins.exit_number ?? 0,
    street: ins.street_name ?? '',
    text: ins.text,
    timeMs: ins.time,
    distanceM: ins.distance,
  }));
  const maxSpeed = (path.details?.max_speed ?? []).map(([a, b, v]) => ({ fromM: cum[a], toM: cum[b], kmh: v }));
  return { points, cum, lengthM: cum[cum.length - 1], timeMs: path.time, instructions, maxSpeed };
}

export type InstructionSpec = Omit<Instruction, 'atM'> & { atIndex: number };

/** Build a route from raw points + instructions (tests, simulator). */
export function makeRoute(points: LatLon[], instructions: InstructionSpec[] = [], speedMps = 15): Route {
  const cum = cumulative(points);
  const lengthM = cum[cum.length - 1];
  const ins: Instruction[] = instructions.map(({ atIndex, ...x }) => ({ ...x, atM: cum[atIndex] }));
  return { points, cum, lengthM, timeMs: (lengthM / speedMps) * 1000, instructions: ins, maxSpeed: [] };
}

/** Index i such that cum[i] <= d < cum[i+1] (clamped). */
export function segmentAt(route: Route, d: number): number {
  const { cum } = route;
  let lo = 0, hi = cum.length - 2;
  if (d <= 0) return 0;
  if (d >= cum[cum.length - 1]) return Math.max(0, cum.length - 2);
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cum[mid] <= d) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function pointAt(route: Route, d: number): LatLon {
  const i = segmentAt(route, d);
  const seg = route.cum[i + 1] - route.cum[i];
  const t = seg > 0 ? Math.max(0, Math.min(1, (d - route.cum[i]) / seg)) : 0;
  return interpolate(route.points[i], route.points[i + 1] ?? route.points[i], t);
}

/** Bearing of the route at distance d, averaged over a short window to ignore tiny GPS-noise segments. */
export function bearingAt(route: Route, d: number, window = 10): number {
  const a = pointAt(route, Math.max(0, d - window / 2));
  const b = pointAt(route, Math.min(route.lengthM, d + window / 2));
  return bearing(a, b);
}

export function speedLimitAt(route: Route, d: number): number | null {
  for (const s of route.maxSpeed) if (d >= s.fromM && d < s.toM) return s.kmh;
  return null;
}
