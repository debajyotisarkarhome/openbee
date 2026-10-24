import { CurveClass, Maneuver, MAX_PAYLOAD, NavState, decode, encodeNav } from '../proto';
import { GhPath, makeRoute, routeFromGraphHopper } from '../route';
import { classifyRadius, curveClassAt, extractShape } from '../shape';
import { NavEngine } from '../nav-engine';
import { PathBuilder, simulateRide } from '../simulator';

const START = { lat: 22.5726, lon: 88.3639 }; // Kolkata

const ins = (atIndex: number, maneuver: Maneuver, street = '', distanceM = 0, timeMs = 0) =>
  ({ atIndex, maneuver, exit: 0, street, text: '', distanceM, timeMs });

describe('curvature classification', () => {
  it('uses radius thresholds', () => {
    expect(classifyRadius(1000)).toBe(CurveClass.STRAIGHT);
    expect(classifyRadius(400)).toBe(CurveClass.STRAIGHT);
    expect(classifyRadius(250)).toBe(CurveClass.GENTLE);
    expect(classifyRadius(100)).toBe(CurveClass.MEDIUM);
    expect(classifyRadius(40)).toBe(CurveClass.SHARP);
  });

  it.each([
    [40, CurveClass.SHARP],
    [100, CurveClass.MEDIUM],
    [250, CurveClass.GENTLE],
  ])('classifies the middle of an arc of radius %i m', (radius, cls) => {
    const b = new PathBuilder(START, 0).straight(200).arc(radius, 120).straight(200);
    const route = makeRoute(b.points);
    const mid = 200 + (120 * Math.PI * radius) / 180 / 2;
    const c = curveClassAt(route, mid);
    expect(c.cls).toBe(cls);
    expect(c.dir).toBe(1);
  });

  it('classifies a straight road as straight', () => {
    const route = makeRoute(new PathBuilder(START, 37).straight(500).points);
    expect(curveClassAt(route, 250).cls).toBe(CurveClass.STRAIGHT);
  });
});

describe('road shape', () => {
  it('is heading-up regardless of compass direction', () => {
    for (const heading of [0, 90, 213]) {
      const route = makeRoute(new PathBuilder(START, heading).straight(800).points);
      const s = extractShape(route, 100, null);
      expect(s.points.length).toBeLessThanOrEqual(40);
      expect(Math.abs(s.points[0].x)).toBeLessThan(5);
      expect(Math.abs(s.points[0].y)).toBeLessThan(5);
      const last = s.points[s.points.length - 1];
      expect(Math.abs(last.x)).toBeLessThan(30); // < 3 m drift
      expect(last.y).toBeGreaterThan(5900); // ~600 m ahead, in dm
    }
  });

  it('shows the road bending right after a right turn and marks the maneuver point', () => {
    const b = new PathBuilder(START, 45).straight(300);
    const at = b.index;
    b.turn(90).straight(300);
    const route = makeRoute(b.points, [ins(at, Maneuver.RIGHT)]);
    const s = extractShape(route, 100, 300);
    expect(s.maneuverIdx).not.toBeNull();
    const m = s.points[s.maneuverIdx!];
    expect(Math.abs(m.x)).toBeLessThan(10);
    expect(m.y).toBeGreaterThan(1950);
    expect(m.y).toBeLessThan(2050);
    const last = s.points[s.points.length - 1];
    expect(last.x).toBeGreaterThan(1000); // well to the right
    // The intersection turn itself is not reported as a curve warning.
    expect(s.curve.cls).toBe(CurveClass.STRAIGHT);
  });

  it('warns about the next sharp left bend with its distance', () => {
    const b = new PathBuilder(START, 0).straight(250).arc(45, -90).straight(300);
    const route = makeRoute(b.points);
    const s = extractShape(route, 50, null);
    expect(s.curve.dir).toBe(-1);
    expect(s.curve.cls).toBe(CurveClass.SHARP);
    expect(s.curve.distM).toBeGreaterThan(170);
    expect(s.curve.distM).toBeLessThan(215);
    // Points in the bend carry the sharp class; the road ends up on the left.
    expect(s.points.some((p) => p.cls === CurveClass.SHARP)).toBe(true);
    expect(s.points[s.points.length - 1].x).toBeLessThan(-500);
  });

  it('always fits in one NAV frame', () => {
    const b = new PathBuilder(START, 0);
    for (let i = 0; i < 20; i++) b.arc(30 + i * 5, i % 2 ? 70 : -70).straight(20);
    const route = makeRoute(b.points);
    const s = extractShape(route, 0, null);
    const f = encodeNav({
      maneuver: Maneuver.LEFT, exit: 0, distM: 1, curveDir: s.curve.dir, curveClass: s.curve.cls,
      curveDistM: s.curve.distM, maneuverIdx: s.maneuverIdx, anchorId: 0, poseX: 0, poseY: 0, headingCdeg: 0, points: s.points, street: 'Long street name here',
    });
    expect(f.length).toBeLessThanOrEqual(4 + MAX_PAYLOAD);
    expect(decode(f).type).toBe(1);
  });
});

