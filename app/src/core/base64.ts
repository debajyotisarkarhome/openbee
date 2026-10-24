// Minimal base64 for BLE payloads (react-native-ble-plx speaks base64). Pure TS.
const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP = new Map([...ALPHA].map((c, i) => [c, i]));

export function toBase64(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    out += ALPHA[(n >> 18) & 63] + ALPHA[(n >> 12) & 63];
    out += i + 1 < b.length ? ALPHA[(n >> 6) & 63] : '=';
    out += i + 2 < b.length ? ALPHA[n & 63] : '=';
  }
  return out;
}

export function fromBase64(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, '');
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const c = [0, 1, 2, 3].map((k) => LOOKUP.get(clean[i + k]) ?? -1);
    const n = (c[0] << 18) | (c[1] << 12) | (Math.max(c[2], 0) << 6) | Math.max(c[3], 0);
    out.push((n >> 16) & 255);
    if (c[2] >= 0) out.push((n >> 8) & 255);
    if (c[3] >= 0) out.push(n & 255);
  }
  return Uint8Array.from(out);
}
