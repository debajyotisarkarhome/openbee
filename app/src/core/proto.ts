// OpenBee BLE protocol v1 — see docs/protocol.md. Pure TS, no React Native imports.

export const PROTO_VER = 1;
export const MAX_PAYLOAD = 240;
export const MAX_POINTS = 36;
/** Max points in one ROADS frame: (240 - 4 header - 1 len byte) / 4. */
export const MAX_ROAD_POINTS_PER_FRAME = 58;

export const SERVICE_UUID = '6f70656e-6265-4500-a000-000000000000';
export const RX_UUID = '6f70656e-6265-4500-a000-000000000001';
export const TX_UUID = '6f70656e-6265-4500-a000-000000000002';

export enum MsgType {
  NAV = 0x01,
  TRIP = 0x02,
  NOTIF = 0x03,
  STATE = 0x04,
  ROADS = 0x05,
  DEV_STATUS = 0x81,
}

export enum Maneuver {
  NONE = 0,
  STRAIGHT,
  SLIGHT_LEFT,
  LEFT,
  SHARP_LEFT,
  SLIGHT_RIGHT,
  RIGHT,
  SHARP_RIGHT,
  UTURN_LEFT,
  UTURN_RIGHT,
  KEEP_LEFT,
  KEEP_RIGHT,
  ROUNDABOUT,
  ARRIVE,
  DEPART,
}

export enum CurveClass {
  STRAIGHT = 0,
  GENTLE = 1,
  MEDIUM = 2,
  SHARP = 3,
}

export enum NavState {
  IDLE = 0,
  NAVIGATING = 1,
  REROUTING = 2,
  ARRIVED = 3,
  GPS_LOST = 4,
}

export enum NotifKind {
  MESSAGE = 0,
  CALL = 1,
  OTHER = 2,
}

/** Road-shape point in the rider-relative, heading-up frame (decimeters). */
export interface ShapePoint {
  x: number;
  y: number;
  cls: CurveClass;
}

export interface NavMsg {
  maneuver: Maneuver;
  exit: number;
  distM: number | null;
  curveDir: -1 | 0 | 1;
  curveClass: CurveClass;
  curveDistM: number;
  maneuverIdx: number | null;
  /** ROADS set this pose refers to; 0 = no map roads. */
  anchorId: number;
  /** Rider position relative to the anchor (dm, x east / y north) and heading (centidegrees from north). */
  poseX: number;
  poseY: number;
  headingCdeg: number;
  points: ShapePoint[];
  street: string;
}

/** A point of a surrounding street, meters relative to the anchor (x east, y north). */
export interface RoadPoint {
  x: number;
  y: number;
}

export interface RoadsMsg {
  anchorId: number;
  part: number;
  parts: number;
  roads: RoadPoint[][];
}

export interface TripMsg {
  speedKmh: number;
  limitKmh: number;
  etaEpoch: number;
  remainingM: number;
  phoneBatt: number | null;
  nowEpoch: number;
  tzOffsetMin: number;
}

export interface NotifMsg {
  kind: NotifKind;
  app: string;
  title: string;
  body: string;
}

export interface DevStatusMsg {
  battPct: number;
  battMv: number;
  charging: boolean;
  fwVer: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v)));

/** UTF-8 encode, truncated to maxBytes on a code-point boundary. */
export function utf8Truncate(s: string, maxBytes: number): Uint8Array {
  const out: number[] = [];
  for (const ch of s) {
    const bytes = utf8Encode(ch);
    if (out.length + bytes.length > maxBytes) break;
    out.push(...bytes);
  }
  return Uint8Array.from(out);
}

function utf8Encode(ch: string): number[] {
  const cp = ch.codePointAt(0)!;
  if (cp < 0x80) return [cp];
  if (cp < 0x800) return [0xc0 | (cp >> 6), 0x80 | (cp & 0x3f)];
  if (cp < 0x10000) return [0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)];
  return [0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)];
}

