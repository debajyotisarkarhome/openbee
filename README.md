# OpenBee

A DIY, open alternative to the Beeline Moto. It's a round handlebar display that shows turn-by-turn
directions on a **small heading-up map**: your route as a blue line over the streets around you, with
badges warning of sharp bends. The phone does the routing, GPS and map-data work and streams compact
frames over BLE; the display only draws.

- **Display:** Waveshare ESP32-S3-Touch-LCD-1.28(-B): 240×240 GC9A01, CST816S touch, ESP-IDF + LVGL 9.
- **Phone:** React Native (Expo SDK 58) app for Android and iOS, using GraphHopper for routing and
  geocoding, and OpenStreetMap (Overpass) for the streets around you.
- **Protocol:** [`docs/protocol.md`](docs/protocol.md), with shared test vectors in `proto-vectors/`.

```
app/        React Native app. src/core = pure-TS nav engine, protocol, simulator (jest-tested)
firmware/   ESP-IDF project. components: board, ble_link, proto, ui
docs/       BLE protocol spec
```

## Display screens

Swipe left and right to move between views. Tap the Trip or Status view to return to Nav.

- **Nav:** shows the turn arrow and the distance to the turn. Below them is a heading-up map, about
  300 m deep. Your route is a blue line, the streets around it are grey, and a white dot marks where the
  turn happens. Medium and sharp bends get an orange or red badge with a chevron for their direction,
  and a chip warns of the next one, for example "SHARP LEFT 150 m". The bottom shows your speed, the
  speed limit and the street name.
- **Trip:** clock, arrival time and distance left.
- **Status:** device battery, phone battery and link state. **Long-press it to toggle demo mode**, which
  rides a built-in curvy road with side streets so you can check the screen without a phone.
- **Overlays:** phone notifications, plus banners for Rerouting, GPS lost, Arrived and No phone.

## Firmware

You need ESP-IDF **v5.5.x**.

```powershell
. C:\Espressif\esp-idf-v5.5.6\export.ps1
cd firmware
idf.py set-target esp32s3     # first time only
idf.py build flash monitor    # add -p COMx if needed
```

Pins default to the Waveshare ESP32-S3-Touch-LCD-1.28 pinout: LCD DC 8, CS 9, SCLK 10, MOSI 11,
RST 14, BL 2; touch SDA 6, SCL 7, INT 5, RST 13; battery ADC GPIO1. You can change them under
`idf.py menuconfig` → *OpenBee board pins*, along with the battery divider ratio and the option to
boot into demo mode.

To run the host tests for the protocol decoder (needs any gcc):

```sh
sh firmware/test/host/run.sh
```

## App

```sh
cd app
npm install
cp .env.example .env.local      # then put your GraphHopper API key in it (free at graphhopper.com)
npm test                        # nav engine, protocol, session tests
npx expo run:android            # or run:ios, or: npx eas-cli build --profile development
```

The app uses native modules (BLE, MapLibre, background location), so it needs a **development build**.
Expo Go won't work.

### Browser simulator

To try the display without hardware, run `npm run build:sim` and open `app/sim/dist/openbee-display-sim.html`
in a browser. It runs the real nav engine and protocol, and draws the screen with a canvas port of
`ui.c`.

### Testing without riding

Plan a route and tap **Simulate ride**. The app replays the route at 50 km/h through the full pipeline
(nav engine → BLE → display), using fake GPS.

### After changing the protocol

Run `npm run gen:vectors` in `app/`, then run both test suites (`npm test` and `firmware/test/host/run.sh`).

## Status and known gaps

- **Not tested on real hardware yet.** Check the display orientation and the touch axes first.
  `esp_lvgl_port` rotation is set in `firmware/components/board/board.c`.
- **Notification forwarding isn't built yet.** It will use an Android `NotificationListenerService`
  module on the phone and ANCS on the device for iPhone.
- Street names render in Latin script only (the Montserrat fonts).
- Map streets come from the public Overpass API, which is rate limited. They're fetched for the first
  60 km of a route when the ride starts. Without network access the map shows only your route.
- The BLE link is unencrypted, with no bonding.
- Power, mounting and weatherproofing are still open.
