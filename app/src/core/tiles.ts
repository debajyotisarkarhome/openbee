// Slippy-map tile maths for the vector-tile street source. Pure arithmetic, no dependencies, so it is
// testable and shared: src/services/tiles.ts does the fetching and MVT decoding on top of it.

export interface TileId {
  z: number;
  x: number;
  y: number;
}

export const tileKey = (t: TileId) => `${t.z}/${t.x}/${t.y}`;

export function lonToTileX(lon: number, z: number): number {
  return ((lon + 180) / 360) * 2 ** z;
}

export function latToTileY(lat: number, z: number): number {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
}

export function tileToLon(x: number, z: number): number {
  return (x / 2 ** z) * 360 - 180;
}

export function tileToLat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
}

/** Every tile at zoom z touching the square of side 2*radiusM centred on (lat, lon). */
export function coveringTiles(center: { lat: number; lon: number }, radiusM: number, z: number): TileId[] {
  const dLat = radiusM / 111_320;
  const dLon = radiusM / (111_320 * Math.max(0.1, Math.cos((center.lat * Math.PI) / 180)));
  const x0 = Math.floor(lonToTileX(center.lon - dLon, z));
  const x1 = Math.floor(lonToTileX(center.lon + dLon, z));
  // Tile y grows southward, so the northern edge gives the smaller index.
  const y0 = Math.floor(latToTileY(center.lat + dLat, z));
  const y1 = Math.floor(latToTileY(center.lat - dLat, z));
  const out: TileId[] = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push({ z, x, y });
  return out;
}
