// OpenBee firmware entry: wires BLE frames → decoder → UI, battery reporting, and demo mode.
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
#include <sys/time.h>

#include "ble_link.h"
#include "board.h"
#include "demo.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "nvs_flash.h"
#include "proto.h"
#include "sdkconfig.h"
#include "ui.h"

static const char *TAG = "main";

#define FW_VERSION 1
#define TICK_MS 500
#define BATTERY_PERIOD_MS 10000

typedef struct {
    uint16_t len;
    uint8_t data[PROTO_MAX_FRAME];
} frame_t;

static QueueHandle_t s_rx_q;
static atomic_bool s_demo_toggle_req;
static atomic_bool s_connected_changed;

static void on_rx(const uint8_t *data, size_t len)
{
    if (len > PROTO_MAX_FRAME) {
        return;
    }
    frame_t f = {.len = len};
    memcpy(f.data, data, len);
    if (xQueueSend(s_rx_q, &f, 0) != pdTRUE) {
        ESP_LOGW(TAG, "rx queue full, dropping frame");
    }
}

static void on_conn(bool connected)
{
    atomic_store(&s_connected_changed, true);
}

static void on_demo_toggle(void)
{
    atomic_store(&s_demo_toggle_req, true); // called inside the LVGL task: defer to the main loop
}

static uint32_t now_s(void)
{
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return (uint32_t)tv.tv_sec;
}

static void demo_start(void)
{
    static proto_msg_t roads[DEMO_MAX_ROAD_FRAMES];
    static roads_msg_t frames[DEMO_MAX_ROAD_FRAMES];
    demo_init(now_s());
    int n = demo_roads(frames, DEMO_MAX_ROAD_FRAMES);
    for (int i = 0; i < n; i++) {
        roads[i].type = MSG_ROADS;
        roads[i].u.roads = frames[i];
        ui_apply(&roads[i]);
    }
}

static void report_battery(void)
{
    uint16_t mv = board_battery_mv();
    uint8_t pct = board_battery_pct(mv);
    ui_set_device_battery(pct, mv);
    // Charging can't be read directly on this board; ≥4.25 V means USB is feeding the charger.
    dev_status_msg_t st = {.batt_pct = pct, .batt_mv = mv, .charging = mv >= 4250, .fw_ver = FW_VERSION};
    uint8_t buf[16];
    size_t n = proto_encode_dev_status(&st, buf);
    ble_link_send(buf, n);
}

void app_main(void)
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);

    s_rx_q = xQueueCreate(8, sizeof(frame_t));

    lv_display_t *disp = board_display_init();
    if (board_battery_init() != ESP_OK) {
        ESP_LOGW(TAG, "battery ADC unavailable");
    }

    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_BT);
    char name[16];
    snprintf(name, sizeof name, "OpenBee-%02X%02X", mac[4], mac[5]);
    ui_init(disp, name, on_demo_toggle);
    ESP_ERROR_CHECK(ble_link_init(on_rx, on_conn));

#ifdef CONFIG_OPENBEE_DEMO_MODE
    bool demo = true;
#else
    bool demo = false;
#endif
    if (demo) {
        demo_start();
    }
    ui_set_demo(demo);
    report_battery();

    static frame_t f;
    static proto_msg_t msg;
    TickType_t last_tick = xTaskGetTickCount();
    TickType_t last_batt = last_tick;

    for (;;) {
        if (xQueueReceive(s_rx_q, &f, pdMS_TO_TICKS(TICK_MS)) == pdTRUE) {
            if (!proto_decode(f.data, f.len, &msg)) {
                ESP_LOGW(TAG, "bad frame (%u bytes, type 0x%02x)", f.len, f.len > 1 ? f.data[1] : 0);
            } else if (!demo || msg.type == MSG_NOTIF) {
                ui_apply(&msg);
            }
        }

        if (atomic_exchange(&s_connected_changed, false)) {
            ui_set_connected(ble_link_connected());
            if (ble_link_connected()) {
                report_battery();
            }
        }

        if (atomic_exchange(&s_demo_toggle_req, false)) {
            demo = !demo;
            if (demo) {
                demo_start();
            }
            ui_set_demo(demo);
            ESP_LOGI(TAG, "demo mode %s", demo ? "on" : "off");
        }

        TickType_t now = xTaskGetTickCount();
        if (demo && now - last_tick >= pdMS_TO_TICKS(TICK_MS)) {
            float dt = (now - last_tick) * portTICK_PERIOD_MS / 1000.0f;
            last_tick = now;
            proto_msg_t nav = {.type = MSG_NAV}, trip = {.type = MSG_TRIP}, st = {.type = MSG_STATE};
            demo_step(dt, now_s(), &nav.u.nav, &trip.u.trip);
            st.u.state = NAV_NAVIGATING;
            ui_apply(&st);
            ui_apply(&nav);
            ui_apply(&trip);
        } else if (!demo) {
            last_tick = now;
        }

        if (now - last_batt >= pdMS_TO_TICKS(BATTERY_PERIOD_MS)) {
            last_batt = now;
            report_battery();
        }
    }
}
