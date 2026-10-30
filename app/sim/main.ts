// Browser simulator: real OpenBee phone pipeline (NavSession → protocol frames) feeding a canvas port of the device UI.
import { destination, toLocal } from '../src/core/geo';
import {
  CurveClass, Maneuver, MediaCmd, MediaMsg, MediaState, MsgType, NavState, NotifKind, decode, encodeMedia, encodeMediaCmd,
} from '../src/core/proto';
import { Route, bearingAt, pointAt } from '../src/core/route';
import { NavSession } from '../src/core/session';
import { curveClassAt } from '../src/core/shape';
import {
  BRIGHT_BTN_CY, BRIGHT_BTN_DX, BRIGHT_BTN_R, DisplayRenderer, TILE_MEDIA, TILE_NAV, TILE_SETTINGS, brightnessStep, fmtDistance,
  newDeviceState,
  simEngine,
} from './display';
import { DEMO_ROUTES } from './routes';

const TICK_MS = 50;
const FIX_INTERVAL_MS = 500;
const CURVE_SPEED = [1, 0.85, 0.62, 0.42];
const DETOUR_MS = 11000;
const DETOUR_M = 130;
const GPS_LOSS_MS = 12000;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const tz = -new Date().getTimezoneOffset();
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- simulation state ----------
let demo = DEMO_ROUTES[0];
let route: Route = demo.route;
let d = 0;
let v = 0;
let simNow = Date.now();
let playing = true;
let timeScale = 1;
let lastFixAt = -Infinity;
let lastTickAt = -Infinity;
let detourStart: number | null = null;
let gpsLostUntil = -Infinity;
let riderPos = pointAt(route, 0);

// ---------- device side ----------
const dev = newDeviceState();
const canvases = [$<HTMLCanvasElement>('display')];
const renderers = [new DisplayRenderer(canvases[0].getContext('2d')!)];
let tile = 0;
let tileTarget = 0;
const stats = { counts: new Map<number, number>(), window: [] as { t: number; n: number }[], lastNav: new Uint8Array() as Uint8Array };

function onFrame(f: Uint8Array) {
  const now = performance.now();
  stats.counts.set(f[1], (stats.counts.get(f[1]) ?? 0) + 1);
  stats.window.push({ t: now, n: f.length });
  const m = decode(f);
  switch (m.type) {
    case MsgType.NAV:
      dev.nav = m.msg;
      stats.lastNav = f;
      renderers.forEach((r) => r.onNav(m.msg));
      break;
    case MsgType.TRIP:
      dev.trip = m.msg;
      dev.engine = simEngine(m.msg.speedKmh, Math.floor(Date.now() / 1000));
      break;
    case MsgType.ROADS:
      renderers.forEach((r) => r.onRoads(m.msg));
      break;
    case MsgType.STATE:
      dev.navState = m.msg;
      break;
    case MsgType.NOTIF:
      dev.notif = m.msg;
      dev.notifAt = now;
      break;
    case MsgType.MEDIA:
      dev.media = m.msg;
      break;
  }
}

// ---------- fake media player (stands in for the phone's MediaRelay) ----------
const TRACKS: [string, string][] = [
  ['Bohemian Rhapsody', 'Queen'], ['Hotel California', 'Eagles'], ['Stairway to Heaven', 'Led Zeppelin'],
];
const CMD_NAME = ['TOGGLE', 'NEXT', 'PREV', 'VOL_UP', 'VOL_DOWN'];
let track = 0;
const player: MediaMsg = { state: MediaState.PLAYING, volumePct: 60, title: TRACKS[0][0], artist: TRACKS[0][1] };
const cmdLog: string[] = [];

