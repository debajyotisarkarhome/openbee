import { destination } from '../geo';
import { Maneuver, MAX_PAYLOAD, MsgType, decode, encodeRoads } from '../proto';
import { RoadMap, simplify } from '../roads';
import { makeRoute } from '../route';
import { NavSession } from '../session';
import { PathBuilder, simulateRide } from '../simulator';

const START = { lat: 22.5726, lon: 88.3639 };

/** Cross streets every 100 m along a straight north-bound road, each 400 m long east–west. */
function grid(lengthM = 3000) {
  const roads = [];
  for (let d = 0; d <= lengthM; d += 100) {
    const c = destination(START, 0, d);
    roads.push([destination(c, 270, 200), c, destination(c, 90, 200)]);
  }
  return roads;
}

const roadsOf = (frames: Uint8Array[]) =>
  frames.flatMap((f) => {
    const d = decode(f);
    if (d.type !== MsgType.ROADS) throw new Error('not ROADS');
    return d.msg.roads;
  });

describe('encodeRoads', () => {
  it('splits into ≤240-byte frames and long streets into joined pieces', () => {
    const long = Array.from({ length: 150 }, (_, i) => ({ x: i, y: i === 0 ? 0 : -i }));
    const frames = encodeRoads(3, [long, [{ x: 1, y: 2 }, { x: 3, y: 4 }]]);
    expect(frames.length).toBeGreaterThan(2);
    for (const [i, f] of frames.entries()) {
      expect(f.length).toBeLessThanOrEqual(4 + MAX_PAYLOAD);
      const d = decode(f);
      expect(d.msg).toMatchObject({ anchorId: 3, part: i, parts: frames.length });
    }
    const pieces = roadsOf(frames);
    // Pieces of the long street share their joining points, so concatenating them (minus joins) restores it.
    const longPieces = pieces.slice(0, -1);
    const rebuilt = longPieces.flatMap((p, i) => (i === 0 ? p : p.slice(1)));
    expect(rebuilt).toEqual(long);
  });
});

describe('simplify', () => {
  it('drops collinear points and keeps corners', () => {
    const pts = [{ x: 0, y: 0 }, { x: 10, y: 0.5 }, { x: 20, y: 0 }, { x: 20, y: 30 }];
    expect(simplify(pts, 3)).toEqual([pts[0], pts[2], pts[3]]);
  });
});

describe('RoadMap', () => {
  it('issues a new anchor only after moving 300 m, with a matching pose', () => {
    const rm = new RoadMap();
    expect(rm.update(START)).toBeNull(); // no streets yet
    rm.setRoads(grid());
    const first = rm.update(START)!;
    expect(first.length).toBeGreaterThan(0);
    expect(rm.pose(START, 0)).toEqual({ anchorId: 1, poseX: 0, poseY: 0, headingCdeg: 0 });

    const p250 = destination(START, 0, 250);
    expect(rm.update(p250)).toBeNull();
    const pose = rm.pose(p250, 359.996);
    expect(pose.anchorId).toBe(1);
    expect(Math.abs(pose.poseX)).toBeLessThanOrEqual(1);
    expect(pose.poseY).toBeGreaterThan(2490);
    expect(pose.poseY).toBeLessThan(2510);
    expect(pose.headingCdeg).toBe(0); // wraps 36000 → 0

    const p320 = destination(START, 0, 320);
    expect(rm.update(p320)).not.toBeNull();
    expect(rm.pose(p320, 90).anchorId).toBe(2);
  });

  it('keeps only streets near the anchor and within the point budget', () => {
    const rm = new RoadMap({ reanchorM: 300, radiusM: 700, simplifyM: 3, maxPoints: 20 });
    rm.setRoads(grid(5000));
    const roads = roadsOf(rm.update(START)!);
    const total = roads.reduce((a, r) => a + r.length, 0);
    expect(total).toBeLessThanOrEqual(20);
    // Nearest first: the street through the anchor is included.
    expect(roads.some((r) => r.some((p) => Math.abs(p.y) <= 1))).toBe(true);
    for (const r of roads) for (const p of r) expect(Math.hypot(p.x, p.y)).toBeLessThan(1000);
  });
});

describe('NavSession with map streets', () => {
  it('sends ROADS before the NAV frame that refers to them, and replays them on reconnect', async () => {
    const b = new PathBuilder(START, 0).straight(1500);
    const route = makeRoute(b.points, [
      { atIndex: 0, maneuver: Maneuver.DEPART, exit: 0, street: 'A', text: '', distanceM: 1500, timeMs: 150_000 },
      { atIndex: b.index, maneuver: Maneuver.ARRIVE, exit: 0, street: '', text: '', distanceM: 0, timeMs: 0 },
    ]);
    const frames: Uint8Array[] = [];
    const s = new NavSession({
      send: (f) => frames.push(f),
      fetchRoute: async () => route,
      fetchRoads: async () => grid(),
      phoneBatteryPct: () => null,
      tzOffsetMin: () => 0,
    });
    s.start(route, { lat: 0, lon: 0 });
    await Promise.resolve();
    await Promise.resolve();

    const seenAnchors = new Set<number>();
    let navWithRoads = 0;
    for (const fix of simulateRide(route, { speedMps: 15, intervalMs: 500, startMs: 0 })) {
      const before = frames.length;
      s.onFix(fix);
      for (const f of frames.slice(before)) {
        const d = decode(f);
        if (d.type === MsgType.ROADS) seenAnchors.add(d.msg.anchorId);
        if (d.type === MsgType.NAV && d.msg.anchorId) {
          expect(seenAnchors.has(d.msg.anchorId)).toBe(true);
          navWithRoads++;
        }
      }
    }
    expect(seenAnchors.size).toBeGreaterThanOrEqual(4); // 1.5 km / 300 m
    expect(navWithRoads).toBeGreaterThan(100);

    frames.length = 0;
    s.onDeviceConnected();
    const types = frames.map((f) => decode(f).type);
    expect(types[0]).toBe(MsgType.STATE);
    expect(types).toContain(MsgType.ROADS);
    expect(types.indexOf(MsgType.ROADS)).toBeLessThan(types.indexOf(MsgType.NAV));
  });
});
