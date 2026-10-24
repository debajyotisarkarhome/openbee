idf_component_register(
    SRCS "ui.c"
    INCLUDE_DIRS "include"
    REQUIRES proto board lvgl__lvgl espressif__esp_lvgl_port
)
