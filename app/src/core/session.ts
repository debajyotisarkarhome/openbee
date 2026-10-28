// Navigation session: GPS fixes → NavEngine → throttled protocol frames to the device, plus rerouting.
// Platform-free: BLE, routing, battery and clock are injected so it runs under jest.
import { LatLon } from './geo';
import { Fix, NavEngine, NavSnapshot } from './nav-engine';
import {
  NavState, NotifMsg, TripMsg,
  encodeNav, encodeNotif, encodeState, encodeTrip,
} from './proto';
import { RiderPoint, RoadMap } from './roads';
import { Route } from './route';

export interface SessionDeps {
  send(frame: Uint8Array): void;
  fetchRoute(from: LatLon, to: LatLon): Promise<Route>;
  /**
   * Streets within radiusM of center, for one ROADS anchor (optional: without it the map shows only the
   * route). Called just in time as each anchor is issued, so it must be cheap.
   */
  fetchStreets?(center: LatLon, radiusM: number): Promise<LatLon[][]>;
  phoneBatteryPct(): number | null;
  tzOffsetMin(): number;
}

/** Radius of streets requested per anchor. Matches RoadMap's default keep-radius. */
export const STREET_RADIUS_M = 700;

export const NAV_INTERVAL_MS = 500;
export const TRIP_INTERVAL_MS = 1000;

export interface SessionView {
  state: NavState;
  route: Route | null;
  destination: LatLon | null;
  snapshot: NavSnapshot | null;
  lastFix: Fix | null;
  error: string | null;
  /** Surrounding streets in the rider's heading-up frame — the same set the device is drawing. */
  streets: RiderPoint[][];
  /** Why the map streets are missing, if they are. Navigation still works without them. */
  roadsError: string | null;
}

export class NavSession {
  private engine: NavEngine | null = null;
  private dest: LatLon | null = null;
  private state = NavState.IDLE;
  private snapshot: NavSnapshot | null = null;
  private lastFix: Fix | null = null;
  private lastNavAt = -Infinity;
  private lastTripAt = -Infinity;
  private lastManeuverKey = '';
  private rerouting = false;
  private error: string | null = null;
  private roads = new RoadMap();
  private roadsFor: Route | null = null;
  private streets: RiderPoint[][] = [];
  private roadsError: string | null = null;
  private streetFetch: Promise<void> | null = null;
  private listeners = new Set<() => void>();
  private view: SessionView;

  constructor(private deps: SessionDeps) {
    this.view = this.makeView();
  }

  // ---- observable for React (useSyncExternalStore) ----
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getView = () => this.view;

  private emit() {
    this.view = this.makeView();
    this.listeners.forEach((l) => l());
  }

  private makeView(): SessionView {
    return {
      state: this.state,
      route: this.engine?.getRoute() ?? null,
      destination: this.dest,
      snapshot: this.snapshot,
      lastFix: this.lastFix,
      error: this.error,
      streets: this.streets,
      roadsError: this.roadsError,
    };
  }

  // ---- control ----
  start(route: Route, destination: LatLon) {
    this.engine = new NavEngine(route);
    this.dest = destination;
    this.snapshot = null;
    this.error = null;
    this.lastNavAt = this.lastTripAt = -Infinity;
    this.lastManeuverKey = '';
    this.roads.clear();
    this.streets = [];
    this.roadsError = null;
    this.roadsFor = route;
    this.setState(NavState.NAVIGATING);
  }

  /**
   * Fetch streets for the next anchor, once. Kicked off from onFix the moment the rider leaves the
   * current anchor's area; the next fix issues the anchor and sends the frames.
   */
  private maybeFetchStreets(center: LatLon) {
    if (!this.deps.fetchStreets || this.streetFetch || !this.roads.needsAnchor(center)) return;
    const route = this.roadsFor;
    const fetchStreets = this.deps.fetchStreets;
    this.streetFetch = fetchStreets(center, STREET_RADIUS_M)
      .then((streets) => {
        if (this.roadsFor !== route || !this.engine) return;
        this.roads.setRoads(streets);
        this.roadsError = streets.length ? null : 'No map streets near this part of the route';
        this.emit();
      })
      .catch((e: Error) => {
        // Navigation works without streets, but stay loud: a silent failure here looks identical to a
        // stretch of route with no streets near it.
        if (this.roadsFor !== route) return;
        this.roadsError = e.message;
        this.emit();
      })
      .finally(() => {
        this.streetFetch = null;
      });
  }

