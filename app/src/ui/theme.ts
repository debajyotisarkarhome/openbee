// Design tokens for the phone app. The device UI has its own palette in firmware/components/ui/ui.c —
// these are deliberately separate: this is a phone screen, that one is a 240x240 sunlit LCD.

export const colors = {
  bg: '#07090C',
  surface: '#111419',
  surfaceAlt: '#171B22',
  surfaceHi: '#1E242D',
  border: '#232A33',
  borderHi: '#2F3845',
  text: '#F4F6F9',
  dim: '#98A2B0',
  faint: '#5E6773',
  accent: '#00D1FF',
  accentInk: '#00141A',
  ok: '#22C55E',
  warn: '#F59E0B',
  bad: '#EF4444',
  scrim: 'rgba(0,0,0,0.6)',
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };
export const radius = { sm: 8, md: 12, lg: 16, xl: 22, pill: 999 };

export const type = {
  hero: { fontSize: 46, fontWeight: '800' as const, letterSpacing: -1.2 },
  title: { fontSize: 24, fontWeight: '700' as const, letterSpacing: -0.4 },
  heading: { fontSize: 18, fontWeight: '700' as const, letterSpacing: -0.2 },
  body: { fontSize: 16, fontWeight: '500' as const },
  label: { fontSize: 13, fontWeight: '600' as const, letterSpacing: 0.3 },
  mono: { fontSize: 20, fontWeight: '700' as const, fontVariant: ['tabular-nums'] as const },
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

export function fmtClock(epochS: number): string {
  const d = new Date(epochS * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