function utf8Decode(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; ) {
    const c = b[i];
    let cp: number;
    let n: number;
    if (c < 0x80) [cp, n] = [c, 1];
    else if (c < 0xe0) [cp, n] = [c & 0x1f, 2];
    else if (c < 0xf0) [cp, n] = [c & 0x0f, 3];
    else [cp, n] = [c & 0x07, 4];
    for (let k = 1; k < n; k++) cp = (cp << 6) | (b[i + k] & 0x3f);
    s += String.fromCodePoint(cp);
    i += n;
  }
  return s;
}

class Writer {
  private buf: number[] = [];
  u8(v: number) { this.buf.push(v & 0xff); }
  i8(v: number) { this.u8(v < 0 ? v + 256 : v); }
  u16(v: number) { this.u8(v); this.u8(v >> 8); }
  i16(v: number) { this.u16(v < 0 ? v + 65536 : v); }
  u32(v: number) { this.u16(v & 0xffff); this.u16(Math.floor(v / 65536)); }
  str(b: Uint8Array) { this.u8(b.length); this.buf.push(...b); }
  get length() { return this.buf.length; }
  bytes() { return Uint8Array.from(this.buf); }
}

class Reader {
  private off = 0;
  constructor(private b: Uint8Array) {}
  private need(n: number) { if (this.off + n > this.b.length) throw new Error('short payload'); }
  u8() { this.need(1); return this.b[this.off++]; }
  i8() { const v = this.u8(); return v > 127 ? v - 256 : v; }
  u16() { return this.u8() | (this.u8() << 8); }
  i16() { const v = this.u16(); return v > 32767 ? v - 65536 : v; }
  u32() { return this.u16() + this.u16() * 65536; }
  str() { const n = this.u8(); this.need(n); const s = this.b.subarray(this.off, this.off + n); this.off += n; return utf8Decode(s); }
}

function frame(type: MsgType, payload: Uint8Array): Uint8Array {
  if (payload.length > MAX_PAYLOAD) throw new Error(`payload too large: ${payload.length}`);
  const out = new Uint8Array(4 + payload.length);
  out[0] = PROTO_VER;
  out[1] = type;
  out[2] = payload.length & 0xff;
  out[3] = payload.length >> 8;
  out.set(payload, 4);
  return out;
}

export function encodeNav(m: NavMsg): Uint8Array {
  const pts = m.points.slice(0, MAX_POINTS);
  const w = new Writer();
  w.u8(m.maneuver);
  w.u8(clamp(m.exit, 0, 255));
  w.u16(m.distM == null ? 0xffff : clamp(m.distM, 0, 0xfffe));
  w.i8(m.curveDir);
  w.u8(m.curveClass);
  w.u16(clamp(m.curveDistM, 0, 0xffff));
  w.u8(m.maneuverIdx == null || m.maneuverIdx >= pts.length ? 0xff : m.maneuverIdx);
  w.u8(m.anchorId);
  w.i16(clamp(m.poseX, -32768, 32767));
  w.i16(clamp(m.poseY, -32768, 32767));
  w.u16(clamp(m.headingCdeg, 0, 35999));
  w.u8(pts.length);
  for (const p of pts) {
    w.i16(clamp(p.x, -32768, 32767));
    w.i16(clamp(p.y, -32768, 32767));
    w.u8(p.cls);
  }
  w.str(utf8Truncate(m.street, MAX_PAYLOAD - w.length - 1));
  return frame(MsgType.NAV, w.bytes());
}

export function encodeTrip(m: TripMsg): Uint8Array {
  const w = new Writer();
  w.u8(clamp(m.speedKmh, 0, 255));
  w.u8(clamp(m.limitKmh, 0, 255));
  w.u32(clamp(m.etaEpoch, 0, 0xffffffff));
  w.u32(clamp(m.remainingM, 0, 0xffffffff));
  w.u8(m.phoneBatt == null ? 0xff : clamp(m.phoneBatt, 0, 100));
  w.u32(clamp(m.nowEpoch, 0, 0xffffffff));
  w.i16(clamp(m.tzOffsetMin, -32768, 32767));
  return frame(MsgType.TRIP, w.bytes());
}

