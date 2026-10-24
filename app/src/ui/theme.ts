export const colors = {
  bg: '#0B0D10',
  card: '#151920',
  border: '#232A33',
  text: '#F2F4F7',
  dim: '#8A93A0',
  accent: '#00D1FF',
  ok: '#22C55E',
  warn: '#F59E0B',
  bad: '#EF4444',
};

export const curveColors = ['#C8CCD2', '#FFD400', '#FF8A00', '#FF2D2D'];

export function fmtDistance(m: number): string {
  if (m >= 10000) return `${Math.round(m / 1000)} km`;
  if (m >= 1000) return `${(m / 1000).toFixed(1)} km`;
  if (m >= 100) return `${Math.round(m / 10) * 10} m`;
  return `${Math.round(m)} m`;
}

export function fmtDuration(ms: number): string {
  const min = Math.round(ms / 60000);
  return min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`;
}

export function fmtClock(epochS: number): string {
  const d = new Date(epochS * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