function twoTurnRoute() {
  const b = new PathBuilder(START, 0).straight(400);
  const t1 = b.index;
  b.turn(-90).straight(300);
  const t2 = b.index;
  b.turn(90).straight(300);
  return makeRoute(b.points, [
    ins(0, Maneuver.DEPART, 'Start Rd', 400, 40_000),
    ins(t1, Maneuver.LEFT, 'Park St', 300, 30_000),
    ins(t2, Maneuver.RIGHT, 'Lake Rd', 300, 30_000),
    ins(b.index, Maneuver.ARRIVE, '', 0, 0),
  ]);
}

describe('NavEngine', () => {
  it('counts down to each maneuver, then arrives', () => {
    const route = twoTurnRoute();
    const eng = new NavEngine(route);
    const seen: { m: Maneuver; d: number | null; street: string; state: NavState; eta: number }[] = [];
    for (const fix of simulateRide(route, { speedMps: 10, intervalMs: 1000, startMs: 1_000_000 })) {
      const s = eng.update(fix);
      seen.push({ m: s.nav.maneuver, d: s.nav.distM, street: s.nav.street, state: s.state, eta: s.etaEpoch });
      expect(s.needsReroute).toBe(false);
    }
    const order = seen.map((x) => x.m).filter((m, i, a) => i === 0 || a[i - 1] !== m);
    expect(order).toEqual([Maneuver.LEFT, Maneuver.RIGHT, Maneuver.ARRIVE]);
    const first = seen.filter((x) => x.m === Maneuver.LEFT).map((x) => x.d!);
    expect(first[0]).toBeGreaterThan(390);
    expect(first.every((d, i) => i === 0 || d <= first[i - 1])).toBe(true);
    expect(seen[0].street).toBe('Park St');
    expect(seen[seen.length - 1].state).toBe(NavState.ARRIVED);
    // ETA stays consistent: 100 s of route at the instruction speeds, ridden at the same 10 m/s.
    expect(Math.abs(seen[0].eta - (1_000_000 + 100_000) / 1000)).toBeLessThanOrEqual(1);
    expect(Math.abs(seen[50].eta - seen[0].eta)).toBeLessThanOrEqual(2);
  });

  it('requests exactly one reroute after riding off-route for 5 s', () => {
    const route = twoTurnRoute();
    const eng = new NavEngine(route);
    let reroutes = 0;
    const states: NavState[] = [];
    for (const fix of simulateRide(route, {
      speedMps: 10, intervalMs: 1000, startMs: 0, detour: { fromM: 100, toM: 250, offsetM: 120 },
    })) {
      const s = eng.update(fix);
      if (s.needsReroute) reroutes++;
      states.push(s.state);
    }
    expect(reroutes).toBe(1);
    expect(states).toContain(NavState.REROUTING);
    expect(states[states.length - 1]).toBe(NavState.ARRIVED); // rejoined the route afterwards
  });

  it('ignores a brief GPS glitch off the route', () => {
    const route = twoTurnRoute();
    const eng = new NavEngine(route);
    let reroutes = 0;
    for (const fix of simulateRide(route, {
      speedMps: 10, intervalMs: 1000, startMs: 0, detour: { fromM: 100, toM: 130, offsetM: 80 },
    })) {
      if (eng.update(fix).needsReroute) reroutes++;
    }
    expect(reroutes).toBe(0);
  });

  it('reports GPS lost after 10 s without fixes', () => {
    const eng = new NavEngine(twoTurnRoute());
    eng.update({ ...START, speedMps: 0, accuracyM: 5, timeMs: 0 });
    expect(eng.isGpsLost(9_000)).toBe(false);
    expect(eng.isGpsLost(10_001)).toBe(true);
  });
});

describe('GraphHopper parsing', () => {
  it('maps instructions, distances and speed limits', () => {
    const b = new PathBuilder(START, 0).straight(200);
    const t = b.index;
    b.turn(90).straight(100);
    const coords = b.points.map((p) => [p.lon, p.lat] as [number, number]);
    const path: GhPath = {
      distance: 300, time: 30_000,
      points: { coordinates: coords },
      instructions: [
        { distance: 200, time: 20_000, sign: 0, interval: [0, t], text: 'Continue', street_name: 'A' },
        { distance: 100, time: 10_000, sign: 2, interval: [t, coords.length - 1], text: 'Turn right', street_name: 'B' },
        { distance: 0, time: 0, sign: 4, interval: [coords.length - 1, coords.length - 1], text: 'Arrive' },
      ],
      details: { max_speed: [[0, t, 50], [t, coords.length - 1, null]] },
    };
    const r = routeFromGraphHopper(path);
    expect(r.instructions.map((i) => i.maneuver)).toEqual([Maneuver.DEPART, Maneuver.RIGHT, Maneuver.ARRIVE]);
    expect(r.instructions[1].atM).toBeCloseTo(200, 0);
    expect(r.lengthM).toBeCloseTo(300, 0);
    expect(r.maxSpeed[0]).toMatchObject({ kmh: 50 });
    expect(r.maxSpeed[1].kmh).toBeNull();
  });
});