export function encodeNotif(m: NotifMsg): Uint8Array {
  const w = new Writer();
  w.u8(m.kind);
  w.str(utf8Truncate(m.app, 24));
  w.str(utf8Truncate(m.title, 48));
  w.str(utf8Truncate(m.body, MAX_PAYLOAD - w.length - 1));
  return frame(MsgType.NOTIF, w.bytes());
}

/**
 * Split a set of streets into ROADS frames (each ≤ MAX_PAYLOAD). Long streets are cut into pieces that share
 * their joining point so they still draw as one line. Coordinates are clamped to int16 meters.
 */
export function encodeRoads(anchorId: number, roads: RoadPoint[][]): Uint8Array[] {
  const pieces: RoadPoint[][] = [];
  for (const r of roads) {
    if (r.length < 2) continue;
    for (let i = 0; i < r.length - 1; i += MAX_ROAD_POINTS_PER_FRAME - 1) {
      pieces.push(r.slice(i, i + MAX_ROAD_POINTS_PER_FRAME));
    }
  }
  const groups: RoadPoint[][][] = [];
  let cur: RoadPoint[][] = [];
  let size = 4;
  for (const p of pieces) {
    const need = 1 + p.length * 4;
    if (size + need > MAX_PAYLOAD || cur.length === 255) {
      groups.push(cur);
      cur = [];
      size = 4;
    }
    cur.push(p);
    size += need;
  }
  groups.push(cur);
  return groups.map((g, part) => {
    const w = new Writer();
    w.u8(anchorId);
    w.u8(part);
    w.u8(groups.length);
    w.u8(g.length);
    for (const r of g) {
      w.u8(r.length);
      for (const pt of r) {
        w.i16(clamp(pt.x, -32768, 32767));
        w.i16(clamp(pt.y, -32768, 32767));
      }
    }
    return frame(MsgType.ROADS, w.bytes());
  });
}

export function encodeState(s: NavState): Uint8Array {
  return frame(MsgType.STATE, Uint8Array.of(s));
}

export function encodeDevStatus(m: DevStatusMsg): Uint8Array {
  const w = new Writer();
  w.u8(clamp(m.battPct, 0, 100));
  w.u16(clamp(m.battMv, 0, 0xffff));
  w.u8(m.charging ? 1 : 0);
  w.u8(m.fwVer);
  return frame(MsgType.DEV_STATUS, w.bytes());
}

export type Decoded =
  | { type: MsgType.NAV; msg: NavMsg }
  | { type: MsgType.TRIP; msg: TripMsg }
  | { type: MsgType.NOTIF; msg: NotifMsg }
  | { type: MsgType.STATE; msg: NavState }
  | { type: MsgType.ROADS; msg: RoadsMsg }
  | { type: MsgType.DEV_STATUS; msg: DevStatusMsg };