/** A device button press: MEDIA_CMD goes through the real codec, the fake player reacts and answers with MEDIA. */
function onMediaCmd(cmd: MediaCmd) {
  const f = encodeMediaCmd(cmd);
  const m = decode(f);
  if (m.type !== MsgType.MEDIA_CMD) return;
  stats.counts.set(f[1], (stats.counts.get(f[1]) ?? 0) + 1);
  cmdLog.push(CMD_NAME[m.msg.cmd] ?? `cmd ${m.msg.cmd}`);
  if (cmdLog.length > 4) cmdLog.shift();
  const vol = player.volumePct ?? 0;
  switch (m.msg.cmd) {
    case MediaCmd.TOGGLE:
      player.state = player.state === MediaState.PLAYING ? MediaState.PAUSED : MediaState.PLAYING;
      break;
    case MediaCmd.NEXT:
    case MediaCmd.PREV:
      track = (track + (m.msg.cmd === MediaCmd.NEXT ? 1 : TRACKS.length - 1)) % TRACKS.length;
      [player.title, player.artist] = TRACKS[track];
      break;
    case MediaCmd.VOL_UP:
      player.volumePct = Math.min(100, vol + 10);
      break;
    case MediaCmd.VOL_DOWN:
      player.volumePct = Math.max(0, vol - 10);
      break;
  }
  onFrame(encodeMedia(player));
}

const session = new NavSession({
  send: onFrame,
  // Demo routes are synthetic, so a "reroute" leads back onto the same road after a short network delay.
  fetchRoute: () => new Promise((res) => setTimeout(() => res(route), 700)),
  // Mock of the OpenStreetMap corridor fetch: the demo roads come with generated side streets.
  // The demo routes ship generated side streets, so no network and no tile decoding here.
  fetchStreets: async () => demo.sideRoads,
  phoneBatteryPct: () => 64,
  tzOffsetMin: () => tz,
});

function startRoute(i: number) {
  demo = DEMO_ROUTES[i];
  route = demo.route;
  d = 0;
  v = (demo.baseKmh / 3.6) * 0.5;
  simNow = Date.now();
  lastFixAt = lastTickAt = -Infinity;
  detourStart = null;
  gpsLostUntil = -Infinity;
  riderPos = pointAt(route, 0);
  session.start(route, route.points[route.points.length - 1]);
  session.onDeviceConnected();
  playing = true;
  syncControls();
  drawOverview();
}

function step() {
  if (!playing) return;
  const dt = (TICK_MS * timeScale) / 1000;
  simNow += TICK_MS * timeScale;

  // Ride like a rider: slow for what's coming, accelerate on straights.
  const ahead = curveClassAt(route, Math.min(route.lengthM, d + 40)).cls as CurveClass;
  const here = curveClassAt(route, d).cls as CurveClass;
  const target = (demo.baseKmh / 3.6) * CURVE_SPEED[Math.max(ahead, here)];
  v += (target - v) * Math.min(1, dt / 2.5);
  d = Math.min(route.lengthM, d + v * dt);

  let p = pointAt(route, d);
  if (detourStart != null) {
    const t = (simNow - detourStart) / DETOUR_MS;
    if (t >= 1) detourStart = null;
    else p = destination(p, bearingAt(route, d) + 90, DETOUR_M * Math.min(1, t * 4, (1 - t) * 4));
  }
  riderPos = p;

  if (simNow - lastFixAt >= FIX_INTERVAL_MS && simNow > gpsLostUntil) {
    lastFixAt = simNow;
    session.onFix({ lat: p.lat, lon: p.lon, speedMps: v, accuracyM: 5, timeMs: simNow });
  }
  if (simNow - lastTickAt >= 1000) {
    lastTickAt = simNow;
    session.tick(simNow);
  }
  if (d >= route.lengthM && session.getView().state === NavState.ARRIVED) {
    playing = false;
    syncControls();
  }
}

// ---------- rendering ----------
function sizeCanvas() {
  for (const canvas of canvases) {
    const css = canvas.getBoundingClientRect().width || 300;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(css * dpr);
    canvas.height = Math.round(css * dpr);
    canvas.getContext('2d')!.setTransform((css * dpr) / 240, 0, 0, (css * dpr) / 240, 0, 0);
  }
}

