// LVGL UI: swipeable Nav / Engine / Media / Status / Settings views + state banner + notification overlay.
// All functions take the LVGL port lock internally; call them from any task.
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "lvgl.h"
#include "proto.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef void (*ui_demo_toggle_cb_t)(void);
/** Brightness picked on the Settings view (UI_BRIGHTNESS_MIN–100 %). Called inside the LVGL task, often while dragging. */
typedef void (*ui_brightness_cb_t)(uint8_t percent);

/** Media page button. Called inside the LVGL task: only copy/flag, never block. cmd is a media_cmd_t. */
typedef void (*ui_media_cb_t)(uint8_t cmd);

#define UI_BRIGHTNESS_MIN 5 // never fully dark: the rider could not find the control again

void ui_init(lv_display_t *disp, const char *device_name, ui_demo_toggle_cb_t on_demo_toggle, uint8_t brightness,
             ui_brightness_cb_t on_brightness, ui_media_cb_t on_media_cmd);

/** Apply one decoded phone→device message. */
void ui_apply(const proto_msg_t *msg);

/**
 * Hold the UI lock across several ui_* calls (it is recursive). Use it to apply a burst of messages in one go:
 * taking the lock per message waits out a full render each time, which can't keep up with a ROADS burst.
 */
void ui_lock(void);
void ui_unlock(void);

/** Engine page link state. */
enum { UI_ENGINE_SEARCHING, UI_ENGINE_NO_ECU, UI_ENGINE_LIVE };
#define UI_ENGINE_UNKNOWN INT16_MIN

/** Engine page data (OBD-II via the ELM327 adapter). Unknown values are UI_ENGINE_UNKNOWN; batt_mv 0 = unknown. */
typedef struct {
    uint8_t link; // UI_ENGINE_*
    int32_t rpm;
    int16_t speed_kmh;
    int16_t coolant_c;
    int16_t throttle_pct;
    int16_t load_pct;
    uint16_t batt_mv;
} ui_engine_t;

void ui_set_engine(const ui_engine_t *e);

void ui_set_connected(bool connected);
void ui_set_device_battery(uint8_t pct, uint16_t mv);
/** Pages to show, in swipe order (LAYOUT page ids). Unknown ids and repeats are skipped; Nav is added first if
 *  missing. The active page stays put if still shown, otherwise the view returns to Nav. */
void ui_set_layout(const uint8_t *pages, uint8_t n);

/** Demo on/off. Turning it off also wipes everything demo drew (ride, streets, trip, RPM gauge scale), so the
 *  caller should replay the phone's latest frames afterwards. */
void ui_set_demo(bool on);

#ifdef __cplusplus
}
#endif
