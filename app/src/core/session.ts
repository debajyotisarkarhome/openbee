// Navigation session: GPS fixes → NavEngine → throttled protocol frames to the device, plus rerouting.
// Platform-free: BLE, routing, battery and clock are injected so it runs under jest.
import { LatLon } from './geo';
import { Fix, NavEngine, NavSnapshot } from './nav-engine';
import {
  NavState, NotifMsg, TripMsg,
  encodeNav, encodeNotif, encodeState, encodeTrip,
} from './proto';
import { RoadMap } from './roads';
import { Route } from './route';

export interface SessionDeps {
  send(frame: Uint8Array): void;
  fetchRoute(from: LatLon, to: LatLon): Promise<Route>;
  /** Streets along the route corridor for the device's map view (optional: without it the map shows only the route). */
  fetchRoads?(route: Route): Promise<LatLon[][]>;
  phoneBatteryPct(): number | null;
  tzOffsetMin(): number;
}

export const NAV_INTERVAL_MS = 500;
export const TRIP_INTERVAL_MS = 1000;

export interface SessionView {
  state: NavState;
  route: Route | null;
  destination: LatLon | null;
  snapshot: NavSnapshot | null;
  lastFix: Fix | null;
  error: string | null;
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
    void this.loadRoads(route);
    this.setState(NavState.NAVIGATING);
  }

  private async loadRoads(route: Route) {
    if (!this.deps.fetchRoads) return;
    this.roadsFor = route;
    try {
      const roads = await this.deps.fetchRoads(route);
      if (this.roadsFor === route && this.engine) this.roads.setRoads(roads);
    } catch {
      // Map streets are a nice-to-have; navigation works without them.
    }
  }

  stop() {
    this.engine = null;
    this.dest = null;
    this.snapshot = null;
    this.roads.clear();
    this.roadsFor = null;
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
      void this.loadRoads(route);
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
