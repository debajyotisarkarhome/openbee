// Design tokens for the phone app. The device UI has its own palette in firmware/components/ui/ui.c —
// these are deliberately separate: this is a phone screen, that one is a 240x240 sunlit LCD.

// Design language: an instrument, not a dashboard. Borrowed from motorcycle clusters and printed spec
// sheets (Braun, Teenage Engineering): warm neutrals, hierarchy from type size rather than boxes, hairline
// rules instead of cards, tabular numerals for anything measured, and a single signal colour spent only
// where it means something: the primary action, the selected route, live state. That colour, and the
// route blue on the map, are the device's own C_ACCENT and C_ROUTE from ui.c, so phone and display match.

export const colors = {
  bg: '#0B0B0A',
  surface: '#151513',
  surfaceAlt: '#1C1C19',
  surfaceHi: '#262622',
  border: '#2A2A26',
  borderHi: '#3A3934',
  text: '#F2EFE8',
  dim: '#A39E93',
  faint: '#6B675F',
  accent: '#00D1FF', // ui.c C_ACCENT
  accentInk: '#00141A',
  route: '#3D8BFF', // ui.c C_ROUTE
  routeCasing: '#0B2A5C', // ui.c C_ROUTE_CASING
  charge: '#FACC15', // ui.c C_CHARGE
  ok: '#7BC67E',
  warn: '#FFB224',
  bad: '#FF5A4E',
  scrim: 'rgba(0,0,0,0.6)',
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };
/**
 * Vertical rhythm. Every screen stacks with these three steps and nothing else:
 * `section` between sections, `group` between controls inside one section, `tight` to attach a label,
 * hint or subordinate line to the thing it belongs to. `gutter` is the screen's side margin.
 */
export const layout = { gutter: 20, section: space.xl, group: space.md, tight: space.sm, bottom: space.xxl };
export const radius = { sm: 4, md: 6, lg: 8, xl: 12, pill: 999 };

export const type = {
  hero: { fontSize: 64, fontWeight: '300' as const, letterSpacing: -2, fontVariant: ['tabular-nums'] as const },
  display: { fontSize: 34, fontWeight: '700' as const, letterSpacing: -0.8 },
  title: { fontSize: 24, fontWeight: '600' as const, letterSpacing: -0.4 },
  heading: { fontSize: 17, fontWeight: '600' as const, letterSpacing: -0.2 },
  body: { fontSize: 16, fontWeight: '400' as const },
  label: { fontSize: 12, fontWeight: '500' as const, letterSpacing: 0.1 },
  readout: { fontSize: 26, fontWeight: '300' as const, letterSpacing: -0.6, fontVariant: ['tabular-nums'] as const },
};

export const curveColors = ['#C8CCD2', '#FFD400', '#FF8A00', '#FF2D2D'];

export type Units = 'metric' | 'imperial';

const FEET_PER_M = 3.28084;
const MILES_PER_M = 0.000621371;

export function fmtDistance(m: number, units: Units = 'metric'): string {
  if (units === 'imperial') {
    const mi = m * MILES_PER_M;
    if (mi >= 10) return `${Math.round(mi)} mi`;
    if (mi >= 0.2) return `${mi.toFixed(1)} mi`;
    const ft = Math.round((m * FEET_PER_M) / 10) * 10;
    return `${ft} ft`;
  }
  if (m >= 10000) return `${Math.round(m / 1000)} km`;
  if (m >= 1000) return `${(m / 1000).toFixed(1)} km`;
  if (m >= 100) return `${Math.round(m / 10) * 10} m`;
  return `${Math.round(m)} m`;
}

export const speedLabel = (units: Units) => (units === 'imperial' ? 'mph' : 'km/h');

export function toSpeed(kmh: number, units: Units): number {
  return units === 'imperial' ? Math.round(kmh * 0.621371) : Math.round(kmh);
}

export function fmtDuration(ms: number): string {
  const min = Math.round(ms / 60000);
  return min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Tue 28 Oct", or "Today" / "Yesterday" relative to `nowMs`. */
export function fmtDay(ms: number, nowMs: number = Date.now()): string {
  const d = new Date(ms);
  const midnight = new Date(nowMs).setHours(0, 0, 0, 0);
  if (ms >= midnight) return 'Today';
  if (ms >= midnight - 86_400_000) return 'Yesterday';
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

export function fmtClock(epochS: number): string {
  const d = new Date(epochS * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