export function decode(f: Uint8Array): Decoded {
  if (f.length < 4 || f[0] !== PROTO_VER) throw new Error('bad header');
  const len = f[2] | (f[3] << 8);
  if (f.length !== 4 + len) throw new Error('length mismatch');
  const r = new Reader(f.subarray(4));
  switch (f[1]) {
    case MsgType.NAV: {
      const maneuver = r.u8();
      const exit = r.u8();
      const d = r.u16();
      const curveDir = r.i8() as -1 | 0 | 1;
      const curveClass = r.u8();
      const curveDistM = r.u16();
      const mi = r.u8();
      const anchorId = r.u8(), poseX = r.i16(), poseY = r.i16(), headingCdeg = r.u16();
      const n = r.u8();
      const points: ShapePoint[] = [];
      for (let i = 0; i < n; i++) points.push({ x: r.i16(), y: r.i16(), cls: r.u8() });
      const street = r.str();
      return {
        type: MsgType.NAV,
        msg: {
          maneuver, exit, distM: d === 0xffff ? null : d, curveDir, curveClass, curveDistM,
          maneuverIdx: mi === 0xff ? null : mi, anchorId, poseX, poseY, headingCdeg, points, street,
        },
      };
    }
    case MsgType.TRIP: {
      const speedKmh = r.u8(), limitKmh = r.u8(), etaEpoch = r.u32(), remainingM = r.u32();
      const pb = r.u8(), nowEpoch = r.u32(), tzOffsetMin = r.i16();
      return { type: MsgType.TRIP, msg: { speedKmh, limitKmh, etaEpoch, remainingM, phoneBatt: pb === 0xff ? null : pb, nowEpoch, tzOffsetMin } };
    }
    case MsgType.NOTIF: {
      const kind = r.u8(), app = r.str(), title = r.str(), body = r.str();
      return { type: MsgType.NOTIF, msg: { kind, app, title, body } };
    }
    case MsgType.STATE:
      return { type: MsgType.STATE, msg: r.u8() };
    case MsgType.ROADS: {
      const anchorId = r.u8(), part = r.u8(), parts = r.u8(), nr = r.u8();
      const roads: RoadPoint[][] = [];
      for (let i = 0; i < nr; i++) {
        const n = r.u8();
        const pts: RoadPoint[] = [];
        for (let k = 0; k < n; k++) pts.push({ x: r.i16(), y: r.i16() });
        roads.push(pts);
      }
      return { type: MsgType.ROADS, msg: { anchorId, part, parts, roads } };
    }
    case MsgType.DEV_STATUS: {
      const battPct = r.u8(), battMv = r.u16(), charging = r.u8() !== 0, fwVer = r.u8();
      return { type: MsgType.DEV_STATUS, msg: { battPct, battMv, charging, fwVer } };
    }
    default:
      throw new Error(`unknown type ${f[1]}`);
  }
}

/** Canonical key=value dump of a frame (raw wire values); must match firmware/test/proto_dump.c. */
export function dump(f: Uint8Array): string {
  const d = decode(f);
  const L: string[] = [];
  switch (d.type) {
    case MsgType.NAV: {
      const m = d.msg;
      L.push('type=NAV', `maneuver=${m.maneuver}`, `exit=${m.exit}`, `dist_m=${m.distM ?? 65535}`,
        `curve_dir=${m.curveDir}`, `curve_class=${m.curveClass}`, `curve_dist_m=${m.curveDistM}`,
        `maneuver_idx=${m.maneuverIdx ?? 255}`, `anchor_id=${m.anchorId}`, `pose=${m.poseX},${m.poseY},${m.headingCdeg}`,
        `n=${m.points.length}`);
      m.points.forEach((p, i) => L.push(`p${i}=${p.x},${p.y},${p.cls}`));
      L.push(`street=${m.street}`);
      break;
    }
    case MsgType.TRIP: {
      const m = d.msg;
      L.push('type=TRIP', `speed_kmh=${m.speedKmh}`, `limit_kmh=${m.limitKmh}`, `eta_epoch=${m.etaEpoch}`,
        `remaining_m=${m.remainingM}`, `phone_batt=${m.phoneBatt ?? 255}`, `now_epoch=${m.nowEpoch}`,
        `tz_offset_min=${m.tzOffsetMin}`);
      break;
    }
    case MsgType.NOTIF:
      L.push('type=NOTIF', `kind=${d.msg.kind}`, `app=${d.msg.app}`, `title=${d.msg.title}`, `body=${d.msg.body}`);
      break;
    case MsgType.STATE:
      L.push('type=STATE', `state=${d.msg}`);
      break;
    case MsgType.ROADS:
      L.push('type=ROADS', `anchor_id=${d.msg.anchorId}`, `part=${d.msg.part}/${d.msg.parts}`, `n=${d.msg.roads.length}`);
      d.msg.roads.forEach((rd, i) => L.push(`r${i}=${rd.map((p) => `${p.x},${p.y}`).join(' ')}`));
      break;
    case MsgType.DEV_STATUS:
      L.push('type=DEV_STATUS', `batt_pct=${d.msg.battPct}`, `batt_mv=${d.msg.battMv}`,
        `charging=${d.msg.charging ? 1 : 0}`, `fw_ver=${d.msg.fwVer}`);
      break;
  }
  return L.join('\n') + '\n';
}
