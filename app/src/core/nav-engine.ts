// Turns GPS fixes + a Route into what the device shows. Pure TS, deterministic (time comes from fixes).
import { LatLon, haversine, projectOnSegment } from './geo';
import { CurveClass, Maneuver, NavMsg, NavState } from './proto';
import { Route, speedLimitAt } from './route';
import { extractShape } from './shape';

export interface Fix {
  lat: number;
  lon: number;
  /** m/s, null if the platform doesn't report it. */
  speedMps: number | null;
  accuracyM: number | null;
  timeMs: number;
}

export interface NavSnapshot {
  state: NavState;
  progressM: number;
  /** Perpendicular distance from the route at the last fix. */
  offsetM: number;
  nav: NavMsg;
  /** Frame of nav.points: rider origin + heading that is "up" (the device aligns map roads with it). */
  pose: { origin: LatLon; headingDeg: number };
  speedKmh: number;
  limitKmh: number | null;
  remainingM: number;
  etaEpoch: number;
  /** True exactly once per off-route episode: the caller should request a new route. */
  needsReroute: boolean;
}

export interface NavOptions {
  offRouteM: number;
  offRouteMs: number;
  arriveM: number;
  gpsLostMs: number;
}

export const DEFAULT_NAV_OPTIONS: NavOptions = { offRouteM: 40, offRouteMs: 5000, arriveM: 30, gpsLostMs: 10000 };

/** Allowed backwards slip along the route (GPS jitter at low speed). */
const BACKTRACK_M = 30;

export class NavEngine {
  private seg = 0;
  private progress = 0;
  private offSince: number | null = null;
  private rerouteRequested = false;
  private arrived = false;
  private lastFix: Fix | null = null;

  constructor(private route: Route, private opts: NavOptions = DEFAULT_NAV_OPTIONS) {}

  setRoute(route: Route) {
    this.route = route;
    this.seg = 0;
    this.progress = 0;
    this.offSince = null;
    this.rerouteRequested = false;
    this.arrived = false;
  }

  getRoute() {
    return this.route;
  }

  /** True if no fix has arrived for gpsLostMs. */
  isGpsLost(nowMs: number): boolean {
    return this.lastFix == null || nowMs - this.lastFix.timeMs > this.opts.gpsLostMs;
  }

  update(fix: Fix): NavSnapshot {
    const prevFix = this.lastFix;
    this.lastFix = fix;
    const snap = this.snap(fix);
    const tol = Math.max(this.opts.offRouteM, (fix.accuracyM ?? 0) * 1.5);

    let needsReroute = false;
    if (snap.dist > tol) {
      this.offSince ??= fix.timeMs;
      if (fix.timeMs - this.offSince >= this.opts.offRouteMs && !this.rerouteRequested) {
        this.rerouteRequested = true;
        needsReroute = true;
      }
    } else {
      this.offSince = null;
      this.rerouteRequested = false;
      this.seg = snap.seg;
      this.progress = snap.progress;
    }

    const r = this.route;
    const remainingM = Math.max(0, r.lengthM - this.progress);
    if (remainingM <= this.opts.arriveM) this.arrived = true;

    const state = this.arrived
      ? NavState.ARRIVED
      : this.rerouteRequested
        ? NavState.REROUTING
        : NavState.NAVIGATING;

    const { nav, pose } = this.navMsg();
    return {
      state,
      progressM: this.progress,
      offsetM: snap.dist,
      nav,
      pose,
      speedKmh: Math.round(this.speedMps(fix, prevFix) * 3.6),
      limitKmh: speedLimitAt(r, this.progress),
      remainingM: Math.round(remainingM),
      etaEpoch: Math.round((fix.timeMs + this.remainingTimeMs()) / 1000),
      needsReroute,
    };
  }

  private speedMps(fix: Fix, prev: Fix | null): number {
    if (fix.speedMps != null && fix.speedMps >= 0) return fix.speedMps;
    if (!prev || fix.timeMs <= prev.timeMs) return 0;
    return haversine(prev, fix) / ((fix.timeMs - prev.timeMs) / 1000);
  }

  /** Closest point on the route, searching near the last known segment first. */
  private snap(p: Fix): { seg: number; progress: number; dist: number } {
    const r = this.route;
    const last = r.points.length - 2;
    const search = (from: number, to: number) => {
      let best = { seg: this.seg, progress: this.progress, dist: Infinity };
      for (let i = Math.max(0, from); i <= Math.min(last, to); i++) {
        const { t, dist } = projectOnSegment(p, r.points[i], r.points[i + 1]);
        const progress = r.cum[i] + t * (r.cum[i + 1] - r.cum[i]);
        if (progress < this.progress - BACKTRACK_M) continue;
        if (dist < best.dist) best = { seg: i, progress, dist };
      }
      return best;
    };
    let best = search(this.seg - 2, this.seg + 80);
    if (best.dist > this.opts.offRouteM) {
      const global = search(0, last);
      if (global.dist < best.dist) best = global;
    }
    return best;
  }

  private nextInstructionIndex(): number {
    const ins = this.route.instructions;
    for (let i = 0; i < ins.length; i++) if (ins[i].atM > this.progress + 1) return i;
    return -1;
  }

  private navMsg(): { nav: NavMsg; pose: NavSnapshot['pose'] } {
    const r = this.route;
    const idx = this.arrived ? -1 : this.nextInstructionIndex();
    const ins = idx >= 0 ? r.instructions[idx] : null;
    const shape = extractShape(r, this.progress, ins?.atM ?? null);
    const nav: NavMsg = {
      maneuver: this.arrived ? Maneuver.ARRIVE : (ins?.maneuver ?? Maneuver.STRAIGHT),
      exit: ins?.exit ?? 0,
      distM: ins ? Math.round(ins.atM - this.progress) : this.arrived ? 0 : null,
      curveDir: shape.curve.dir,
      curveClass: shape.curve.cls as CurveClass,
      curveDistM: shape.curve.distM,
      maneuverIdx: shape.maneuverIdx,
      // Filled in by the session from its RoadMap (0 = no map roads).
      anchorId: 0,
      poseX: 0,
      poseY: 0,
      headingCdeg: Math.round(shape.headingDeg * 100) % 36000,
      points: shape.points,
      street: ins?.street ?? '',
    };
    return { nav, pose: { origin: shape.origin, headingDeg: shape.headingDeg } };
  }

  /** Remaining time from per-instruction durations, prorated within the current instruction. */
  private remainingTimeMs(): number {
    const ins = this.route.instructions;
    if (ins.length === 0) {
      return this.route.lengthM > 0 ? this.route.timeMs * (1 - this.progress / this.route.lengthM) : 0;
    }
    let ms = 0;
    for (let i = 0; i < ins.length; i++) {
      const start = ins[i].atM;
      const end = start + ins[i].distanceM;
      if (end <= this.progress || ins[i].distanceM <= 0) continue;
      const frac = Math.min(1, (end - Math.max(start, this.progress)) / ins[i].distanceM);
      ms += ins[i].timeMs * frac;
    }
    return ms;
  }
}