  stop() {
    this.engine = null;
    this.dest = null;
    this.snapshot = null;
    this.roads.clear();
    this.roadsFor = null;
    this.streets = [];
    this.roadsError = null;
    this.setState(NavState.IDLE);
  }

  get active() {
    return this.engine != null;
  }

  /** Call when the device (re)connects: it gets the full current picture immediately. */
  onDeviceConnected() {
    this.deps.send(encodeState(this.state));
    this.roads.currentFrames().forEach((f) => this.deps.send(f));
    if (this.snapshot) {
      this.deps.send(encodeNav(this.snapshot.nav));
      this.deps.send(encodeTrip(this.tripMsg(this.snapshot, this.lastFix!.timeMs)));
    }
  }

  notify(n: NotifMsg) {
    this.deps.send(encodeNotif(n));
  }

  /** Periodic check (e.g. every second) so GPS loss is reported even when no fixes arrive. */
  tick(nowMs: number) {
    if (!this.engine || this.state === NavState.ARRIVED) return;
    const lost = this.engine.isGpsLost(nowMs);
    if (lost && this.state !== NavState.GPS_LOST) this.setState(NavState.GPS_LOST);
  }

  onFix(fix: Fix) {
    this.lastFix = fix;
    if (!this.engine) {
      this.emit();
      return;
    }
    const s = this.engine.update(fix);
    // Streets first, so the device has the anchor set before a NAV frame refers to it.
    this.roads.update(s.pose.origin)?.forEach((f) => this.deps.send(f));
    Object.assign(s.nav, this.roads.pose(s.pose.origin, s.pose.headingDeg));
    this.streets = this.roads.riderFrame(s.pose.origin, s.pose.headingDeg);
    // Then queue the *next* anchor's streets. After update(), so an anchor issued on this very fix is
    // not immediately treated as stale and re-fetched.
    this.maybeFetchStreets(s.pose.origin);
    this.snapshot = s;

    if (s.needsReroute && this.dest) void this.reroute(fix);
    const state = this.rerouting ? NavState.REROUTING : s.state;
    if (state !== this.state) this.setState(state);

    const key = `${s.nav.maneuver}:${s.nav.street}`;
    const maneuverChanged = key !== this.lastManeuverKey;
    if (maneuverChanged || fix.timeMs - this.lastNavAt >= NAV_INTERVAL_MS) {
      this.lastManeuverKey = key;
      this.lastNavAt = fix.timeMs;
      this.deps.send(encodeNav(s.nav));
    }
    if (fix.timeMs - this.lastTripAt >= TRIP_INTERVAL_MS) {
      this.lastTripAt = fix.timeMs;
      this.deps.send(encodeTrip(this.tripMsg(s, fix.timeMs)));
    }
    this.emit();
  }

  private tripMsg(s: NavSnapshot, nowMs: number): TripMsg {
    return {
      speedKmh: s.speedKmh,
      limitKmh: s.limitKmh ?? 0,
      etaEpoch: s.etaEpoch,
      remainingM: s.remainingM,
      phoneBatt: this.deps.phoneBatteryPct(),
      nowEpoch: Math.round(nowMs / 1000),
      tzOffsetMin: this.deps.tzOffsetMin(),
    };
  }

  private async reroute(from: Fix) {
    if (this.rerouting || !this.dest) return;
    this.rerouting = true;
    this.setState(NavState.REROUTING);
    try {
      const route = await this.deps.fetchRoute(from, this.dest);
      this.engine?.setRoute(route);
      this.roadsFor = route;
      this.error = null;
    } catch (e) {
      this.error = `Reroute failed: ${(e as Error).message}`;
    } finally {
      this.rerouting = false;
      if (this.engine) this.setState(NavState.NAVIGATING);
    }
  }

  private setState(s: NavState) {
    this.state = s;
    this.deps.send(encodeState(s));
    this.emit();
  }
}
