// Demo mode: rides a canned road (straights, bends, intersection turns) and produces NAV/TRIP messages
// the same way the phone does, so the UI can be judged on the device without a phone.
#include "demo.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

#define STEP_M 5.0f
#define MAX_PTS 700
#define MAX_MAN 8
#define SPEED_MPS 14.0f
#define OUT_STEP 3 // output point every 3 samples = 15 m → 39 × 15 = 585 m ahead
#define CURVE_HALF 3 // ±15 m window for curvature
#define LOOKAHEAD 120 // samples (600 m) for the curve warning

static float s_x[MAX_PTS], s_y[MAX_PTS];
static int s_n;
static struct {
    int idx;
    uint8_t maneuver;
    const char *street;
} s_man[MAX_MAN];
static int s_nman;
static float s_heading; // degrees, clockwise from north
static float s_progress; // in samples
static uint32_t s_t0;

static void straight(float m)
{
    for (float d = STEP_M; d <= m && s_n < MAX_PTS; d += STEP_M, s_n++) {
        float h = s_heading * (float)M_PI / 180.0f;
        s_x[s_n] = s_x[s_n - 1] + sinf(h) * STEP_M;
        s_y[s_n] = s_y[s_n - 1] + cosf(h) * STEP_M;
    }
}

static void arc(float radius, float deg)
{
    float len = fabsf(deg) * (float)M_PI * radius / 180.0f;
    int k = (int)(len / STEP_M);
    float dh = deg / k;
    for (int i = 0; i < k && s_n < MAX_PTS; i++, s_n++) {
        s_heading += dh;
        float h = s_heading * (float)M_PI / 180.0f;
        s_x[s_n] = s_x[s_n - 1] + sinf(h) * STEP_M;
        s_y[s_n] = s_y[s_n - 1] + cosf(h) * STEP_M;
    }
}

static void turn(float deg, uint8_t maneuver, const char *street)
{
    s_man[s_nman++] = (typeof(s_man[0])){.idx = s_n - 1, .maneuver = maneuver, .street = street};
    s_heading += deg;
}

void demo_init(uint32_t now_s)
{
    s_n = 1;
    s_x[0] = s_y[0] = 0;
    s_heading = 0;
    s_nman = 0;
    straight(250);
    arc(40, -90);
    straight(200);
    turn(90, MAN_RIGHT, "Ridge Road");
    straight(250);
    arc(120, 60);
    arc(120, -60);
    straight(150);
    arc(55, 110);
    straight(200);
    turn(-90, MAN_LEFT, "Lake View");
    straight(300);
    arc(250, 45);
    straight(300);
    s_man[s_nman++] = (typeof(s_man[0])){.idx = s_n - 1, .maneuver = MAN_ARRIVE, .street = ""};
    s_progress = 0;
    s_t0 = now_s;
}

static float bearing_at(int i)
{
    int a = i > 0 ? i - 1 : 0, b = i < s_n - 1 ? i + 1 : s_n - 1;
    return atan2f(s_x[b] - s_x[a], s_y[b] - s_y[a]) * 180.0f / (float)M_PI;
}

static float angle_diff(float a, float b)
{
    float d = fmodf(b - a, 360.0f);
    if (d > 180) {
        d -= 360;
    } else if (d <= -180) {
        d += 360;
    }
    return d;
}

static int clampi(int i)
{
    return i < 0 ? 0 : i >= s_n ? s_n - 1 : i;
}

static void curve_at(int i, uint8_t *cls, int8_t *dir)
{
    float d = angle_diff(bearing_at(clampi(i - CURVE_HALF)), bearing_at(clampi(i + CURVE_HALF)));
    float rad = fabsf(d) * (float)M_PI / 180.0f;
    float r = rad > 1e-4f ? (2 * CURVE_HALF * STEP_M) / rad : 1e9f;
    *cls = r >= 400 ? CURVE_STRAIGHT : r >= 150 ? CURVE_GENTLE : r >= 60 ? CURVE_MEDIUM : CURVE_SHARP;
    *dir = d > 0 ? 1 : d < 0 ? -1 : 0;
}

static bool near_turn(int i)
{
    for (int m = 0; m < s_nman; m++) {
        if (s_man[m].maneuver != MAN_ARRIVE && abs(s_man[m].idx - i) <= 5) {
            return true;
        }
    }
    return false;
}

