#include "obd.h"

#include <stdbool.h>
#include <stdio.h>
#include <string.h>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"
#include "host/ble_hs.h"
#include "obd_parse.h"

static const char *TAG = "obd";

// BLE ELM327 clones put their serial bridge on one of these 16-bit services.
#define SVC_FFF0 0xFFF0
#define SVC_FFE0 0xFFE0

#define SCAN_MS 8000          // one scan window
#define SCAN_PAUSE_MS 7000    // radio time left to the phone link between scans
#define LINK_TIMEOUT_MS 20000 // scan + connect + discovery must finish within this
#define CMD_TIMEOUT_MS 2000
#define RESET_TIMEOUT_MS 4000
#define SEARCH_TIMEOUT_MS 12000 // first 0100 after ATSP0: the adapter tries each protocol in turn
#define ECU_RETRY_MS 5000       // ignition off: ask again this often
#define MAX_TIMEOUTS 4          // consecutive unanswered commands before the adapter is dropped
#define MAX_ECU_MISSES 3        // consecutive "NO DATA"-type replies before the ECU counts as gone
#define VOLT_EVERY 20           // ATRV once per this many polls (~3 s)
#define MAX_REJECTS 4

// Event bits: set from the NimBLE host task, waited on by the OBD task.
#define EV_SYNC BIT0
#define EV_READY BIT1 // connected, characteristics found, notifications on
#define EV_DOWN BIT2  // connect failed or link lost
#define EV_SCAN_DONE BIT3
#define EV_PROMPT BIT4 // a '>' arrived: the adapter finished replying

static obd_data_cb_t s_on_data;
static EventGroupHandle_t s_ev;
static obd_data_t s_data;

// Link state. Written in the host task during setup, read by the OBD task once EV_READY is set.
static uint16_t s_conn = BLE_HS_CONN_HANDLE_NONE;
static uint16_t s_svc_start, s_svc_end;
static uint16_t s_notify_val, s_notify_end, s_cccd, s_write_val;
static bool s_write_no_rsp;
static bool s_connecting;
static ble_addr_t s_peer;
static ble_addr_t s_rejects[MAX_REJECTS]; // answered ATZ with something other than ELM327: not an OBD adapter
static int s_nrejects;

// Reply text, filled by notifications in the host task.
static portMUX_TYPE s_rx_lock = portMUX_INITIALIZER_UNLOCKED;
static char s_rx[512];
static size_t s_rx_len;

static int gap_event(struct ble_gap_event *ev, void *arg);

// ---------- discovery chain (host task) ----------

static void link_failed(const char *step, int rc)
{
    ESP_LOGW(TAG, "%s failed: %d", step, rc);
    if (s_conn != BLE_HS_CONN_HANDLE_NONE) {
        ble_gap_terminate(s_conn, BLE_ERR_REM_USER_CONN_TERM); // DISCONNECT then sets EV_DOWN
    } else {
        xEventGroupSetBits(s_ev, EV_DOWN);
    }
}

static int cccd_written(uint16_t conn, const struct ble_gatt_error *error, struct ble_gatt_attr *attr, void *arg)
{
    if (error->status != 0) {
        link_failed("subscribe", error->status);
        return 0;
    }
    xEventGroupSetBits(s_ev, EV_READY);
    return 0;
}

static int dsc_found(uint16_t conn, const struct ble_gatt_error *error, uint16_t chr_val_handle,
                     const struct ble_gatt_dsc *dsc, void *arg)
{
    if (error->status == 0) {
        if (ble_uuid_u16(&dsc->uuid.u) == BLE_GATT_DSC_CLT_CFG_UUID16) {
            s_cccd = dsc->handle;
        }
        return 0;
    }
    if (error->status != BLE_HS_EDONE || !s_cccd) {
        link_failed("descriptor discovery", error->status == BLE_HS_EDONE ? BLE_HS_ENOENT : error->status);
        return 0;
    }
    static const uint8_t on[] = {0x01, 0x00};
    int rc = ble_gattc_write_flat(conn, s_cccd, on, sizeof on, cccd_written, NULL);
    if (rc != 0) {
        link_failed("subscribe", rc);
    }
    return 0;
}

