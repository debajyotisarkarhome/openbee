# OpenBee BLE protocol — v1

The device (ESP32-S3) is a BLE **peripheral**; the phone app is the **central**.
All multi-byte integers are **little-endian**. Strings are UTF-8, length-prefixed,
never NUL-terminated, and truncated by the sender on a code-point boundary.

## GATT

| Item              | UUID                                   | Properties                 |
|-------------------|----------------------------------------|----------------------------|
| OpenBee service   | `6f70656e-6265-4500-a000-000000000000` |                            |
| RX (phone→device) | `6f70656e-6265-4500-a000-000000000001` | write, write-without-resp. |
| TX (device→phone) | `6f70656e-6265-4500-a000-000000000002` | notify                     |

Advertised name: `OpenBee-XXXX` (last two MAC bytes, hex). The phone requests MTU 247,
so one frame is at most **244 bytes** (4-byte header + ≤240-byte payload). One write = one frame.

## Frame

| Offset | Size | Field                        |
|--------|------|------------------------------|
| 0      | 1    | `ver` = `1`                  |
| 1      | 1    | `type`                       |
| 2      | 2    | `len` (payload length, ≤240) |
| 4      | len  | payload                      |

Receivers drop frames with an unknown `ver`, an unknown `type`, or a `len` that doesn't
match the bytes received.

| type   | Name         | Direction      | Rate                                  |
|--------|--------------|----------------|---------------------------------------|
| `0x01` | `NAV`        | phone → device | 2 Hz while navigating, and on maneuver change |
| `0x02` | `TRIP`       | phone → device | 1 Hz                                  |
| `0x03` | `NOTIF`      | phone → device | on event                              |
| `0x04` | `STATE`      | phone → device | on change, plus once on connect       |
| `0x05` | `ROADS`      | phone → device | per anchor: when the rider is 300 m from the last one, plus on connect |
| `0x06` | `MEDIA`      | phone → device | on change, plus once on connect       |
| `0x81` | `DEV_STATUS` | device → phone | every 10 s, plus once on subscribe    |
| `0x82` | `MEDIA_CMD`  | device → phone | on button press                       |

## `NAV` (0x01)

| Size  | Field            | Notes                                                        |
|-------|------------------|--------------------------------------------------------------|
| 1     | `maneuver`       | see *Maneuver*                                               |
| 1     | `exit`           | roundabout exit number, 0 if not a roundabout                |
| 2     | `dist_m`         | distance to the maneuver in meters; `0xFFFF` = unknown       |
| 1     | `curve_dir`      | int8: -1 left, 0 none, +1 right (next notable curve)         |
| 1     | `curve_class`    | class of that curve (see *Curvature class*)                  |
| 2     | `curve_dist_m`   | distance to the start of that curve in meters                |
| 1     | `maneuver_idx`   | index into `points` of the maneuver point; `0xFF` = not in view |
| 1     | `anchor_id`      | `ROADS` set the pose below refers to; 0 = no map streets     |
| 2     | `pose_x`         | int16 dm east of the anchor                                  |
| 2     | `pose_y`         | int16 dm north of the anchor                                 |
| 2     | `heading_cdeg`   | uint16, centidegrees clockwise from north; this direction is "up" on screen |
| 1     | `n`              | number of points, ≤36                                        |
| 5 × n | `points[]`       | `x` int16 dm, `y` int16 dm, `cls` uint8                      |
| 1     | `street_len`     | ≤ 240 − 17 − 5n − 1 (42 bytes with 36 points)                |
| …     | `street`         | name of the street after the maneuver                        |

**Road-shape frame.** The phone computes this frame from the rider's position snapped to the route and the
route's direction at that point (`heading_cdeg`). The rider is at the origin, **heading up**: +y is the rider's
direction of travel and +x is to the rider's right. Units are decimeters (±3276.7 m).
`points[0]` is at or near the origin. Each point's `cls` describes the segment that *ends*
at that point.

### Maneuver

| v  | Name          | v  | Name           |
|----|---------------|----|----------------|
| 0  | `NONE`        | 8  | `UTURN_LEFT`   |
| 1  | `STRAIGHT`    | 9  | `UTURN_RIGHT`  |
| 2  | `SLIGHT_LEFT` | 10 | `KEEP_LEFT`    |
| 3  | `LEFT`        | 11 | `KEEP_RIGHT`   |
| 4  | `SHARP_LEFT`  | 12 | `ROUNDABOUT`   |
| 5  | `SLIGHT_RIGHT`| 13 | `ARRIVE`       |
| 6  | `RIGHT`       | 14 | `DEPART`       |
| 7  | `SHARP_RIGHT` |    |                |

### Curvature class

Classes come from the turning radius `R` of the road, smoothed over about 30 m:

