# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

OpenBee is a DIY Beeline Moto: a 240×240 round ESP32-S3 handlebar display that shows turn-by-turn
directions over a heading-up map. **The phone does all the work** (routing, GPS, snapping, curvature
analysis, street fetching, framing); the device only decodes frames and draws. Any new feature should
be pushed onto the phone side unless it genuinely needs to be on-device.

Three parts: `app/` (Expo React Native), `firmware/` (ESP-IDF + LVGL 9), `docs/protocol.md` +
`proto-vectors/` (the contract between them). `app/AGENTS.md` holds Expo-specific rules — read it
before touching anything Expo/EAS/React Native.

## Commands

App (`cd app`):
```sh
npm install
cp .env.example .env.local        # EXPO_PUBLIC_GRAPHHOPPER_KEY (geocoding only)
npm test                          # jest (jest-expo preset), src/core/__tests__
npm test -- nav.test.ts           # one file
npm test -- -t 'NavEngine'        # one describe/test by name
npm run typecheck                 # tsc --noEmit
npm run lint                      # expo lint
npx expo run:android              # or run:ios — needs a dev build, Expo Go won't work
npm run build:sim                 # → sim/dist/openbee-display-sim.html (open in a browser)
npm run gen:vectors               # rewrite proto-vectors/ from the TS encoder
```

Firmware (ESP-IDF **v5.5.x**, source `export.ps1`/`export.sh` first):
```sh
cd firmware
idf.py set-target esp32s3         # first time only
idf.py build flash monitor        # -p PORT if needed
idf.py menuconfig                 # → "OpenBee board pins" (pins, battery divider, boot-in-demo)
sh firmware/test/host/run.sh      # host C decoder test vs proto-vectors/ (needs any gcc, no IDF)
```

## Architecture

### The one data path

```
GPS fix (expo-location bg task) ─┐
ride simulator ──────────────────┴→ NavSession.onFix()
   → NavEngine.update()      snap to route, progress, off-route/arrive/gps-lost, ETA
   → extractShape()          route ahead in rider frame + curvature classes + next-curve warning
   → RoadMap.update()        new ROADS anchor set when the rider moved 300 m
   → encodeNav/Trip/State/Roads → DeviceLink.send() → BLE write
      → firmware on_rx → queue → proto_decode() → ui_apply() → LVGL
```

`src/services/runtime.ts` is the single place where platform singletons (`link`, `session`) are built
and wired to GPS, battery and the simulator; screens read them through `useSyncExternalStore` hooks
in `src/ui/hooks.ts`. `NavSession` takes all platform access as injected `SessionDeps`, which is why
it runs unmodified under jest and in the browser simulator.

### `app/src/core/` must stay platform-free

No React Native or Expo imports in `src/core/**` (nor in `app/sim/**`). Three consumers depend on it:
jest, `tsx scripts/gen-vectors.ts` under plain Node, and the esbuild browser bundle. Platform code
belongs in `src/services/`, UI in `src/ui/` and `src/app/` (Expo Router routes — screens only).

### The protocol is implemented three times

| | role |
|---|---|
| `docs/protocol.md` | the spec; update it first |
| `app/src/core/proto.ts` | encode all phone→device types, decode everything, `dump()` |
| `firmware/components/proto/proto.c` | decode phone→device, encode `DEV_STATUS` |
| `proto-vectors/*.bin` + `.txt` | written by the TS encoder, diffed by the C decoder |

The `.txt` files are canonical `key=value` dumps. `dump()` in `proto.ts` and `dump()` in
`firmware/test/host/proto_vectors_test.c` must produce **byte-identical** output — that equality is
the entire cross-language test.

**After any protocol change:** edit `docs/protocol.md` → `proto.ts` → `proto.c` (+ both `dump()`s) →
`cd app && npm run gen:vectors` → run **both** `npm test` and `sh firmware/test/host/run.sh`, and
commit the regenerated vectors.

Hard limits that the encoders, the decoder and the tests all encode: 244-byte frame (4-byte header +
≤240 payload), `MAX_POINTS = 36` route points per NAV, `MAX_ROAD_POINTS_PER_FRAME = 58`, ≤32 parts
per ROADS set, ~600 points per anchor. Strings are length-prefixed UTF-8, never NUL-terminated, and
truncated by the sender on a code-point boundary. Everything is little-endian.

### Where routes come from

`services/routing.ts` is the entry point. `fetchRoutes` queries Valhalla twice in parallel — `fast` and
`curvy` costings (`services/valhalla.ts`, public FOSSGIS instance, `costing: motorcycle`) — then
de-duplicates on `lengthM:timeMs:points.length` and sorts by duration. **There is deliberately no road
preference setting:** the plan screen's picker is the choice, so nothing can disagree with the route the
rider actually selected. `fetchRoute` (used only for mid-ride rerouting) asks for `fast` with zero
alternates. GraphHopper is a single-route fallback — its free tier allows neither the motorcycle profile
nor alternatives, so it cannot be primary.

`core/route.ts` holds both parsers. `routeFromValhalla` decodes leg shapes with `core/polyline.ts`
(**precision 6** — decoding at 5 silently lands 100°+ away, which there is a test for) and maps
Valhalla's maneuver `type` ints via `maneuverFromValhallaType`, whose values come from
`proto/descriptors/directions.proto` in the Valhalla repo, not from guesswork. Valhalla sends no speed
limits, so `Route.maxSpeed` is empty and the device shows `limit_kmh = 0` (unknown).

### Where map streets come from

