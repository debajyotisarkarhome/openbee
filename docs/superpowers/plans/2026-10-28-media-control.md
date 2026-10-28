# Media Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Media page on the device, one swipe right of Nav, that shows and controls phone playback:
on Android through the OpenBee app, on iPhone through Apple's AMS.

**Architecture:** Additive protocol v1 types `MEDIA` (0x06, phone→device) and `MEDIA_CMD` (0x82,
device→phone). Both sources produce one `media_msg_t` on the device and reach `ui_apply` from the main
loop. Button presses go back out through a `ui_media_cb_t`, and the main loop routes them to AMS (when
it is active) or to a `MEDIA_CMD` notify. On Android, a local Expo module wraps
`MediaSessionManager` and `AudioManager`, and a platform-free `MediaRelay` in `src/core/` does the
encoding, de-duplication and command routing.

**Tech Stack:** ESP-IDF 5.5 + NimBLE + LVGL 9 (C); Expo SDK 58 / React Native 0.88 / TypeScript; a
Kotlin local Expo module; jest; host gcc tests.

**Spec:** `docs/superpowers/specs/2026-10-28-media-control-design.md`

## Global Constraints

- **Nothing media-related on the Nav screen**: no strip, no popup, no icon.
- Tile order `Nav(0) → Media(1) → Trip(2) → Status(3) → Settings(4)`; Nav keeps `LV_DIR_RIGHT` only.
- No two Media-page elements overlap; every button lies inside the volume ring with ≥ 7 px between buttons.
- The Media page has **no** tap-to-go-back (Trip and Status keep theirs).
- No pairing is ever requested from an Android phone. The OpenBee service keeps no encryption requirement.
- `src/core/**` and `app/sim/**` stay free of React Native and Expo imports.
- Protocol change order (CLAUDE.md): `docs/protocol.md` → `proto.ts` → `proto.c` + both `dump()`s →
  `npm run gen:vectors` → `npm test` **and** `sh firmware/test/host/run.sh` → commit the vectors.
- Strings are length-prefixed UTF-8, truncated on a code-point boundary: `title` ≤ 96 bytes, `artist` ≤ 64.
- `MEDIA` is never dropped under BLE backpressure (only `NAV` is).
- Everything works on `master` (the user asked for no feature branches). Commit after each task.

## Review Focus

1. **Oversized strings from a misbehaving sender:** a `MEDIA` frame whose `title` length byte is greater than 96
   must be rejected by `proto_decode`, never copied into a 97-byte buffer → test in Task 2.
2. **The volume ring swallowing touches:** an `lv_arc` is hit-tested over its whole 240×240 box (see the
   `bright_arc_hit_test` comment in `ui.c`), so a display-only ring would eat every button press and
   swipe. The ring must be non-clickable → bench check in Task 3.
3. **Stale track after disconnect:** when BLE drops, the Media page must go back to "Nothing playing",
   not keep the last song → main-loop step in Task 3, `MediaRelay` reconnect test in Task 7.
4. **AMS strings cut mid-character:** a long iPhone title truncated to 96 bytes must end on a UTF-8
   boundary → `ams_parse` test in Task 4.
5. **Android without the permission:** `getActiveSessions` throws `SecurityException`. The module must
   report state NONE and not crash, and the commands must not crash → Task 6 (native guard) and Task 7
   (relay sends NONE).

---

### Task 1: Protocol spec + TypeScript codec + vectors

