// OpenBee firmware entry: wires BLE frames → decoder → UI, battery reporting, and demo mode.
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
#include <sys/time.h>

#include "ams.h"
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
#define RX_QUEUE_LEN 40 // a full 32-part ROADS set plus NAV/TRIP, even if one render is in progress (~10 KB)
#define NVS_NS "openbee"
#define NVS_KEY_BRIGHTNESS "bright"
#define BRIGHTNESS_DEFAULT 80
#define BRIGHTNESS_SAVE_DELAY_MS 1000 // save once the rider stops adjusting, not on every drag step

typedef struct {
    uint16_t len;
    uint8_t data[PROTO_MAX_FRAME];
} frame_t;

static QueueHandle_t s_rx_q;
static atomic_bool s_demo_toggle_req;
static atomic_bool s_connected_changed;
static atomic_uint s_media_cmd; // media_cmd_t + 1; 0 = none
static atomic_uint s_brightness;
static atomic_uint s_brightness_changed_tick; // 0 = saved
static portMUX_TYPE s_ams_media_lock = portMUX_INITIALIZER_UNLOCKED;
static media_msg_t s_ams_media; // guarded by s_ams_media_lock
static atomic_bool s_ams_media_changed;

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

static void on_media_cmd(uint8_t cmd)
{
    atomic_store(&s_media_cmd, (unsigned)cmd + 1); // inside the LVGL task: defer to the main loop
}

static void ams_media_cb(const media_msg_t *m)
{
    // NimBLE host task: copy and flag; the main loop applies it to the UI.
    portENTER_CRITICAL(&s_ams_media_lock);
    s_ams_media = *m;
    portEXIT_CRITICAL(&s_ams_media_lock);
    atomic_store(&s_ams_media_changed, true);
}

/** Send a media command from the device's buttons to whichever source is playing: the iPhone's AMS when
 *  subscribed, otherwise the phone app (Android relays it to its media session). */
static void media_route(uint8_t cmd)
{
    if (ams_active()) {
        esp_err_t err = ams_send(cmd);
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "media cmd %u not sent to AMS: %s", cmd, esp_err_to_name(err));
        }
        return;
    }
    uint8_t buf[8];
    size_t n = proto_encode_media_cmd(cmd, buf);
    esp_err_t err = ble_link_send(buf, n);
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) { // INVALID_STATE = no phone connected
        ESP_LOGW(TAG, "media cmd %u not sent: %s", cmd, esp_err_to_name(err));
    }
}

static void on_brightness(uint8_t pct)
{
    // Inside the LVGL task: set the backlight right away so dragging feels live; the main loop persists it.
    board_backlight_set(pct);
    atomic_store(&s_brightness, pct);
    atomic_store(&s_brightness_changed_tick, xTaskGetTickCount() | 1); // never 0
}

static uint8_t brightness_load(void)
{
    uint8_t v = BRIGHTNESS_DEFAULT;
    nvs_handle_t h;
    if (nvs_open(NVS_NS, NVS_READONLY, &h) == ESP_OK) { // fails on first boot: namespace not created yet
        nvs_get_u8(h, NVS_KEY_BRIGHTNESS, &v);
        nvs_close(h);
    }
    return v < UI_BRIGHTNESS_MIN ? UI_BRIGHTNESS_MIN : v > 100 ? 100 : v;
}

static void brightness_save_if_settled(TickType_t now)
{
    unsigned changed = atomic_load(&s_brightness_changed_tick);
    if (!changed || now - changed < pdMS_TO_TICKS(BRIGHTNESS_SAVE_DELAY_MS)) {
        return;
    }
    // Only mark clean if no newer change raced in; otherwise the next pass saves that one.
    if (!atomic_compare_exchange_strong(&s_brightness_changed_tick, &changed, 0)) {
        return;
    }
    nvs_handle_t h;
    if (nvs_open(NVS_NS, NVS_READWRITE, &h) != ESP_OK) {
        ESP_LOGW(TAG, "nvs open failed; brightness not saved");
        return;
    }
    nvs_set_u8(h, NVS_KEY_BRIGHTNESS, (uint8_t)atomic_load(&s_brightness));
    nvs_commit(h);
    nvs_close(h);
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

    s_rx_q = xQueueCreate(RX_QUEUE_LEN, sizeof(frame_t));

    lv_display_t *disp = board_display_init();
    uint8_t brightness = brightness_load();
    atomic_store(&s_brightness, brightness);
    board_backlight_set(brightness);
    if (board_battery_init() != ESP_OK) {
        ESP_LOGW(TAG, "battery ADC unavailable");
    }

    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_BT);
    char name[16];
    snprintf(name, sizeof name, "OpenBee-%02X%02X", mac[4], mac[5]);
    ui_init(disp, name, on_demo_toggle, brightness, on_brightness, on_media_cmd);
    ams_init(ams_media_cb);
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
            // Drain everything queued under one lock: per-frame locking waits out a whole render each time, and
            // a ROADS burst then overflows the queue (one lost part and that street set never shows).
            ui_lock();
            do {
                if (!proto_decode(f.data, f.len, &msg)) {
                    ESP_LOGW(TAG, "bad frame (%u bytes, type 0x%02x)", f.len, f.len > 1 ? f.data[1] : 0);
                } else if (!demo || msg.type == MSG_NOTIF || msg.type == MSG_MEDIA) {
                    ui_apply(&msg);
                }
            } while (xQueueReceive(s_rx_q, &f, 0) == pdTRUE);
            ui_unlock();
        }

        if (atomic_exchange(&s_connected_changed, false)) {
            ui_set_connected(ble_link_connected());
            if (ble_link_connected()) {
                report_battery();
            } else {
                // The phone is gone, so its now-playing is stale. (Task 5's AMS source clears itself.)
                static proto_msg_t none = {.type = MSG_MEDIA, .u.media = {.state = MEDIA_NONE, .volume_pct = PROTO_UNKNOWN_VOLUME}};
                ui_apply(&none);
            }
        }

        if (atomic_exchange(&s_ams_media_changed, false)) {
            static proto_msg_t ams_msg = {.type = MSG_MEDIA}; // static: proto_msg_t is ~750 bytes
            portENTER_CRITICAL(&s_ams_media_lock);
            ams_msg.u.media = s_ams_media;
            portEXIT_CRITICAL(&s_ams_media_lock);
            ui_apply(&ams_msg);
        }

        unsigned media_cmd = atomic_exchange(&s_media_cmd, 0);
        if (media_cmd) {
            media_route((uint8_t)(media_cmd - 1));
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
            // static: three proto_msg_t unions (~2.2 KB) would overflow the main task stack
            static proto_msg_t nav, trip, st;
            nav = (proto_msg_t){.type = MSG_NAV};
            trip = (proto_msg_t){.type = MSG_TRIP};
            st = (proto_msg_t){.type = MSG_STATE};
            demo_step(dt, now_s(), &nav.u.nav, &trip.u.trip);
            st.u.state = NAV_NAVIGATING;
            ui_apply(&st);
            ui_apply(&nav);
            ui_apply(&trip);
        } else if (!demo) {
            last_tick = now;
        }

        brightness_save_if_settled(now);

        if (now - last_batt >= pdMS_TO_TICKS(BATTERY_PERIOD_MS)) {
            last_batt = now;
            report_battery();
        }
    }
}
