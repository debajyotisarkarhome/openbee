#include "proto.h"

#include <string.h>

typedef struct {
    const uint8_t *p;
    size_t left;
    bool ok;
} reader_t;

static uint8_t rd_u8(reader_t *r)
{
    if (r->left < 1) {
        r->ok = false;
        return 0;
    }
    r->left--;
    return *r->p++;
}

static uint16_t rd_u16(reader_t *r)
{
    uint16_t lo = rd_u8(r);
    return lo | (uint16_t)(rd_u8(r) << 8);
}

static uint32_t rd_u32(reader_t *r)
{
    uint32_t lo = rd_u16(r);
    return lo | ((uint32_t)rd_u16(r) << 16);
}

static void rd_str(reader_t *r, char *dst)
{
    uint8_t n = rd_u8(r);
    if (!r->ok || n > r->left) {
        r->ok = false;
        dst[0] = '\0';
        return;
    }
    memcpy(dst, r->p, n);
    dst[n] = '\0';
    r->p += n;
    r->left -= n;
}

// Like rd_str but fails when the string is longer than `max` (dst must hold max + 1).
static void rd_str_max(reader_t *r, char *dst, size_t max)
{
    uint8_t n = rd_u8(r);
    if (!r->ok || n > max || n > r->left) {
        r->ok = false;
        dst[0] = '\0';
        return;
    }
    memcpy(dst, r->p, n);
    dst[n] = '\0';
    r->p += n;
    r->left -= n;
}

bool proto_decode(const uint8_t *frame, size_t len, proto_msg_t *out)
{
    if (len < 4 || frame[0] != PROTO_VER) {
        return false;
    }
    size_t plen = frame[2] | ((size_t)frame[3] << 8);
    if (plen > PROTO_MAX_PAYLOAD || len != 4 + plen) {
        return false;
    }
    reader_t r = {.p = frame + 4, .left = plen, .ok = true};
    out->type = (msg_type_t)frame[1];

    switch (out->type) {
    case MSG_NAV: {
        nav_msg_t *m = &out->u.nav;
        m->maneuver = rd_u8(&r);
        m->exit = rd_u8(&r);
        m->dist_m = rd_u16(&r);
        m->curve_dir = (int8_t)rd_u8(&r);
        m->curve_class = rd_u8(&r);
        m->curve_dist_m = rd_u16(&r);
        m->maneuver_idx = rd_u8(&r);
        m->anchor_id = rd_u8(&r);
        m->pose_x = (int16_t)rd_u16(&r);
        m->pose_y = (int16_t)rd_u16(&r);
        m->heading_cdeg = rd_u16(&r);
        m->n = rd_u8(&r);
        if (m->n > PROTO_MAX_POINTS) {
            return false;
        }
        for (int i = 0; i < m->n; i++) {
            m->points[i].x = (int16_t)rd_u16(&r);
            m->points[i].y = (int16_t)rd_u16(&r);
            m->points[i].cls = rd_u8(&r);
        }
        rd_str(&r, m->street);
        break;
    }
    case MSG_TRIP: {
        trip_msg_t *m = &out->u.trip;
        m->speed_kmh = rd_u8(&r);
        m->limit_kmh = rd_u8(&r);
        m->eta_epoch = rd_u32(&r);
        m->remaining_m = rd_u32(&r);
        m->phone_batt = rd_u8(&r);
        m->now_epoch = rd_u32(&r);
        m->tz_offset_min = (int16_t)rd_u16(&r);
        break;
    }
    case MSG_NOTIF: {
        notif_msg_t *m = &out->u.notif;
        m->kind = rd_u8(&r);
        rd_str(&r, m->app);
        rd_str(&r, m->title);
        rd_str(&r, m->body);
        break;
    }
    case MSG_STATE:
        out->u.state = rd_u8(&r);
        break;
    case MSG_ROADS: {
        roads_msg_t *m = &out->u.roads;
        m->anchor_id = rd_u8(&r);
        m->part = rd_u8(&r);
        m->parts = rd_u8(&r);
        m->nroads = rd_u8(&r);
        m->npoints = 0;
        if (m->nroads > PROTO_MAX_ROADS_PER_FRAME || m->parts == 0 || m->part >= m->parts) {
            return false;
        }
        for (int i = 0; i < m->nroads && r.ok; i++) {
            m->len[i] = rd_u8(&r);
            if (m->npoints + m->len[i] > PROTO_MAX_ROAD_POINTS_PER_FRAME) {
                return false;
            }
            for (int k = 0; k < m->len[i]; k++) {
                m->pts[m->npoints].x = (int16_t)rd_u16(&r);
                m->pts[m->npoints].y = (int16_t)rd_u16(&r);
                m->npoints++;
            }
        }
        break;
    }
    case MSG_MEDIA: {
        media_msg_t *m = &out->u.media;
        m->state = rd_u8(&r);
        m->volume_pct = rd_u8(&r);
        rd_str_max(&r, m->title, PROTO_MEDIA_TITLE_MAX);
        rd_str_max(&r, m->artist, PROTO_MEDIA_ARTIST_MAX);
        break;
    }
    case MSG_MEDIA_CMD:
        out->u.media_cmd = rd_u8(&r);
        break;
    case MSG_DEV_STATUS: {
        dev_status_msg_t *m = &out->u.dev_status;
        m->batt_pct = rd_u8(&r);
        m->batt_mv = rd_u16(&r);
        m->charging = rd_u8(&r);
        m->fw_ver = rd_u8(&r);
        break;
    }
    default:
        return false;
    }
    return r.ok;
}

size_t proto_encode_dev_status(const dev_status_msg_t *m, uint8_t *buf)
{
    buf[0] = PROTO_VER;
    buf[1] = MSG_DEV_STATUS;
    buf[2] = 5;
    buf[3] = 0;
    buf[4] = m->batt_pct;
    buf[5] = m->batt_mv & 0xFF;
    buf[6] = m->batt_mv >> 8;
    buf[7] = m->charging ? 1 : 0;
    buf[8] = m->fw_ver;
    return 9;
}

size_t proto_encode_media_cmd(uint8_t cmd, uint8_t *buf)
{
    buf[0] = PROTO_VER;
    buf[1] = MSG_MEDIA_CMD;
    buf[2] = 1;
    buf[3] = 0;
    buf[4] = cmd;
    return 5;
}