function frame() {
  if (!dragging) {
    const diff = tileTarget - tile;
    tile = reducedMotion || Math.abs(diff) < 0.002 ? tileTarget : tile + diff * 0.22;
  }
  for (const r of renderers) {
    r.tile = tile;
    r.draw(dev, performance.now(), dev.trip ? Math.floor(simNow / 1000) : 0, tz);
  }
  drawOverview();
  requestAnimationFrame(frame);
}

const overview = $<HTMLCanvasElement>('overview');
function drawOverview() {
  const c = overview.getContext('2d')!;
  const css = overview.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  if (overview.width !== Math.round(css.width * dpr)) {
    overview.width = Math.round(css.width * dpr);
    overview.height = Math.round(css.height * dpr);
  }
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = css.width, H = css.height, pad = 18;
  const cs = getComputedStyle(document.documentElement);
  const col = (n: string) => cs.getPropertyValue(n).trim();
  c.clearRect(0, 0, W, H);

  const o = route.points[0];
  const pts = route.points.map((p) => toLocal(o, p));
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const s = Math.min((W - pad * 2) / (maxX - minX || 1), (H - pad * 2) / (maxY - minY || 1));
  const ox = (W - (maxX - minX) * s) / 2, oy = (H - (maxY - minY) * s) / 2;
  const X = (x: number) => ox + (x - minX) * s;
  const Y = (y: number) => H - (oy + (y - minY) * s);

  c.lineCap = c.lineJoin = 'round';
  c.lineWidth = 5;
  c.strokeStyle = col('--line-strong');
  c.beginPath();
  pts.forEach((p, i) => (i ? c.lineTo(X(p.x), Y(p.y)) : c.moveTo(X(p.x), Y(p.y))));
  c.stroke();

  const prog = session.getView().snapshot?.progressM ?? 0;
  c.strokeStyle = col('--accent');
  c.beginPath();
  let started = false;
  for (let i = 0; i < pts.length && route.cum[i] <= prog; i++) {
    if (started) c.lineTo(X(pts[i].x), Y(pts[i].y));
    else { c.moveTo(X(pts[i].x), Y(pts[i].y)); started = true; }
  }
  c.stroke();

  for (const ins of route.instructions) {
    if (ins.maneuver === Maneuver.DEPART) continue;
    const p = toLocal(o, pointAt(route, ins.atM));
    c.beginPath();
    c.arc(X(p.x), Y(p.y), 4, 0, Math.PI * 2);
    c.fillStyle = col('--fg');
    c.fill();
  }
  const r = toLocal(o, riderPos);
  c.beginPath();
  c.arc(X(r.x), Y(r.y), 7, 0, Math.PI * 2);
  c.fillStyle = col('--surface');
  c.fill();
  c.lineWidth = 3;
  c.strokeStyle = col('--accent');
  c.stroke();
}

// ---------- readouts ----------
const MAN_TEXT: Record<number, string> = {
  [Maneuver.STRAIGHT]: 'Continue', [Maneuver.SLIGHT_LEFT]: 'Slight left', [Maneuver.LEFT]: 'Turn left',
  [Maneuver.SHARP_LEFT]: 'Sharp left', [Maneuver.SLIGHT_RIGHT]: 'Slight right', [Maneuver.RIGHT]: 'Turn right',
  [Maneuver.SHARP_RIGHT]: 'Sharp right', [Maneuver.UTURN_LEFT]: 'U-turn', [Maneuver.UTURN_RIGHT]: 'U-turn',
  [Maneuver.KEEP_LEFT]: 'Keep left', [Maneuver.KEEP_RIGHT]: 'Keep right', [Maneuver.ROUNDABOUT]: 'Roundabout',
  [Maneuver.ARRIVE]: 'Arrive', [Maneuver.DEPART]: 'Depart',
};
const STATE_TEXT = ['Idle', 'Navigating', 'Rerouting', 'Arrived', 'GPS lost'];
const TYPE_NAME: Record<number, string> = { 1: 'NAV', 2: 'TRIP', 3: 'NOTIF', 4: 'STATE', 5: 'ROADS', 6: 'MEDIA', 0x82: 'MEDIA_CMD' };

