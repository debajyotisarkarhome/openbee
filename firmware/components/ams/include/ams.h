// Apple Media Service (AMS) GATT client: on an iPhone, read now-playing and send media commands over the
// same LE link the OpenBee app uses. On a phone without AMS (Android) it does nothing, and never asks to pair.
// Everything except ams_active/ams_send runs in the NimBLE host task (called from ble_link's GAP handler).
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"
#include "host/ble_hs.h"
#include "proto.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Called from the NimBLE host task whenever the iPhone's now-playing changes. Copy + flag only. */
typedef void (*ams_media_cb_t)(const media_msg_t *m);

void ams_init(ams_media_cb_t on_media);

/** A phone connected: look for AMS on it. */
void ams_on_connect(uint16_t conn);

/** Encryption changed: 0 → (re)subscribe; anything else → give up for this connection. */
void ams_on_enc_change(uint16_t conn, int status);

/** A notification arrived from the phone's GATT server. */
void ams_on_notify_rx(uint16_t conn, uint16_t attr, struct os_mbuf *om);

/** The phone disconnected: forget everything and report "nothing playing". */
void ams_on_disconnect(void);

/** True once subscribed to Entity Update on this connection (any task). */
bool ams_active(void);

/** Write a media_cmd_t to the iPhone's Remote Command characteristic (any task). */
esp_err_t ams_send(uint8_t media_cmd);

#ifdef __cplusplus
}
#endif