static int chr_found(uint16_t conn, const struct ble_gatt_error *error, const struct ble_gatt_chr *chr, void *arg)
{
    if (error->status == 0) {
        // The notify characteristic's descriptors end where the next characteristic starts.
        if (s_notify_val && chr->def_handle > s_notify_val && chr->def_handle - 1 < s_notify_end) {
            s_notify_end = chr->def_handle - 1;
        }
        bool notify = chr->properties & BLE_GATT_CHR_PROP_NOTIFY;
        bool no_rsp = chr->properties & BLE_GATT_CHR_PROP_WRITE_NO_RSP;
        bool write = no_rsp || (chr->properties & BLE_GATT_CHR_PROP_WRITE);
        if (notify && !s_notify_val) {
            s_notify_val = chr->val_handle;
            s_notify_end = s_svc_end;
            if (write) { // one characteristic both ways (FFF1 on the OBDBLE clone, FFE1 on HM-10 style ones)
                s_write_val = chr->val_handle;
                s_write_no_rsp = no_rsp;
            }
        } else if (write && !s_write_val) {
            s_write_val = chr->val_handle;
            s_write_no_rsp = no_rsp;
        }
        return 0;
    }
    if (error->status != BLE_HS_EDONE || !s_notify_val || !s_write_val) {
        link_failed("characteristic discovery", error->status == BLE_HS_EDONE ? BLE_HS_ENOENT : error->status);
        return 0;
    }
    int rc = ble_gattc_disc_all_dscs(conn, s_notify_val, s_notify_end, dsc_found, NULL);
    if (rc != 0) {
        link_failed("descriptor discovery", rc);
    }
    return 0;
}

static int svc_found(uint16_t conn, const struct ble_gatt_error *error, const struct ble_gatt_svc *svc, void *arg)
{
    if (error->status == 0) {
        if (svc->uuid.u.type == BLE_UUID_TYPE_16) {
            uint16_t u = ble_uuid_u16(&svc->uuid.u);
            // FFF0 wins over FFE0 when a module exposes both.
            if (u == SVC_FFF0 || (u == SVC_FFE0 && !s_svc_start)) {
                s_svc_start = svc->start_handle;
                s_svc_end = svc->end_handle;
            }
        }
        return 0;
    }
    if (error->status != BLE_HS_EDONE || !s_svc_start) {
        link_failed("service discovery", error->status == BLE_HS_EDONE ? BLE_HS_ENOENT : error->status);
        return 0;
    }
    int rc = ble_gattc_disc_all_chrs(conn, s_svc_start, s_svc_end, chr_found, NULL);
    if (rc != 0) {
        link_failed("characteristic discovery", rc);
    }
    return 0;
}

static int mtu_done(uint16_t conn, const struct ble_gatt_error *error, uint16_t mtu, void *arg)
{
    // A failed MTU exchange is fine: commands fit in 20 bytes, replies just arrive in more notifications.
    int rc = ble_gattc_disc_all_svcs(conn, svc_found, NULL);
    if (rc != 0) {
        link_failed("service discovery", rc);
    }
    return 0;
}

// ---------- scanning (host task) ----------

static bool rejected(const ble_addr_t *a)
{
    for (int i = 0; i < s_nrejects; i++) {
        if (ble_addr_cmp(&s_rejects[i], a) == 0) {
            return true;
        }
    }
    return false;
}

static bool name_has(const uint8_t *name, uint8_t len, const char *needle)
{
    size_t n = strlen(needle);
    for (size_t i = 0; i + n <= len; i++) {
        bool hit = true;
        for (size_t j = 0; j < n && hit; j++) {
            char c = (char)name[i + j];
            hit = (c >= 'a' && c <= 'z' ? c - 32 : c) == needle[j];
        }
        if (hit) {
            return true;
        }
    }
    return false;
}

