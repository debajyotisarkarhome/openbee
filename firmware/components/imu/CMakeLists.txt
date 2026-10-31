idf_component_register(SRCS "imu.c" "knock.c" "qmi8658.c" INCLUDE_DIRS "include" REQUIRES esp_driver_i2c PRIV_REQUIRES esp_timer)