function readouts() {
  const view = session.getView();
  const s = view.snapshot;
  $('st-state').textContent = STATE_TEXT[view.state];
  $('st-state').dataset.state = String(view.state);
  $('st-next').textContent = s ? `${MAN_TEXT[s.nav.maneuver] ?? ''}${s.nav.street ? ' onto ' + s.nav.street : ''}` : '—';
  $('st-dist').textContent = s?.nav.distM != null ? fmtDistance(s.nav.distM) : '—';
  $('st-speed').textContent = s ? `${s.speedKmh} km/h` : '—';
  $('st-offset').textContent = s ? `${Math.round(s.offsetM)} m` : '—';
  $('st-left').textContent = s ? fmtDistance(s.remainingM) : '—';
  $('st-progress').style.width = `${(100 * d) / route.lengthM}%`;

  const now = performance.now();
  stats.window = stats.window.filter((w) => now - w.t < 1000);
  const bps = stats.window.reduce((a, w) => a + w.n, 0);
  $('bt-rate').textContent = `${bps} B/s`;
  $('bt-counts').textContent = [1, 5, 2, 4, 3, 6].map((t) => `${TYPE_NAME[t]} ${stats.counts.get(t) ?? 0}`).join('  ·  ');
  $('bt-cmds').textContent = cmdLog.length ? `${TYPE_NAME[0x82]} ${stats.counts.get(0x82)}: ${cmdLog.join(', ')}` : '—';
  const f = stats.lastNav;
  $('bt-size').textContent = f.length ? `${f.length} B (${dev.nav?.points.length ?? 0} road points)` : '—';
  $('bt-hex').textContent = f.length
    ? Array.from(f.subarray(0, 32), (b) => b.toString(16).padStart(2, '0')).join(' ') + (f.length > 32 ? ' …' : '')
    : '—';
}

// ---------- controls ----------
function syncControls() {
  document.querySelectorAll<HTMLButtonElement>('[data-route]').forEach((b) =>
    b.setAttribute('aria-pressed', String(DEMO_ROUTES[Number(b.dataset.route)] === demo)));
  $('play').textContent = playing ? 'Pause' : d >= route.lengthM ? 'Ride again' : 'Resume';
  document.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach((b) =>
    b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === timeScale)));
  document.querySelectorAll<HTMLButtonElement>('[data-tile]').forEach((b) =>
    b.setAttribute('aria-pressed', String(Number(b.dataset.tile) === tileTarget)));
}

const routeList = $('routes');
DEMO_ROUTES.forEach((r, i) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'route';
  b.dataset.route = String(i);
  b.innerHTML = `<span class="route-name"></span><span class="route-meta"></span>`;
  b.querySelector('.route-name')!.textContent = r.name;
  b.querySelector('.route-meta')!.textContent = `${fmtDistance(r.route.lengthM)} · ${r.blurb}`;
  b.addEventListener('click', () => startRoute(i));
  routeList.appendChild(b);
});

$('play').addEventListener('click', () => {
  if (!playing && d >= route.lengthM) startRoute(DEMO_ROUTES.indexOf(demo));
  else playing = !playing;
  syncControls();
});
document.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach((b) =>
  b.addEventListener('click', () => { timeScale = Number(b.dataset.speed); syncControls(); }));
document.querySelectorAll<HTMLButtonElement>('[data-tile]').forEach((b) =>
  b.addEventListener('click', () => { tileTarget = Number(b.dataset.tile); syncControls(); }));

$('ev-detour').addEventListener('click', () => { if (session.active) detourStart = simNow; });
$('ev-gps').addEventListener('click', () => { gpsLostUntil = simNow + GPS_LOSS_MS; });
$('ev-call').addEventListener('click', () =>
  session.notify({ kind: NotifKind.CALL, app: 'Phone', title: 'Riya', body: 'Incoming call' }));
$('ev-msg').addEventListener('click', () =>
  session.notify({ kind: NotifKind.MESSAGE, app: 'WhatsApp', title: 'Arjun', body: 'Reached the viewpoint, waiting near the tea stall' }));