/** Cross streets every ~120 m and the road you leave at each turn, packed into ROADS frames. */
int demo_roads(roads_msg_t *out, int max_frames)
{
    int nf = 0;
    roads_msg_t *f = NULL;
    road_point_t road[3];
    for (int i = 20, n = 0; i < s_n - 20 && nf <= max_frames; i += 24, n++) {
        int len = 0;
        bool turn = false;
        for (int m = 0; m < s_nman; m++) {
            if (abs(s_man[m].idx - i) < 12) {
                turn = true;
            }
        }
        if (turn) {
            continue;
        }
        float h = bearing_at(i) * (float)M_PI / 180.0f;
        float nx = cosf(h), ny = -sinf(h); // unit vector to the right of travel
        float a = (n % 3 == 1) ? 0 : 150, b = (n % 3 == 2) ? 0 : 150; // some streets only on one side
        road[len++] = (road_point_t){(int16_t)(s_x[i] - nx * a), (int16_t)(s_y[i] - ny * a)};
        road[len++] = (road_point_t){(int16_t)s_x[i], (int16_t)s_y[i]};
        road[len++] = (road_point_t){(int16_t)(s_x[i] + nx * b), (int16_t)(s_y[i] + ny * b)};
        if (a == 0 || b == 0) {
            if (a == 0) {
                road[0] = road[1];
                road[1] = road[2];
            }
            len = 2;
        }
        if (!f || f->npoints + len > PROTO_MAX_ROAD_POINTS_PER_FRAME || f->nroads >= PROTO_MAX_ROADS_PER_FRAME) {
            if (nf == max_frames) {
                break;
            }
            f = &out[nf++];
            memset(f, 0, sizeof *f);
            f->anchor_id = DEMO_ANCHOR_ID;
            f->part = nf - 1;
        }
        f->len[f->nroads++] = len;
        memcpy(&f->pts[f->npoints], road, len * sizeof road[0]);
        f->npoints += len;
    }
    // Road continuing straight at each junction turn.
    for (int m = 0; m < s_nman && nf > 0; m++) {
        if (s_man[m].maneuver == MAN_ARRIVE) {
            continue;
        }
        int i = s_man[m].idx;
        float h = bearing_at(clampi(i - 3)) * (float)M_PI / 180.0f;
        road[0] = (road_point_t){(int16_t)s_x[i], (int16_t)s_y[i]};
        road[1] = (road_point_t){(int16_t)(s_x[i] + sinf(h) * 220), (int16_t)(s_y[i] + cosf(h) * 220)};
        if (f->npoints + 2 > PROTO_MAX_ROAD_POINTS_PER_FRAME) {
            if (nf == max_frames) {
                break;
            }
            f = &out[nf++];
            memset(f, 0, sizeof *f);
            f->anchor_id = DEMO_ANCHOR_ID;
            f->part = nf - 1;
        }
        f->len[f->nroads++] = 2;
        memcpy(&f->pts[f->npoints], road, sizeof road[0] * 2);
        f->npoints += 2;
    }
    for (int i = 0; i < nf; i++) {
        out[i].parts = nf;
    }
    return nf;
}

void demo_step(float dt_s, uint32_t now_s, nav_msg_t *nav, trip_msg_t *trip)
{
    s_progress += SPEED_MPS * dt_s / STEP_M;
    if (s_progress >= s_n - 1) {
        s_progress = 0;
        s_t0 = now_s;
    }
    int k = (int)s_progress;

    int next = -1;
    for (int m = 0; m < s_nman; m++) {
        if (s_man[m].idx > k) {
            next = m;
            break;
        }
    }

    memset(nav, 0, sizeof *nav);
    nav->maneuver = next >= 0 ? s_man[next].maneuver : MAN_ARRIVE;
    nav->dist_m = next >= 0 ? (uint16_t)((s_man[next].idx - s_progress) * STEP_M) : 0;
    strcpy(nav->street, next >= 0 ? s_man[next].street : "");
    nav->maneuver_idx = PROTO_NO_INDEX;

    float ox = s_x[k], oy = s_y[k];
    float hdeg = bearing_at(clampi(k + 2));
    float h = hdeg * (float)M_PI / 180.0f;
    float ch = cosf(h), sh = sinf(h);
    // Pose in the demo's single street anchor (the road's start point).
    nav->anchor_id = DEMO_ANCHOR_ID;
    nav->pose_x = (int16_t)(ox * 10);
    nav->pose_y = (int16_t)(oy * 10);
    nav->heading_cdeg = (uint16_t)((int)lroundf((hdeg < 0 ? hdeg + 360 : hdeg) * 100) % 36000);
    nav->n = 0;
    for (int j = 0; j < PROTO_MAX_POINTS; j++) {
        int i = k + j * OUT_STEP;
        if (i >= s_n) {
            break;
        }
        float e = s_x[i] - ox, nn = s_y[i] - oy;
        shape_point_t *p = &nav->points[nav->n++];
        p->x = (int16_t)((e * ch - nn * sh) * 10);
        p->y = (int16_t)((e * sh + nn * ch) * 10);
        uint8_t worst = CURVE_STRAIGHT;
        for (int q = i - OUT_STEP + 1; q <= i; q++) {
            uint8_t c;
            int8_t d;
            curve_at(clampi(q), &c, &d);
            if (c > worst) {
                worst = c;
            }
        }
        p->cls = worst;
        if (next >= 0 && nav->maneuver_idx == PROTO_NO_INDEX && i >= s_man[next].idx) {
            nav->maneuver_idx = (uint8_t)j;
        }
    }

    nav->curve_dir = 0;
    nav->curve_class = CURVE_STRAIGHT;
    for (int i = k; i < k + LOOKAHEAD && i < s_n; i++) {
        uint8_t c;
        int8_t d;
        curve_at(i, &c, &d);
        if (c >= CURVE_MEDIUM && !near_turn(i)) {
            nav->curve_class = c;
            nav->curve_dir = d;
            nav->curve_dist_m = (uint16_t)((i - s_progress) * STEP_M);
            for (int q = i; q < i + 40 && q < s_n; q++) {
                curve_at(q, &c, &d);
                if (c < CURVE_GENTLE) {
                    break;
                }
                if (c > nav->curve_class) {
                    nav->curve_class = c;
                }
            }
            break;
        }
    }

    memset(trip, 0, sizeof *trip);
    trip->speed_kmh = (uint8_t)(SPEED_MPS * 3.6f);
    trip->limit_kmh = k < s_n / 2 ? 50 : 0;
    trip->remaining_m = (uint32_t)((s_n - 1 - s_progress) * STEP_M);
    trip->eta_epoch = now_s + (uint32_t)(trip->remaining_m / SPEED_MPS);
    trip->phone_batt = PROTO_UNKNOWN_BATT;
    trip->tz_offset_min = 330;
}
