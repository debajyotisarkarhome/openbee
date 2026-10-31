idf_component_register(
    SRCS "board.c"
    INCLUDE_DIRS "include"
    REQUIRES lvgl__lvgl espressif__esp_lvgl_port esp_lcd esp_driver_spi esp_driver_i2c esp_driver_ledc esp_driver_gpio esp_adc esp_timer
)
