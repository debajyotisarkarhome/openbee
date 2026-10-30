import { destination } from '../geo';
import { MIN_RIDE_M, RideRecorder } from '../history';

const START = { lat: 22.5726, lon: 88.3639 };
const DEST = { name: 'Park', detail: 'Kolkata', point: START };

const fix = (metresNorth: number, timeMs: number, extra: { speedMps?: number; accuracyM?: number } = {}) => ({
  ...destination(START, 0, metresNorth),
  speedMps: extra.speedMps ?? 10,
  accuracyM: extra.accuracyM ?? 5,
  timeMs,
});

describe('RideRecorder', () => {
  it('sums ridden distance and keeps the top speed', () => {
    const r = new RideRecorder(1000, false, DEST, 500);
    for (let i = 0; i <= 30; i++) r.onFix(fix(i * 10, 1000 + i * 1000, { speedMps: i === 12 ? 25 : 10 }));
    const rec = r.finish(40_000, true)!;
    expect(rec.riddenM).toBeGreaterThan(295);
    expect(rec.riddenM).toBeLessThan(305);
    expect(rec.maxSpeedKmh).toBe(90);
    expect(rec).toMatchObject({ id: '1000', simulated: false, arrived: true, routeLengthM: 500, endedMs: 40_000 });
  });

  it('drops inaccurate fixes and GPS jumps', () => {
    const r = new RideRecorder(0, true, DEST, 500);
    r.onFix(fix(0, 0));
    r.onFix(fix(500, 500, { accuracyM: 80 })); // poor accuracy: ignored entirely
    r.onFix(fix(5000, 1000)); // 5 km in a second: a glitch, not riding
    r.onFix(fix(5100, 11_000));
    expect(r.finish(20_000, false)!.riddenM).toBe(100);
  });

  it('does not keep false starts', () => {
    const r = new RideRecorder(0, false, DEST, 500);
    r.onFix(fix(0, 0));
    r.onFix(fix(MIN_RIDE_M - 5, 5000));
    expect(r.finish(6000, false)).toBeNull();
  });
});
