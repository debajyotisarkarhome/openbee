// Surrounding streets for the device's map view. Streets are sent once per "anchor" (a fixed local frame around
// the rider) and re-sent only after the rider has moved REANCHOR_M; every NAV frame carries the rider's pose in that
// frame so the device can rotate the streets itself. Pure TS.
import { LatLon, haversine, toLocal } from './geo';
import { RoadPoint, encodeRoads } from './proto';

export interface RoadMapOptions {
  /** Issue a new anchor once the rider is this far from the current one. */
  reanchorM: number;
  /** Streets are kept within this radius of the anchor. */
  radiusM: number;
  /** Douglas–Peucker tolerance. */
  simplifyM: number;
  /** Cap on points per anchor set (bounds BLE traffic and device memory). */
  maxPoints: number;
}

export const DEFAULT_ROADMAP_OPTIONS: RoadMapOptions = { reanchorM: 300, radiusM: 700, simplifyM: 3, maxPoints: 600 };

export interface Pose {
  anchorId: number;
  poseX: number;
  poseY: number;
  headingCdeg: number;
}

export class RoadMap {
  private roads: LatLon[][] = [];
  private anchor: LatLon | null = null;
  private anchorId = 0;
  private frames: Uint8Array[] = [];

  constructor(private opts: RoadMapOptions = DEFAULT_ROADMAP_OPTIONS) {}

  /** Replace the street set (e.g. after fetching the route corridor). Forces a new anchor on the next update. */
  setRoads(roads: LatLon[][]) {
    this.roads = roads.filter((r) => r.length >= 2);
    this.anchor = null;
  }

  clear() {
    this.roads = [];
    this.anchor = null;
    this.frames = [];
  }

  get hasRoads() {
    return this.roads.length > 0;
  }

  /** Frames describing the current anchor set (resend on reconnect). */
  currentFrames(): Uint8Array[] {
    return this.frames;
  }

  /**
   * Call with the rider's position on every fix. Returns ROADS frames to send when a new anchor is issued,
   * otherwise null.
   */
  update(rider: LatLon): Uint8Array[] | null {
    if (!this.roads.length) return null;
    if (this.anchor && haversine(this.anchor, rider) < this.opts.reanchorM) return null;
    this.anchor = rider;
    this.anchorId = (this.anchorId % 255) + 1; // 1..255, 0 means "no roads"
    this.frames = encodeRoads(this.anchorId, this.select(rider));
    return this.frames;
  }

  /** Rider pose in the current anchor frame, for the NAV message. */
  pose(rider: LatLon, headingDeg: number): Pose {
    const headingCdeg = ((Math.round(headingDeg * 100) % 36000) + 36000) % 36000;
    if (!this.anchor) return { anchorId: 0, poseX: 0, poseY: 0, headingCdeg };
    const p = toLocal(this.anchor, rider);
    return { anchorId: this.anchorId, poseX: Math.round(p.x * 10), poseY: Math.round(p.y * 10), headingCdeg };
  }

  /** Streets near the anchor, clipped to the radius, simplified, nearest first, within the point budget. */
  private select(anchor: LatLon): RoadPoint[][] {
    const R = this.opts.radiusM;
    const runs: { pts: RoadPoint[]; near: number }[] = [];
    for (const road of this.roads) {
      const local = road.map((p) => toLocal(anchor, p));
      let run: { x: number; y: number }[] = [];
      const flush = () => {
        if (run.length >= 2) {
          const pts = simplify(run, this.opts.simplifyM).map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
          runs.push({ pts, near: Math.min(...run.map((p) => Math.hypot(p.x, p.y))) });
        }
        run = [];
      };
      for (let i = 0; i < local.length; i++) {
        const inside = Math.hypot(local[i].x, local[i].y) <= R;
        const prevInside = i > 0 && Math.hypot(local[i - 1].x, local[i - 1].y) <= R;
        const nextInside = i + 1 < local.length && Math.hypot(local[i + 1].x, local[i + 1].y) <= R;
        // Keep one point beyond the radius on each side so lines run off the edge instead of stopping short.
        if (inside || prevInside || nextInside) run.push(local[i]);
        else flush();
      }
      flush();
    }
    runs.sort((a, b) => a.near - b.near);
    const out: RoadPoint[][] = [];
    let budget = this.opts.maxPoints;
    for (const r of runs) {
      if (r.pts.length > budget) continue;
      out.push(r.pts);
      budget -= r.pts.length;
    }
    return out;
  }
}

/** Douglas–Peucker polyline simplification in a planar frame. */
export function simplify<T extends { x: number; y: number }>(pts: T[], tol: number): T[] {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const A = pts[a], B = pts[b];
    const dx = B.x - A.x, dy = B.y - A.y;
    const len = Math.hypot(dx, dy) || 1;
    let worst = -1, worstD = tol;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * (pts[i].x - A.x) - dx * (pts[i].y - A.y)) / len;
      if (d > worstD) {
        worst = i;
        worstD = d;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}
