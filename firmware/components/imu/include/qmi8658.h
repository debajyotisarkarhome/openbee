// QMI8658 6-axis IMU (on the board's shared I2C bus): accelerometer ±8 g, gyroscope ±512 °/s, ~897 Hz.
#pragma once

#include "driver/i2c_master.h"
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Find the chip (0x6B, then 0x6A), reset and configure it. */
esp_err_t qmi8658_init(i2c_master_bus_handle_t bus);

/** Latest sample: acceleration in g, angular rate in °/s, both in the chip's own axes. */
esp_err_t qmi8658_read(float acc_g[3], float gyro_dps[3]);

/** Latest acceleration only (half the bus time of qmi8658_read), in g. */
esp_err_t qmi8658_read_acc(float acc_g[3]);

#ifdef __cplusplus
}
#endif
