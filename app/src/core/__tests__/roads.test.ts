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

/** Let a queued street fetch resolve: the session fetches per anchor, so anchors advance on await. */
const settle = () => new Promise((r) => setImmediate(r));

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
  it('issues an anchor when fresh streets arrive, not merely on distance', () => {
    const rm = new RoadMap();
    expect(rm.update(START)).toBeNull(); // no streets yet
    expect(rm.needsAnchor(START)).toBe(true);

    rm.setRoads(grid());
    const first = rm.update(START)!;
    expect(first.length).toBeGreaterThan(0);
    expect(rm.pose(START, 0)).toEqual({ anchorId: 1, poseX: 0, poseY: 0, headingCdeg: 0 });
    expect(rm.needsAnchor(START)).toBe(false);

    const p250 = destination(START, 0, 250);
    expect(rm.update(p250)).toBeNull();
    const pose = rm.pose(p250, 359.996);
    expect(pose.anchorId).toBe(1);
    expect(Math.abs(pose.poseX)).toBeLessThanOrEqual(1);
    expect(pose.poseY).toBeGreaterThan(2490);
    expect(pose.poseY).toBeLessThan(2510);
    expect(pose.headingCdeg).toBe(0); // wraps 36000 → 0

    // Past the reanchor distance the session is told to fetch, but the anchor must not move until the
    // new streets actually land: re-anchoring off the old set would retransmit it for nothing.
    const p320 = destination(START, 0, 320);
    expect(rm.needsAnchor(p320)).toBe(true);
    expect(rm.update(p320)).toBeNull();
    expect(rm.pose(p320, 90).anchorId).toBe(1);

    rm.setRoads(grid()); // fetch landed
    expect(rm.update(p320)).not.toBeNull();
    expect(rm.pose(p320, 90).anchorId).toBe(2);
  });

  it('drops the street set when the rider outruns it, so the device stops drawing stale streets', () => {
    const rm = new RoadMap();
    rm.setRoads(grid(5000));
    rm.update(START);
    expect(rm.pose(START, 0).anchorId).toBe(1);

    // Still inside the kept radius: the set stays on screen even though a fetch is due.
    const inside = destination(START, 0, 600);
    expect(rm.update(inside)).toBeNull();
    expect(rm.pose(inside, 0).anchorId).toBe(1);

    // Beyond it, with no fresh streets: the set is dropped and pose reports "no roads".
    const beyond = destination(START, 0, 900);
    expect(rm.update(beyond)).toBeNull();
    expect(rm.pose(beyond, 0).anchorId).toBe(0);
    expect(rm.riderFrame(beyond, 0)).toEqual([]);
    expect(rm.hasRoads).toBe(false);

    // And the next set gets a fresh id rather than reusing 1.
    rm.setRoads(grid(5000));
    expect(rm.update(beyond)).not.toBeNull();
    expect(rm.pose(beyond, 0).anchorId).toBe(2);
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

describe('RoadMap.riderFrame', () => {
  it('is empty until an anchor has been issued', () => {
    const rm = new RoadMap();
    expect(rm.riderFrame(START, 0)).toEqual([]);
    rm.setRoads(grid());
    expect(rm.riderFrame(START, 0)).toEqual([]); // setRoads alone does not anchor
    rm.update(START);
    expect(rm.riderFrame(START, 0).length).toBeGreaterThan(0);
  });

  it('rotates streets into the heading-up frame like draw_streets() on the device', () => {
    const rm = new RoadMap();
    rm.setRoads(grid());
    rm.update(START);

    // riderFrame preserves the order of the anchor set, so the same index is the same street.
    const north = rm.riderFrame(START, 0);
    const east = rm.riderFrame(START, 90);
    const spread = (r: { x: number; y: number }[], k: 'x' | 'y') => Math.max(...r.map((p) => Math.abs(p[k])));

    // Facing north, the east-west street through the anchor lies across the view: wide in x, flat in y.
    const i = north.findIndex((r) => spread(r, 'y') < 5 && spread(r, 'x') > 150);
    expect(i).toBeGreaterThanOrEqual(0);

    // Facing east, that same street now runs ahead and behind the rider: wide in y, flat in x.
    expect(spread(east[i], 'y')).toBeGreaterThan(150);
    expect(spread(east[i], 'x')).toBeLessThan(5);
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
      fetchStreets: async () => grid(),
      phoneBatteryPct: () => null,
      tzOffsetMin: () => 0,
    });
    s.start(route, { lat: 0, lon: 0 });

    const seenAnchors = new Set<number>();
    let navWithRoads = 0;
    for (const fix of simulateRide(route, { speedMps: 15, intervalMs: 500, startMs: 0 })) {
      const before = frames.length;
      s.onFix(fix);
      await settle(); // a street fetch queued by this fix lands before the next one
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

  it('mirrors the streets it sent on the session view', async () => {
    const b = new PathBuilder(START, 0).straight(600);
    const route = makeRoute(b.points, [
      { atIndex: 0, maneuver: Maneuver.DEPART, exit: 0, street: 'A', text: '', distanceM: 600, timeMs: 60_000 },
      { atIndex: b.index, maneuver: Maneuver.ARRIVE, exit: 0, street: '', text: '', distanceM: 0, timeMs: 0 },
    ]);
    const s = new NavSession({
      send: () => {},
      fetchRoute: async () => route,
      fetchStreets: async () => grid(),
      phoneBatteryPct: () => null,
      tzOffsetMin: () => 0,
    });
    s.start(route, { lat: 0, lon: 0 });
    expect(s.getView().streets).toEqual([]); // nothing fetched until a fix gives us a position

    // First fix queues the fetch; it lands on await; the next fix publishes the anchor.
    s.onFix({ lat: START.lat, lon: START.lon, speedMps: 10, accuracyM: 5, timeMs: 0 });
    expect(s.getView().streets).toEqual([]);
    await settle();
    s.onFix({ lat: START.lat, lon: START.lon, speedMps: 10, accuracyM: 5, timeMs: 500 });
    const streets = s.getView().streets;
    expect(streets.length).toBeGreaterThan(0);
    expect(s.getView().roadsError).toBeNull();
    // Heading north up a north-bound route: the cross streets run across the view.
    expect(streets.some((r) => Math.max(...r.map((q) => Math.abs(q.x))) > 150)).toBe(true);
  });

  it('surfaces a street fetch failure instead of swallowing it', async () => {
    const b = new PathBuilder(START, 0).straight(600);
    const route = makeRoute(b.points, [
      { atIndex: 0, maneuver: Maneuver.DEPART, exit: 0, street: 'A', text: '', distanceM: 600, timeMs: 60_000 },
      { atIndex: b.index, maneuver: Maneuver.ARRIVE, exit: 0, street: '', text: '', distanceM: 0, timeMs: 0 },
    ]);
    const s = new NavSession({
      send: () => {},
      fetchRoute: async () => route,
      fetchStreets: async () => {
        throw new Error('Map streets unavailable (502)');
      },
      phoneBatteryPct: () => null,
      tzOffsetMin: () => 0,
    });
    expect(s.getView().roadsError).toBeNull();
    s.start(route, { lat: 0, lon: 0 });
    s.onFix({ lat: START.lat, lon: START.lon, speedMps: 10, accuracyM: 5, timeMs: 0 });
    await settle();
    expect(s.getView().roadsError).toBe('Map streets unavailable (502)');
    expect(s.getView().streets).toEqual([]);

    s.stop();
    expect(s.getView().roadsError).toBeNull();
  });

  it('reports an empty street set distinctly from a failure', async () => {
    const b = new PathBuilder(START, 0).straight(600);
    const route = makeRoute(b.points, [
      { atIndex: 0, maneuver: Maneuver.DEPART, exit: 0, street: 'A', text: '', distanceM: 600, timeMs: 60_000 },
      { atIndex: b.index, maneuver: Maneuver.ARRIVE, exit: 0, street: '', text: '', distanceM: 0, timeMs: 0 },
    ]);
    const s = new NavSession({
      send: () => {},
      fetchRoute: async () => route,
      fetchStreets: async () => [],
      phoneBatteryPct: () => null,
      tzOffsetMin: () => 0,
    });
    s.start(route, { lat: 0, lon: 0 });
    s.onFix({ lat: START.lat, lon: START.lon, speedMps: 10, accuracyM: 5, timeMs: 0 });
    await settle();
    expect(s.getView().roadsError).toBe('No map streets near this part of the route');
  });
});
