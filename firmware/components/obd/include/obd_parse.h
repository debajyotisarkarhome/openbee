// Pure-C helpers for ELM327 replies (OBD-II mode 01 over the adapter's text protocol).
// No ESP-IDF dependencies so it can be tested on the host.
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Mode 01 PIDs the Engine page shows.
enum {
    OBD_PID_SUPPORTED = 0x00, // bitmap of PIDs 01–20
    OBD_PID_LOAD = 0x04,
    OBD_PID_COOLANT = 0x05,
    OBD_PID_RPM = 0x0C,
    OBD_PID_SPEED = 0x0D,
    OBD_PID_THROTTLE = 0x11,
};

/**
 * Find the mode 01 answer for pid in an ELM327 reply (any line, spaces ignored, so it works with or without ATS0
 * and skips "SEARCHING..."). Copies up to max data bytes into out; returns how many, or 0 if the reply has none.
 */
size_t obd_parse_mode01(const char *reply, uint8_t pid, uint8_t *out, size_t max);

/**
 * Decode a multi-PID mode 01 reply ("010C0D110504"), single-frame ("410C1AF80D20") or ISO-TP multi-frame as the
 * ELM327 prints it ("00C", "0:410C1AF80D20", "1:..."). Fills values[i]/got[i] for each pids[i] present and
 * returns how many were decoded.
 */
size_t obd_parse_mode01_multi(const char *reply, const uint8_t *pids, size_t npids, int32_t *values, bool *got);

/** Decode a mode 01 value: RPM in rpm, speed km/h, coolant °C, load/throttle %. False if pid is unknown or n too short. */
bool obd_decode(uint8_t pid, const uint8_t *data, size_t n, int32_t *value);

/** Is PID 01–20 in a 0100 bitmap (4 data bytes)? */
bool obd_pid_supported(const uint8_t bitmap[4], uint8_t pid);

/** True if the adapter says no ECU answered: ignition off, wrong protocol, or bus trouble. */
bool obd_reply_no_ecu(const char *reply);

/** "12.4V" (ATRV) → 12400 mV. False if the reply holds no voltage. */
bool obd_parse_voltage(const char *reply, uint16_t *mv);

#ifdef __cplusplus
}
#endif
