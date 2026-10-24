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

#ifdef __cplusplus
}
#endif
