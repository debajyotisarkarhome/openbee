// Demo routes for the browser simulator, built from turtle commands so curvature is exact.
import { LatLon, destination } from '../src/core/geo';
import { Maneuver } from '../src/core/proto';
import { InstructionSpec, Route, bearingAt, makeRoute, pointAt } from '../src/core/route';
import { PathBuilder } from '../src/core/simulator';

type Step =
  | ['straight', number]
  | ['arc', number, number]
  | ['turn', number, Maneuver, string, number?]; // angle, maneuver, street, roundabout exit

export interface DemoRoute {
  id: string;
  name: string;
  blurb: string;
  baseKmh: number;
  route: Route;
  /** Surrounding streets (mock of what the phone would fetch from OpenStreetMap). */
  sideRoads: LatLon[][];
}

function build(start: { lat: number; lon: number }, heading: number, firstStreet: string, steps: Step[], baseKmh: number,
  limits: { untilFrac: number; kmh: number | null }[]): Route {
  const b = new PathBuilder(start, heading);
  const ins: InstructionSpec[] = [
    { atIndex: 0, maneuver: Maneuver.DEPART, exit: 0, street: firstStreet, text: '', distanceM: 0, timeMs: 0 },
  ];
  for (const s of steps) {
    if (s[0] === 'straight') b.straight(s[1]);
    else if (s[0] === 'arc') b.arc(s[1], s[2]);
    else {
      ins.push({ atIndex: b.index, maneuver: s[2], exit: s[4] ?? 0, street: s[3], text: '', distanceM: 0, timeMs: 0 });
      b.turn(s[1]);
    }
  }
  ins.push({ atIndex: b.index, maneuver: Maneuver.ARRIVE, exit: 0, street: '', text: '', distanceM: 0, timeMs: 0 });

  const r = makeRoute(b.points, ins, baseKmh / 3.6);
  // Fill per-instruction distance/time (as GraphHopper would) so ETA works.
  r.instructions.forEach((x, i) => {
    const next = r.instructions[i + 1];
    x.distanceM = next ? next.atM - x.atM : 0;
    x.timeMs = (x.distanceM / (baseKmh / 3.6)) * 1000;
  });
  let from = 0;
  r.maxSpeed = limits.map((l) => {
    const span = { fromM: from, toM: l.untilFrac * r.lengthM, kmh: l.kmh };
    from = span.toM;
    return span;
  });
  return r;
}

interface SideRoadOpts {
  spacingM: number;
  lengthM: number;
  bothSides: boolean;
  /** Degrees of bend along each side road (0 = straight grid streets). */
  wiggle: number;
}

/** Deterministic pseudo-random in [0,1). */
function rand(seed: number) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function branch(from: LatLon, heading: number, lengthM: number, wiggle: number, seed: number): LatLon[] {
  const pts = [from];
  let h = heading;
  const steps = 6;
  for (let i = 0; i < steps; i++) {
    h += (rand(seed + i) - 0.5) * wiggle;
    pts.push(destination(pts[pts.length - 1], h, lengthM / steps));
  }
  return pts;
}

function makeSideRoads(r: Route, o: SideRoadOpts): LatLon[][] {
  const roads: LatLon[][] = [];
  const turns = r.instructions.filter((i) => i.maneuver !== Maneuver.DEPART && i.maneuver !== Maneuver.ARRIVE);
  // At every turn: the road continues straight, and the cross street extends to the other side.
  for (const [k, t] of turns.entries()) {
    const p = pointAt(r, t.atM);
    const hin = bearingAt(r, Math.max(0, t.atM - 20), 20);
    roads.push(branch(p, hin, 260, o.wiggle, 100 + k));
    const hout = bearingAt(r, t.atM + 20, 20);
    roads.push(branch(p, hout + 180, 200, o.wiggle, 300 + k));
  }
  // Cross streets along the way.
  for (let d = o.spacingM * 0.6, k = 0; d < r.lengthM - 60; d += o.spacingM * (0.75 + rand(k) * 0.5), k++) {
    if (turns.some((t) => Math.abs(t.atM - d) < 60)) continue;
    const p = pointAt(r, d);
    const h = bearingAt(r, d, 20);
    const right = rand(k + 50) > 0.5;
    if (o.bothSides || right) roads.push(branch(p, h + 90, o.lengthM, o.wiggle, 400 + k));
    if (o.bothSides || !right) roads.push(branch(p, h - 90, o.lengthM, o.wiggle, 500 + k));
  }
  return roads;
}

