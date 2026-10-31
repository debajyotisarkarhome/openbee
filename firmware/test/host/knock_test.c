// Host test for the double-knock detector on synthetic 896 Hz accelerometer streams.
#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>

#include "knock.h"

#define FS 896.0f // the accelerometer rate imu.c runs at: 224 Hz misses most of a knock's few-ms ring
#define DT (1.0f / FS)

typedef struct {
    float knocks[8]; // knock times, s
    int nknocks;
    float bump_at;   // wide bump (pothole), s; < 0 = none
    float vib_g;     // continuous road vibration amplitude
    float vib_from, vib_to;
} scene_t;

/** Run a scene for `secs`; returns how many double knocks fired. */
static int run(const scene_t *sc, float secs)
{
    knock_t k;
    knock_init(&k);
    int fired = 0;
    srand(1);
    for (int n = 0; n < (int)(secs * FS); n++) {
        float t = n * DT;
        float a[3] = {0.0f, 0.1f, -0.99f}; // the board's resting reading
        for (int i = 0; i < 3; i++) {
            a[i] += ((rand() % 1000) / 1000.0f - 0.5f) * 0.02f; // sensor noise
        }
        for (int j = 0; j < sc->nknocks; j++) {
            float dtk = t - sc->knocks[j];
            if (dtk >= 0 && dtk < 0.03f) { // knuckle: a ~2 g jolt along the screen normal, ringing out in ~15 ms
                a[2] += 2.0f * expf(-dtk / 0.004f) * cosf(2 * (float)M_PI * 180 * dtk);
            }
        }
        if (sc->bump_at >= 0 && t >= sc->bump_at && t < sc->bump_at + 0.12f) {
            a[2] += 1.5f * sinf((float)M_PI * (t - sc->bump_at) / 0.12f);
        }
        if (t >= sc->vib_from && t < sc->vib_to) {
            a[0] += sc->vib_g * sinf(2 * (float)M_PI * 31 * t);
            a[2] += sc->vib_g * sinf(2 * (float)M_PI * 47 * t + 1);
        }
        bool tap;
        fired += knock_update(&k, a, DT, &tap);
    }
    return fired;
}

int main(void)
{
    // A clean double knock fires once.
    assert(run(&(scene_t){.knocks = {2.0f, 2.25f}, .nknocks = 2, .bump_at = -1}, 4) == 1);
    // Slow and quick ends of the window.
    assert(run(&(scene_t){.knocks = {2.0f, 2.45f}, .nknocks = 2, .bump_at = -1}, 4) == 1);
    assert(run(&(scene_t){.knocks = {2.0f, 2.15f}, .nknocks = 2, .bump_at = -1}, 4) == 1);
    // Two double knocks, far enough apart, fire twice.
    assert(run(&(scene_t){.knocks = {2.0f, 2.25f, 5.0f, 5.25f}, .nknocks = 4, .bump_at = -1}, 7) == 2);

    // Not double knocks.
    assert(run(&(scene_t){.knocks = {2.0f}, .nknocks = 1, .bump_at = -1}, 4) == 0);                  // single
    assert(run(&(scene_t){.knocks = {2.0f, 2.8f}, .nknocks = 2, .bump_at = -1}, 4) == 0);            // too slow
    assert(run(&(scene_t){.knocks = {2.0f, 2.25f, 2.5f}, .nknocks = 3, .bump_at = -1}, 4) == 0);     // triple
    assert(run(&(scene_t){.nknocks = 0, .bump_at = 2.0f}, 4) == 0);                                   // pothole
    assert(run(&(scene_t){.knocks = {2.0f}, .nknocks = 1, .bump_at = 2.2f}, 4) == 0);                 // knock + bump
    // Rough road: vibration alone never fires, and a double knock in the middle of it doesn't either.
    assert(run(&(scene_t){.nknocks = 0, .bump_at = -1, .vib_g = 0.6f, .vib_from = 0, .vib_to = 10}, 10) == 0);
    assert(run(&(scene_t){.knocks = {3.0f, 3.25f}, .nknocks = 2, .bump_at = -1, .vib_g = 0.6f, .vib_from = 0,
                          .vib_to = 10},
               10) == 0);
    // Light vibration (a smooth road) doesn't stop a deliberate double knock.
    assert(run(&(scene_t){.knocks = {3.0f, 3.25f}, .nknocks = 2, .bump_at = -1, .vib_g = 0.08f, .vib_from = 0,
                          .vib_to = 10},
               10) == 1);

    printf("knock_test: all passed\n");
    return 0;
}
