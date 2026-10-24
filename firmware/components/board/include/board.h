// Board bring-up: GC9A01 round LCD, CST816S touch, LVGL port, battery ADC.
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"
#include "lvgl.h"

#ifdef __cplusplus
extern "C" {
#endif

#define BOARD_LCD_H_RES 240
#define BOARD_LCD_V_RES 240

/** Initialise LCD, touch and LVGL (esp_lvgl_port task). Returns the LVGL display. */
lv_display_t *board_display_init(void);

/** Backlight 0–100 %. */
void board_backlight_set(uint8_t percent);

esp_err_t board_battery_init(void);

/** Battery voltage in mV (averaged), 0 on error. */
uint16_t board_battery_mv(void);

/** Rough Li-ion state of charge from voltage. */
uint8_t board_battery_pct(uint16_t mv);

#ifdef __cplusplus
}
#endif
