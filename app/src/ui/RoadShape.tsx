// Phone-side mirror of the device's road drawing: the surrounding streets from the ROADS frames plus the
// route from the NAV frame, in the same heading-up frame the display uses. Drawn with plain Views.
import { StyleSheet, View } from 'react-native';

import { ShapePoint } from '../core/proto';
import { RiderPoint } from '../core/roads';
import { colors, curveColors } from './theme';

const SIZE = 220;
const RIDER_Y = SIZE * 0.78;
const STREET_COLOR = '#39424F';
const STREET_W = 3;

/** One rounded bar from a to b: the same trick ui.c uses to draw a line segment without a canvas. */
function Segment({ ax, ay, bx, by, w, color }: { ax: number; ay: number; bx: number; by: number; w: number; color: string }) {
  const len = Math.hypot(bx - ax, by - ay);
  const angle = Math.atan2(by - ay, bx - ax);
  return (
    <View
      style={{
        position: 'absolute',
        left: (ax + bx) / 2 - len / 2 - w / 2,
        top: (ay + by) / 2 - w / 2,
        width: len + w,
        height: w,
        borderRadius: w / 2,
        backgroundColor: color,
        transform: [{ rotate: `${angle}rad` }],
      }}
    />
  );
}

export function RoadShape({
  points,
  maneuverIdx,
  streets = [],
}: {
  points: ShapePoint[];
  maneuverIdx: number | null;
  streets?: RiderPoint[][];
}) {
  // Scale from the route alone, like the device's auto-zoom: streets must not pull the view out.
  const maxY = Math.max(60, ...points.map((p) => p.y / 10));
  const maxX = Math.max(30, ...points.map((p) => Math.abs(p.x / 10)));
  const scale = Math.min((RIDER_Y - 14) / maxY, (SIZE / 2 - 14) / maxX);
  /** Metres in the rider frame -> pixels. +y is ahead (up the screen), +x is to the rider's right. */
  const proj = (xm: number, ym: number) => ({ x: SIZE / 2 + xm * scale, y: RIDER_Y - ym * scale });
  const px = (p: ShapePoint) => proj(p.x / 10, p.y / 10);

  return (
    <View style={styles.circle}>
      {/* Streets first so the route draws over them, as on the device. */}
      {streets.map((road, r) =>
        road.slice(1).map((b, i) => {
          const a = proj(road[i].x, road[i].y);
          const c = proj(b.x, b.y);
          return <Segment key={`s${r}-${i}`} ax={a.x} ay={a.y} bx={c.x} by={c.y} w={STREET_W} color={STREET_COLOR} />;
        }),
      )}

      {points.slice(1).map((b, i) => {
        const a = px(points[i]);
        const c = px(b);
        const after = maneuverIdx != null && i >= maneuverIdx;
        return (
          <Segment
            key={`r${i}`}
            ax={a.x}
            ay={a.y}
            bx={c.x}
            by={c.y}
            w={after ? 6 : 10}
            color={curveColors[b.cls] ?? curveColors[0]}
          />
        );
      })}

      {maneuverIdx != null && points[maneuverIdx] ? (
        <View style={[styles.dot, { left: px(points[maneuverIdx]).x - 7, top: px(points[maneuverIdx]).y - 7 }]} />
      ) : null}
      <View style={[styles.rider, { left: SIZE / 2 - 7, top: RIDER_Y - 7 }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  circle: { width: SIZE, height: SIZE, borderRadius: SIZE / 2, backgroundColor: '#000', overflow: 'hidden', alignSelf: 'center' },
  dot: { position: 'absolute', width: 14, height: 14, borderRadius: 7, backgroundColor: colors.accent, borderWidth: 2, borderColor: '#000' },
  rider: { position: 'absolute', width: 14, height: 14, borderRadius: 7, backgroundColor: '#FFFFFF' },
});