**Files:**
- Modify: `docs/protocol.md` (type table + two new sections; copy the tables from the spec's *Protocol* section)
- Modify: `app/src/core/proto.ts`
- Modify: `app/scripts/gen-vectors.ts`
- Test: `app/src/core/__tests__/proto.test.ts`

**Interfaces:**
- Produces (in `proto.ts`):
  ```ts
  MsgType.MEDIA = 0x06, MsgType.MEDIA_CMD = 0x82
  export const MEDIA_TITLE_MAX = 96, MEDIA_ARTIST_MAX = 64;
  export enum MediaState { NONE = 0, PLAYING = 1, PAUSED = 2 }
  export enum MediaCmd { TOGGLE = 0, NEXT = 1, PREV = 2, VOL_UP = 3, VOL_DOWN = 4 }
  export interface MediaMsg { state: MediaState; volumePct: number | null; title: string; artist: string }
  export function encodeMedia(m: MediaMsg): Uint8Array      // volumePct null → 0xFF, else clamp 0–100
  export function encodeMediaCmd(cmd: MediaCmd): Uint8Array
  // Decoded gains: { type: MsgType.MEDIA; msg: MediaMsg } | { type: MsgType.MEDIA_CMD; msg: { cmd: MediaCmd } }
  ```
- `dump()` lines: `type=MEDIA`, `state=<n>`, `volume_pct=<0–100|255>`, `title=…`, `artist=…`;
  and `type=MEDIA_CMD`, `cmd=<n>`.

- [ ] **Step 1: Write the failing tests** in `proto.test.ts`:
  - `MEDIA round-trips`: `decode(encodeMedia({state: PLAYING, volumePct: 42, title: 'Bohemian Rhapsody', artist: 'Queen'}))` deep-equals the input.
  - `MEDIA unknown volume`: `volumePct: null` → byte 5 of the frame is `0xFF`, and it decodes back to `null`.
  - `MEDIA truncates on code points`: a title of 40 × `'é'` (80 bytes) + 10 × `'日'` (30 bytes) encodes a 95-byte title (the next `'日'` would make 98 > 96, so it is dropped whole), decodes without `U+FFFD`, and `decoded.title` is a prefix of the input.
  - `MEDIA_CMD round-trips`: for every `MediaCmd`, `decode(encodeMediaCmd(c)).msg.cmd === c`, and the frame length is 5.
- [ ] **Step 2: Run** `cd app && npm test -- proto.test.ts`. Expected: FAIL (`encodeMedia` is not exported).
- [ ] **Step 3: Implement** the interfaces above in `proto.ts`, following the `encodeNotif` and `encodeDevStatus` pattern; add both cases to `decode` and `dump`.
- [ ] **Step 4: Add vectors** in `gen-vectors.ts`:
  `media_playing: encodeMedia({state: PLAYING, volumePct: 60, title: 'Für Elise — Remastered', artist: 'Beethoven'})`,
  `media_none: encodeMedia({state: NONE, volumePct: null, title: '', artist: ''})`,
  `media_cmd_next: encodeMediaCmd(MediaCmd.NEXT)`.
- [ ] **Step 5: Run** `npm test`, `npm run typecheck`, `npm run gen:vectors`. Expected: all pass; six new files appear in `proto-vectors/`.
  (`sh firmware/test/host/run.sh` now **fails** on the new vectors. That's expected, and Task 2 fixes it.)
- [ ] **Step 6: Commit** `docs/protocol.md app/src/core/proto.ts app/scripts/gen-vectors.ts app/src/core/__tests__/proto.test.ts proto-vectors/` with the message "Protocol: MEDIA and MEDIA_CMD (spec, TS codec, vectors)".

### Task 2: C decoder + encoder + host test

**Files:**
- Modify: `firmware/components/proto/include/proto.h`, `firmware/components/proto/proto.c`
- Test: `firmware/test/host/proto_vectors_test.c`

**Interfaces:**
- Consumes: the vectors from Task 1.
- Produces (in `proto.h`):
  ```c
  MSG_MEDIA = 0x06, MSG_MEDIA_CMD = 0x82
  #define PROTO_MEDIA_TITLE_MAX 96
  #define PROTO_MEDIA_ARTIST_MAX 64
  #define PROTO_UNKNOWN_VOLUME 0xFF
  typedef enum { MEDIA_NONE = 0, MEDIA_PLAYING, MEDIA_PAUSED } media_state_t;
  typedef enum { MEDIA_CMD_TOGGLE = 0, MEDIA_CMD_NEXT, MEDIA_CMD_PREV, MEDIA_CMD_VOL_UP, MEDIA_CMD_VOL_DOWN } media_cmd_t;
  typedef struct { uint8_t state; uint8_t volume_pct; char title[PROTO_MEDIA_TITLE_MAX + 1]; char artist[PROTO_MEDIA_ARTIST_MAX + 1]; } media_msg_t;
  // union gains: media_msg_t media; uint8_t media_cmd;
  size_t proto_encode_media_cmd(uint8_t cmd, uint8_t *buf); // buf ≥ 5, returns 5
  ```

- [ ] **Step 1: Write the failing tests:** add `MSG_MEDIA` and `MSG_MEDIA_CMD` cases to the host `dump()` (byte-identical format to Task 1). Add `test_media_cmd_encode(dir)`, which compares `proto_encode_media_cmd(MEDIA_CMD_NEXT, buf)` to `media_cmd_next.bin`, as `test_dev_status_encode` does. In `test_malformed`, add `media_title_too_long`: a MEDIA frame with `state=1, vol=10, title len=97` + 97 bytes + `artist len=0` → `CHECK(!proto_decode(...))`. Do the same for an artist length of 65.
- [ ] **Step 2: Run** `sh firmware/test/host/run.sh`. Expected: FAIL (no `MSG_MEDIA`).
- [ ] **Step 3: Implement** the decode cases and `proto_encode_media_cmd`. Add a `rd_str_max(reader_t*, char *dst, size_t max)` that sets `ok = false` when `n > max`. Use it for both media strings.
- [ ] **Step 4: Run** `sh firmware/test/host/run.sh` and `cd app && npm test`. Expected: `all host tests passed`, with the vector count up by 3; jest green.
- [ ] **Step 5: Commit** with the message "Firmware proto: decode MEDIA, encode MEDIA_CMD".

### Task 3: Firmware Media page + command routing (no AMS yet)

**Files:**
- Modify: `firmware/components/ui/ui.c`, `firmware/components/ui/include/ui.h`, `firmware/main/main.c`

**Interfaces:**
- Consumes: `media_msg_t`, `MSG_MEDIA`, `proto_encode_media_cmd`, `ble_link_send`.
- Produces:
  ```c
  /** Media page button. Called inside the LVGL task: only copy/flag, never block. cmd is a media_cmd_t. */
  typedef void (*ui_media_cb_t)(uint8_t cmd);
  void ui_init(lv_display_t *disp, const char *device_name, ui_demo_toggle_cb_t on_demo_toggle, uint8_t brightness,
               ui_brightness_cb_t on_brightness, ui_media_cb_t on_media_cmd);
  // ui_apply handles MSG_MEDIA.
  // main.c: static void media_route(uint8_t cmd);  — Task 5 adds the AMS branch.
  ```

- [ ] **Step 1: Tiles:** add `s.tile_media` at index 1 (`LV_DIR_LEFT | LV_DIR_RIGHT`), and shift Trip, Status and Settings to 2, 3 and 4 (Settings keeps `LV_DIR_LEFT`). `back_to_nav` still targets index 0.
- [ ] **Step 2: `build_media(t)`:** use the spec's layout table as is. Use an `lv_arc` for the ring with `lv_obj_remove_flag(arc, LV_OBJ_FLAG_CLICKABLE)` and no knob (Review Focus 2). Use 360° bg angles, range 0–100 and `C_PH_RING`/`C_ACCENT`. Title: Montserrat 20, width 130, `LV_LABEL_LONG_DOT`. Artist: Montserrat 14, `C_DIM`, width 120. Make five `lv_button`s styled like `bright_button` (pressed `0x0E2A36` + accent border). The play button's fill is `C_ACCENT` with a black symbol. Fire `on_media_cmd` on `LV_EVENT_CLICKED`. The vol ± buttons also fire on `LV_EVENT_LONG_PRESSED_REPEAT`. Don't add `back_to_nav`.
- [ ] **Step 3: `apply_media(const media_msg_t*)`:** state NONE → the title reads "Nothing playing", the artist is empty, and the ring is 0. A volume of `0xFF` → ring 0. The play symbol is `LV_SYMBOL_PAUSE` while PLAYING and `LV_SYMBOL_PLAY` otherwise. Call it once from `ui_init` with a NONE message.
- [ ] **Step 4: main.c:** an `on_media_cmd` that does `atomic_store(&s_media_cmd, cmd + 1)` (0 = none). The loop does `atomic_exchange` and then `media_route(cmd)`, which encodes `MEDIA_CMD` and calls `ble_link_send` (ignoring `ESP_ERR_INVALID_STATE`). Demo filter: `!demo || msg.type == MSG_NOTIF || msg.type == MSG_MEDIA`. On disconnect (the `s_connected_changed` branch, when not connected), apply a NONE media message (Review Focus 3).
- [ ] **Step 5: Build** with `cd firmware && idf.py build`. Expected: success, no new warnings.
- [ ] **Step 6: Bench check** (if hardware is available; otherwise note it as unverified in the commit body). Each button press logs a `MEDIA_CMD` notify. Swiping left and right across the Media page still changes tiles. Tapping between buttons doesn't leave the page.
- [ ] **Step 7: Commit** with the message "Firmware: Media page and MEDIA_CMD".

### Task 4: AMS parsing (pure C, host-tested)

**Files:**
- Create: `firmware/components/ams/ams_parse.c`, `firmware/components/ams/include/ams_parse.h`
- Modify: `firmware/test/host/run.sh` (compile `ams_parse.c`, add `-I …/ams/include`)
- Create: `firmware/test/host/ams_parse_test.c` (its own `main`, run after the proto test in `run.sh`)

**Interfaces:**
- Consumes: `media_msg_t`, `media_cmd_t` from `proto.h`.
- Produces:
  ```c
  // Apple AMS IDs (Apple "AMS Specification").
  enum { AMS_ENTITY_PLAYER = 0, AMS_ENTITY_QUEUE = 1, AMS_ENTITY_TRACK = 2 };
  enum { AMS_PLAYER_NAME = 0, AMS_PLAYER_PLAYBACK_INFO = 1, AMS_PLAYER_VOLUME = 2 };
  enum { AMS_TRACK_ARTIST = 0, AMS_TRACK_ALBUM = 1, AMS_TRACK_TITLE = 2, AMS_TRACK_DURATION = 3 };
  /** Apply one Entity Update notification (EntityID, AttributeID, Flags, value…) to m. Returns true if m changed. */
  bool ams_parse_entity_update(const uint8_t *data, size_t len, media_msg_t *m);
  /** media_cmd_t → AMS RemoteCommandID (Toggle 2, Next 3, Prev 4, VolUp 5, VolDown 6); 0xFF if unknown. */
  uint8_t ams_remote_cmd(uint8_t media_cmd);
  ```
  Parsing rules: PlaybackInfo is `"state,rate,elapsed"`. First field 0 → PAUSED; 1, 2 or 3 → PLAYING; an
  empty value → NONE (no player). Volume `"0.4375"` → `volume_pct = round(v*100)`, clamped to 0–100;
  unparsable → `0xFF`. Title and artist are copied with truncation to the field max **on a UTF-8 boundary**.
  Any `len < 3` or an unknown entity/attribute → return false and leave `m` untouched. Parse floats by
  hand or with `strtof` on a NUL-terminated local copy, never in place.

- [ ] **Step 1: Write the failing tests** in `ams_parse_test.c`:
  - `{2,2,0,'H','e','y'}` → title `"Hey"`, returns true; applying it again returns false.
  - `{0,1,0,'1',',','1','.','0',',','3','.','5'}` → PLAYING; the same with `'0'` → PAUSED; `{0,1,0}` → NONE.
  - `{0,2,0,'0','.','5'}` → 50; `"1.0"` → 100; `"abc"` → 255.
  - Title of 95 × `'a'` + `'é'` (97 bytes) → the stored title has 95 bytes (the `é` is dropped whole) (Review Focus 4).
  - `{2}` (len 1) → false; entity 7 → false.
  - `ams_remote_cmd`: TOGGLE→2, NEXT→3, PREV→4, VOL_UP→5, VOL_DOWN→6, 9→0xFF.
- [ ] **Step 2: Run** `sh firmware/test/host/run.sh`. Expected: FAIL (link error).
- [ ] **Step 3: Implement** `ams_parse.c`. No ESP-IDF includes.
- [ ] **Step 4: Run** `sh firmware/test/host/run.sh`. Expected: both test binaries print that they passed.
- [ ] **Step 5: Commit** with the message "Firmware: AMS entity-update parser + host tests".

### Task 5: AMS GATT client, bonding, and routing

**Files:**
- Create: `firmware/components/ams/ams.c`, `firmware/components/ams/include/ams.h`, `firmware/components/ams/CMakeLists.txt` (SRCS `ams.c ams_parse.c`, REQUIRES `bt proto`)
- Modify: `firmware/components/ble_link/ble_link.c` (+ its `CMakeLists.txt` REQUIRES `ams`), `firmware/main/main.c`, `firmware/sdkconfig.defaults`

**Interfaces:**
- Consumes: `ams_parse_entity_update`, `ams_remote_cmd` (Task 4); `media_route` (Task 3).
- Produces:
  ```c
  typedef void (*ams_media_cb_t)(const media_msg_t *m); // NimBLE host task: copy + flag only
  void ams_init(ams_media_cb_t on_media);
  void ams_on_connect(uint16_t conn);                // start service discovery for AMS
  void ams_on_enc_change(uint16_t conn, int status); // 0 → (re)subscribe; else give up for this connection
  void ams_on_notify_rx(uint16_t conn, uint16_t attr, struct os_mbuf *om);
  void ams_on_disconnect(void);                      // clears state, reports NONE
  bool ams_active(void);                             // subscribed to Entity Update on this connection
  esp_err_t ams_send(uint8_t media_cmd);             // write Remote Command
  ```
  UUIDs: service `89D3502B-0F36-433A-8EF4-C502AD55F8DC`, Remote Command `9B3C81D8-57B1-4A8A-B8DF-0E56F7CA51C2`,
  Entity Update `2F7CABCE-808D-411F-9A0C-BB92BA96C102`, Entity Attribute `C6B2F38C-23AB-46D8-A6AB-A3A870BBD5D7`.

- [ ] **Step 1: sdkconfig.defaults:** enable bond persistence (`CONFIG_BT_NIMBLE_NVS_PERSIST=y`) and the GATT client. Check the option name against the ESP-IDF 5.5 NimBLE Kconfig (`CONFIG_BT_NIMBLE_GATT_CLIENT` or the equivalent) while keeping `ROLE_CENTRAL=n`. Run `idf.py reconfigure` and confirm the options land in `sdkconfig`.
- [ ] **Step 2: ble_link.c security:** `ble_hs_cfg.sm_bonding = 1; sm_sc = 1; sm_io_cap = BLE_SM_IO_CAP_NO_IO; sm_our_key_dist = sm_their_key_dist = BLE_SM_PAIR_KEY_DIST_ENC | BLE_SM_PAIR_KEY_DIST_ID; ble_hs_cfg.store_status_cb = ble_store_util_status_rr;` plus `ble_store_config_init()`. GAP events: CONNECT → `ams_on_connect`; ENC_CHANGE → `ams_on_enc_change`; NOTIFY_RX → `ams_on_notify_rx`; DISCONNECT → `ams_on_disconnect`; REPEAT_PAIRING → delete the peer's bond (`ble_store_util_delete_peer`) and return `BLE_GAP_REPEAT_PAIRING_RETRY`. Don't add security flags to the OpenBee characteristics.
- [ ] **Step 3: ams.c:** discover the service by UUID. If it isn't found → stay inactive (Android: no security request ever). If found → discover the characteristics and the Entity Update CCCD, and write CCCD = notify. On `BLE_HS_ATT_ERR(BLE_ATT_ERR_INSUFFICIENT_AUTHEN|ENC)` call `ble_gap_security_initiate(conn)` **once** per connection. After a successful enc change, write CCCD again. Then write to Entity Update `{PLAYER, NAME, PLAYBACK_INFO, VOLUME}` and `{TRACK, ARTIST, TITLE}`. Keep a single `media_msg_t` per connection, update it through `ams_parse_entity_update`, and on change call `on_media`. Every GATT callback checks its status and returns quietly on errors (never disconnect).
- [ ] **Step 4: main.c:** an `ams_media_cb` copies into `s_ams_media` under a `portMUX` spinlock and sets `atomic_bool s_ams_media_changed`. The loop then copies it out and does `ui_apply({.type = MSG_MEDIA})`. `media_route(cmd)`: `if (ams_active()) ams_send(cmd); else` the Task 3 notify path. Call `ams_init` before `ble_link_init`.
- [ ] **Step 5: Build** with `idf.py build`. Expected: success, no new warnings. Also run `sh firmware/test/host/run.sh` (still green).
- [ ] **Step 6: Bench check** (with hardware): an iPhone connects with the OpenBee app, the system pairing prompt appears once, and after you accept, Spotify's title/artist/state/volume show up and all five buttons act. Cancelling the prompt gives "Nothing playing" and no second prompt on that connection. An Android phone connects with no prompt. If there's no hardware, list these as unverified in the commit body.
- [ ] **Step 7: Commit** with the message "Firmware: AMS client and bonding for iPhone media".

### Task 6: Android native media module

**Files:**
- Create (via `cd app && npx create-expo-module@latest --local openbee-media`, then trim): `app/modules/openbee-media/` with `expo-module.config.json` (android only), `index.ts`, `android/src/main/AndroidManifest.xml`, `android/src/main/java/expo/modules/openbeemedia/OpenbeeMediaModule.kt`, `.../MediaListenerService.kt`
- Modify: `app/.gitignore` (add `/android`; CNG, same as `/ios`)

**Interfaces:**
- Produces (`app/modules/openbee-media/index.ts`):
  ```ts
  export interface NativeMedia { state: 0 | 1 | 2; title: string; artist: string; volumePct: number | null }
  export function isSupported(): boolean               // Platform.OS === 'android'
  export function isPermissionGranted(): boolean
  export function openPermissionSettings(): void
  export function getState(): NativeMedia
  export function command(cmd: number): void           // MediaCmd values; unknown → ignored
  export function addMediaListener(fn: (m: NativeMedia) => void): { remove(): void } // event 'onMediaChanged'
  ```
  On iOS every function is a no-op or returns NONE, and `isSupported()` is false (no native code is loaded).

- [ ] **Step 1: Read** `app/AGENTS.md` and the Expo SDK 58 module docs (`https://docs.expo.dev/versions/v58.0.0/`, "Expo Modules API: get started / local module").
- [ ] **Step 2: Scaffold** and trim the module to Android only.
- [ ] **Step 3: `MediaListenerService`**, an empty `NotificationListenerService`, declared in the module manifest with `android:permission="android.permission.BIND_NOTIFICATION_LISTENER_SERVICE"` and the `android.service.notification.NotificationListenerService` intent filter.
- [ ] **Step 4: `OpenbeeMediaModule.kt`:** do everything the spec's *Android* section says. Wrap every `getActiveSessions` call in a `SecurityException` catch → NONE (Review Focus 5). Toggle with no controller → `dispatchMediaKeyEvent(KEYCODE_MEDIA_PLAY)` down+up. Emit `onMediaChanged` on session change, metadata/playback change, and volume change (register a receiver for `android.media.VOLUME_CHANGED_ACTION`). Map PLAYING/BUFFERING → 1; PAUSED/STOPPED → 2; no controller → 0.
- [ ] **Step 5: Verify:** run `cd app && npm run typecheck && npm run lint`, then `npx expo prebuild -p android --no-install && cd android && ./gradlew :app:assembleDebug`. Expected: BUILD SUCCESSFUL. (Or run `npx expo run:android` on a device if one is attached.)
- [ ] **Step 6: Commit** with the message "App: Android media session module".

### Task 7: MediaRelay, wiring, settings row

**Files:**
- Create: `app/src/core/media.ts`, `app/src/core/__tests__/media.test.ts`, `app/src/services/media.ts`
- Modify: `app/src/services/ble.ts`, `app/src/services/runtime.ts`, `app/src/app/(tabs)/settings.tsx`

**Interfaces:**
- Consumes: `encodeMedia`, `MediaMsg`, `MediaCmd`, `MsgType.MEDIA_CMD` (Task 1); the module API (Task 6).
- Produces:
  ```ts
  // core/media.ts — platform-free
  export interface MediaRelayDeps { send(frame: Uint8Array): void; command(cmd: MediaCmd): void }
  export class MediaRelay {
    constructor(deps: MediaRelayDeps)
    onMediaChanged(m: MediaMsg): void     // send encodeMedia(m) unless byte-identical to the last frame sent
    onDeviceConnected(): void             // always send the latest (NONE/null/''/'' if none seen yet)
    onDeviceCommand(cmd: number): void    // forwards valid MediaCmd values only
  }
  // ble.ts
  DeviceLink.onMediaCmd: (cmd: number) => void   // called for MEDIA_CMD notifications
  // services/media.ts
  export const mediaPermission: { subscribe(fn): () => void; getView(): { supported: boolean; granted: boolean }; refresh(): void; open(): void }
  export function startMediaRelay(link: DeviceLink): void   // no-op unless isSupported()
  ```

- [ ] **Step 1: Write the failing tests** in `media.test.ts` with a fake `deps`:
  - `sends on change`: one `onMediaChanged` → one `send`, and `decode(frame).msg` equals the input.
  - `dedupes identical state`: the same message twice → one `send`.
  - `resends on connect`: after a change, `onDeviceConnected()` → a second, identical `send` (Review Focus 3).
  - `connect before any media sends NONE`: `onDeviceConnected()` on a fresh relay → decodes to `{state: NONE, volumePct: null, title: '', artist: ''}` (Review Focus 5).
  - `forwards commands`: `onDeviceCommand(MediaCmd.NEXT)` → `command(1)`; `onDeviceCommand(9)` → no call.
- [ ] **Step 2: Run** `cd app && npm test -- media.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `core/media.ts`.
- [ ] **Step 4: Run** `npm test -- media.test.ts`. Expected: PASS.
- [ ] **Step 5: Wire it up:** in `ble.ts`, the TX monitor routes `MsgType.MEDIA_CMD` to `this.onMediaCmd(msg.msg.cmd)`. In `services/media.ts`, build a `MediaRelay({send: link.send, command})` and subscribe `addMediaListener` → `relay.onMediaChanged` (mapping `NativeMedia` → `MediaMsg`); `mediaPermission.refresh` runs on `AppState` 'active', and `startMediaRelay` seeds the relay with `getState()`. In `runtime.ts`, `link.onConnected = () => { session.onDeviceConnected(); mediaRelay.onDeviceConnected(); }` (through what `startMediaRelay` returns or exposes), and `link.onMediaCmd` → relay. In `settings.tsx`, add a `Row` "Media controls on display", subtitle "Allowed" / "Tap to allow notification access", which calls `mediaPermission.open()` on tap. It renders only when `supported` and reads through `useSyncExternalStore`.
- [ ] **Step 6: Verify:** `npm test && npm run typecheck && npm run lint`. Expected: all green. On a device, if one is available: grant access; Spotify title and play state appear on the display; all five buttons work.
- [ ] **Step 7: Commit** with the message "App: relay Android media to the display".

### Task 8: Browser simulator Media page

**Files:**
- Modify: `app/sim/display.ts`, `app/sim/main.ts`, `app/sim/template.html` (only if the tile buttons are listed there)

**Interfaces:**
- Consumes: `MediaMsg`, `MediaCmd`, `encodeMedia`, `encodeMediaCmd`, `decode` (Task 1).
- Produces: `TILE_MEDIA = 1`, `TILE_SETTINGS = 4`; `DeviceState.media: MediaMsg`; and
  `DisplayRenderer.mediaHit(x: number, y: number): MediaCmd | null` (the same geometry as the spec's layout table).

- [ ] **Step 1: display.ts:** shift the tile indices, add `drawMedia(st)`, and use the same layout, colors and ring as `build_media` in `ui.c` (the spec's layout table). Use the exact pixel values Task 3 ended up with.
- [ ] **Step 2: main.ts:** handle the `MsgType.MEDIA` frame → `dev.media`. A fake player starts at `{PLAYING, 60, 'Bohemian Rhapsody', 'Queen'}`. A tap on the Media tile goes through `mediaHit` → round-trip through `decode(encodeMediaCmd(cmd))` → the fake player (toggle flips PLAYING/PAUSED; next/prev cycle a 3-track list; vol ± by 10 within 0–100) → `onFrame(encodeMedia(player))`. A tap that misses on the Media tile does **not** return to Nav. Add `6: 'MEDIA'` to `TYPE_NAME`, plus the `0x82` log.
- [ ] **Step 3: Verify** with `npm run build:sim && npm run typecheck`. Open `sim/dist/openbee-display-sim.html`: swipe once right of Nav → the Media page; every button changes the page as described; the Nav tile is unchanged.
- [ ] **Step 4: Commit** with the message "Sim: Media page".
