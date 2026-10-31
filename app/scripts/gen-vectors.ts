// Writes proto-vectors/<name>.bin + <name>.txt (canonical dump). Run: npm run gen:vectors
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CurveClass, Maneuver, MediaCmd, MediaState, NavState, NotifKind, Page, ShapePoint,
  dump, encodeDevStatus, encodeLayout, encodeMedia, encodeMediaCmd, encodeNav, encodeNotif, encodeRoads, encodeState, encodeTrip,
} from '../src/core/proto';

const out = join(__dirname, '..', '..', 'proto-vectors');
mkdirSync(out, { recursive: true });

const fullPoints: ShapePoint[] = Array.from({ length: 36 }, (_, i) => ({
  x: Math.round(300 * Math.sin(i / 6)) - 150 * (i % 3),
  y: i * 150 - 50,
  cls: (i % 4) as CurveClass,
}));

const vectors: Record<string, Uint8Array> = {
  nav_basic: encodeNav({
    maneuver: Maneuver.LEFT, exit: 0, distM: 230, curveDir: 1, curveClass: CurveClass.MEDIUM,
    curveDistM: 120, maneuverIdx: 3, anchorId: 0, poseX: 0, poseY: 0, headingCdeg: 0,
    points: [
      { x: 0, y: 0, cls: CurveClass.STRAIGHT },
      { x: 40, y: 800, cls: CurveClass.GENTLE },
      { x: 300, y: 1500, cls: CurveClass.MEDIUM },
      { x: 250, y: 2300, cls: CurveClass.STRAIGHT },
      { x: -900, y: 2350, cls: CurveClass.SHARP },
    ],
    street: 'MG Road',
  }),
  // 36 points leaves 240-17-180-1 = 42 bytes; street gets truncated on a code-point boundary.
  nav_full_utf8: encodeNav({
    maneuver: Maneuver.ROUNDABOUT, exit: 3, distM: 1450, curveDir: -1, curveClass: CurveClass.SHARP,
    curveDistM: 60, maneuverIdx: 35, anchorId: 7, poseX: -1234, poseY: 2950, headingCdeg: 27015, points: fullPoints,
    street: 'Straße am Hügel — कोलकाता बाईपास, Shakespeare Sarani',
  }),
  nav_unknown: encodeNav({
    maneuver: Maneuver.STRAIGHT, exit: 0, distM: null, curveDir: 0, curveClass: CurveClass.STRAIGHT,
    curveDistM: 0, maneuverIdx: null, anchorId: 0, poseX: 0, poseY: 0, headingCdeg: 0, points: [], street: '',
  }),
  trip_basic: encodeTrip({
    speedKmh: 62, limitKmh: 60, etaEpoch: 1793001234, remainingM: 48210, phoneBatt: 77,
    nowEpoch: 1792998000, tzOffsetMin: 330,
  }),
  trip_negative_tz: encodeTrip({
    speedKmh: 0, limitKmh: 0, etaEpoch: 0, remainingM: 0, phoneBatt: null,
    nowEpoch: 1792998000, tzOffsetMin: -420,
  }),
  notif_call: encodeNotif({ kind: NotifKind.CALL, app: 'Phone', title: 'Mom', body: 'Incoming call' }),
  state_rerouting: encodeState(NavState.REROUTING),
  media_playing: encodeMedia({ state: MediaState.PLAYING, volumePct: 60, title: 'Für Elise — Remastered', artist: 'Beethoven' }),
  media_none: encodeMedia({ state: MediaState.NONE, volumePct: null, title: '', artist: '' }),
  media_cmd_next: encodeMediaCmd(MediaCmd.NEXT),
  layout_default: encodeLayout({ pages: [Page.NAV, Page.ENGINE, Page.MEDIA, Page.STATUS, Page.SETTINGS] }),
  // Reordered with Engine and Settings switched off, and Nav not first.
  layout_custom: encodeLayout({ pages: [Page.STATUS, Page.NAV, Page.MEDIA] }),
  dev_status: encodeDevStatus({ battPct: 84, battMv: 4012, charging: true, fwVer: 1 }),
};

const longRoad = Array.from({ length: 70 }, (_, i) => ({ x: i * 10 - 350, y: Math.round(40 * Math.sin(i / 5)) }));
const roadFrames = encodeRoads(9, [
  [{ x: -300, y: 12 }, { x: 0, y: 0 }, { x: 310, y: -8 }],
  [{ x: 5, y: -400 }, { x: -20, y: 650 }],
  longRoad,
]);
roadFrames.forEach((f, i) => (vectors[`roads_part${i}`] = f));

for (const [name, bytes] of Object.entries(vectors)) {
  writeFileSync(join(out, `${name}.bin`), bytes);
  writeFileSync(join(out, `${name}.txt`), dump(bytes));
}
console.log(`wrote ${Object.keys(vectors).length} vectors to ${out}`);
