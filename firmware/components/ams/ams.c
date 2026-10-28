#include "ams.h"

#include <stdatomic.h>
#include <string.h>

#include "ams_parse.h"
#include "esp_log.h"

static const char *TAG = "ams";

// Apple AMS UUIDs (little-endian byte order):
//   service        89D3502B-0F36-433A-8EF4-C502AD55F8DC
//   Remote Command 9B3C81D8-57B1-4A8A-B8DF-0E56F7CA51C2
//   Entity Update  2F7CABCE-808D-411F-9A0C-BB92BA96C102
//   (Entity Attribute C6B2F38C-23AB-46D8-A6AB-A3A870BBD5D7 is not used: truncated titles are fine.)
static const ble_uuid128_t s_svc_uuid = BLE_UUID128_INIT(0xdc, 0xf8, 0x55, 0xad, 0x02, 0xc5, 0xf4, 0x8e, 0x3a, 0x43, 0x36,
                                                         0x0f, 0x2b, 0x50, 0xd3, 0x89);
static const ble_uuid128_t s_rc_uuid = BLE_UUID128_INIT(0xc2, 0x51, 0xca, 0xf7, 0x56, 0x0e, 0xdf, 0xb8, 0x8a, 0x4a, 0xb1,
                                                        0x57, 0xd8, 0x81, 0x3c, 0x9b);
static const ble_uuid128_t s_eu_uuid = BLE_UUID128_INIT(0x02, 0xc1, 0x96, 0xba, 0x92, 0xbb, 0x0c, 0x9a, 0x1f, 0x41, 0x8d,
                                                        0x80, 0xce, 0xab, 0x7c, 0x2f);
static const ble_uuid16_t s_cccd_uuid = BLE_UUID16_INIT(BLE_GATT_DSC_CLT_CFG_UUID16);

static ams_media_cb_t s_on_media;

// Per-connection state. Only the NimBLE host task touches it (GAP events and GATT callbacks both run there).
static uint16_t s_conn = BLE_HS_CONN_HANDLE_NONE;
static uint32_t s_gen; // bumped on connect/disconnect; passed as cb_arg so a stale GATT callback is ignored
static uint16_t s_svc_start, s_svc_end;
static uint16_t s_eu_def, s_eu_val, s_eu_end, s_eu_cccd;
static uint16_t s_rc_val;
static bool s_subscribing;   // CCCD write + registration chain in flight
static bool s_no_more_security; // security already requested (or failed) on this connection
static bool s_encrypted_retry;  // already re-subscribed once after a security error on an encrypted link
static bool s_media_reported;   // on_media was called on this connection
static media_msg_t s_media;

// Shared with ams_send/ams_active, which run in other tasks.
static atomic_bool s_active;
static atomic_bool s_rc_busy;    // one Remote Command write at a time
static atomic_uint s_rc_target;  // (conn << 16) | Remote Command value handle; stored before s_active

static void *gen_arg(void)
{
    return (void *)(uintptr_t)s_gen;
}

static bool current(uint16_t conn, void *arg)
{
    return conn == s_conn && (uintptr_t)arg == s_gen;
}

static void reset(uint16_t conn)
{
    atomic_store(&s_active, false);
    atomic_store(&s_rc_busy, false);
    s_gen++;
    s_conn = conn;
    s_svc_start = s_svc_end = 0;
    s_eu_def = s_eu_val = s_eu_end = s_eu_cccd = 0;
    s_rc_val = 0;
    s_subscribing = false;
    s_no_more_security = false;
    s_encrypted_retry = false;
    s_media_reported = false;
    memset(&s_media, 0, sizeof s_media);
    s_media.state = MEDIA_NONE;
    s_media.volume_pct = PROTO_UNKNOWN_VOLUME;
}

static bool is_security_error(int status)
{
    return status == BLE_HS_ATT_ERR(BLE_ATT_ERR_INSUFFICIENT_AUTHEN) ||
           status == BLE_HS_ATT_ERR(BLE_ATT_ERR_INSUFFICIENT_ENC);
}

/** An ATT error response from the iPhone, as opposed to a host error (not connected, timeout, no memory...). */
static bool is_att_error(int status)
{
    return status > BLE_HS_ERR_ATT_BASE && status < BLE_HS_ERR_ATT_BASE + 0x100;
}

static bool link_encrypted(void)
{
    struct ble_gap_conn_desc desc;
    return ble_gap_conn_find(s_conn, &desc) == 0 && desc.sec_state.encrypted;
}

static void subscribe(void);

/** End the subscribe chain after a failed step. A security error asks iOS to pair, once per connection;
 *  the resulting ENC_CHANGE restarts the chain. */
