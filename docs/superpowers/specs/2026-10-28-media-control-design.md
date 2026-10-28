# Media control — design

## Intent

The rider wants to control phone music from the handlebar display: play/pause, next, previous, and
volume, and see what is playing (title, artist, play state). They ride with gloves, have only the
touchscreen (no handlebar buttons), and the feature must work with **both Android and iPhone**.

The rider was explicit that **nothing media-related appears on the Nav screen**: no strip, no
track-change popup, no icon. Navigation stays exactly as it is. Media lives on its own page.

## Goals

- A new **Media page** on the device, one swipe right of Nav.
- It shows the title, artist and play state of whatever the phone is playing (Spotify, YouTube Music,
  Apple Music and so on), and its volume as a ring.
- Glove-sized buttons: previous, play/pause, next, volume −, volume +.
- Works on Android (through the OpenBee app) and iOS (directly, through Apple's AMS).

## Non-goals

- Album art, a seek bar or track progress, playlists, browsing, shuffle and repeat.
- Notification forwarding (`NOTIF`). It is a separate, still unimplemented gap; it overlaps with the
  Android native work here, but it is not part of this design.
- Showing or controlling media in the phone app's own UI, beyond the one permission row described below.
- Non-Latin titles. The device fonts are Montserrat (Latin only), a known gap; non-Latin glyphs
  render however LVGL renders missing glyphs today.

## Anti-goals (would make this a failure even if it works)

- Anything media-related on the Nav screen.
- Controls that overlap or crowd each other on the round display, or are too small for gloves.
- A media feature that degrades navigation: a frame that delays or drops `ROADS`, a crash in the AMS
  client that kills the BLE link, or a pairing prompt that blocks Android riders.

## Look (approved mockup)

The rider approved this mockup (`.superpowers/brainstorm/…/media-layout-v2.html`, not committed). It uses
the existing palette (`C_BG`, `C_TEXT`, `C_DIM`, `C_ACCENT`, `C_PANEL`, `C_PH_RING` in `ui.c`):

| Element | Position (240×240, px) | Notes |
|---|---|---|
| Volume ring | 6 px inset, 6 px stroke | track `C_PH_RING`; fill `C_ACCENT` proportional to volume; hidden or empty when volume unknown |
| Title | top ≈ 44, width ≈ 130, centered | Montserrat 20 (the mockup used ~17 px; 20 is the nearest existing font), one line, ellipsis |
| Artist | top ≈ 68, width ≈ 120, centered | Montserrat 14, `C_DIM`, one line, ellipsis |
| Prev | 48 px circle, center (54, 120) | `C_PANEL`, `LV_SYMBOL_PREV` |
| Play/Pause | 70 px circle, center (120, 120) | `C_ACCENT` fill, black `LV_SYMBOL_PLAY` / `LV_SYMBOL_PAUSE` |
| Next | 48 px circle, center (186, 120) | `C_PANEL`, `LV_SYMBOL_NEXT` |
| Vol − | 44 px circle, center (92, 190) | `C_PANEL`, `LV_SYMBOL_MINUS` |
| Vol + | 44 px circle, center (148, 190) | `C_PANEL`, `LV_SYMBOL_PLUS` |

Hard constraints: no two elements overlap, and every button sits inside the ring with ≥ 7 px between
buttons. The exact pixel values are the builder's to adjust if the real fonts need it, as long as those
constraints hold. Pressed state: the same pre-mixed accent tint the Settings buttons use (`0x0E2A36`).

**Nothing playing / no source:** title "Nothing playing", artist empty, ring empty, all buttons still
active. Play then asks the phone to resume the last session. **(Builder's call, flagged by me:** this
was my guess and the rider did not object.)

**Tapping the background does not return to Nav** (Trip and Status do that). On a page full of
buttons, a near-miss with a glove should not throw the rider off the page. **(My call.)**

## Tile order

`Nav(0) → Media(1) → Trip(2) → Status(3) → Settings(4)`. Nav keeps `LV_DIR_RIGHT` only. Update the
`back_to_nav` behavior, the tile indices, and `app/sim/display.ts` to match.

## Architecture

Two sources feed one device-side model:

```
Android: MediaSession (any app) ─→ OpenBee app (native module) ─→ MEDIA 0x06 ─→ device
         device button ─→ MEDIA_CMD 0x82 ─→ OpenBee app ─→ MediaController / AudioManager

iOS:     iPhone AMS service ←─ GATT client on the device (no app involvement) ─→ device
```

On the device, both paths produce the same `media_msg_t` and go through the **same main-loop path**
as other frames (queue → `ui_apply`), so LVGL is only touched from the main loop. The AMS client
runs in the NimBLE host task and must only copy and queue, the same rule `on_rx` follows.

When a button is pressed, the UI calls a `ui_media_cb_t(cmd)` callback (inside the LVGL task, so it
only sets an atomic or queues). The main loop routes the command:

- **AMS active** (an iPhone connected, bonded, AMS discovered and subscribed): write the matching AMS
  Remote Command.
- **Otherwise:** notify `MEDIA_CMD` on TX. If nobody is subscribed, the press does nothing.

### Protocol (bump nothing; v1 is additive)

`docs/protocol.md` first, then `proto.ts`, `proto.c`, both `dump()`s, then `npm run gen:vectors`, both test
suites, and commit the vectors (per CLAUDE.md).

**`MEDIA` (0x06), phone → device**, on change, plus once on connect:

| Size | Field        | Notes |
|------|--------------|-------|
| 1    | `state`      | 0 none (no active session), 1 playing, 2 paused |
| 1    | `volume_pct` | 0–100, `0xFF` = unknown |
| 1+…  | `title`      | len u8 + bytes (≤ 96) |
| 1+…  | `artist`     | len u8 + bytes (≤ 64) |

The encoder truncates on a UTF-8 code-point boundary (`utf8Truncate`), as for other strings.

**`MEDIA_CMD` (0x82), device → phone**, on button press:

| Size | Field | Notes |
|------|-------|-------|
| 1    | `cmd` | 0 toggle play/pause, 1 next, 2 previous, 3 volume up, 4 volume down |

Add the C encoder `proto_encode_media_cmd` beside `proto_encode_dev_status`, plus TS `decode` support.
New vectors at minimum: `media_playing` (UTF-8 title), `media_none`, `media_cmd_next`.

`demo` mode: `MEDIA` frames pass through like `NOTIF` (media is independent of navigation).

### iOS: Apple Media Service (AMS) client in firmware

New component `firmware/components/ams/`. Apple's AMS spec defines the service
`89D3502B-0F36-433A-8EF4-C502AD55F8DC` with three characteristics: Remote Command, Entity Update and
Entity Attribute.

- After connect, discover services on the peer. AMS exists only on iPhones; if it is absent (Android),
  do nothing else. **No pairing is ever requested from an Android phone.**
- If AMS is present, subscribe to Entity Update. The resulting "insufficient authentication" error
  makes iOS show its system pairing prompt. Use `ble_gap_security_initiate` if needed.
- Register for Player: PlaybackInfo (state is the first comma-separated field), Volume (float 0–1 →
  percent). Register for Track: Title, Artist. Handle the truncated-attribute flag: titles longer than
  one notification are fine truncated, so fetching the full value through Entity Attribute is optional.
- Map the commands: toggle → `TogglePlayPause` (2), next → `NextTrack` (3), previous → `PreviousTrack` (4),
  volume up → `VolumeUp` (5), volume down → `VolumeDown` (6).
- Volume reaches AMS ≈ 0–1 in steps the iPhone picks; one press is one step.

**Bonding (required for AMS).** NimBLE security manager: bonding on, LE Secure Connections on, IO
capability `NoInputNoOutput` (Just Works; the device has no keypad and no numeric display path). Persist
bonds in NVS (`CONFIG_BT_NIMBLE_NVS_PERSIST=y`, `ble_store_config_init()`). Handle
`BLE_GAP_EVENT_REPEAT_PAIRING` by deleting the old bond and retrying, so an iPhone that "forgot" the
device can re-pair. The OpenBee service itself keeps **no** encryption requirement, so Android and the
current app keep working unchanged.

**sdkconfig.** The device stays a peripheral but now needs the GATT **client** role toward the iPhone.
Check which ESP-IDF 5.5 NimBLE options enable `ble_gattc_*` with `ROLE_CENTRAL=n` (for example
`CONFIG_BT_NIMBLE_GATT_CLIENT`), and turn on only what is needed.

The AMS code lives behind a small interface (`ams_init(on_media, ...)`, `ams_send(cmd)`, `ams_active()`)
and is called from `ble_link`'s GAP event handler (connect, disconnect, encryption change). It must not
block the host task, and a malformed AMS notification must never crash or disconnect.

The iOS app needs **no** change for this. The rider's existing app connection is the same LE link
that AMS uses; iOS asks once to pair.

**If the rider declines the pairing prompt:** the device makes no further attempt on that connection.
On the next connection it tries once more. Nothing is persisted, so there is no "declined" flag and
no reset. The Media page shows "Nothing playing" until pairing succeeds. **(My call.)**

### Android: native media module in the app

Read `app/AGENTS.md` first (Expo SDK 58; CNG, so no hand-edited `android/`). Create a **local Expo
module** (`npx create-expo-module --local`, e.g. `app/modules/openbee-media`), Android-only (iOS stub
returns "unsupported"):

- A `NotificationListenerService` subclass, declared in the module's `AndroidManifest.xml` with
  `BIND_NOTIFICATION_LISTENER_SERVICE`. It exists only so that
  `MediaSessionManager.getActiveSessions(componentName)` is allowed. It does not forward notifications.
- Track the active controller: listen with `addOnActiveSessionsChangedListener`, pick the first
  controller (the one most recently active), and attach a `MediaController.Callback` for metadata and
  playback-state changes.
- Emit one JS event `onMediaChanged { state, title, artist, volumePct }`. `volumePct` comes from
  `AudioManager.STREAM_MUSIC` (current/max), refreshed on volume changes.
- Functions: `isPermissionGranted()`, `openPermissionSettings()`
  (`ACTION_NOTIFICATION_LISTENER_SETTINGS`), and `command(cmd)`. The commands map to
  `transportControls.play/pause` (toggle from the current state; when no controller exists, a
  `KEYCODE_MEDIA_PLAY` key event through `AudioManager.dispatchMediaKeyEvent` resumes the last player),
  `skipToNext`, `skipToPrevious`, and `adjustStreamVolume(STREAM_MUSIC, ADJUST_RAISE/LOWER, 0)`.

**Wiring (platform code, `src/services/`):** a new `services/media.ts` subscribes to the module and
encodes `MEDIA` frames through `link.send`. It sends on change, and the latest state on
`link.onConnected` (which today only calls `session.onDeviceConnected()`; it needs to fan out). It
de-duplicates identical frames. `DeviceLink`'s TX handler today only handles `DEV_STATUS`; route
`MEDIA_CMD` to the media service. Keep `src/core/` platform-free: only the `proto.ts` encode and decode
go there.

**Congestion:** `MEDIA` is small and infrequent. Never drop it under backpressure (only `NAV` is
dropped today; keep it that way).

**Permission UX:** one row on the Settings screen: "Media controls on display". It shows granted or not
granted, and a tap opens the notification-access settings. Hide the row on iOS. Re-check on app
foreground.

**Known limit:** the relay lives in JS, so on Android media control works while the app process and
its BLE connection are alive. In practice that means while it is connected to the display, which is
already true for navigation. Don't build anything extra to keep it running outside a ride.

### Simulator

`app/sim/display.ts` mirrors the Media page (same layout, colors and ring), per the CLAUDE.md rule
that the display is rendered in three places. The browser sim feeds it a fixed fake `MEDIA` frame and
logs `MEDIA_CMD` presses. `RoadShape.tsx` is unaffected.

## Testing

- `proto.test.ts`: MEDIA and MEDIA_CMD round-trips, string truncation, and `volume_pct = 0xFF`.
- Host C test: the new vectors pass `firmware/test/host/run.sh`.
- AMS parsing: keep the attribute parsing (PlaybackInfo CSV, volume float, the entity update header) in
  a plain-C function with no IDF dependencies, and add it to the host test.
- On the bench, with real hardware (none is verified yet): pair an iPhone, check that Spotify and
  Apple Music update the page and that all five buttons work; on Android, grant access, check
  Spotify and YouTube Music; confirm that the Android connection never shows a pairing prompt.

## Left to the builder

- Exact pixel nudges within the layout constraints above, and the press feedback.
- How the AMS and NimBLE GATT-client config is enabled in ESP-IDF 5.5.
- The internal module structure in Kotlin, and the event and function names.
- Whether to fetch the full AMS title through Entity Attribute when it is truncated.
