// Canvas port of firmware/components/ui/ui.c: same coordinates, colors, auto-zoom and arrow geometry.
// It only consumes decoded protocol messages, exactly like the device.
import { CurveClass, Maneuver, NavMsg, NavState, NotifKind, NotifMsg, RoadPoint, RoadsMsg, TripMsg } from '../src/core/proto';

const W = 240, CX = 120, RIDER_Y = 178, ROAD_TOP_Y = 18, ROAD_HALF_W = 100;
const NOTIF_SHOW_MS = 5000, CURVE_WARN_MAX_M = 400;
const C_TEXT = '#FFFFFF', C_DIM = '#8A8F98', C_ACCENT = '#00D1FF';
const CURVE_COLORS = ['#C8CCD2', '#FFD400', '#FF8A00', '#FF2D2D'];
const CURVE_NAMES = ['', 'GENTLE', 'MEDIUM', 'SHARP'];
const MAP_BG = '#11151A';
const VIEW_MAX_M = 300;
const FONT = (px: number) => `500 ${px}px Montserrat, "Helvetica Neue", Arial, sans-serif`;

export interface DeviceState {
  connected: boolean;
  navState: NavState;
  nav: NavMsg | null;
  trip: TripMsg | null;
  notif: NotifMsg | null;
  notifAt: number;
  deviceBattPct: number;
}

export function newDeviceState(): DeviceState {
  return { connected: true, navState: NavState.IDLE, nav: null, trip: null, notif: null, notifAt: 0, deviceBattPct: 87 };
}

export class DisplayRenderer {
  private scale = 0.3;
  private lastNav: NavMsg | null = null;
  /** 0 = Nav, 1 = Trip, 2 = Status; fractional while swiping. */
  tile = 0;

  // Street sets assembled from ROADS frames, like road_set_t in ui.c.
  private shown: { anchorId: number; roads: RoadPoint[][] } = { anchorId: 0, roads: [] };
  private pending: { anchorId: number; parts: number; got: Set<number>; roads: RoadPoint[][] } =
    { anchorId: 0, parts: 0, got: new Set(), roads: [] };

  constructor(private ctx: CanvasRenderingContext2D) {}

  /** Collect one ROADS frame; a complete set replaces the shown one (port of apply_roads in ui.c). */
  onRoads(m: RoadsMsg) {
    const p = this.pending;
    if (p.anchorId !== m.anchorId || p.parts !== m.parts) {
      this.pending = { anchorId: m.anchorId, parts: m.parts, got: new Set(), roads: [] };
    }
    if (this.pending.got.has(m.part)) return;
    this.pending.got.add(m.part);
    this.pending.roads.push(...m.roads);
    if (this.pending.got.size === m.parts) {
      this.shown = { anchorId: m.anchorId, roads: this.pending.roads };
      this.pending = { anchorId: 0, parts: 0, got: new Set(), roads: [] };
    }
  }

  /** Called once per received NAV frame (zoom smoothing is per frame, as on the device). */
  onNav(m: NavMsg) {
    let maxY = 60, maxX = 30;
    for (const p of m.points) {
      maxY = Math.max(maxY, p.y / 10);
      maxX = Math.max(maxX, Math.abs(p.x / 10));
    }
    // Cap the view at ~300 m ahead: close bends stay big, the far road runs off the edge like a map.
    const target = Math.min((RIDER_Y - ROAD_TOP_Y) / Math.min(maxY, VIEW_MAX_M), ROAD_HALF_W / Math.min(maxX, VIEW_MAX_M / 2));
    this.scale = this.scale * 0.6 + target * 0.4;
    this.lastNav = m;
  }

