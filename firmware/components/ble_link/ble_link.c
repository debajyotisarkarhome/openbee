#include "ble_link.h"

#include <stdio.h>
#include <string.h>

#include "ams.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_timer.h"
#include "host/ble_hs.h"
#include "host/util/util.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "obd.h"
#include "proto.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"

static const char *TAG = "ble";

// 6f70656e-6265-4500-a000-00000000000X, little-endian byte order.
#define OPENBEE_UUID(last) \
    BLE_UUID128_INIT(last, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xa0, 0x00, 0x45, 0x65, 0x62, 0x6e, 0x65, 0x70, 0x6f)

static const ble_uuid128_t s_svc_uuid = OPENBEE_UUID(0x00);
static const ble_uuid128_t s_rx_uuid = OPENBEE_UUID(0x01);
static const ble_uuid128_t s_tx_uuid = OPENBEE_UUID(0x02);

static ble_link_rx_cb_t s_on_rx;
static ble_link_conn_cb_t s_on_conn;
static uint16_t s_conn = BLE_HS_CONN_HANDLE_NONE;
static uint16_t s_tx_handle;
static bool s_tx_subscribed;
static uint8_t s_own_addr_type;
static char s_name[16];

// HID over GATT: a consumer-control remote whose "Voice Command" button iOS maps to Siri (Apple's accessory
// guidelines list Consumer 0xCF for it), if it's held: an 80 ms tap was ignored, 1.5 s opened Siri. Play/Pause
// and AC Search are in the map from the experiment that found that; changing the map means re-pairing, so they
// stay, unused. HOGP also wants the Device Information and Battery services.
static const uint8_t HID_REPORT_MAP[] = {
    0x05, 0x0C,       // Usage Page (Consumer)
    0x09, 0x01,       // Usage (Consumer Control)
    0xA1, 0x01,       // Collection (Application)
    0x85, 0x01,       //   Report ID 1
    0x15, 0x00,       //   Logical Minimum 0
    0x25, 0x01,       //   Logical Maximum 1
    0x75, 0x01,       //   Report Size 1
    0x95, 0x03,       //   Report Count 3: one bit per usage below
    0x09, 0xCF,       //   bit 0: Voice Command
    0x09, 0xCD,       //   bit 1: Play/Pause
    0x0A, 0x21, 0x02, //   bit 2: AC Search
    0x81, 0x02,       //   Input (Data, Var, Abs)
    0x75, 0x05,       //   Report Size 5
    0x95, 0x01,       //   Report Count 1
    0x81, 0x03,       //   Input (Const): pad to a byte
    0xC0,             // End Collection
};
#define HID_REPORT_ID 1
#define HID_BIT_VOICE 0x01
#define HID_VOICE_HOLD_US 1500000

enum { HID_INFO, HID_MAP, HID_REPORT, HID_REPORT_REF, HID_CTRL, DIS_PNP, DIS_MFR, BAS_LEVEL };
static uint16_t s_hid_report_handle;
static bool s_hid_subscribed;
static uint16_t s_batt_handle;
static uint8_t s_batt_pct = 100;

static void advertise(void);

void ble_store_config_init(void); // NimBLE's NVS bond store; it has no public header

static int chr_access(uint16_t conn, uint16_t attr, struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) {
        return BLE_ATT_ERR_UNLIKELY;
    }
    uint8_t buf[PROTO_MAX_FRAME];
    uint16_t len = 0;
    if (OS_MBUF_PKTLEN(ctxt->om) > sizeof buf) {
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }
    if (ble_hs_mbuf_to_flat(ctxt->om, buf, sizeof buf, &len) != 0) {
        return BLE_ATT_ERR_UNLIKELY;
    }
    if (s_on_rx) {
        s_on_rx(buf, len);
    }
    return 0;
}

static int append(struct ble_gatt_access_ctxt *ctxt, const void *data, size_t len)
{
    return os_mbuf_append(ctxt->om, data, len) == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
}

