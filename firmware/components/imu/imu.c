#include "imu.h"

#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "knock.h"
#include "qmi8658.h"

static const char *TAG = "imu";

static imu_knock_cb_t s_on_knock;

static void imu_task(void *arg)
{
    static knock_t k;
    knock_init(&k);
    int64_t last = esp_timer_get_time();
    for (;;) {
        // One tick (1 ms at CONFIG_FREERTOS_HZ=1000): just above the sensor's ~897 Hz, so no sample is skipped
        // for long and the occasional repeat is harmless (dt is measured, not assumed).
        vTaskDelay(1);
        float a[3];
        if (qmi8658_read_acc(a) != ESP_OK) {
            continue;
        }
        int64_t now = esp_timer_get_time();
        float dt = (now - last) / 1e6f;
        last = now;
        if (dt <= 0 || dt > 0.05f) {
            continue; // a stall (bus busy for long): don't feed the filter a giant step
        }
        bool tap;
        bool fired = knock_update(&k, a, dt, &tap);
        if (tap) {
            // For tuning knock.c's thresholds (debug level: compiled out by default).
            ESP_LOGD(TAG, "knock peak %.2f g, %.1f ms", k.last_peak_g, k.last_width_s * 1000);
        }
        if (fired) {
            ESP_LOGI(TAG, "double knock");
            if (s_on_knock) {
                s_on_knock();
            }
        }
    }
}

esp_err_t imu_init(i2c_master_bus_handle_t bus, imu_knock_cb_t on_double_knock)
{
    esp_err_t err = qmi8658_init(bus);
    if (err != ESP_OK) {
        return err;
    }
    s_on_knock = on_double_knock;
    xTaskCreate(imu_task, "imu", 3072, NULL, 4, NULL);
    return ESP_OK;
}
