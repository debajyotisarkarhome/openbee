#include "ams_parse.h"

#include <string.h>

// Copies value into dst (capacity max+1) truncating on a UTF-8 boundary.
// Returns true if dst changed.
static bool set_text(char *dst, size_t max, const uint8_t *src, size_t n) {
    if (n > max) {
        n = max;
        while (n > 0 && (src[n] & 0xC0) == 0x80) n--; // don't split a code point
    }
    if (strlen(dst) == n && memcmp(dst, src, n) == 0) return false;
    memcpy(dst, src, n);
    dst[n] = '\0';
    return true;
}

static bool set_u8(uint8_t *dst, uint8_t v) {
    if (*dst == v) return false;
    *dst = v;
    return true;
}

// Parses "0.4375" style decimals (digits, optional fraction) into 0-100.
// Returns 0xFF if the text is not a plain non-negative decimal.
static uint8_t parse_volume_pct(const uint8_t *s, size_t n) {
    double v = 0, scale = 0.1;
    size_t i = 0;
    bool digits = false, frac = false;
    for (; i < n; i++) {
        char c = (char)s[i];
        if (c >= '0' && c <= '9') {
            digits = true;
            if (frac) {
                v += (c - '0') * scale;
                scale /= 10;
            } else if (v < 1e6) {
                v = v * 10 + (c - '0');
            }
        } else if (c == '.' && !frac) {
            frac = true;
        } else {
            return PROTO_UNKNOWN_VOLUME;
        }
    }
    if (!digits) return PROTO_UNKNOWN_VOLUME;
    double pct = v * 100.0 + 0.5;
    if (pct > 100.0) return 100;
    return (uint8_t)pct;
}

bool ams_parse_entity_update(const uint8_t *data, size_t len, media_msg_t *m) {
    if (!data || !m || len < 3) return false;
    const uint8_t *val = data + 3;
    size_t n = len - 3;

    if (data[0] == AMS_ENTITY_TRACK) {
        if (data[1] == AMS_TRACK_TITLE) return set_text(m->title, PROTO_MEDIA_TITLE_MAX, val, n);
        if (data[1] == AMS_TRACK_ARTIST) return set_text(m->artist, PROTO_MEDIA_ARTIST_MAX, val, n);
    } else if (data[0] == AMS_ENTITY_PLAYER) {
        if (data[1] == AMS_PLAYER_PLAYBACK_INFO) {
            if (n == 0) return set_u8(&m->state, MEDIA_NONE);
            // First comma-separated field is the state: 0 paused, 1 playing, 2 rewinding, 3 fast-forwarding.
            if (val[0] == '0') return set_u8(&m->state, MEDIA_PAUSED);
            if (val[0] >= '1' && val[0] <= '3') return set_u8(&m->state, MEDIA_PLAYING);
            return false;
        }
        if (data[1] == AMS_PLAYER_VOLUME) return set_u8(&m->volume_pct, parse_volume_pct(val, n));
    }
    return false;
}

uint8_t ams_remote_cmd(uint8_t media_cmd) {
    switch (media_cmd) {
    case MEDIA_CMD_TOGGLE: return 2;
    case MEDIA_CMD_NEXT: return 3;
    case MEDIA_CMD_PREV: return 4;
    case MEDIA_CMD_VOL_UP: return 5;
    case MEDIA_CMD_VOL_DOWN: return 6;
    default: return 0xFF;
    }
}
