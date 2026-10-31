import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  CurveClass, Maneuver, MAX_PAYLOAD, MediaCmd, MediaState, MsgType, NotifKind, Page,
  decode, dump, encodeLayout, encodeMedia, encodeMediaCmd, encodeNav, encodeNotif, encodeTrip, utf8Truncate,
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

  it('MEDIA round-trips', () => {
    const msg = { state: MediaState.PLAYING, volumePct: 42, title: 'Bohemian Rhapsody', artist: 'Queen' };
    const d = decode(encodeMedia(msg));
    expect(d.type).toBe(MsgType.MEDIA);
    expect(d.msg).toEqual(msg);
  });

  it('MEDIA unknown volume', () => {
    const f = encodeMedia({ state: MediaState.PAUSED, volumePct: null, title: 'a', artist: 'b' });
    expect(f[5]).toBe(0xff);
    const d = decode(f);
    if (d.type !== MsgType.MEDIA) throw new Error();
    expect(d.msg.volumePct).toBeNull();
  });

  it('MEDIA truncates on code points', () => {
    const title = 'é'.repeat(40) + '日'.repeat(10);
    const f = encodeMedia({ state: MediaState.PLAYING, volumePct: 1, title, artist: '' });
    expect(f[6]).toBe(95);
    const d = decode(f);
    if (d.type !== MsgType.MEDIA) throw new Error();
    expect(d.msg.title).not.toContain('�');
    expect(title.startsWith(d.msg.title)).toBe(true);
  });

  it('MEDIA_CMD round-trips', () => {
    for (const c of [MediaCmd.TOGGLE, MediaCmd.NEXT, MediaCmd.PREV, MediaCmd.VOL_UP, MediaCmd.VOL_DOWN]) {
      const f = encodeMediaCmd(c);
      expect(f.length).toBe(5);
      const d = decode(f);
      if (d.type !== MsgType.MEDIA_CMD) throw new Error();
      expect(d.msg.cmd).toBe(c);
    }
  });

  it('LAYOUT round-trips and caps at 8 pages', () => {
    const pages = [Page.STATUS, Page.NAV, Page.MEDIA];
    const d = decode(encodeLayout({ pages }));
    if (d.type !== MsgType.LAYOUT) throw new Error();
    expect(d.msg.pages).toEqual(pages);
    const many = decode(encodeLayout({ pages: Array.from({ length: 12 }, (_, i) => i % 5) }));
    if (many.type !== MsgType.LAYOUT) throw new Error();
    expect(many.msg.pages).toHaveLength(8);
    expect(() => decode(Uint8Array.of(1, MsgType.LAYOUT, 2, 0, 9, 0))).toThrow();
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
