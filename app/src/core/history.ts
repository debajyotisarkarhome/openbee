// Ride history: what one ride looked like, and the accumulator that builds it from the fix stream.
// Platform-free: persistence lives in services/history.ts.
import { LatLon, haversine } from './geo';
import { Fix } from './nav-engine';

export interface RideRecord {
  id: string;
  startedMs: number;
  endedMs: number;
  simulated: boolean;
  destination: { name: string; detail: string; point: LatLon };
  /** Planned route length, metres. */
  routeLengthM: number;
  /** Distance actually covered, metres, summed from fixes. */
  riddenM: number;
  maxSpeedKmh: number;
  arrived: boolean;
}

/** Rides shorter than this were false starts, not rides, and are not kept. */
export const MIN_RIDE_M = 50;
/** Fixes worse than this would add GPS jitter to the ridden distance. */
const MAX_ACCURACY_M = 30;
/** A jump faster than this between fixes is a GPS glitch, not riding (~360 km/h). */
const MAX_PLAUSIBLE_MPS = 100;

export class RideRecorder {
  private last: Fix | null = null;
  private riddenM = 0;
  private maxSpeedMps = 0;

  constructor(
    private readonly startedMs: number,
    private readonly simulated: boolean,
    private readonly destination: RideRecord['destination'],
    private readonly routeLengthM: number,
  ) {}

  onFix(f: Fix) {
    if (f.accuracyM != null && f.accuracyM > MAX_ACCURACY_M) return;
    if (f.speedMps != null) this.maxSpeedMps = Math.max(this.maxSpeedMps, f.speedMps);
    const prev = this.last;
    this.last = f;
    if (!prev) return;
    const d = haversine(prev, f);
    const dt = (f.timeMs - prev.timeMs) / 1000;
    if (dt > 0 && d / dt > MAX_PLAUSIBLE_MPS) return;
    this.riddenM += d;
  }

  /** The finished record, or null when the ride was too short to be worth keeping. */
  finish(endedMs: number, arrived: boolean): RideRecord | null {
    if (this.riddenM < MIN_RIDE_M) return null;
    return {
      id: `${this.startedMs}`,
      startedMs: this.startedMs,
      endedMs,
      simulated: this.simulated,
      destination: this.destination,
      routeLengthM: this.routeLengthM,
      riddenM: Math.round(this.riddenM),
      maxSpeedKmh: Math.round(this.maxSpeedMps * 3.6),
      arrived,
    };
  }
}
