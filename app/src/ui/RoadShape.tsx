// Phone-side mirror of the device's road drawing (same data as the NAV frame), drawn with plain Views.
import { StyleSheet, View } from 'react-native';

import { ShapePoint } from '../core/proto';
import { colors, curveColors } from './theme';

const SIZE = 220;
const RIDER_Y = SIZE * 0.78;

export function RoadShape({ points, maneuverIdx }: { points: ShapePoint[]; maneuverIdx: number | null }) {
  const maxY = Math.max(60, ...points.map((p) => p.y / 10));
  const maxX = Math.max(30, ...points.map((p) => Math.abs(p.x / 10)));
  const scale = Math.min((RIDER_Y - 14) / maxY, (SIZE / 2 - 14) / maxX);
  const px = (p: ShapePoint) => ({ x: SIZE / 2 + (p.x / 10) * scale, y: RIDER_Y - (p.y / 10) * scale });

  return (
    <View style={styles.circle}>
      {points.slice(1).map((b, i) => {
        const a = px(points[i]);
        const c = px(b);
        const len = Math.hypot(c.x - a.x, c.y - a.y);
        const angle = Math.atan2(c.y - a.y, c.x - a.x);
        const after = maneuverIdx != null && i >= maneuverIdx;
        const w = after ? 6 : 10;
        return (
          <View
            key={i}
            style={{
              position: 'absolute',
              left: (a.x + c.x) / 2 - len / 2 - w / 2,
              top: (a.y + c.y) / 2 - w / 2,
              width: len + w,
              height: w,
              borderRadius: w / 2,
              backgroundColor: curveColors[b.cls] ?? curveColors[0],
              transform: [{ rotate: `${angle}rad` }],
            }}
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
  rider: { position: 'absolute', width: 14, height: 14, borderRadius: 7, backgroundColor: colors.accent },
});
