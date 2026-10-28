// Google/Valhalla encoded-polyline decoding. Valhalla encodes route shapes at precision 6; the classic
// Google format is precision 5. Pure TS.
import { LatLon } from './geo';

export const VALHALLA_PRECISION = 6;

/** Decode an encoded polyline into lat/lon points. `precision` is the number of decimal places. */
export function decodePolyline(encoded: string, precision = VALHALLA_PRECISION): LatLon[] {
  const factor = 10 ** precision;
  const points: LatLon[] = [];
  let i = 0;
  let lat = 0;
  let lon = 0;

  while (i < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte: number;
    // Each coordinate is a zig-zag encoded varint in 5-bit chunks, offset by 63.
    do {
      byte = encoded.charCodeAt(i++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    shift = 0;
    result = 0;
    do {
      byte = encoded.charCodeAt(i++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lon += result & 1 ? ~(result >> 1) : result >> 1;

    points.push({ lat: lat / factor, lon: lon / factor });
  }
  return points;
}