static bool looks_like_obd(const struct ble_hs_adv_fields *f)
{
    for (int i = 0; i < f->num_uuids16; i++) {
        uint16_t u = ble_uuid_u16(&f->uuids16[i].u);
        if (u == SVC_FFF0 || u == SVC_FFE0) {
            return true;
        }
    }
    static const char *const names[] = {"OBD", "ELM", "VLINK", "V-LINK", "VGATE", "VEEPEAK"};
    for (size_t i = 0; i < sizeof names / sizeof names[0]; i++) {
        if (f->name && name_has(f->name, f->name_len, names[i])) {
            return true;
        }
    }
    return false;
}

static void on_disc(const struct ble_gap_disc_desc *d)
{
    if (s_connecting || rejected(&d->addr)) {
        return;
    }
    struct ble_hs_adv_fields f;
    if (ble_hs_adv_parse_fields(&f, d->data, d->length_data) != 0 || !looks_like_obd(&f)) {
        return;
    }
    s_connecting = true;
    ble_gap_disc_cancel();
    s_peer = d->addr;
    uint8_t own;
    ble_hs_id_infer_auto(0, &own);
    // Ask for a short connection interval: every command is a write plus a notification, so the interval adds
    // to each round trip. Adapters may push back (the OBDBLE clone renegotiates to 30 ms).
    static const struct ble_gap_conn_params params = {
        .scan_itvl = 16,
        .scan_window = 16,
        .itvl_min = 6,  // 7.5 ms
        .itvl_max = 12, // 15 ms
        .latency = 0,
        .supervision_timeout = 400, // 4 s
    };
    int rc = ble_gap_connect(own, &d->addr, 5000, &params, gap_event, NULL);
    ESP_LOGI(TAG, "adapter candidate (rssi %d), connecting: %d", d->rssi, rc);
    if (rc != 0) {
        s_connecting = false;
        xEventGroupSetBits(s_ev, EV_DOWN);
    }
}

static int gap_event(struct ble_gap_event *ev, void *arg)
{
    switch (ev->type) {
    case BLE_GAP_EVENT_DISC:
        on_disc(&ev->disc);
        break;
    case BLE_GAP_EVENT_DISC_COMPLETE:
        if (!s_connecting) {
            xEventGroupSetBits(s_ev, EV_SCAN_DONE);
        }
        break;
    case BLE_GAP_EVENT_CONNECT: {
        s_connecting = false;
        if (ev->connect.status != 0) {
            ESP_LOGW(TAG, "connect failed: %d", ev->connect.status);
            xEventGroupSetBits(s_ev, EV_DOWN);
            break;
        }
        s_conn = ev->connect.conn_handle;
        s_svc_start = s_svc_end = s_notify_val = s_notify_end = s_cccd = s_write_val = 0;
        if (ble_gattc_exchange_mtu(s_conn, mtu_done, NULL) != 0) {
            mtu_done(s_conn, NULL, 0, NULL); // mtu_done ignores its error argument
        }
        break;
    }
    case BLE_GAP_EVENT_DISCONNECT:
        ESP_LOGI(TAG, "adapter disconnected (reason %d)", ev->disconnect.reason);
        s_conn = BLE_HS_CONN_HANDLE_NONE;
        xEventGroupClearBits(s_ev, EV_READY);
        xEventGroupSetBits(s_ev, EV_DOWN);
        break;
    case BLE_GAP_EVENT_NOTIFY_RX: {
        if (ev->notify_rx.attr_handle != s_notify_val) {
            break;
        }
        char buf[128];
        uint16_t len = OS_MBUF_PKTLEN(ev->notify_rx.om);
        if (len > sizeof buf) {
            len = sizeof buf;
        }
        if (os_mbuf_copydata(ev->notify_rx.om, 0, len, buf) != 0) {
            break;
        }
        bool prompt = false;
        portENTER_CRITICAL(&s_rx_lock);
        for (uint16_t i = 0; i < len; i++) {
            if (buf[i] == '>') {
                prompt = true;
            } else if (buf[i] && s_rx_len < sizeof s_rx - 1) {
                s_rx[s_rx_len++] = buf[i];
            }
        }
        portEXIT_CRITICAL(&s_rx_lock);
        if (prompt) {
            xEventGroupSetBits(s_ev, EV_PROMPT);
        }
        break;
    }
    default:
        break;
    }
    return 0;
}

