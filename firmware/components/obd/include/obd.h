// BLE ELM327 client: finds an OBD-II adapter (service FFF0 or FFE0, or an OBD-ish name), checks it really is an
// ELM327, then polls engine data in its own task. The device is the BLE central here, alongside its peripheral
// link to the phone. Engine data never touches the phone protocol.
#pragma once

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define OBD_UNKNOWN INT16_MIN

typedef enum {
    OBD_SEARCHING, // no adapter connected
    OBD_NO_ECU,    // adapter connected, but nothing answers (ignition off)
    OBD_LIVE,      // ECU answering
} obd_link_t;

typedef struct {
    obd_link_t link;
    int32_t rpm;       // OBD_UNKNOWN if not known
    int16_t speed_kmh; // OBD_UNKNOWN if not known
    int16_t coolant_c; // OBD_UNKNOWN if not known
    int16_t throttle_pct;
    int16_t load_pct;
    uint16_t batt_mv; // 0 = unknown; read from the adapter (ATRV), so it works with the ignition off too
} obd_data_t;

/** Called from the OBD task whenever the data changes. Copy + flag only. */
typedef void (*obd_data_cb_t)(const obd_data_t *d);

/** Start the OBD task. It waits for obd_on_sync before scanning. */
void obd_init(obd_data_cb_t on_data);

/** The NimBLE host is in sync (called from ble_link's sync callback). */
void obd_on_sync(void);

#ifdef __cplusplus
}
#endif