const SIDE_ROADS: Record<string, SideRoadOpts> = {
  hills: { spacingM: 380, lengthM: 220, bothSides: false, wiggle: 50 },
  city: { spacingM: 110, lengthM: 160, bothSides: true, wiggle: 0 },
  coast: { spacingM: 520, lengthM: 260, bothSides: false, wiggle: 25 },
};

const DEMO_DEFS: Omit<DemoRoute, 'sideRoads'>[] = [
  {
    id: 'hills',
    name: 'Hill road',
    blurb: 'Hairpins and tight bends, one junction turn',
    baseKmh: 42,
    route: build({ lat: 26.98, lon: 88.27 }, 20, 'Hill Cart Road', [
      ['straight', 220], ['arc', 35, 150], ['straight', 140], ['arc', 30, -160], ['straight', 120],
      ['arc', 80, 60], ['straight', 100], ['arc', 45, -100], ['straight', 180],
      ['turn', 90, Maneuver.RIGHT, 'Rohini Road'],
      ['straight', 200], ['arc', 120, -40], ['arc', 40, 120], ['straight', 160], ['arc', 60, -90], ['straight', 250],
    ], 42, [{ untilFrac: 0.55, kmh: 40 }, { untilFrac: 1, kmh: null }]),
  },
  {
    id: 'city',
    name: 'City streets',
    blurb: 'Junction turns and a roundabout',
    baseKmh: 32,
    route: build({ lat: 22.5535, lon: 88.3519 }, 90, 'Park Street', [
      ['straight', 300], ['turn', 90, Maneuver.RIGHT, 'Camac Street'],
      ['straight', 250], ['turn', -35, Maneuver.SLIGHT_LEFT, 'Shakespeare Sarani'],
      ['straight', 200], ['turn', 0, Maneuver.ROUNDABOUT, 'AJC Bose Road', 2], ['arc', 18, 90], ['straight', 300],
      ['turn', -90, Maneuver.LEFT, 'Elliot Road'], ['straight', 200],
      ['turn', 135, Maneuver.SHARP_RIGHT, 'Ripon Street'], ['straight', 220],
    ], 32, [{ untilFrac: 0.5, kmh: 30 }, { untilFrac: 1, kmh: 40 }]),
  },
  {
    id: 'coast',
    name: 'Coastal sweepers',
    blurb: 'Fast, open bends of every radius',
    baseKmh: 68,
    route: build({ lat: 21.62, lon: 87.52 }, 0, 'Marine Drive', [
      ['straight', 300], ['arc', 400, 30], ['straight', 200], ['arc', 250, -50], ['straight', 150], ['arc', 180, 70],
      ['arc', 300, -40], ['straight', 300], ['arc', 110, -80], ['straight', 250],
      ['turn', -15, Maneuver.KEEP_LEFT, 'Coast Road'], ['straight', 300], ['arc', 500, 20], ['straight', 400],
    ], 68, [{ untilFrac: 0.4, kmh: 60 }, { untilFrac: 0.75, kmh: 80 }, { untilFrac: 1, kmh: 60 }]),
  },
];

export const DEMO_ROUTES: DemoRoute[] = DEMO_DEFS.map((d) => ({ ...d, sideRoads: makeSideRoads(d.route, SIDE_ROADS[d.id]) }));