/** Pointer position in device px (0–240). */
function devicePx(canvas: HTMLCanvasElement, e: PointerEvent): [number, number] {
  const box = canvas.getBoundingClientRect();
  return [((e.clientX - box.left) / box.width) * 240, ((e.clientY - box.top) / box.height) * 240];
}
const mediaHitAt = (canvas: HTMLCanvasElement, e: PointerEvent) =>
  tileTarget === TILE_MEDIA && Math.abs(tile0 - TILE_MEDIA) < 0.01 ? renderers[0].mediaHit(...devicePx(canvas, e)) : null;
const setMediaPressed = (cmd: MediaCmd | null) => renderers.forEach((r) => (r.mediaPressed = cmd));

// Swipe between views like the touchscreen (drag), tap Trip/Status to go back to Nav.
let dragging = false;
let dragX0 = 0, tile0 = 0, moved = false, dragW = 300;
for (const canvas of canvases) {
  canvas.addEventListener('pointerdown', (e) => {
    dragging = true;
    moved = false;
    dragX0 = e.clientX;
    dragW = canvas.getBoundingClientRect().width;
    tile0 = tile;
    setMediaPressed(mediaHitAt(canvas, e));
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = (e.clientX - dragX0) / dragW;
    if (Math.abs(dx) > 0.03) {
      moved = true;
      setMediaPressed(null);
    }
    tile = Math.max(-0.15, Math.min(TILE_SETTINGS + 0.15, tile0 - dx));
  });
}
/** Taps on the Settings view hit its −/+ buttons (device px); anywhere else does nothing there, like ui.c. */
function settingsTap(canvas: HTMLCanvasElement, e: PointerEvent) {
  const [x, y] = devicePx(canvas, e);
  for (const dir of [-1, 1] as const) {
    if (Math.hypot(x - (120 + dir * BRIGHT_BTN_DX), y - BRIGHT_BTN_CY) <= BRIGHT_BTN_R) {
      dev.brightnessPct = brightnessStep(dev.brightnessPct, dir);
      applyBrightness();
    }
  }
}
/** The real screen gets dimmer; approximate that on the canvas. */
function applyBrightness() {
  for (const c of canvases) c.style.filter = `brightness(${0.25 + 0.75 * (dev.brightnessPct / 100)})`;
}
const endDrag = (e?: PointerEvent) => {
  if (!dragging) return;
  dragging = false;
  setMediaPressed(null);
  if (!moved) {
    if (tileTarget === TILE_SETTINGS) {
      if (e) settingsTap(e.currentTarget as HTMLCanvasElement, e);
    } else if (tileTarget === TILE_MEDIA) {
      // Buttons only: a near miss stays on the page (no tap-to-go-back, like ui.c).
      const cmd = e ? mediaHitAt(e.currentTarget as HTMLCanvasElement, e) : null;
      if (cmd != null) onMediaCmd(cmd);
    } else if (tileTarget !== TILE_NAV) tileTarget = TILE_NAV;
  } else {
    const delta = tile - tile0;
    tileTarget = Math.max(0, Math.min(TILE_SETTINGS,
      Math.abs(delta) > 0.18 ? Math.round(tile0) + Math.sign(delta) : Math.round(tile0)));
  }
  syncControls();
};
const onKey = (e: KeyboardEvent) => {
  if (e.key === 'ArrowRight') tileTarget = Math.min(TILE_SETTINGS, tileTarget + 1);
  else if (e.key === 'ArrowLeft') tileTarget = Math.max(0, tileTarget - 1);
  else return;
  e.preventDefault();
  syncControls();
};
for (const canvas of canvases) {
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', () => endDrag()); // a cancelled touch is never a tap
  canvas.addEventListener('keydown', onKey);
}

window.addEventListener('resize', () => { sizeCanvas(); drawOverview(); });

// ---------- boot ----------
sizeCanvas();
applyBrightness();
startRoute(0);
onFrame(encodeMedia(player));
setInterval(step, TICK_MS);
setInterval(readouts, 250);
void document.fonts?.ready.then(sizeCanvas);
requestAnimationFrame(frame);
