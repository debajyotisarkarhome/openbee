// Ride simulator + synthetic road builder. Used by tests and the app's "simulate ride" mode.
import { LatLon, destination } from './geo';
import type { Fix } from './nav-engine';
import { Route, bearingAt, pointAt } from './route';

/** Builds a polyline from turtle-style commands (headings in degrees clockwise from north). */
export class PathBuilder {
  readonly points: LatLon[];
  private heading: number;

  constructor(start: LatLon, headingDeg: number) {
    this.points = [start];
    this.heading = headingDeg;
  }

  private get last() {
    return this.points[this.points.length - 1];
  }

  get index() {
    return this.points.length - 1;
  }

  straight(lengthM: number, stepM = 10): this {
    for (let d = stepM; d <= lengthM + 1e-6; d += stepM) this.points.push(destination(this.last, this.heading, stepM));
    return this;
  }

  /** Circular arc; positive angle = right turn. */
  arc(radiusM: number, angleDeg: number, stepM = 5): this {
    const len = (Math.abs(angleDeg) * Math.PI * radiusM) / 180;
    const n = Math.max(1, Math.ceil(len / stepM));
    const dθ = angleDeg / n;
    const chord = 2 * radiusM * Math.sin((Math.abs(dθ) * Math.PI) / 360);
    for (let i = 0; i < n; i++) {
      this.heading += dθ / 2;
      this.points.push(destination(this.last, this.heading, chord));
      this.heading += dθ / 2;
    }
    return this;
  }

  /** Instant heading change (an intersection turn). */
  turn(angleDeg: number): this {
    this.heading = (this.heading + angleDeg + 360) % 360;
    return this;
  }
}

export interface SimOptions {
  speedMps: number;
  intervalMs: number;
  startMs: number;
  /** Lateral offset (m, + = right) applied between route distances [fromM, toM): simulates a wrong turn. */
  detour?: { fromM: number; toM: number; offsetM: number };
}

/** Generates GPS fixes moving along the route at constant speed. */
export function* simulateRide(route: Route, o: SimOptions): Generator<Fix> {
  for (let t = 0; ; t += o.intervalMs) {
    const d = Math.min(route.lengthM, (o.speedMps * t) / 1000);
    let p = pointAt(route, d);
    if (o.detour && d >= o.detour.fromM && d < o.detour.toM) {
      p = destination(p, bearingAt(route, d) + 90, o.detour.offsetM);
    }
    yield { lat: p.lat, lon: p.lon, speedMps: o.speedMps, accuracyM: 5, timeMs: o.startMs + t };
    if (d >= route.lengthM) return;
  }
}