  draw(st: DeviceState, nowMs: number, deviceClockS: number, tzMin: number) {
    const c = this.ctx;
    c.save();
    c.clearRect(0, 0, W, W);
    c.beginPath();
    c.arc(CX, CX, CX, 0, Math.PI * 2);
    c.clip();
    c.fillStyle = MAP_BG;
    c.fillRect(0, 0, W, W);

    for (let t = 0; t < 3; t++) {
      const x = (t - this.tile) * W;
      if (x <= -W || x >= W) continue;
      c.save();
      c.translate(x, 0);
      if (t === 0) this.drawNav(st);
      else if (t === 1) this.drawTrip(st, deviceClockS, tzMin);
      else this.drawStatus(st);
      c.restore();
    }

    this.drawBanner(st);
    if (st.notif && nowMs - st.notifAt < NOTIF_SHOW_MS) this.drawNotif(st.notif);
    c.restore();
  }

  // ---------- text helpers ----------
  private text(s: string, x: number, y: number, px: number, color: string, align: CanvasTextAlign = 'center') {
    const c = this.ctx;
    c.font = FONT(px);
    c.fillStyle = color;
    c.textAlign = align;
    c.textBaseline = 'middle';
    c.fillText(s, x, y);
  }

  private ellipsize(s: string, px: number, maxW: number) {
    const c = this.ctx;
    c.font = FONT(px);
    if (c.measureText(s).width <= maxW) return s;
    let t = s;
    while (t.length > 0 && c.measureText(t + '...').width > maxW) t = t.slice(0, -1);
    return t + '...';
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number, fill: string) {
    const c = this.ctx;
    c.beginPath();
    c.roundRect(x, y, w, h, r);
    c.fillStyle = fill;
    c.fill();
  }

  // ---------- Nav tile ----------
  private drawNav(st: DeviceState) {
    const c = this.ctx;
    const m = this.lastNav;
    const s = this.scale;
    this.drawMap(m, s);

    // Distance box with arrow
    this.roundRect(32, 14, 176, 64, 20, 'rgba(0,0,0,0.7)');
    this.drawArrow(m?.maneuver ?? Maneuver.STRAIGHT, m?.exit ?? 0, 40, 18);
    // Number large, unit small so "1.4 km" fits beside the arrow inside the round edge (mirrors ui.c).
    const [num, unit] = m == null || m.distM == null ? ['--', ''] : fmtDistance(m.distM).split(' ');
    this.text(num, 100, 48, 40, C_TEXT, 'left');
    if (unit) {
      this.ctx.font = FONT(40);
      this.text(unit, 104 + this.ctx.measureText(num).width, 56, 20, C_TEXT, 'left');
    }

    // Curve warning chip
    if (m && m.curveClass >= CurveClass.MEDIUM && m.curveDistM <= CURVE_WARN_MAX_M) {
      const dir = m.curveDir < 0 ? 'LEFT' : 'RIGHT';
      const label = m.curveDistM < 10
        ? `${CURVE_NAMES[m.curveClass]} ${dir}`
        : `${CURVE_NAMES[m.curveClass]} ${dir}  ${Math.floor(m.curveDistM / 10) * 10} m`;
      c.font = FONT(14);
      const w = c.measureText(label).width + 16;
      this.roundRect(CX - w / 2, 84, w, 22, 8, CURVE_COLORS[m.curveClass]);
      this.text(label, CX, 95, 14, '#000');
    }

    // Speed + limit + street
    const trip = st.trip;
    if (trip) {
      const over = trip.limitKmh > 0 && trip.speedKmh > trip.limitKmh + 5;
      this.text(String(trip.speedKmh), 22, 154, 28, over ? '#FF2D2D' : C_TEXT, 'left');
      this.text('km/h', 22, 176, 14, C_DIM, 'left');
      if (trip.limitKmh > 0) {
        c.beginPath();
        c.arc(198, 158, 22, 0, Math.PI * 2);
        c.fillStyle = '#E00000';
        c.fill();
        c.beginPath();
        c.arc(198, 158, 17, 0, Math.PI * 2);
        c.fillStyle = '#FFFFFF';
        c.fill();
        this.text(String(trip.limitKmh), 198, 159, 20, '#000');
      }
    }
    if (m?.street) this.text(this.ellipsize(m.street, 14, 150), CX, 210, 14, C_TEXT);
  }