static void subscribe_failed(const char *step, int status)
{
    s_subscribing = false;
    if (!is_security_error(status)) {
        ESP_LOGW(TAG, "%s failed: %d", step, status);
        return;
    }
    if (link_encrypted()) {
        // The write went out just before encryption completed (a bonded iPhone reconnecting), and the
        // ENC_CHANGE that would have re-subscribed was skipped because this chain was in flight. Retry once.
        if (s_encrypted_retry) {
            ESP_LOGW(TAG, "%s rejected on an encrypted link: %d", step, status);
            return;
        }
        s_encrypted_retry = true;
        subscribe();
        return;
    }
    if (s_no_more_security) {
        ESP_LOGI(TAG, "%s needs pairing; not asking again on this connection", step);
        return;
    }
    s_no_more_security = true;
    int rc = ble_gap_security_initiate(s_conn);
    ESP_LOGI(TAG, "%s needs pairing; security request: %d", step, rc);
}

static int track_registered(uint16_t conn, const struct ble_gatt_error *error, struct ble_gatt_attr *attr, void *arg)
{
    if (!current(conn, arg)) {
        return 0;
    }
    if (error->status != 0) {
        if (!is_att_error(error->status) || is_security_error(error->status)) {
            subscribe_failed("track register", error->status);
            return 0;
        }
        ESP_LOGW(TAG, "track register rejected: %d", error->status); // the CCCD is set; carry on
    }
    s_subscribing = false;
    atomic_store(&s_rc_target, ((unsigned)s_conn << 16) | s_rc_val);
    atomic_store(&s_active, true);
    ESP_LOGI(TAG, "subscribed");
    return 0;
}

static int player_registered(uint16_t conn, const struct ble_gatt_error *error, struct ble_gatt_attr *attr, void *arg)
{
    if (!current(conn, arg)) {
        return 0;
    }
    if (error->status != 0) {
        if (!is_att_error(error->status) || is_security_error(error->status)) {
            subscribe_failed("player register", error->status);
            return 0;
        }
        ESP_LOGW(TAG, "player register rejected: %d", error->status); // the CCCD is set; carry on
    }
    static const uint8_t track[] = {AMS_ENTITY_TRACK, AMS_TRACK_ARTIST, AMS_TRACK_TITLE};
    int rc = ble_gattc_write_flat(conn, s_eu_val, track, sizeof track, track_registered, arg);
    if (rc != 0) {
        subscribe_failed("track register", rc);
    }
    return 0;
}

static int cccd_written(uint16_t conn, const struct ble_gatt_error *error, struct ble_gatt_attr *attr, void *arg)
{
    if (!current(conn, arg)) {
        return 0;
    }
    if (error->status != 0) {
        subscribe_failed("subscribe", error->status);
        return 0;
    }
    static const uint8_t player[] = {AMS_ENTITY_PLAYER, AMS_PLAYER_NAME, AMS_PLAYER_PLAYBACK_INFO, AMS_PLAYER_VOLUME};
    int rc = ble_gattc_write_flat(conn, s_eu_val, player, sizeof player, player_registered, arg);
    if (rc != 0) {
        subscribe_failed("player register", rc);
    }
    return 0;
}

static void subscribe(void)
{
    static const uint8_t notify[] = {0x01, 0x00};
    s_subscribing = true;
    int rc = ble_gattc_write_flat(s_conn, s_eu_cccd, notify, sizeof notify, cccd_written, gen_arg());
    if (rc != 0) {
        subscribe_failed("subscribe", rc);
    }
}

static int dsc_found(uint16_t conn, const struct ble_gatt_error *error, uint16_t chr_val_handle,
                     const struct ble_gatt_dsc *dsc, void *arg)
{
    if (!current(conn, arg)) {
        return 0;
    }
    if (error->status == 0) {
        if (ble_uuid_cmp(&dsc->uuid.u, &s_cccd_uuid.u) == 0) {
            s_eu_cccd = dsc->handle;
        }
        return 0;
    }
    if (error->status != BLE_HS_EDONE) {
        ESP_LOGW(TAG, "descriptor discovery failed: %d", error->status);
    } else if (!s_eu_cccd) {
        ESP_LOGW(TAG, "Entity Update has no CCCD");
    } else if (!s_subscribing && !atomic_load(&s_active)) {
        subscribe();
    }
    return 0;
}

static int chr_found(uint16_t conn, const struct ble_gatt_error *error, const struct ble_gatt_chr *chr, void *arg)
{
    if (!current(conn, arg)) {
        return 0;
    }
    if (error->status == 0) {
        if (ble_uuid_cmp(&chr->uuid.u, &s_eu_uuid.u) == 0) {
            s_eu_def = chr->def_handle;
            s_eu_val = chr->val_handle;
        } else if (ble_uuid_cmp(&chr->uuid.u, &s_rc_uuid.u) == 0) {
            s_rc_val = chr->val_handle;
        }
        // Entity Update's descriptors end where the next characteristic starts.
        if (s_eu_def && chr->def_handle > s_eu_def && chr->def_handle - 1 < s_eu_end) {
            s_eu_end = chr->def_handle - 1;
        }
        return 0;
    }
    if (error->status != BLE_HS_EDONE) {
        ESP_LOGW(TAG, "characteristic discovery failed: %d", error->status);
        return 0;
    }
    if (!s_eu_val || !s_rc_val) {
        ESP_LOGW(TAG, "AMS is missing Entity Update or Remote Command");
        return 0;
    }
    int rc = ble_gattc_disc_all_dscs(conn, s_eu_val, s_eu_end, dsc_found, arg);
    if (rc != 0) {
        ESP_LOGW(TAG, "descriptor discovery: %d", rc);
    }
    return 0;
}

