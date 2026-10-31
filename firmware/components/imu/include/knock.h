// Double-knock detector on accelerometer samples. Pure C (host-tested in test/host/knock_test.c).
//
// A knock is a short, sharp spike once gravity and slow motion are removed: the high-passed magnitude goes over
// KNOCK_HI_G and falls back within KNOCK_MAX_WIDTH_S. A double knock is two of them 120–500 ms apart, after a quiet
// spell (so rough road doesn't count) and with no third one right after (so rattling doesn't count).
#pragma once

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    float lp[3];         // slow component (gravity + body motion)
    float t;             // seconds since start
    bool loud;           // high-passed magnitude above KNOCK_QUIET_G right now
    float quiet_since;   // when the current (or last) calm stretch began
    float quiet_len;     // how long the calm lasted before the signal last went loud
    bool in_spike;
    float spike_start, spike_peak;
    float tap1, tap2;    // times of the pending knocks; < 0 = none
    float quiet_before;  // how long it had been quiet before tap1
    float cooldown_until;
    bool primed;
    // Last spike, for tuning logs.
    float last_peak_g, last_width_s;
} knock_t;

void knock_init(knock_t *k);

/**
 * Feed one sample (g, any axes) taken dt seconds after the last. Returns true once per double knock (~300 ms after
 * the second knock, when no third one came). *tap is set when a single knock was just recognised (for tuning logs).
 */
bool knock_update(knock_t *k, const float acc_g[3], float dt, bool *tap);

#ifdef __cplusplus
}
#endif