static int hid_access(uint16_t conn, uint16_t attr, struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    switch ((int)(intptr_t)arg) {
    case HID_INFO: {
        static const uint8_t info[] = {0x11, 0x01, 0x00, 0x02}; // HID 1.11, no country, normally connectable
        return append(ctxt, info, sizeof info);
    }
    case HID_MAP:
        return append(ctxt, HID_REPORT_MAP, sizeof HID_REPORT_MAP);
    case HID_REPORT: {
        static const uint8_t released = 0;
        return ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR ? append(ctxt, &released, 1) : 0;
    }
    case HID_REPORT_REF: {
        static const uint8_t ref[] = {HID_REPORT_ID, 0x01}; // input report
        return append(ctxt, ref, sizeof ref);
    }
    case HID_CTRL:
        return 0; // suspend / exit suspend: nothing to do
    case DIS_PNP: {
        static const uint8_t pnp[] = {0x02, 0x3A, 0x30, 0x01, 0x00, 0x01, 0x00}; // USB VID 0x303A (Espressif), PID 1, v1
        return append(ctxt, pnp, sizeof pnp);
    }
    case DIS_MFR:
        return append(ctxt, "OpenBee", 7);
    case BAS_LEVEL:
        return append(ctxt, &s_batt_pct, 1);
    }
    return BLE_ATT_ERR_UNLIKELY;
}

#define HID_ARG(x) ((void *)(intptr_t)(x))

static const struct ble_gatt_svc_def s_svcs[] = {
    {
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = &s_svc_uuid.u,
        .characteristics =
            (struct ble_gatt_chr_def[]){
                {
                    .uuid = &s_rx_uuid.u,
                    .access_cb = chr_access,
                    .flags = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_NO_RSP,
                },
                {
                    .uuid = &s_tx_uuid.u,
                    .access_cb = chr_access,
                    .val_handle = &s_tx_handle,
                    .flags = BLE_GATT_CHR_F_NOTIFY,
                },
                {0},
            },
    },
    {
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = BLE_UUID16_DECLARE(0x1812), // HID
        .characteristics =
            (struct ble_gatt_chr_def[]){
                {.uuid = BLE_UUID16_DECLARE(0x2A4A), .access_cb = hid_access, .arg = HID_ARG(HID_INFO),
                 .flags = BLE_GATT_CHR_F_READ},
                {.uuid = BLE_UUID16_DECLARE(0x2A4B), .access_cb = hid_access, .arg = HID_ARG(HID_MAP),
                 .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_READ_ENC},
                {.uuid = BLE_UUID16_DECLARE(0x2A4C), .access_cb = hid_access, .arg = HID_ARG(HID_CTRL),
                 .flags = BLE_GATT_CHR_F_WRITE_NO_RSP},
                {
                    .uuid = BLE_UUID16_DECLARE(0x2A4D), // Report (input)
                    .access_cb = hid_access,
                    .arg = HID_ARG(HID_REPORT),
                    .val_handle = &s_hid_report_handle,
                    .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_READ_ENC | BLE_GATT_CHR_F_NOTIFY,
                    .descriptors =
                        (struct ble_gatt_dsc_def[]){
                            {.uuid = BLE_UUID16_DECLARE(0x2908), // Report Reference
                             .att_flags = BLE_ATT_F_READ | BLE_ATT_F_READ_ENC,
                             .access_cb = hid_access,
                             .arg = HID_ARG(HID_REPORT_REF)},
                            {0},
                        },
                },
                {0},
            },
    },
    {
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = BLE_UUID16_DECLARE(0x180A), // Device Information
        .characteristics =
            (struct ble_gatt_chr_def[]){
                {.uuid = BLE_UUID16_DECLARE(0x2A50), .access_cb = hid_access, .arg = HID_ARG(DIS_PNP),
                 .flags = BLE_GATT_CHR_F_READ},
                {.uuid = BLE_UUID16_DECLARE(0x2A29), .access_cb = hid_access, .arg = HID_ARG(DIS_MFR),
                 .flags = BLE_GATT_CHR_F_READ},
                {0},
            },
    },
    {
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = BLE_UUID16_DECLARE(0x180F), // Battery
        .characteristics =
            (struct ble_gatt_chr_def[]){
                {.uuid = BLE_UUID16_DECLARE(0x2A19), .access_cb = hid_access, .arg = HID_ARG(BAS_LEVEL),
                 .val_handle = &s_batt_handle, .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_NOTIFY},
                {0},
            },
    },
    {0},
};

