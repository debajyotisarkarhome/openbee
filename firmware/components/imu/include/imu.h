// IMU task: polls the QMI8658 at ~1 kHz and runs the double-knock detector (knock.h).
#pragma once

#include "driver/i2c_master.h"
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Called from the IMU task on each double knock. Flag only; never block. */
typedef void (*imu_knock_cb_t)(void);

/** Find the IMU on bus and start polling. ESP_ERR_NOT_FOUND if there's no QMI8658. */
esp_err_t imu_init(i2c_master_bus_handle_t bus, imu_knock_cb_t on_double_knock);

#ifdef __cplusplus
}
#endif
