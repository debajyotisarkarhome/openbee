import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  CurveClass, Maneuver, MAX_PAYLOAD, MsgType, NotifKind,
  decode, dump, encodeNav, encodeNotif, encodeTrip, utf8Truncate,
} from '../proto';

const VEC = join(__dirname, '..', '..', '..', '..', 'proto-vectors');

describe('proto', () => {
  it('round-trips NAV', () => {
    const msg = {
      maneuver: Maneuver.SHARP_RIGHT, exit: 0, distM: 42, curveDir: -1 as const,
      curveClass: CurveClass.SHARP, curveDistM: 10, maneuverIdx: 1, anchorId: 0, poseX: 0, poseY: 0, headingCdeg: 0,
      points: [{ x: 0, y: 0, cls: CurveClass.STRAIGHT }, { x: -32768, y: 32767, cls: CurveClass.SHARP }],
      street: 'NH 16',
    };
    const d = decode(encodeNav(msg));
    expect(d.type).toBe(MsgType.NAV);
    expect(d.msg).toEqual(msg);
  });

  it('clamps out-of-range points and drops an out-of-view maneuver index', () => {
    const f = encodeNav({
      maneuver: Maneuver.LEFT, exit: 0, distM: 70000, curveDir: 0, curveClass: CurveClass.STRAIGHT,
      curveDistM: 0, maneuverIdx: 5, anchorId: 0, poseX: 0, poseY: 0, headingCdeg: 0, points: [{ x: 99999, y: -99999, cls: CurveClass.STRAIGHT }], street: '',
    });
    const d = decode(f);
    if (d.type !== MsgType.NAV) throw new Error();
    expect(d.msg.points[0]).toEqual({ x: 32767, y: -32768, cls: 0 });
    expect(d.msg.distM).toBe(0xfffe);
    expect(d.msg.maneuverIdx).toBeNull();
  });

  it('never exceeds the payload limit', () => {
    const pts = Array.from({ length: 60 }, () => ({ x: 1, y: 1, cls: CurveClass.GENTLE }));
    const f = encodeNav({
      maneuver: Maneuver.LEFT, exit: 0, distM: 1, curveDir: 0, curveClass: 0, curveDistM: 0,
      maneuverIdx: null, anchorId: 0, poseX: 0, poseY: 0, headingCdeg: 0, points: pts, street: 'x'.repeat(500),
    });
    expect(f.length).toBe(4 + MAX_PAYLOAD);
    const n = encodeNotif({ kind: NotifKind.MESSAGE, app: 'a'.repeat(99), title: 't'.repeat(99), body: 'b'.repeat(999) });
    expect(n.length).toBeLessThanOrEqual(4 + MAX_PAYLOAD);
  });

  it('truncates UTF-8 on a code point boundary', () => {
    expect(Array.from(utf8Truncate('aé', 2))).toEqual([0x61]);
    expect(Array.from(utf8Truncate('aé', 3))).toEqual([0x61, 0xc3, 0xa9]);
    expect(utf8Truncate('🏍️', 3).length).toBe(0);
  });

  it('encodes TRIP little-endian with signed tz', () => {
    const f = encodeTrip({ speedKmh: 300, limitKmh: 50, etaEpoch: 0x01020304, remainingM: 5, phoneBatt: null, nowEpoch: 0, tzOffsetMin: -60 });
    expect(Array.from(f.subarray(4, 10))).toEqual([255, 50, 4, 3, 2, 1]);
    expect(Array.from(f.subarray(f.length - 2))).toEqual([0xc4, 0xff]);
  });

  it('rejects malformed frames', () => {
    expect(() => decode(Uint8Array.of(2, 1, 0, 0))).toThrow();
    expect(() => decode(Uint8Array.of(1, 4, 2, 0, 1))).toThrow();
    expect(() => decode(Uint8Array.of(1, 0x55, 0, 0))).toThrow();
  });

  it('matches committed test vectors', () => {
    const bins = readdirSync(VEC).filter((f) => f.endsWith('.bin'));
    expect(bins.length).toBeGreaterThan(0);
    for (const b of bins) {
      const bytes = new Uint8Array(readFileSync(join(VEC, b)));
      expect(dump(bytes)).toBe(readFileSync(join(VEC, b.replace('.bin', '.txt')), 'utf8'));
    }
  });
});
