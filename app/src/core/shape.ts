// Road-shape extraction: the route ahead in the rider's heading-up frame, with per-segment curvature classes,
// plus a "next notable curve" warning. Pure TS.
import { LatLon, angleDiff, toLocal } from './geo';
import { CurveClass, Maneuver, MAX_POINTS, ShapePoint } from './proto';
import { Route, bearingAt, pointAt } from './route';

export const FINE_STEP_M = 5;
export const CURVE_WINDOW_M = 30;
export const MIN_SPAN_M = 200;
export const MAX_SPAN_M = 600;
export const PAST_MANEUVER_M = 150;
export const CURVE_LOOKAHEAD_M = 600;
/** Curves within this distance of a turn instruction are the turn itself, not a road bend. */
export const TURN_EXCLUSION_M = 25;

export function classifyRadius(radiusM: number): CurveClass {
  if (radiusM >= 400) return CurveClass.STRAIGHT;
  if (radiusM >= 150) return CurveClass.GENTLE;
  if (radiusM >= 60) return CurveClass.MEDIUM;
  return CurveClass.SHARP;
}

/** Signed heading change (deg, + = right) across a window centred on d. */
function headingChange(route: Route, d: number, window = CURVE_WINDOW_M): number {
  const a = Math.max(0, d - window / 2);
  const b = Math.min(route.lengthM, d + window / 2);
  if (b - a < window / 2) return 0;
  return angleDiff(bearingAt(route, a, 10), bearingAt(route, b, 10));
}

export function curveClassAt(route: Route, d: number): { cls: CurveClass; dir: -1 | 0 | 1 } {
  const dθ = headingChange(route, d);
  const rad = Math.abs((dθ * Math.PI) / 180);
  if (rad < 1e-6) return { cls: CurveClass.STRAIGHT, dir: 0 };
  return { cls: classifyRadius(CURVE_WINDOW_M / rad), dir: dθ > 0 ? 1 : -1 };
}

const isTurn = (m: Maneuver) => m !== Maneuver.STRAIGHT && m !== Maneuver.DEPART && m !== Maneuver.NONE;

export interface CurveWarning {
  dir: -1 | 0 | 1;
  cls: CurveClass;
  distM: number;
}

export interface Shape {
  points: ShapePoint[];
  maneuverIdx: number | null;
  curve: CurveWarning;
  /** The frame the points are in: rider origin and the heading that maps to "up". */
  origin: LatLon;
  headingDeg: number;
}

/**
 * @param progressM rider's snapped distance along the route
 * @param maneuverAtM route distance of the next maneuver, or null
 */
export function extractShape(route: Route, progressM: number, maneuverAtM: number | null): Shape {
  const toManeuver = maneuverAtM == null ? Infinity : maneuverAtM - progressM;
  const span = Math.min(
    route.lengthM - progressM,
    Math.max(MIN_SPAN_M, Math.min(MAX_SPAN_M, toManeuver + PAST_MANEUVER_M)),
  );

  // Fine curvature samples over the larger of the drawn span and the curve look-ahead.
  const fineEnd = Math.min(route.lengthM, progressM + Math.max(span, CURVE_LOOKAHEAD_M));
  const fine: { d: number; cls: CurveClass; dir: -1 | 0 | 1 }[] = [];
  for (let d = progressM; d <= fineEnd + 1e-6; d += FINE_STEP_M) fine.push({ d, ...curveClassAt(route, d) });

  // Output distances: uniform, ≤ MAX_POINTS, with the maneuver snapped onto the nearest one.
  const n = Math.max(2, Math.min(MAX_POINTS, Math.floor(span / 10) + 1));
  const ds = Array.from({ length: n }, (_, i) => progressM + (span * i) / (n - 1));
  let maneuverIdx: number | null = null;
  if (maneuverAtM != null && toManeuver >= 0 && toManeuver <= span) {
    maneuverIdx = Math.round((toManeuver / span) * (n - 1));
    ds[maneuverIdx] = maneuverAtM;
  }

  const origin = pointAt(route, progressM);
  const headingDeg = bearingAt(route, progressM, 20);
  const h = (headingDeg * Math.PI) / 180;
  const cosH = Math.cos(h), sinH = Math.sin(h);
  const points: ShapePoint[] = ds.map((d, i) => {
    const { x: e, y: nn } = toLocal(origin, pointAt(route, d));
    const x = e * cosH - nn * sinH;
    const y = e * sinH + nn * cosH;
    const prev = i === 0 ? d - FINE_STEP_M : ds[i - 1];
    let cls = CurveClass.STRAIGHT;
    for (const f of fine) if (f.d > prev && f.d <= d && f.cls > cls) cls = f.cls;
    return { x: Math.round(x * 10), y: Math.round(y * 10), cls };
  });

  return { points, maneuverIdx, curve: nextCurve(route, progressM, fine), origin, headingDeg };
}

function nextCurve(route: Route, progressM: number, fine: { d: number; cls: CurveClass; dir: -1 | 0 | 1 }[]): CurveWarning {
  const turnsAt = route.instructions.filter((i) => isTurn(i.maneuver)).map((i) => i.atM);
  const nearTurn = (d: number) => turnsAt.some((t) => Math.abs(t - d) <= TURN_EXCLUSION_M);
  for (let k = 0; k < fine.length; k++) {
    if (fine[k].cls < CurveClass.MEDIUM || nearTurn(fine[k].d)) continue;
    let cls = fine[k].cls;
    let sum = 0;
    for (let j = k; j < fine.length && fine[j].cls >= CurveClass.GENTLE && !nearTurn(fine[j].d); j++) {
      if (fine[j].cls > cls) cls = fine[j].cls;
      sum += fine[j].dir;
    }
    return { dir: sum > 0 ? 1 : sum < 0 ? -1 : fine[k].dir, cls, distM: Math.round(fine[k].d - progressM) };
  }
  return { dir: 0, cls: CurveClass.STRAIGHT, distM: 0 };
}
