idf_component_register(
    SRCS "ble_link.c"
    INCLUDE_DIRS "include"
    REQUIRES bt proto
    PRIV_REQUIRES ams obd esp_hw_support esp_timer
)
