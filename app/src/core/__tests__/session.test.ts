import { fromBase64, toBase64 } from '../base64';
import { Maneuver, MsgType, NavState, NotifKind, decode } from '../proto';
import { makeRoute } from '../route';
import { IDLE_TRIP_INTERVAL_MS, NavSession } from '../session';
import { PathBuilder, simulateRide } from '../simulator';

const START = { lat: 22.5726, lon: 88.3639 };

function route() {
  const b = new PathBuilder(START, 0).straight(300);
  const t = b.index;
  b.turn(90).straight(300);
  return makeRoute(b.points, [
    { atIndex: 0, maneuver: Maneuver.DEPART, exit: 0, street: 'A', text: '', distanceM: 300, timeMs: 30_000 },
    { atIndex: t, maneuver: Maneuver.RIGHT, exit: 0, street: 'B', text: '', distanceM: 300, timeMs: 30_000 },
    { atIndex: b.index, maneuver: Maneuver.ARRIVE, exit: 0, street: '', text: '', distanceM: 0, timeMs: 0 },
  ]);
}

function setup(fetchRoute = jest.fn(async () => route())) {
  const frames: Uint8Array[] = [];
  const s = new NavSession({
    send: (f) => frames.push(f),
    fetchRoute,
    phoneBatteryPct: () => 55,
    tzOffsetMin: () => 330,
  });
  return { s, frames, fetchRoute, types: () => frames.map((f) => decode(f).type) };
}

describe('base64', () => {
  it('round-trips all lengths', () => {
    for (let n = 0; n < 20; n++) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 255);
      expect(Array.from(fromBase64(toBase64(b)))).toEqual(Array.from(b));
    }
    expect(toBase64(Uint8Array.of(1, 2, 3, 4))).toBe('AQIDBA==');
  });
});

describe('NavSession', () => {
  it('throttles NAV to 2 Hz and TRIP to 1 Hz on a 10 Hz GPS', () => {
    const { s, frames, types } = setup();
    s.start(route(), { lat: 0, lon: 0 });
    frames.length = 0;
    let n = 0;
    for (const fix of simulateRide(route(), { speedMps: 10, intervalMs: 100, startMs: 0 })) {
      s.onFix(fix);
      if (++n === 100) break; // 10 s
    }
    const t = types();
    const nav = t.filter((x) => x === MsgType.NAV).length;
    const trip = t.filter((x) => x === MsgType.TRIP).length;
    expect(nav).toBeGreaterThanOrEqual(20);
    expect(nav).toBeLessThanOrEqual(23); // 20 periodic + maneuver-change extras
    expect(trip).toBe(10);
    const tripMsg = frames.map(decode).find((d) => d.type === MsgType.TRIP)!;
    expect(tripMsg.msg).toMatchObject({ phoneBatt: 55, tzOffsetMin: 330 });
  });

  it('sends NAV immediately when the maneuver changes', () => {
    const { s, frames } = setup();
    s.start(route(), { lat: 0, lon: 0 });
    let prev: { m: number; t: number } | null = null;
    const changeGaps: number[] = [];
    // 9 m/s puts the switch at ~33.3 s, between the 500 ms periodic sends.
    for (const fix of simulateRide(route(), { speedMps: 9, intervalMs: 100, startMs: 0 })) {
      const before = frames.length;
      s.onFix(fix);
      for (const f of frames.slice(before)) {
        const d = decode(f);
        if (d.type !== MsgType.NAV) continue;
        if (prev && d.msg.maneuver !== prev.m) changeGaps.push(fix.timeMs - prev.t);
        prev = { m: d.msg.maneuver, t: fix.timeMs };
      }
    }
    expect(changeGaps.length).toBe(1); // RIGHT -> ARRIVE
    expect(changeGaps[0]).toBeLessThan(500);
  });

  it('reroutes once when off-route, reporting REROUTING then NAVIGATING', async () => {
    const { s, frames, fetchRoute } = setup();
    s.start(route(), { lat: 1, lon: 1 });
    for (const fix of simulateRide(route(), {
      speedMps: 10, intervalMs: 1000, startMs: 0, detour: { fromM: 50, toM: 150, offsetM: 150 },
    })) {
      s.onFix(fix);
      if (fix.timeMs === 12000) break; // off-route from t≈5 s, so the 5 s timer fires at t≈10 s
    }
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchRoute).toHaveBeenCalledTimes(1);
    const states = frames.map(decode).filter((d) => d.type === MsgType.STATE).map((d) => d.msg);
    expect(states).toEqual([NavState.NAVIGATING, NavState.REROUTING, NavState.NAVIGATING]);
  });

  it('reports GPS lost on tick and recovers on the next fix', () => {
    const { s, types, frames } = setup();
    s.start(route(), { lat: 0, lon: 0 });
    s.onFix({ ...START, speedMps: 5, accuracyM: 5, timeMs: 0 });
    s.tick(11_000);
    expect(s.getView().state).toBe(NavState.GPS_LOST);
    s.onFix({ ...START, speedMps: 5, accuracyM: 5, timeMs: 12_000 });
    expect(s.getView().state).toBe(NavState.NAVIGATING);
    expect(types()).toContain(MsgType.STATE);
    expect(frames.length).toBeGreaterThan(0);
  });

  it('replays state + latest frames when the device reconnects', () => {
    const { s, frames, types } = setup();
    s.start(route(), { lat: 0, lon: 0 });
    s.onFix({ ...START, speedMps: 5, accuracyM: 5, timeMs: 0 });
    frames.length = 0;
    s.onDeviceConnected();
    expect(types()).toEqual([MsgType.STATE, MsgType.NAV, MsgType.TRIP]);
    s.notify({ kind: NotifKind.CALL, app: 'Phone', title: 'X', body: '' });
    expect(types()[3]).toBe(MsgType.NOTIF);
  });

  it('keeps an idle display supplied with phone battery and clock', () => {
    const { s, frames, types } = setup();
    s.onDeviceConnected();
    expect(types()).toEqual([MsgType.STATE, MsgType.TRIP]);
    const idle = decode(frames[1]);
    expect(idle.type === MsgType.TRIP && idle.msg).toMatchObject({ etaEpoch: 0, remainingM: 0, phoneBatt: 55, tzOffsetMin: 330 });

    frames.length = 0;
    const t0 = Date.now() + IDLE_TRIP_INTERVAL_MS; // onDeviceConnected stamped the wall clock
    s.heartbeat(t0);
    s.heartbeat(t0 + IDLE_TRIP_INTERVAL_MS - 1); // too soon
    s.onPhoneBatteryChanged(t0 + 1000); // immediate regardless of the interval
    s.heartbeat(t0 + 1000 + IDLE_TRIP_INTERVAL_MS);
    expect(types()).toEqual([MsgType.TRIP, MsgType.TRIP, MsgType.TRIP]);
  });

  it('leaves TRIP to the fix stream during a ride, and clears the route when it stops', () => {
    const { s, frames, types } = setup();
    s.start(route(), { lat: 0, lon: 0 });
    frames.length = 0;
    s.heartbeat(10 * IDLE_TRIP_INTERVAL_MS);
    s.onPhoneBatteryChanged(10 * IDLE_TRIP_INTERVAL_MS);
    expect(frames).toHaveLength(0);

    s.stop();
    expect(types()).toEqual([MsgType.STATE, MsgType.TRIP]);
    const cleared = decode(frames[1]);
    expect(cleared.type === MsgType.TRIP && cleared.msg.etaEpoch).toBe(0);
  });
});
