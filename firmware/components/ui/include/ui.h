// LVGL UI: swipeable Nav / Trip / Status views + state banner + notification overlay.
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

void ui_init(lv_display_t *disp, const char *device_name, ui_demo_toggle_cb_t on_demo_toggle);

/** Apply one decoded phone→device message. */
void ui_apply(const proto_msg_t *msg);

void ui_set_connected(bool connected);
void ui_set_device_battery(uint8_t pct, uint16_t mv);
void ui_set_demo(bool on);

#ifdef __cplusplus
}
#endif
