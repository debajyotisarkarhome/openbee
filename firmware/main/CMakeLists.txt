idf_component_register(
    SRCS "main.c" "demo.c"
    INCLUDE_DIRS "."
    REQUIRES ams board ble_link obd proto ui nvs_flash esp_hw_support
)