static int gap_event(struct ble_gap_event *ev, void *arg)
{
    switch (ev->type) {
    case BLE_GAP_EVENT_CONNECT:
        if (ev->connect.status == 0) {
            s_conn = ev->connect.conn_handle;
            ESP_LOGI(TAG, "connected");
            if (s_on_conn) {
                s_on_conn(true);
            }
            ams_on_connect(s_conn);
        } else {
            advertise();
        }
        break;
    case BLE_GAP_EVENT_DISCONNECT:
        ESP_LOGI(TAG, "disconnected (reason %d)", ev->disconnect.reason);
        s_conn = BLE_HS_CONN_HANDLE_NONE;
        s_tx_subscribed = false;
        s_hid_subscribed = false;
        ams_on_disconnect();
        if (s_on_conn) {
            s_on_conn(false);
        }
        advertise();
        break;
    case BLE_GAP_EVENT_ADV_COMPLETE:
        advertise();
        break;
    case BLE_GAP_EVENT_SUBSCRIBE:
        if (ev->subscribe.attr_handle == s_tx_handle) {
            s_tx_subscribed = ev->subscribe.cur_notify;
        } else if (ev->subscribe.attr_handle == s_hid_report_handle) {
            s_hid_subscribed = ev->subscribe.cur_notify;
            ESP_LOGI(TAG, "HID report %s (Siri button %s)", s_hid_subscribed ? "subscribed" : "unsubscribed",
                     s_hid_subscribed ? "ready" : "off");
        }
        break;
    case BLE_GAP_EVENT_ENC_CHANGE:
        ESP_LOGI(TAG, "encryption change: %d", ev->enc_change.status);
        ams_on_enc_change(ev->enc_change.conn_handle, ev->enc_change.status);
        break;
    case BLE_GAP_EVENT_NOTIFY_RX:
        ams_on_notify_rx(ev->notify_rx.conn_handle, ev->notify_rx.attr_handle, ev->notify_rx.om);
        break;
    case BLE_GAP_EVENT_REPEAT_PAIRING: {
        // The phone lost its bond (e.g. "Forget this device") but we still have ours: drop ours and re-pair.
        struct ble_gap_conn_desc desc;
        if (ble_gap_conn_find(ev->repeat_pairing.conn_handle, &desc) == 0) {
            ble_store_util_delete_peer(&desc.peer_id_addr);
        }
        return BLE_GAP_REPEAT_PAIRING_RETRY;
    }
    case BLE_GAP_EVENT_MTU:
        ESP_LOGI(TAG, "mtu %d", ev->mtu.value);
        break;
    default:
        break;
    }
    return 0;
}

static void advertise(void)
{
    struct ble_hs_adv_fields adv = {0};
    adv.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    adv.uuids128 = &s_svc_uuid;
    adv.num_uuids128 = 1;
    adv.uuids128_is_complete = 1;
    // Also a HID remote (the Siri button), so iOS lists and pairs it as an accessory.
    static const ble_uuid16_t hid_uuid = BLE_UUID16_INIT(0x1812);
    adv.uuids16 = &hid_uuid;
    adv.num_uuids16 = 1;
    adv.uuids16_is_complete = 1;
    adv.appearance = 0x03C0; // generic HID
    adv.appearance_is_present = 1;
    int rc = ble_gap_adv_set_fields(&adv);
    if (rc != 0) {
        ESP_LOGE(TAG, "adv fields: %d", rc);
        return;
    }

    struct ble_hs_adv_fields rsp = {0};
    rsp.name = (const uint8_t *)s_name;
    rsp.name_len = strlen(s_name);
    rsp.name_is_complete = 1;
    ble_gap_adv_rsp_set_fields(&rsp);

    struct ble_gap_adv_params params = {0};
    params.conn_mode = BLE_GAP_CONN_MODE_UND;
    params.disc_mode = BLE_GAP_DISC_MODE_GEN;
    rc = ble_gap_adv_start(s_own_addr_type, NULL, BLE_HS_FOREVER, &params, gap_event, NULL);
    if (rc != 0 && rc != BLE_HS_EALREADY) {
        ESP_LOGE(TAG, "adv start: %d", rc);
    }
}

static void on_sync(void)
{
    ble_hs_util_ensure_addr(0);
    ble_hs_id_infer_auto(0, &s_own_addr_type);
    advertise();
    ESP_LOGI(TAG, "advertising as %s", s_name);
    obd_on_sync(); // the OBD client scans and connects as a central alongside this peripheral link
}

