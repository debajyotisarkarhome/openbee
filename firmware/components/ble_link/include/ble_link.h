// NimBLE GATT peripheral for the OpenBee service (docs/protocol.md).
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Called from the NimBLE host task for every RX write. Keep it short (copy + queue). */
typedef void (*ble_link_rx_cb_t)(const uint8_t *data, size_t len);
/** Called on connect (true) and disconnect (false). */
typedef void (*ble_link_conn_cb_t)(bool connected);

esp_err_t ble_link_init(ble_link_rx_cb_t on_rx, ble_link_conn_cb_t on_conn);

bool ble_link_connected(void);

/** Notify one frame on TX if a central is subscribed. */
esp_err_t ble_link_send(const uint8_t *data, size_t len);

/**
 * Hold the HID "Voice Command" button (Consumer page 0xCF) for 1.5 s, which opens Siri on an iPhone (a quick tap
 * is ignored by iOS). Returns at once; a timer releases it. INVALID_STATE until the phone has subscribed to the
 * HID report, i.e. it's paired and iOS took the device as a remote.
 */
esp_err_t ble_link_voice_command(void);

/** Battery level for the Battery service (shown in the iPhone's battery widget). */
void ble_link_set_battery(uint8_t pct);

#ifdef __cplusplus
}
#endif
