#include "obd_parse.h"

#include <ctype.h>
#include <string.h>

static int hexval(char c)
{
    if (c >= '0' && c <= '9') {
        return c - '0';
    }
    c = (char)toupper((unsigned char)c);
    return c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1;
}

size_t obd_parse_mode01(const char *reply, uint8_t pid, uint8_t *out, size_t max)
{
    const char *p = reply;
    while (*p) {
        // One line at a time, with spaces squeezed out: "41 0C 1A F8" and "410C1AF8" read the same.
        char hex[64];
        size_t h = 0;
        for (; *p && *p != '\r' && *p != '\n'; p++) {
            if (*p != ' ' && h < sizeof hex - 1) {
                hex[h++] = *p;
            }
        }
        while (*p == '\r' || *p == '\n') {
            p++;
        }
        hex[h] = '\0';
        if (h < 4 || hexval(hex[0]) != 4 || hexval(hex[1]) != 1) {
            continue;
        }
        int hi = hexval(hex[2]), lo = hexval(hex[3]);
        if (hi < 0 || lo < 0 || (uint8_t)(hi << 4 | lo) != pid) {
            continue;
        }
        size_t n = 0;
        for (size_t i = 4; i + 2 <= h && n < max; i += 2) {
            int a = hexval(hex[i]), b = hexval(hex[i + 1]);
            if (a < 0 || b < 0) {
                break;
            }
            out[n++] = (uint8_t)(a << 4 | b);
        }
        return n;
    }
    return 0;
}

/** Data bytes after a mode 01 PID, or 0 if this parser doesn't know the PID. */
static size_t pid_len(uint8_t pid)
{
    switch (pid) {
    case OBD_PID_SUPPORTED: return 4;
    case OBD_PID_RPM: return 2;
    case OBD_PID_SPEED:
    case OBD_PID_COOLANT:
    case OBD_PID_LOAD:
    case OBD_PID_THROTTLE: return 1;
    default: return 0;
    }
}

static size_t hex_bytes(const char *hex, size_t h, uint8_t *out, size_t max)
{
    size_t n = 0;
    for (size_t i = 0; i + 2 <= h && n < max; i += 2) {
        int a = hexval(hex[i]), b = hexval(hex[i + 1]);
        if (a < 0 || b < 0) {
            break;
        }
        out[n++] = (uint8_t)(a << 4 | b);
    }
    return n;
}

size_t obd_parse_mode01_multi(const char *reply, const uint8_t *pids, size_t npids, int32_t *values, bool *got)
{
    // Gather the message payload: either one "41..." line, or a byte count line then "N:" frame lines.
    uint8_t msg[64];
    size_t len = 0, declared = 0;
    int next_frame = 0;
    const char *p = reply;
    while (*p) {
        char hex[64];
        size_t h = 0;
        for (; *p && *p != '\r' && *p != '\n'; p++) {
            if (*p != ' ' && h < sizeof hex - 1) {
                hex[h++] = *p;
            }
        }
        while (*p == '\r' || *p == '\n') {
            p++;
        }
        hex[h] = '\0';
        if (h >= 2 && hex[1] == ':' && hexval(hex[0]) >= 0) {
            // Frame lines in order only: a repeated or out-of-order frame (seen on clones) is dropped.
            if (hexval(hex[0]) == (next_frame & 0xF)) {
                next_frame++;
                len += hex_bytes(hex + 2, h - 2, msg + len, sizeof msg - len);
            }
        } else if (h == 3 && hexval(hex[0]) >= 0 && hexval(hex[1]) >= 0 && hexval(hex[2]) >= 0 && !len) {
            declared = (size_t)(hexval(hex[0]) << 8 | hexval(hex[1]) << 4 | hexval(hex[2]));
        } else if (!len && !declared && h >= 4 && hexval(hex[0]) == 4 && hexval(hex[1]) == 1) {
            len = hex_bytes(hex, h, msg, sizeof msg);
            break; // a second single-frame line is another ECU (or a repeat): the first one wins
        }
    }
    if (declared && declared < len) {
        len = declared; // ISO-TP pads the last frame
    }
    for (size_t i = 0; i < npids; i++) {
        got[i] = false;
    }
    if (len < 1 || msg[0] != 0x41) {
        return 0;
    }
    size_t found = 0;
    for (size_t i = 1; i < len;) {
        uint8_t pid = msg[i];
        size_t dl = pid_len(pid);
        if (!dl || i + 1 + dl > len) {
            break; // unknown PID: the rest can't be framed
        }
        for (size_t k = 0; k < npids; k++) {
            if (pids[k] == pid && !got[k] && obd_decode(pid, msg + i + 1, dl, &values[k])) {
                got[k] = true;
                found++;
            }
        }
        i += 1 + dl;
    }
    return found;
}

bool obd_decode(uint8_t pid, const uint8_t *data, size_t n, int32_t *value)
{
    switch (pid) {
    case OBD_PID_RPM:
        if (n < 2) {
            return false;
        }
        *value = (data[0] * 256 + data[1]) / 4;
        return true;
    case OBD_PID_SPEED:
        if (n < 1) {
            return false;
        }
        *value = data[0];
        return true;
    case OBD_PID_COOLANT:
        if (n < 1) {
            return false;
        }
        *value = data[0] - 40;
        return true;
    case OBD_PID_LOAD:
    case OBD_PID_THROTTLE:
        if (n < 1) {
            return false;
        }
        *value = (data[0] * 100 + 127) / 255;
        return true;
    default:
        return false;
    }
}

bool obd_pid_supported(const uint8_t bitmap[4], uint8_t pid)
{
    if (pid < 1 || pid > 0x20) {
        return false;
    }
    unsigned bit = pid - 1; // PID 01 is the top bit of the first byte
    return bitmap[bit / 8] & (0x80 >> (bit % 8));
}

bool obd_reply_no_ecu(const char *reply)
{
    // "ERROR" also covers CAN ERROR, BUS ERROR, FB ERROR, DATA ERROR and a failed "BUS INIT: ...ERROR".
    static const char *const kinds[] = {"NO DATA", "UNABLE TO CONNECT", "STOPPED", "ERROR"};
    for (size_t i = 0; i < sizeof kinds / sizeof kinds[0]; i++) {
        if (strstr(reply, kinds[i])) {
            return true;
        }
    }
    return false;
}

bool obd_parse_voltage(const char *reply, uint16_t *mv)
{
    for (const char *p = reply; *p; p++) {
        if (!isdigit((unsigned char)*p)) {
            continue;
        }
        unsigned whole = 0, frac = 0, frac_digits = 0;
        const char *q = p;
        for (; isdigit((unsigned char)*q); q++) {
            whole = whole * 10 + (unsigned)(*q - '0');
        }
        if (*q == '.') {
            for (q++; isdigit((unsigned char)*q); q++) {
                if (frac_digits < 3) {
                    frac = frac * 10 + (unsigned)(*q - '0');
                    frac_digits++;
                }
            }
        }
        if (*q != 'V' && *q != 'v') {
            p = q - 1; // a number that isn't a voltage; keep looking after it
            if (!*q) {
                break;
            }
            continue;
        }
        while (frac_digits < 3) {
            frac *= 10;
            frac_digits++;
        }
        unsigned v = whole * 1000 + frac;
        if (v > 60000) {
            return false;
        }
        *mv = (uint16_t)v;
        return true;
    }
    return false;
}