static void on_reset(int reason)
{
    ESP_LOGW(TAG, "host reset: %d", reason);
}

static void host_task(void *param)
{
    nimble_port_run();
    nimble_port_freertos_deinit();
}

esp_err_t ble_link_init(ble_link_rx_cb_t on_rx, ble_link_conn_cb_t on_conn)
{
    s_on_rx = on_rx;
    s_on_conn = on_conn;

    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_BT);
    snprintf(s_name, sizeof s_name, "OpenBee-%02X%02X", mac[4], mac[5]);

    esp_err_t err = nimble_port_init();
    if (err != ESP_OK) {
        return err;
    }
    ble_hs_cfg.sync_cb = on_sync;
    ble_hs_cfg.reset_cb = on_reset;
    // Bonding for the iPhone's Apple Media Service (Just Works, LE Secure Connections). The OpenBee service
    // itself needs no encryption, so a phone is only asked to pair when ams.c finds AMS on it.
    ble_hs_cfg.sm_bonding = 1;
    ble_hs_cfg.sm_sc = 1;
    ble_hs_cfg.sm_io_cap = BLE_SM_IO_CAP_NO_IO;
    ble_hs_cfg.sm_our_key_dist = BLE_SM_PAIR_KEY_DIST_ENC | BLE_SM_PAIR_KEY_DIST_ID;
    ble_hs_cfg.sm_their_key_dist = BLE_SM_PAIR_KEY_DIST_ENC | BLE_SM_PAIR_KEY_DIST_ID;
    ble_hs_cfg.store_status_cb = ble_store_util_status_rr;

    ble_svc_gap_init();
    ble_svc_gatt_init();
    if (ble_gatts_count_cfg(s_svcs) != 0 || ble_gatts_add_svcs(s_svcs) != 0) {
        return ESP_FAIL;
    }
    ble_svc_gap_device_name_set(s_name);
    ble_att_set_preferred_mtu(247);
    ble_store_config_init();

    nimble_port_freertos_init(host_task);
    return ESP_OK;
}

static esp_err_t hid_report(uint8_t v)
{
    struct os_mbuf *om = ble_hs_mbuf_from_flat(&v, 1);
    if (!om) {
        return ESP_ERR_NO_MEM;
    }
    return ble_gatts_notify_custom(s_conn, s_hid_report_handle, om) == 0 ? ESP_OK : ESP_FAIL;
}

static esp_timer_handle_t s_release_timer;

static void hid_release(void *arg)
{
    if (s_conn != BLE_HS_CONN_HANDLE_NONE && s_hid_subscribed) {
        hid_report(0);
    }
}

esp_err_t ble_link_voice_command(void)
{
    if (s_conn == BLE_HS_CONN_HANDLE_NONE || !s_hid_subscribed) {
        return ESP_ERR_INVALID_STATE;
    }
    if (!s_release_timer) {
        const esp_timer_create_args_t args = {.callback = hid_release, .name = "hid_release"};
        if (esp_timer_create(&args, &s_release_timer) != ESP_OK) {
            return ESP_ERR_NO_MEM;
        }
    }
    if (esp_timer_is_active(s_release_timer)) {
        return ESP_OK; // already held
    }
    esp_err_t err = hid_report(HID_BIT_VOICE);
    esp_timer_start_once(s_release_timer, HID_VOICE_HOLD_US); // release even if the press failed: never stick down
    return err;
}

void ble_link_set_battery(uint8_t pct)
{
    if (pct > 100 || pct == s_batt_pct) {
        return;
    }
    s_batt_pct = pct;
    if (s_conn != BLE_HS_CONN_HANDLE_NONE) {
        ble_gatts_chr_updated(s_batt_handle);
    }
}

bool ble_link_connected(void)
{
    return s_conn != BLE_HS_CONN_HANDLE_NONE;
}

esp_err_t ble_link_send(const uint8_t *data, size_t len)
{
    if (s_conn == BLE_HS_CONN_HANDLE_NONE || !s_tx_subscribed) {
        return ESP_ERR_INVALID_STATE;
    }
    struct os_mbuf *om = ble_hs_mbuf_from_flat(data, len);
    if (!om) {
        return ESP_ERR_NO_MEM;
    }
    return ble_gatts_notify_custom(s_conn, s_tx_handle, om) == 0 ? ESP_OK : ESP_FAIL;
}
