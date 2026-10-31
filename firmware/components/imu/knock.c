#include "knock.h"

#include <math.h>

#define KNOCK_LP_TAU_S 0.05f    // high-pass corner: anything slower than ~3 Hz is motion, not a knock
#define KNOCK_HI_G 0.8f         // spike threshold (high-passed magnitude)
#define KNOCK_LO_G 0.3f         // spike is over once back below this
#define KNOCK_QUIET_G 0.3f      // "calm" means staying below this
#define KNOCK_MAX_WIDTH_S 0.04f // longer than this is a bump or a shove, not a knuckle
#define KNOCK_GAP_MIN_S 0.12f   // two knocks closer than this are one knock ringing
#define KNOCK_GAP_MAX_S 0.50f
#define KNOCK_QUIET_BEFORE_S 0.30f
#define KNOCK_CONFIRM_S 0.30f   // wait this long after the second knock for a third (then it's rattle)
#define KNOCK_COOLDOWN_S 1.5f
#define KNOCK_SETTLE_S 0.3f     // let the low-pass settle after start

void knock_init(knock_t *k)
{
    *k = (knock_t){.tap1 = -1, .tap2 = -1};
}

static void reset_pending(knock_t *k)
{
    k->tap1 = k->tap2 = -1;
}

bool knock_update(knock_t *k, const float acc_g[3], float dt, bool *tap)
{
    *tap = false;
    k->t += dt;
    if (!k->primed) {
        for (int i = 0; i < 3; i++) {
            k->lp[i] = acc_g[i];
        }
        k->primed = true;
        k->quiet_since = k->t;
        return false;
    }
    float alpha = dt / (KNOCK_LP_TAU_S + dt);
    float hp2 = 0;
    for (int i = 0; i < 3; i++) {
        k->lp[i] += alpha * (acc_g[i] - k->lp[i]);
        float h = acc_g[i] - k->lp[i];
        hp2 += h * h;
    }
    float hp = sqrtf(hp2);
    if (k->t < KNOCK_SETTLE_S) {
        k->quiet_since = k->t;
        return false;
    }

    // Calm stretches, measured edge to edge: the rise into a knock is itself loud, so "how quiet was it before"
    // has to be taken at the moment it went loud, not when the spike threshold was crossed a sample later.
    if (!k->loud && hp > KNOCK_QUIET_G) {
        k->loud = true;
        k->quiet_len = k->t - k->quiet_since;
    } else if (k->loud && hp < KNOCK_QUIET_G) {
        k->loud = false;
        k->quiet_since = k->t;
    }

    // Spike tracking.
    if (!k->in_spike && hp > KNOCK_HI_G) {
        k->in_spike = true;
        k->spike_start = k->t;
        k->spike_peak = hp;
    } else if (k->in_spike) {
        if (hp > k->spike_peak) {
            k->spike_peak = hp;
        }
        if (hp < KNOCK_LO_G) {
            k->in_spike = false;
            float width = k->t - k->spike_start;
            k->last_peak_g = k->spike_peak;
            k->last_width_s = width;
            if (width <= KNOCK_MAX_WIDTH_S && k->t >= k->cooldown_until) {
                *tap = true;
                float quiet = k->quiet_len;
                if (k->tap1 < 0) {
                    k->tap1 = k->spike_start;
                    k->quiet_before = quiet;
                } else if (k->tap2 < 0) {
                    float gap = k->spike_start - k->tap1;
                    if (gap < KNOCK_GAP_MIN_S) {
                        // ringing of the first knock: ignore
                    } else if (gap <= KNOCK_GAP_MAX_S) {
                        k->tap2 = k->spike_start;
                    } else { // too late: this one starts a new pair
                        k->tap1 = k->spike_start;
                        k->quiet_before = quiet;
                    }
                } else if (k->spike_start - k->tap2 >= KNOCK_GAP_MIN_S) {
                    reset_pending(k); // a third knock: rattle, not a double knock
                }
            } else if (width > KNOCK_MAX_WIDTH_S) {
                reset_pending(k); // a bump in between spoils the pair
            }
        } else if (k->t - k->spike_start > KNOCK_MAX_WIDTH_S * 4) {
            k->in_spike = false; // sustained: treat as noise
            reset_pending(k);
        }
    }

    // Decide once the confirm window after the second knock has passed.
    bool fired = false;
    if (k->tap2 >= 0 && k->t - k->tap2 >= KNOCK_CONFIRM_S) {
        fired = k->quiet_before >= KNOCK_QUIET_BEFORE_S;
        reset_pending(k);
        if (fired) {
            k->cooldown_until = k->t + KNOCK_COOLDOWN_S;
        }
    } else if (k->tap1 >= 0 && k->tap2 < 0 && k->t - k->tap1 > KNOCK_GAP_MAX_S) {
        reset_pending(k); // a lone knock
    }
    return fired;
}