| v | Name       | Radius       |
|---|------------|--------------|
| 0 | `STRAIGHT` | R ≥ 400 m    |
| 1 | `GENTLE`   | 150 ≤ R < 400|
| 2 | `MEDIUM`   | 60 ≤ R < 150 |
| 3 | `SHARP`    | R < 60 m     |

## `ROADS` (0x05)

These are the streets around the rider, for the map view. To keep traffic low they aren't sent with
every update. The phone picks an **anchor** (the rider's position) and sends every street within about
700 m of it, in a fixed frame centered on that anchor:

- x is meters east of the anchor; y is meters north.
- One anchor set can span several frames.
- The phone sends the nearest streets first and caps a set at about 600 points.
- When the rider is 300 m from the anchor, the phone sends a new set with the next `anchor_id`.

| Size | Field       | Notes                                                    |
|------|-------------|----------------------------------------------------------|
| 1    | `anchor_id` | 1–255, wraps; 0 is never used                            |
| 1    | `part`      | 0-based index of this frame within the set               |
| 1    | `parts`     | number of frames in the set (≤32)                        |
| 1    | `nroads`    | streets in this frame                                    |
| per street | `len` u8, then `len` × (`x` int16 m, `y` int16 m) | ≤58 points per frame |

A street longer than one frame allows is split into pieces that share their joining point.

**Device behavior:**

1. Collect frames for an `anchor_id`.
2. Once all `parts` have arrived, swap the new set in.
3. Draw streets only when a `NAV` frame's `anchor_id` matches the set on screen.

To draw a street point P, first offset it by the NAV pose and rotate it into the heading-up frame:

```
e = P.x − pose_x/10,  n = P.y − pose_y/10,  h = heading_cdeg/100 (degrees)
x_rider = e·cos h − n·sin h      (right of the rider)
y_rider = e·sin h + n·cos h      (ahead of the rider)
```

The route `points` use this same frame, so streets and route line up exactly. The phone always sends
`ROADS` frames *before* the first `NAV` frame that refers to their anchor. It never drops `ROADS` frames
when the link is congested; it drops stale `NAV` frames instead.

## `TRIP` (0x02)

| Size | Field          | Notes                               |
|------|----------------|-------------------------------------|
| 1    | `speed_kmh`    | 0–255                               |
| 1    | `limit_kmh`    | 0 = unknown                         |
| 4    | `eta_epoch`    | uint32 Unix seconds, 0 = unknown    |
| 4    | `remaining_m`  | uint32                              |
| 1    | `phone_batt`   | 0–100, `0xFF` = unknown             |
| 4    | `now_epoch`    | uint32 Unix seconds (clock sync)    |
| 2    | `tz_offset_min`| int16 local offset from UTC         |

## `NOTIF` (0x03)

| Size | Field       | Notes                       |
|------|-------------|-----------------------------|
| 1    | `kind`      | 0 message, 1 call, 2 other  |
| 1+…  | `app`       | len u8 + bytes (≤24)        |
| 1+…  | `title`     | len u8 + bytes (≤48)        |
| 1+…  | `body`      | len u8 + bytes (rest)       |

## `STATE` (0x04)

| Size | Field   | Notes                                                       |
|------|---------|-------------------------------------------------------------|
| 1    | `state` | 0 idle, 1 navigating, 2 rerouting, 3 arrived, 4 gps_lost    |

## `MEDIA` (0x06)

| Size | Field        | Notes                                           |
|------|--------------|-------------------------------------------------|
| 1    | `state`      | 0 none (no active session), 1 playing, 2 paused |
| 1    | `volume_pct` | 0–100, `0xFF` = unknown                         |
| 1+…  | `title`      | len u8 + bytes (≤ 96)                           |
| 1+…  | `artist`     | len u8 + bytes (≤ 64)                           |

Strings are truncated by the sender on a UTF-8 code-point boundary.

## `DEV_STATUS` (0x81)

| Size | Field      | Notes          |
|------|------------|----------------|
| 1    | `batt_pct` | 0–100          |
| 2    | `batt_mv`  | uint16         |
| 1    | `charging` | 0/1            |
| 1    | `fw_ver`   | firmware build |

## `MEDIA_CMD` (0x82)

| Size | Field | Notes                                                               |
|------|-------|---------------------------------------------------------------------|
| 1    | `cmd` | 0 toggle play/pause, 1 next, 2 previous, 3 volume up, 4 volume down |

## Test vectors

`proto-vectors/` contains `<name>.bin` (one raw frame) and `<name>.txt`, a canonical
`key=value` dump with one field per line. The TypeScript encoder generates both
(`npm run gen:vectors` in `app/`). The C decoder's host test decodes every `.bin`,
prints the same dump, and diffs it against the `.txt`.