// ---------- OBD task ----------

static void publish(void)
{
    if (s_on_data) {
        s_on_data(&s_data);
    }
}

static void clear_engine(void)
{
    s_data.rpm = OBD_UNKNOWN;
    s_data.speed_kmh = s_data.coolant_c = s_data.throttle_pct = s_data.load_pct = OBD_UNKNOWN;
}

/** Send one command and wait for the prompt. Returns false on timeout or link loss; out holds the reply text. */
static bool cmd(const char *c, uint32_t timeout_ms, char *out, size_t n)
{
    portENTER_CRITICAL(&s_rx_lock);
    s_rx_len = 0;
    portEXIT_CRITICAL(&s_rx_lock);
    xEventGroupClearBits(s_ev, EV_PROMPT);

    char line[24];
    int len = snprintf(line, sizeof line, "%s\r", c);
    int rc = s_write_no_rsp ? ble_gattc_write_no_rsp_flat(s_conn, s_write_val, line, len)
                            : ble_gattc_write_flat(s_conn, s_write_val, line, len, NULL, NULL);
    if (rc != 0) {
        return false;
    }
    EventBits_t b = xEventGroupWaitBits(s_ev, EV_PROMPT | EV_DOWN, pdFALSE, pdFALSE, pdMS_TO_TICKS(timeout_ms));
    if (!(b & EV_PROMPT)) {
        return false;
    }
    portENTER_CRITICAL(&s_rx_lock);
    size_t m = s_rx_len < n - 1 ? s_rx_len : n - 1;
    memcpy(out, s_rx, m);
    portEXIT_CRITICAL(&s_rx_lock);
    out[m] = '\0';
    return true;
}

/** Scan until an adapter is connected and ready. False if none turned up this round. */
static bool find_adapter(void)
{
    xEventGroupClearBits(s_ev, EV_READY | EV_DOWN | EV_SCAN_DONE);
    s_connecting = false;
    uint8_t own;
    ble_hs_id_infer_auto(0, &own);
    struct ble_gap_disc_params p = {
        .itvl = 160,  // 100 ms
        .window = 48, // 30 ms: leaves most of the radio to the phone link
        .filter_duplicates = 1,
        .passive = 0, // active, so scan responses (where most clones put their name) arrive too
    };
    int rc = ble_gap_disc(own, SCAN_MS, &p, gap_event, NULL);
    if (rc != 0) {
        ESP_LOGW(TAG, "scan start: %d", rc);
        return false;
    }
    EventBits_t b = xEventGroupWaitBits(s_ev, EV_READY | EV_DOWN | EV_SCAN_DONE, pdFALSE, pdFALSE,
                                        pdMS_TO_TICKS(LINK_TIMEOUT_MS));
    if (b & EV_READY) {
        return true;
    }
    if (!(b & (EV_DOWN | EV_SCAN_DONE))) { // timed out mid-connect or mid-discovery
        ble_gap_disc_cancel();
        if (s_conn != BLE_HS_CONN_HANDLE_NONE) {
            ble_gap_terminate(s_conn, BLE_ERR_REM_USER_CONN_TERM);
        } else if (s_connecting) {
            ble_gap_conn_cancel();
        }
    }
    return false;
}