static int svc_found(uint16_t conn, const struct ble_gatt_error *error, const struct ble_gatt_svc *svc, void *arg)
{
    if (!current(conn, arg)) {
        return 0;
    }
    if (error->status == 0) {
        s_svc_start = svc->start_handle;
        s_svc_end = svc->end_handle;
        s_eu_end = svc->end_handle;
        return 0;
    }
    if (error->status != BLE_HS_EDONE) {
        ESP_LOGW(TAG, "service discovery failed: %d", error->status);
        return 0;
    }
    if (!s_svc_start) {
        ESP_LOGI(TAG, "no AMS on this phone");
        return 0;
    }
    int rc = ble_gattc_disc_all_chrs(conn, s_svc_start, s_svc_end, chr_found, arg);
    if (rc != 0) {
        ESP_LOGW(TAG, "characteristic discovery: %d", rc);
    }
    return 0;
}

void ams_init(ams_media_cb_t on_media)
{
    s_on_media = on_media;
    reset(BLE_HS_CONN_HANDLE_NONE);
}

void ams_on_connect(uint16_t conn)
{
    reset(conn);
    int rc = ble_gattc_disc_svc_by_uuid(conn, &s_svc_uuid.u, svc_found, gen_arg());
    if (rc != 0) {
        ESP_LOGW(TAG, "service discovery: %d", rc);
    }
}

void ams_on_enc_change(uint16_t conn, int status)
{
    if (conn != s_conn) {
        return;
    }
    if (status != 0) {
        s_no_more_security = true; // declined or failed: no second prompt on this connection
        ESP_LOGI(TAG, "pairing failed (%d); no media from this phone until it reconnects", status);
        return;
    }
    // Before discovery finishes there is no CCCD yet; discovery then subscribes over the encrypted link.
    if (s_eu_cccd && !s_subscribing && !atomic_load(&s_active)) {
        subscribe();
    }
}

void ams_on_notify_rx(uint16_t conn, uint16_t attr, struct os_mbuf *om)
{
    if (conn != s_conn || !s_eu_val || attr != s_eu_val || !om) {
        return;
    }
    static uint8_t buf[256]; // > ATT MTU 247; a longer value is just truncated further
    uint16_t len = OS_MBUF_PKTLEN(om);
    if (len > sizeof buf) {
        len = sizeof buf;
    }
    if (os_mbuf_copydata(om, 0, len, buf) != 0) {
        return;
    }
    if (ams_parse_entity_update(buf, len, &s_media) && s_on_media) {
        s_media_reported = true;
        s_on_media(&s_media);
    }
}

void ams_on_disconnect(void)
{
    // Only clear what AMS itself put on screen: on Android a NONE here could land after (and overwrite) a
    // fresh phone MEDIA frame. main.c clears the UI on disconnect anyway.
    bool served = atomic_load(&s_active) || s_media_reported;
    reset(BLE_HS_CONN_HANDLE_NONE);
    if (served && s_on_media) {
        s_on_media(&s_media);
    }
}

bool ams_active(void)
{
    return atomic_load(&s_active);
}

static int rc_written(uint16_t conn, const struct ble_gatt_error *error, struct ble_gatt_attr *attr, void *arg)
{
    atomic_store(&s_rc_busy, false);
    if (error->status != 0) {
        ESP_LOGW(TAG, "remote command failed: %d", error->status); // e.g. AMS 0xA0 "player not ready"
    }
    return 0;
}

esp_err_t ams_send(uint8_t media_cmd)
{
    if (!atomic_load(&s_active)) {
        return ESP_ERR_INVALID_STATE;
    }
    uint8_t id = ams_remote_cmd(media_cmd);
    if (id == 0xFF) {
        return ESP_ERR_INVALID_ARG;
    }
    bool idle = false;
    if (!atomic_compare_exchange_strong(&s_rc_busy, &idle, true)) {
        return ESP_ERR_NOT_FINISHED; // previous command still awaiting its response
    }
    unsigned target = atomic_load(&s_rc_target);
    int rc = ble_gattc_write_flat((uint16_t)(target >> 16), (uint16_t)target, &id, 1, rc_written, NULL);
    if (rc != 0) {
        atomic_store(&s_rc_busy, false);
        return ESP_FAIL;
    }
    return ESP_OK;
}
