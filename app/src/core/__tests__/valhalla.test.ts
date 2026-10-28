import { haversine } from '../geo';
import { decodePolyline } from '../polyline';
import { Maneuver } from '../proto';
import { ValhallaTrip, maneuverFromValhallaType, routeFromValhalla } from '../route';

/**
 * A real response from valhalla1.openstreetmap.de: a 498 m hop in central Kolkata, 20 shape points and
 * 8 maneuvers. Captured rather than hand-written so the precision-6 shape is genuinely what the service
 * emits. Note the backslash in the encoding — it must stay escaped or JS silently drops it.
 */
const SHAPE = 'crv`j@m~hpgDyCnIkBxEaO_GmG_Cv@}D~EkO}\\oM|GwPDS~Kod@nDoOiXeG_De@cWuGgJyCwFqCeG{CeLaDiDnB';

const TRIP: ValhallaTrip = {
  summary: { length: 0.498, time: 209.57 },
  legs: [
    {
      shape: SHAPE,
      maneuvers: [
        { type: 1, instruction: 'Go.', street_names: ['Chatterjee Lane'], length: 0.032, time: 14.4, begin_shape_index: 0 },
        { type: 10, instruction: 'Right.', length: 0.048, time: 26.624, begin_shape_index: 2 },
        { type: 10, instruction: 'Right.', length: 0.04, time: 22.624, begin_shape_index: 4 },
        { type: 15, instruction: 'Left.', length: 0.058, time: 28.414, begin_shape_index: 6 },
        { type: 10, instruction: 'Right.', street_names: ['Surya Sen Street'], length: 0.129, time: 31.842, begin_shape_index: 7 },
        { type: 15, instruction: 'Left.', length: 0.18, time: 83.466, begin_shape_index: 11 },
        { type: 15, instruction: 'Left.', street_names: ['Mahatma Gandhi Road'], length: 0.011, time: 2.196, begin_shape_index: 18 },
        { type: 6, instruction: 'Arrive.', length: 0, time: 0, begin_shape_index: 19 },
      ],
    },
  ],
};

describe('decodePolyline', () => {
  it('decodes the documented precision-5 example', () => {
    // From Google's polyline algorithm reference: (38.5,-120.2) (40.7,-120.95) (43.252,-126.453).
    const pts = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@', 5);
    expect(pts).toHaveLength(3);
    expect(pts[0].lat).toBeCloseTo(38.5, 6);
    expect(pts[0].lon).toBeCloseTo(-120.2, 6);
    expect(pts[2].lat).toBeCloseTo(43.252, 6);
    expect(pts[2].lon).toBeCloseTo(-126.453, 6);
  });

  it('decodes a real precision-6 Valhalla shape', () => {
    const pts = decodePolyline(SHAPE);
    expect(pts).toHaveLength(20);
    expect(pts[0].lat).toBeCloseTo(22.57285, 6);
    expect(pts[0].lon).toBeCloseTo(88.364023, 6);
    expect(pts[19].lat).toBeCloseTo(22.574872, 6);
    expect(pts[19].lon).toBeCloseTo(88.366227, 6);
    // Consecutive points of a city street are metres apart, never kilometres: catches precision slips.
    for (let i = 1; i < pts.length; i++) expect(haversine(pts[i - 1], pts[i])).toBeLessThan(200);
  });

  it('mis-scales at the wrong precision, which is why the default matters', () => {
    // Decoding a precision-6 shape as precision 5 puts it 10x off, nowhere near Kolkata.
    const wrong = decodePolyline(SHAPE, 5);
    expect(wrong).toHaveLength(20);
    expect(Math.abs(wrong[0].lat - 22.57285)).toBeGreaterThan(100);
  });

  it('returns nothing for an empty shape', () => {
    expect(decodePolyline('')).toEqual([]);
  });
});

