import { destination, haversine } from '../geo';
import { coveringTiles, latToTileY, lonToTileX, tileKey, tileToLat, tileToLon } from '../tiles';

const KOLKATA = { lat: 22.5726, lon: 88.3639 };
const Z = 14;

const tileOf = (p: { lat: number; lon: number }) =>
  tileKey({ z: Z, x: Math.floor(lonToTileX(p.lon, Z)), y: Math.floor(latToTileY(p.lat, Z)) });

describe('slippy-map tile maths', () => {
  it('maps lat/lon to the documented z14 tile', () => {
    expect(Math.floor(lonToTileX(KOLKATA.lon, Z))).toBe(12213);
    expect(Math.floor(latToTileY(KOLKATA.lat, Z))).toBe(7137);
    expect(Math.floor(lonToTileX(-180, Z))).toBe(0);
    expect(Math.floor(lonToTileX(179.999, Z))).toBe(2 ** Z - 1);
    expect(latToTileY(0, Z)).toBeCloseTo(2 ** (Z - 1), 6); // the equator is the middle row
  });

  it('y grows southward', () => {
    expect(latToTileY(40, Z)).toBeLessThan(latToTileY(-40, Z));
  });

  it('round-trips back to lat/lon', () => {
    for (const p of [KOLKATA, { lat: 0, lon: 0 }, { lat: -33.9, lon: 151.2 }, { lat: 60.2, lon: -149.4 }]) {
      expect(tileToLon(lonToTileX(p.lon, Z), Z)).toBeCloseTo(p.lon, 9);
      expect(tileToLat(latToTileY(p.lat, Z), Z)).toBeCloseTo(p.lat, 9);
    }
  });
});

describe('coveringTiles', () => {
  it('always includes the tile the centre falls in', () => {
    for (const r of [100, 700, 2000]) {
      expect(coveringTiles(KOLKATA, r, Z).map(tileKey)).toContain(tileOf(KOLKATA));
    }
  });

  it('stays small for one anchor and grows with radius', () => {
    // A z14 tile is ~2.3 km across at this latitude, so a 700 m anchor must not need many.
    const few = coveringTiles(KOLKATA, 700, Z);
    expect(few.length).toBeGreaterThanOrEqual(1);
    expect(few.length).toBeLessThanOrEqual(4);
    expect(coveringTiles(KOLKATA, 5000, Z).length).toBeGreaterThan(few.length);
  });

  it('covers every direction an anchor reaches', () => {
    const tiles = new Set(coveringTiles(KOLKATA, 700, Z).map(tileKey));
    for (let brg = 0; brg < 360; brg += 30) {
      const p = destination(KOLKATA, brg, 700);
      expect(haversine(KOLKATA, p)).toBeCloseTo(700, 0);
      expect(tiles).toContain(tileOf(p));
    }
  });

  it('returns unique tiles', () => {
    const all = coveringTiles(KOLKATA, 3000, Z).map(tileKey);
    expect(new Set(all).size).toBe(all.length);
  });
});