`SessionDeps.fetchStreets(center, radiusM)` is called **per ROADS anchor**, just in time — not as an
up-front corridor prefetch. `services/streets.ts` tries OpenFreeMap vector tiles first
(`services/tiles.ts`, z14, OpenMapTiles `transportation` layer, ~2 tiles per 700 m anchor, cached) and
falls back to Overpass (`services/osm.ts`, several mirrors, main instance last — it is chronically
overloaded). The slippy-map maths lives in `core/tiles.ts` so it stays dependency-free and testable;
only the fetch and MVT decode sit in `services/`.

`RoadMap` issues a new anchor **only when fresh streets arrive** (`setRoads` clears the anchor).
Re-anchoring on distance alone would retransmit the old set over BLE for nothing. If the rider outruns
the set by more than `radiusM` and no new streets land, the set is dropped so `pose()` reports anchor 0
and the device stops drawing stale streets. `NavSession` exposes `streets` (via `RoadMap.riderFrame`)
and `roadsError` on `SessionView`, so the phone mirrors the display and says why streets are missing.

### Two coordinate frames — the easiest thing to get wrong

- **ROADS (anchor) frame:** meters east/north of an anchor lat/lon the phone picks (`RoadMap` in
  `core/roads.ts`). Reused for ~300 m of riding, then a new `anchor_id` is issued.
- **NAV (rider) frame:** decimeters, rider at the origin, **+y = direction of travel, +x = right**
  (`core/shape.ts`). Every NAV frame carries `pose_x/pose_y/heading_cdeg` so the device can rotate
  anchor-frame streets into the rider frame itself (`draw_streets()` in `ui.c`; the rotation is
  spelled out in `docs/protocol.md`).

Two ordering invariants live in `NavSession.onFix` and must be preserved: ROADS frames are sent
**before** the first NAV frame that references their `anchor_id`, and ROADS frames are never dropped
under congestion — stale NAV frames are dropped instead.

### The display screen is rendered three times

`firmware/components/ui/ui.c` is the source of truth (LVGL tileview: Nav / Engine / Media / Status / Settings, plus state
banner and notification overlay; all `ui_*` functions take the LVGL port lock internally so they're
callable from any task). Which pages show and their swipe order come from the app's `LAYOUT` frame
(`apply_layout()` repositions the existing tiles, it doesn't rebuild them; the device keeps the last layout in
NVS; Nav is always shown). `app/sim/display.ts` is a hand-maintained canvas port — same coordinates,
colors, auto-zoom, arrow geometry — and `app/src/ui/RoadShape.tsx` draws a simpler in-app version.
A change to the on-screen layout or palette in `ui.c` should be mirrored into `display.ts`.

### Engine data (OBD-II) is the one thing the device does on its own

The one deliberate exception to "the phone does the work": `components/obd` makes the device a BLE
**central** to a BLE ELM327 adapter (found by service `FFF0`/`FFE0` or an OBD-ish name, accepted only if
`ATZ` answers "ELM327"), alongside its peripheral link to the phone (`BT_NIMBLE_MAX_CONNECTIONS=2`,
`ROLE_OBSERVER=y`). Its own task polls mode 01 (RPM/speed/throttle fast, coolant/load slower, `ATRV`
battery) and hands an `obd_data_t` to `main.c`, which maps it to `ui_engine_t` for the Engine page. Engine
data never touches the phone protocol. `obd_parse.c` is pure C with a host test (`obd_parse_test.c`) built
from a real adapter's replies. Classic-Bluetooth (SPP) ELM327s can't work: the ESP32-S3 has no BR/EDR.

### Double knock → Siri

`components/imu` polls the QMI8658 (shared I2C bus with touch) at ~1 kHz; the accelerometer runs at ~897 Hz
with its low-pass off, because a knuckle knock rings out in a few ms and 224 Hz sampling missed its peak.
`knock.c` (pure C, `knock_test.c`) wants two short spikes 120–500 ms apart after a calm spell, and no third.
A double knock makes the device press a **BLE HID** consumer button: `ble_link.c` also exposes HID-over-GATT
(+ Device Information, Battery). iOS opens Siri for Voice Command (0xCF) only if it's **held** (1.5 s; an
80 ms tap was ignored). iOS caches the report map per bond: **changing `HID_REPORT_MAP` means every user has
to forget and re-pair the display**, so it keeps the unused Play/Pause and AC Search bits from that experiment.

### Firmware main loop

`main/main.c` owns everything: BLE RX callbacks only copy-and-queue, the loop drains the queue,
decodes, and calls `ui_apply`. Callbacks that fire inside the LVGL task (demo toggle) set an atomic
flag the loop picks up. Demo mode (`main/demo.c`) synthesizes NAV/TRIP/ROADS from a built-in curvy
road, and while it's on, phone frames other than `NOTIF` are ignored.

## Testing without hardware

Three escalating options: the **browser simulator** (`npm run build:sim`) runs the real engine and
protocol against the canvas display port; **Simulate ride** in the app replays a route at 50 km/h
through the whole pipeline to a real device over BLE; **demo mode** on the device (long-press Status,
or `CONFIG_OPENBEE_DEMO_MODE`) runs standalone with no phone.

## Known gaps to keep in mind

First flashed to real hardware on 2026-10-28: the device boots and iPhone media control (AMS) works.
Display rotation (set in `components/board/board.c`) and touch axes haven't been checked on their own
yet, and the Android media module (`app/modules/openbee-media`) has never been compiled. Notification
forwarding (iOS ANCS, Android notifications) is specified in the protocol and drawn by the UI but has
no implementation. Android's `NotificationListenerService` exists only to authorise
`getActiveSessions`, and forwards nothing. Street names are
Latin-script only (Montserrat fonts). The BLE link is unencrypted with no bonding.