  // ---------- road styles ----------
  private toPx(m: NavMsg, i: number, s: number): [number, number] {
    return [CX + (m.points[i].x / 10) * s, RIDER_Y - (m.points[i].y / 10) * s];
  }

  private polyline(pts: [number, number][], width: number, color: string, dash: number[] = []) {
    const c = this.ctx;
    if (pts.length < 2) return;
    c.strokeStyle = color;
    c.lineWidth = width;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.setLineDash(dash);
    c.beginPath();
    pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
    c.stroke();
    c.setLineDash([]);
  }

  /** Runs of MEDIUM/SHARP points with their turn direction (+1 right, -1 left), computable on the device. */
  private curveRuns(m: NavMsg): { start: number; end: number; cls: number; dir: number }[] {
    const runs: { start: number; end: number; cls: number; dir: number }[] = [];
    for (let i = 1; i < m.points.length; i++) {
      if (m.points[i].cls < CurveClass.MEDIUM) continue;
      const last = runs[runs.length - 1];
      if (last && last.end === i - 1) {
        last.end = i;
        last.cls = Math.max(last.cls, m.points[i].cls);
      } else runs.push({ start: i, end: i, cls: m.points[i].cls, dir: 0 });
    }
    for (const r of runs) {
      let sum = 0;
      for (let i = Math.max(1, r.start - 1); i <= Math.min(m.points.length - 2, r.end); i++) {
        const a = m.points[i - 1], b = m.points[i], c = m.points[i + 1];
        sum += (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x); // >0 = left in x-right/y-up frame
      }
      r.dir = sum > 0 ? -1 : 1;
    }
    return runs;
  }

  /** Port of map_draw_cb in ui.c: streets (anchor frame → rider frame), blue route, curve badges, puck. */
  private drawMap(m: NavMsg | null, s: number) {
    const c = this.ctx;
    if (m && m.anchorId && this.shown.anchorId === m.anchorId) {
      const h = (m.headingCdeg / 100) * (Math.PI / 180);
      const ch = Math.cos(h), sh = Math.sin(h);
      const px = m.poseX / 10, py = m.poseY / 10;
      const streets = this.shown.roads.map((road) => road.map((p) => {
        const e = p.x - px, n = p.y - py;
        return [CX + (e * ch - n * sh) * s, RIDER_Y - (e * sh + n * ch) * s] as [number, number];
      }));
      for (const pts of streets) this.polyline(pts, 9, '#232A33');
      for (const pts of streets) this.polyline(pts, 6, '#3E4754');
    }
    if (m && m.points.length > 1) {
      const pts = m.points.map((_, i) => this.toPx(m, i, s));
      this.polyline(pts, 16, '#0B2A5C');
      this.polyline(pts, 11, '#3D8BFF');
      if (m.maneuverIdx != null && pts[m.maneuverIdx]) {
        const [x, y] = pts[m.maneuverIdx];
        c.beginPath();
        c.arc(x, y, 7, 0, Math.PI * 2);
        c.fillStyle = '#FFFFFF';
        c.fill();
        c.beginPath();
        c.arc(x, y, 3, 0, Math.PI * 2);
        c.fillStyle = '#3D8BFF';
        c.fill();
      }
      for (const r of this.curveRuns(m).slice(0, 3)) {
        const [x, y] = pts[r.start];
        const [nx, ny] = pts[Math.min(pts.length - 1, r.start + 1)];
        const tx = nx - x, ty = ny - y, tl = Math.hypot(tx, ty) || 1;
        // Badge sits beside the road on the outside of the bend.
        const bx = x + (-ty / tl) * -r.dir * 17, by = y + (tx / tl) * -r.dir * 17;
        c.beginPath();
        c.arc(bx, by, 11, 0, Math.PI * 2);
        c.fillStyle = MAP_BG;
        c.fill();
        c.beginPath();
        c.arc(bx, by, 9, 0, Math.PI * 2);
        c.fillStyle = CURVE_COLORS[r.cls];
        c.fill();
        this.chevron(bx, by, r.dir, 0, -1, '#000', 4.5, 3);
      }
    }
    // Navigation puck
    c.beginPath();
    c.moveTo(CX, RIDER_Y - 12);
    c.lineTo(CX + 9, RIDER_Y + 9);
    c.lineTo(CX, RIDER_Y + 4);
    c.lineTo(CX - 9, RIDER_Y + 9);
    c.closePath();
    c.fillStyle = '#FFFFFF';
    c.fill();
    c.lineWidth = 3;
    c.lineJoin = 'round';
    c.strokeStyle = '#3D8BFF';
    c.stroke();
  }