describe('maneuverFromValhallaType', () => {
  it('maps the enum from proto/descriptors/directions.proto', () => {
    expect(maneuverFromValhallaType(1)).toBe(Maneuver.DEPART); // kStart
    expect(maneuverFromValhallaType(4)).toBe(Maneuver.ARRIVE); // kDestination
    expect(maneuverFromValhallaType(6)).toBe(Maneuver.ARRIVE); // kDestinationLeft
    expect(maneuverFromValhallaType(9)).toBe(Maneuver.SLIGHT_RIGHT);
    expect(maneuverFromValhallaType(10)).toBe(Maneuver.RIGHT);
    expect(maneuverFromValhallaType(11)).toBe(Maneuver.SHARP_RIGHT);
    expect(maneuverFromValhallaType(12)).toBe(Maneuver.UTURN_RIGHT);
    expect(maneuverFromValhallaType(13)).toBe(Maneuver.UTURN_LEFT);
    expect(maneuverFromValhallaType(14)).toBe(Maneuver.SHARP_LEFT);
    expect(maneuverFromValhallaType(15)).toBe(Maneuver.LEFT);
    expect(maneuverFromValhallaType(16)).toBe(Maneuver.SLIGHT_LEFT);
    expect(maneuverFromValhallaType(26)).toBe(Maneuver.ROUNDABOUT);
    // Ramps and exits become keep-left/right, which is what the device can draw.
    expect(maneuverFromValhallaType(18)).toBe(Maneuver.KEEP_RIGHT);
    expect(maneuverFromValhallaType(21)).toBe(Maneuver.KEEP_LEFT);
    // Unmapped (transit, lifts, steps) must not break the renderer.
    expect(maneuverFromValhallaType(31)).toBe(Maneuver.STRAIGHT);
    expect(maneuverFromValhallaType(999)).toBe(Maneuver.STRAIGHT);
  });

  it('never returns an out-of-range maneuver', () => {
    for (let t = 0; t < 45; t++) {
      const m = maneuverFromValhallaType(t);
      expect(m).toBeGreaterThanOrEqual(Maneuver.NONE);
      expect(m).toBeLessThanOrEqual(Maneuver.DEPART);
    }
  });
});

describe('routeFromValhalla', () => {
  it('builds a route matching the captured response', () => {
    const r = routeFromValhalla(TRIP);
    expect(r.points).toHaveLength(20);
    expect(r.cum).toHaveLength(20);
    expect(r.cum[0]).toBe(0);
    expect(r.lengthM).toBe(498);
    expect(r.timeMs).toBe(209_570);
    expect(r.instructions.map((i) => i.maneuver)).toEqual([
      Maneuver.DEPART,
      Maneuver.RIGHT,
      Maneuver.RIGHT,
      Maneuver.LEFT,
      Maneuver.RIGHT,
      Maneuver.LEFT,
      Maneuver.LEFT,
      Maneuver.ARRIVE,
    ]);
    expect(r.instructions[0].street).toBe('Chatterjee Lane');
    expect(r.instructions[4].street).toBe('Surya Sen Street');
    expect(r.instructions[1].street).toBe(''); // no street_names -> empty, never undefined
    expect(r.instructions[4].distanceM).toBe(129);
    expect(r.instructions[4].timeMs).toBe(31_842);
  });

  it('keeps instructions ordered along the route and in range', () => {
    const r = routeFromValhalla(TRIP);
    for (let i = 1; i < r.instructions.length; i++) {
      expect(r.instructions[i].atM).toBeGreaterThanOrEqual(r.instructions[i - 1].atM);
    }
    const total = r.cum[r.cum.length - 1];
    for (const ins of r.instructions) {
      expect(ins.atM).toBeGreaterThanOrEqual(0);
      expect(ins.atM).toBeLessThanOrEqual(total + 1);
    }
    // The last maneuver is the arrival, so it sits at the end of the shape.
    expect(r.instructions[r.instructions.length - 1].atM).toBeCloseTo(total, 0);
  });

  it('reports no speed limits, so the device shows "unknown"', () => {
    expect(routeFromValhalla(TRIP).maxSpeed).toEqual([]);
  });

  it('joins multiple legs without duplicating the shared point', () => {
    const two: ValhallaTrip = {
      summary: { length: 0.996, time: 419 },
      legs: [TRIP.legs[0], { ...TRIP.legs[0] }],
    };
    expect(routeFromValhalla(two).points).toHaveLength(20 * 2 - 1);
  });

  it('survives a trip with no maneuvers', () => {
    const bare: ValhallaTrip = { summary: { length: 0.1, time: 10 }, legs: [{ shape: SHAPE, maneuvers: [] }] };
    const r = routeFromValhalla(bare);
    expect(r.instructions).toEqual([]);
    expect(r.points).toHaveLength(20);
  });
});