// Everything the Engine page shows, in the order the multi-PID request asks for it (at most 6 per request).
static const uint8_t ENGINE_PIDS[] = {OBD_PID_RPM, OBD_PID_SPEED, OBD_PID_THROTTLE, OBD_PID_COOLANT, OBD_PID_LOAD};

/** Store one decoded value; true if it changed. */
static bool set_value(uint8_t pid, int32_t v)
{
    if (pid == OBD_PID_RPM) {
        bool changed = s_data.rpm != v;
        s_data.rpm = v;
        return changed;
    }
    int16_t *slot = pid == OBD_PID_SPEED      ? &s_data.speed_kmh
                    : pid == OBD_PID_THROTTLE ? &s_data.throttle_pct
                    : pid == OBD_PID_COOLANT  ? &s_data.coolant_c
                    : pid == OBD_PID_LOAD     ? &s_data.load_pct
                                              : NULL;
    if (!slot || *slot == v) {
        return false;
    }
    *slot = (int16_t)v;
    return true;
}

/** Talk to a ready adapter until it goes away or stops answering. */
static void session(void)
{
    static char r[512];
    if (!cmd("ATZ", RESET_TIMEOUT_MS, r, sizeof r) || !strstr(r, "ELM327")) {
        // Something else advertising FFF0/FFE0 (an LED strip, a beacon): never try it again this boot.
        ESP_LOGW(TAG, "not an ELM327, ignoring it");
        if (s_nrejects < MAX_REJECTS) {
            s_rejects[s_nrejects++] = s_peer;
        }
        return;
    }
    ESP_LOGI(TAG, "ELM327 ready");
    static const char *const setup[] = {"ATE0", "ATL0", "ATS0", "ATH0", "ATSP0"}; // no echo, no spaces, auto protocol
    for (size_t i = 0; i < sizeof setup / sizeof setup[0]; i++) {
        if (!cmd(setup[i], CMD_TIMEOUT_MS, r, sizeof r)) {
            return;
        }
    }

    s_data.link = OBD_NO_ECU;
    clear_engine();
    publish();

    uint8_t supported[4] = {0};
    bool ecu = false, multi = true;
    int timeouts = 0, ecu_misses = 0;
    TickType_t next_search = 0;
    uint8_t want[sizeof ENGINE_PIDS]; // ENGINE_PIDS this ECU supports
    size_t nwant = 0;
    char multi_req[4 + 2 * sizeof ENGINE_PIDS] = "01";

    for (unsigned cycle = 0;; cycle++) {
        if (xEventGroupGetBits(s_ev) & EV_DOWN || timeouts >= MAX_TIMEOUTS) {
            return;
        }

        // Battery straight from the adapter: useful with the ignition off, so it runs in both states.
        if (cycle % VOLT_EVERY == 0) {
            uint16_t mv;
            if (!cmd("ATRV", CMD_TIMEOUT_MS, r, sizeof r)) {
                timeouts++;
                continue;
            }
            timeouts = 0;
            if (obd_parse_voltage(r, &mv) && mv != s_data.batt_mv) {
                s_data.batt_mv = mv;
                publish();
            }
        }

        if (!ecu) {
            if ((int32_t)(xTaskGetTickCount() - next_search) < 0) {
                vTaskDelay(pdMS_TO_TICKS(250));
                continue;
            }
            next_search = xTaskGetTickCount() + pdMS_TO_TICKS(ECU_RETRY_MS);
            if (!cmd("0100", SEARCH_TIMEOUT_MS, r, sizeof r)) {
                timeouts++;
                continue;
            }
            timeouts = 0;
            if (obd_parse_mode01(r, OBD_PID_SUPPORTED, supported, sizeof supported) == 4) {
                ESP_LOGI(TAG, "ECU answering, PIDs 01-20: %02X%02X%02X%02X", supported[0], supported[1], supported[2],
                         supported[3]);
                nwant = 0;
                for (size_t i = 0; i < sizeof ENGINE_PIDS; i++) {
                    if (obd_pid_supported(supported, ENGINE_PIDS[i])) {
                        want[nwant] = ENGINE_PIDS[i];
                        snprintf(multi_req + 2 + 2 * nwant, 3, "%02X", ENGINE_PIDS[i]);
                        nwant++;
                    }
                }
                ecu = nwant > 0;
                ecu_misses = 0;
                s_data.link = ecu ? OBD_LIVE : OBD_NO_ECU;
                publish();
            }
            continue;
        }

        // One request for every value when the ECU takes multi-PID requests (CAN ECUs must, up to 6 PIDs):
        // the adapter's round trip (~150 ms on a BLE clone) is the cost, not the number of values. Otherwise
        // one PID per request, with RPM every other one since it changes fastest.
        const uint8_t *pids = want;
        size_t npids = nwant;
        const char *req = multi_req;
        char single[8];
        if (!multi) {
            static const uint8_t order[] = {OBD_PID_RPM, OBD_PID_SPEED,   OBD_PID_RPM, OBD_PID_THROTTLE,
                                            OBD_PID_RPM, OBD_PID_COOLANT, OBD_PID_RPM, OBD_PID_LOAD};
            pids = &order[cycle % sizeof order];
            npids = 1;
            if (!obd_pid_supported(supported, *pids)) {
                continue;
            }
            snprintf(single, sizeof single, "01%02X", *pids);
            req = single;
        }
        if (!cmd(req, CMD_TIMEOUT_MS, r, sizeof r)) {
            timeouts++;
            continue;
        }
        timeouts = 0;

        int32_t v[sizeof ENGINE_PIDS];
        bool got[sizeof ENGINE_PIDS];
        if (obd_parse_mode01_multi(r, pids, npids, v, got) == 0) {
            if (obd_reply_no_ecu(r)) {
                if (++ecu_misses >= MAX_ECU_MISSES) {
                    ESP_LOGI(TAG, "ECU stopped answering");
                    ecu = false;
                    s_data.link = OBD_NO_ECU;
                    clear_engine();
                    publish();
                }
            } else if (multi) {
                ESP_LOGI(TAG, "ECU doesn't take multi-PID requests; polling one PID at a time");
                multi = false;
            }
            continue;
        }
        ecu_misses = 0;
        bool changed = false;
        for (size_t i = 0; i < npids; i++) {
            if (got[i]) {
                changed |= set_value(pids[i], v[i]);
            }
        }
        if (changed) {
            publish();
        }
    }
}

static void obd_task(void *arg)
{
    for (;;) {
        xEventGroupWaitBits(s_ev, EV_SYNC, pdFALSE, pdFALSE, portMAX_DELAY);
        if (!find_adapter()) {
            vTaskDelay(pdMS_TO_TICKS(SCAN_PAUSE_MS));
            continue;
        }
        ESP_LOGI(TAG, "adapter linked");
        session();
        if (s_conn != BLE_HS_CONN_HANDLE_NONE) {
            ble_gap_terminate(s_conn, BLE_ERR_REM_USER_CONN_TERM);
            xEventGroupWaitBits(s_ev, EV_DOWN, pdFALSE, pdFALSE, pdMS_TO_TICKS(3000));
        }
        s_data.link = OBD_SEARCHING;
        s_data.batt_mv = 0;
        clear_engine();
        publish();
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}

void obd_init(obd_data_cb_t on_data)
{
    s_on_data = on_data;
    s_ev = xEventGroupCreate();
    s_data.link = OBD_SEARCHING;
    clear_engine();
    xTaskCreate(obd_task, "obd", 4096, NULL, 3, NULL);
}

void obd_on_sync(void)
{
    xEventGroupSetBits(s_ev, EV_SYNC);
}