  /** Chevron pointing toward the turn: dir -1 = left, +1 = right, relative to travel direction (ux, uy). */
  private chevron(x: number, y: number, dir: number, ux: number, uy: number, color: string, size: number, width: number) {
    if (ux === 0 && uy === 0) [ux, uy] = [0, -1];
    const nx = -uy * dir, ny = ux * dir; // unit vector toward the turn side
    this.polyline([
      [x - nx * size + ux * size, y - ny * size + uy * size],
      [x + nx * size, y + ny * size],
      [x - nx * size - ux * size, y - ny * size - uy * size],
    ], width, color);
  }

  /** Port of draw_arrow() in ui.c (56×56 box at ox, oy). */
  private drawArrow(man: Maneuver, exit: number, ox: number, oy: number) {
    const c = this.ctx;
    const p: [number, number][] = [];
    if (man === Maneuver.UTURN_LEFT || man === Maneuver.UTURN_RIGHT) {
      const d = man === Maneuver.UTURN_LEFT ? -1 : 1;
      const x0 = 28 - d * 10, x1 = 28 + d * 10;
      p.push([x0, 54], [x0, 14], [x1, 14], [x1, 40], [x1 - 9, 31], [x1, 40], [x1 + 9, 31]);
    } else if (man === Maneuver.ARRIVE) {
      p.push([16, 54], [16, 6], [44, 14], [16, 24]);
    } else if (man === Maneuver.ROUNDABOUT) {
      for (let i = 0; i <= 8; i++) p.push([28 + Math.cos((i * Math.PI) / 4) * 20, 28 + Math.sin((i * Math.PI) / 4) * 20]);
    } else {
      const a = ({
        [Maneuver.SLIGHT_LEFT]: -40, [Maneuver.LEFT]: -90, [Maneuver.SHARP_LEFT]: -135,
        [Maneuver.SLIGHT_RIGHT]: 40, [Maneuver.RIGHT]: 90, [Maneuver.SHARP_RIGHT]: 135,
        [Maneuver.KEEP_LEFT]: -25, [Maneuver.KEEP_RIGHT]: 25,
      } as Partial<Record<Maneuver, number>>)[man] ?? 0;
      const r = (a * Math.PI) / 180;
      const bx = 28, by = a === 0 ? 6 : 30;
      let tx = bx + Math.sin(r) * 22, ty = by - Math.cos(r) * 22;
      if (a === 0) [tx, ty] = [bx, 6];
      const hl = 11;
      p.push([28, 54], [bx, by], [tx, ty],
        [tx - Math.sin(r - 0.7) * hl, ty + Math.cos(r - 0.7) * hl], [tx, ty],
        [tx - Math.sin(r + 0.7) * hl, ty + Math.cos(r + 0.7) * hl]);
    }
    c.strokeStyle = C_TEXT;
    c.lineWidth = 7;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.beginPath();
    p.forEach(([x, y], i) => (i ? c.lineTo(ox + x, oy + y) : c.moveTo(ox + x, oy + y)));
    c.stroke();
    if (man === Maneuver.ROUNDABOUT && exit) this.text(String(exit), ox + 28, oy + 29, 20, C_ACCENT);
  }

  // ---------- Trip / Status tiles ----------
  private drawTrip(st: DeviceState, clockS: number, tzMin: number) {
    this.text(clockS > 1_700_000_000 ? fmtClock(clockS, tzMin) : '--:--', CX, 63, 40, C_TEXT);
    this.text('ARRIVAL', CX, 102, 14, C_DIM);
    const t = st.trip;
    this.text(t && t.etaEpoch ? fmtClock(t.etaEpoch, tzMin) : '--:--', CX, 128, 28, C_ACCENT);
    if (t) {
      this.text(`${fmtDistance(t.remainingM)} to go`, CX, 164, 20, C_TEXT);
      this.text(`${t.speedKmh} km/h`, CX, 198, 14, C_DIM);
    }
  }

  private drawStatus(st: DeviceState) {
    this.text(st.connected ? 'Phone connected' : 'Waiting for phone', CX, 58, 20, C_TEXT);
    this.text(`Device  ${st.deviceBattPct}%`, CX, 130, 20, C_TEXT);
    const pb = st.trip?.phoneBatt;
    this.text(`Phone  ${pb != null ? pb + '%' : '--'}`, CX, 160, 20, C_TEXT);
    this.text('Simulator', CX, 203, 14, C_DIM);
  }

  // ---------- overlays ----------
  private drawBanner(st: DeviceState) {
    let txt: string | null = null, color = '#3A3F47';
    if (!st.connected) txt = 'No phone';
    else if (st.navState === NavState.REROUTING) [txt, color] = ['Rerouting...', '#D97706'];
    else if (st.navState === NavState.GPS_LOST) [txt, color] = ['GPS lost', '#B91C1C'];
    else if (st.navState === NavState.ARRIVED) [txt, color] = ['Arrived', '#15803D'];
    else if (st.navState === NavState.IDLE) txt = 'Pick a destination';
    if (!txt) return;
    this.ctx.globalAlpha = 0.9;
    this.roundRect(30, 104, 180, 44, 22, color);
    this.ctx.globalAlpha = 1;
    this.text(txt, CX, 127, 20, C_TEXT);
  }

  private drawNotif(n: NotifMsg) {
    const c = this.ctx;
    c.beginPath();
    c.arc(CX, CX, CX, 0, Math.PI * 2);
    c.fillStyle = n.kind === NotifKind.CALL ? '#14532D' : '#0B2A4A';
    c.fill();
    this.text(n.app, CX, 48, 14, C_DIM);
    this.text(this.ellipsize(n.title, 28, 190), CX, 83, 28, C_TEXT);
    // Body: wrap into up to 3 lines of 180 px.
    c.font = FONT(20);
    const words = n.body.split(' ');
    const lines: string[] = [];
    let line = '';
    for (const w of words) {
      const t = line ? line + ' ' + w : w;
      if (c.measureText(t).width > 180 && line) {
        lines.push(line);
        line = w;
      } else line = t;
    }
    if (line) lines.push(line);
    lines.slice(0, 3).forEach((l, i) => this.text(l, CX, 122 + i * 24, 20, C_TEXT));
  }
}

export function fmtDistance(m: number): string {
  if (m >= 10000) return `${Math.floor(m / 1000)} km`;
  if (m >= 1000) return `${Math.floor(m / 1000)}.${Math.floor((m % 1000) / 100)} km`;
  if (m >= 100) return `${Math.floor(m / 10) * 10} m`;
  return `${Math.round(m)} m`;
}

function fmtClock(utcS: number, tzMin: number): string {
  const d = new Date((utcS + tzMin * 60) * 1000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
