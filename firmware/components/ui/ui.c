#include "ui.h"

#include <math.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>

#include "esp_lvgl_port.h"
#include "src/core/lv_obj_event_private.h" // lv_hit_test_info_t, for the brightness knob's custom hit test

#define W 240
#define H 240
#define CX 120
#define RIDER_Y 178
#define ROAD_TOP_Y 18
#define ROAD_HALF_W 100
#define NOTIF_SHOW_MS 5000
#define CURVE_WARN_MAX_M 400

#define C_BG lv_color_hex(0x000000)
#define C_TEXT lv_color_hex(0xFFFFFF)
#define C_DIM lv_color_hex(0x8A8F98)
#define C_ACCENT lv_color_hex(0x00D1FF)
#define C_PANEL lv_color_hex(0x101418)

// Map view ("nav app" style)
#define VIEW_MAX_M 300.0f // zoom never shows more than this far ahead
#define MAP_MAX_ROADS 200
#define MAP_MAX_PTS 1400
#define C_MAP_BG lv_color_hex(0x11151A)
#define C_STREET_CASING lv_color_hex(0x232A33)
#define C_STREET lv_color_hex(0x3E4754)
#define C_ROUTE_CASING lv_color_hex(0x0B2A5C)
#define C_ROUTE lv_color_hex(0x3D8BFF)

// Nav placeholder: icon disc centred at (CX, PH_ICON_Y), radar rings around it.
#define PH_ICON_Y 92
#define PH_ICON_D 72
#define PH_PULSE_MAX_D 200
#define PH_PULSE_MS 2400
#define C_PH_RING lv_color_hex(0x1C232B)
enum { PH_UNSET = -1, PH_HIDDEN, PH_WAITING, PH_READY };

// Status tile battery gauges
#define BATT_ARC_W 10
#define BATT_ARC_INSET 4 // from the glass edge, so the rounded caps aren't clipped by the bezel
#define BATT_ARC_GAP 8   // degrees left open at top and bottom between the two halves
#define BATT_DEV_Y 46    // device block (caption top) in the upper half, under the device arc
#define BATT_PHONE_Y 128 // phone block in the lower half, above the phone arc
#define BATT_DIVIDER_W 100
#define BATT_LOW_PCT 15
#define BATT_MID_PCT 35
#define BATT_ANIM_MS 700
#define BATT_CHARGING_MV 4250 // ≥ this means USB is feeding the charger (same rule as main.c)

// Settings tile: brightness gauge around the edge (open at the bottom), −/+ buttons for gloved fingers.
#define BRIGHT_ARC_W 14
#define BRIGHT_ARC_START 135 // LVGL degrees: 0 = 3 o'clock, clockwise; 135 → 45 leaves the bottom quarter open
#define BRIGHT_ARC_END 45
#define BRIGHT_STEP 10
#define BRIGHT_BTN_D 56
#define BRIGHT_BTN_DX 38
#define BRIGHT_BTN_Y 140 // top edge of the buttons
#define BRIGHT_KNOB_HIT_R 28 // touch radius around the knob centre (gloves); the rest of the page swipes

// Media tile (240x240 px): volume ring + title/artist + five round buttons, all inside the ring.
#define MEDIA_RING_INSET 6
#define MEDIA_RING_W 6
#define MEDIA_TITLE_Y 44
#define MEDIA_TITLE_W 130
#define MEDIA_ARTIST_Y 68
#define MEDIA_ARTIST_W 120
#define MEDIA_ROW_Y 120 // centre of prev / play / next
#define MEDIA_VOL_Y 190 // centre of vol - / vol +

static const uint32_t CURVE_COLORS[] = {0xC8CCD2, 0xFFD400, 0xFF8A00, 0xFF2D2D};
static const char *CURVE_NAMES[] = {"", "GENTLE", "MEDIUM", "SHARP"};

static struct {
    lv_obj_t *tv;
    lv_obj_t *tile_nav, *tile_media, *tile_trip, *tile_status;

    // Media
    lv_obj_t *media_ring, *media_title, *media_artist, *media_play_lbl;
    ui_media_cb_t on_media_cmd;

    // Nav
    lv_obj_t *map; // custom-drawn: streets, route, curve badges, rider puck
    nav_msg_t nav;
    bool have_nav;
    lv_obj_t *dist_box, *dist_lbl, *dist_unit;
    lv_obj_t *arrow;
    lv_point_precise_t arrow_pts[12];
    lv_obj_t *exit_lbl;
    lv_obj_t *curve_lbl;
    lv_obj_t *street_lbl;
    lv_obj_t *speed_lbl, *speed_unit;
    lv_obj_t *limit_ring, *limit_lbl;
    float scale; // px per meter, smoothed
    // Placeholder over the nav tile while there is nothing to navigate (no phone / no destination).
    lv_obj_t *ph, *ph_pulse, *ph_icon, *ph_title, *ph_sub, *ph_name;
    int ph_mode; // PH_*

    // Trip
    lv_obj_t *clock_lbl, *eta_lbl, *remain_lbl, *trip_speed_lbl;

    // Status
    lv_obj_t *dev_batt_lbl, *phone_batt_lbl;
    lv_obj_t *dev_arc, *phone_arc;         // semicircle gauges on the round edge: device left, phone right
    lv_obj_t *dev_sub_lbl, *phone_sub_lbl; // voltage / charging under each percentage

    // Settings
    lv_obj_t *tile_settings;
    lv_obj_t *bright_arc, *bright_lbl;
    uint8_t brightness;
    ui_brightness_cb_t on_brightness;

    // Overlays
    lv_obj_t *banner, *banner_lbl;
    lv_obj_t *notif, *notif_app, *notif_title, *notif_body;
    lv_timer_t *notif_timer;

    char device_name[24];
    bool connected;
    bool demo;
    uint8_t nav_state;
    bool have_trip;
    trip_msg_t trip;
    int16_t tz_offset_min;
    ui_demo_toggle_cb_t on_demo_toggle;
} s;

/** Streets for one anchor, assembled from ROADS frames (x east / y north, meters from the anchor). */
typedef struct {
    uint8_t anchor_id;
    uint8_t parts;
    uint32_t got_mask;
    uint16_t nroads;
    uint16_t npts;
    uint16_t start[MAP_MAX_ROADS];
    uint8_t len[MAP_MAX_ROADS];
    road_point_t pts[MAP_MAX_PTS];
} road_set_t;

static road_set_t s_roads[2];
static road_set_t *s_shown = &s_roads[0];   // drawn
static road_set_t *s_pending = &s_roads[1]; // being received

// s_shown projected to map-local pixels, redone on every NAV/ROADS change rather than per draw chunk.
typedef struct {
    int16_t x1, y1, x2, y2;
} box16_t;
static lv_point_precise_t s_street_px[MAP_MAX_PTS];
static box16_t s_street_box[MAP_MAX_ROADS];
static bool s_streets_valid;

// ---------- helpers ----------

static lv_obj_t *label(lv_obj_t *parent, const lv_font_t *font, lv_color_t color)
{
    lv_obj_t *l = lv_label_create(parent);
    lv_obj_set_style_text_font(l, font, 0);
    lv_obj_set_style_text_color(l, color, 0);
    lv_label_set_text(l, "");
    return l;
}

static void fmt_distance(char *buf, size_t n, uint32_t m)
{
    if (m >= 10000) {
        snprintf(buf, n, "%lu km", (unsigned long)(m / 1000));
    } else if (m >= 1000) {
        snprintf(buf, n, "%lu.%lu km", (unsigned long)(m / 1000), (unsigned long)((m % 1000) / 100));
    } else if (m >= 100) {
        snprintf(buf, n, "%lu m", (unsigned long)(m / 10 * 10));
    } else {
        snprintf(buf, n, "%lu m", (unsigned long)m);
    }
}

static void fmt_local_time(char *buf, size_t n, time_t utc)
{
    time_t local = utc + (time_t)s.tz_offset_min * 60;
    struct tm tm;
    gmtime_r(&local, &tm);
    snprintf(buf, n, "%02d:%02d", tm.tm_hour, tm.tm_min);
}

static void style_tile(lv_obj_t *t)
{
    lv_obj_set_style_bg_color(t, C_BG, 0);
    lv_obj_set_style_bg_opa(t, LV_OPA_COVER, 0);
    lv_obj_set_scrollable(t, false);
}

// ---------- maneuver arrow ----------

/** Heading change of the arrow tip for a maneuver, degrees (+ = right). */
static int maneuver_angle(uint8_t m)
{
    switch (m) {
    case MAN_SLIGHT_LEFT: return -40;
    case MAN_LEFT: return -90;
    case MAN_SHARP_LEFT: return -135;
    case MAN_SLIGHT_RIGHT: return 40;
    case MAN_RIGHT: return 90;
    case MAN_SHARP_RIGHT: return 135;
    case MAN_KEEP_LEFT: return -25;
    case MAN_KEEP_RIGHT: return 25;
    default: return 0;
    }
}

/** Arrow polyline in a 56×56 box: stem up from the bottom, bend, arrow head. */
static void draw_arrow(uint8_t m)
{
    lv_point_precise_t *p = s.arrow_pts;
    int n = 0;
    lv_obj_set_hidden(s.exit_lbl, true);

    if (m == MAN_UTURN_LEFT || m == MAN_UTURN_RIGHT) {
        int d = m == MAN_UTURN_LEFT ? -1 : 1;
        int x0 = 28 - d * 10, x1 = 28 + d * 10;
        p[n++] = (lv_point_precise_t){x0, 54};
        p[n++] = (lv_point_precise_t){x0, 14};
        p[n++] = (lv_point_precise_t){x1, 14};
        p[n++] = (lv_point_precise_t){x1, 40};
        p[n++] = (lv_point_precise_t){x1 - 9, 31};
        p[n++] = (lv_point_precise_t){x1, 40};
        p[n++] = (lv_point_precise_t){x1 + 9, 31};
    } else if (m == MAN_ARRIVE) {
        p[n++] = (lv_point_precise_t){16, 54};
        p[n++] = (lv_point_precise_t){16, 6};
        p[n++] = (lv_point_precise_t){44, 14};
        p[n++] = (lv_point_precise_t){16, 24};
    } else if (m == MAN_ROUNDABOUT) {
        // Ring; the exit number is drawn inside by apply_nav().
        for (int i = 0; i <= 8; i++) {
            float t = i * (float)M_PI / 4.0f;
            p[n++] = (lv_point_precise_t){28 + cosf(t) * 20, 28 + sinf(t) * 20};
        }
    } else {
        int a = maneuver_angle(m);
        float r = a * (float)M_PI / 180.0f;
        float bx = 28, by = a == 0 ? 6 : 30;
        float tx = bx + sinf(r) * 22, ty = by - cosf(r) * 22;
        if (a == 0) {
            tx = bx;
            ty = 6;
        }
        p[n++] = (lv_point_precise_t){28, 54};
        p[n++] = (lv_point_precise_t){bx, by};
        p[n++] = (lv_point_precise_t){tx, ty};
        // Arrow head: two strokes back from the tip at ±40° of the tip direction.
        float hl = 11;
        p[n++] = (lv_point_precise_t){tx - sinf(r - 0.7f) * hl, ty + cosf(r - 0.7f) * hl};
        p[n++] = (lv_point_precise_t){tx, ty};
        p[n++] = (lv_point_precise_t){tx - sinf(r + 0.7f) * hl, ty + cosf(r + 0.7f) * hl};
    }
    lv_line_set_points(s.arrow, p, n);
}

// ---------- map drawing (LV_EVENT_DRAW_MAIN on s.map) ----------

static lv_layer_t *s_layer;
static int32_t s_ox, s_oy; // map object's screen origin (moves while the tileview scrolls)
// Area being rendered right now, in map-local px and grown by the widest stroke. LVGL renders the screen in
// several buffer-height chunks and calls map_draw_cb once per chunk, so culling against it (not the whole
// screen) skips most of the line work.
static float s_cx1, s_cy1, s_cx2, s_cy2;
#define CULL_MARGIN 10

static void line(float ax, float ay, float bx, float by, int32_t w, lv_color_t c)
{
    if ((ax < s_cx1 && bx < s_cx1) || (ax > s_cx2 && bx > s_cx2) || (ay < s_cy1 && by < s_cy1) ||
        (ay > s_cy2 && by > s_cy2)) {
        return;
    }
    lv_draw_line_dsc_t d;
    lv_draw_line_dsc_init(&d);
    d.p1 = (lv_point_precise_t){s_ox + ax, s_oy + ay};
    d.p2 = (lv_point_precise_t){s_ox + bx, s_oy + by};
    d.width = w;
    d.color = c;
    d.round_start = 1;
    d.round_end = 1;
    lv_draw_line(s_layer, &d);
}

static void disc(float x, float y, int32_t r, lv_color_t c)
{
    lv_draw_rect_dsc_t d;
    lv_draw_rect_dsc_init(&d);
    d.bg_color = c;
    d.radius = LV_RADIUS_CIRCLE;
    lv_area_t a = {s_ox + (int32_t)x - r, s_oy + (int32_t)y - r, s_ox + (int32_t)x + r, s_oy + (int32_t)y + r};
    lv_draw_rect(s_layer, &d, &a);
}

static void triangle(float ax, float ay, float bx, float by, float cx, float cy, lv_color_t c)
{
    lv_draw_triangle_dsc_t d;
    lv_draw_triangle_dsc_init(&d);
    d.p[0] = (lv_point_precise_t){s_ox + ax, s_oy + ay};
    d.p[1] = (lv_point_precise_t){s_ox + bx, s_oy + by};
    d.p[2] = (lv_point_precise_t){s_ox + cx, s_oy + cy};
    d.color = c;
    lv_draw_triangle(s_layer, &d);
}

/** Chevron centred at (x, y) pointing toward dir (-1 left, +1 right) of the travel direction (ux, uy). */
static void chevron(float x, float y, int dir, float ux, float uy, lv_color_t c, float size, int32_t w)
{
    float nx = -uy * dir, ny = ux * dir;
    line(x - nx * size + ux * size, y - ny * size + uy * size, x + nx * size, y + ny * size, w, c);
    line(x + nx * size, y + ny * size, x - nx * size - ux * size, y - ny * size - uy * size, w, c);
}

// ---------- animated view ----------
// NAV frames arrive at 1-2 Hz. Instead of jumping to each new pose, the displayed view (pose in the anchor frame,
// heading, zoom) glides from where it is to the new target over the measured frame interval, re-projected every
// LVGL refresh. The route is stored in the anchor frame too so it moves together with the streets.

typedef struct {
    float x, y;  // meters east/north of the anchor
    float h;     // radians clockwise from north
    float scale; // px per meter
} view_t;

#define ANIM_PERIOD_MS 16
#define ANIM_SNAP_M 80.0f // further than this (reroute, sim restart) is a jump, not motion

static view_t s_view, s_view_from, s_view_to;
static uint8_t s_view_anchor; // anchor_id the view's coordinates refer to (0 = the frame's own rider frame)
static uint32_t s_anim_t0, s_anim_dur, s_last_nav_ms;
static bool s_anim_on;
static float s_last_dx, s_last_dy; // last frame-to-frame motion, carried across anchor changes
static float s_route_e[PROTO_MAX_POINTS], s_route_n[PROTO_MAX_POINTS];
static lv_point_precise_t s_route_px[PROTO_MAX_POINTS];

static void route_px(int i, float *x, float *y)
{
    *x = s_route_px[i].x;
    *y = s_route_px[i].y;
}

/**
 * Re-project the route and s_shown into map pixels for the displayed view. Call with the LVGL lock held.
 * Anchor frame (x east, y north) → rider frame (heading up) → screen. Same transform as the phone's road shape.
 */
static void project_view(void)
{
    float ch = cosf(s_view.h), sh = sinf(s_view.h), sc = s_view.scale;
    for (int i = 0; i < s.nav.n; i++) {
        float e = s_route_e[i] - s_view.x, n = s_route_n[i] - s_view.y;
        s_route_px[i] = (lv_point_precise_t){CX + (e * ch - n * sh) * sc, RIDER_Y - (e * sh + n * ch) * sc};
    }

    const road_set_t *r = s_shown;
    s_streets_valid = s.have_nav && s_view_anchor && r->anchor_id == s_view_anchor;
    if (!s_streets_valid) {
        return;
    }
    for (int i = 0; i < r->nroads; i++) {
        const road_point_t *p = &r->pts[r->start[i]];
        lv_point_precise_t *o = &s_street_px[r->start[i]];
        float x1 = INFINITY, y1 = INFINITY, x2 = -INFINITY, y2 = -INFINITY;
        for (int k = 0; k < r->len[i]; k++) {
            float e = p[k].x - s_view.x, n = p[k].y - s_view.y;
            float x = CX + (e * ch - n * sh) * sc;
            float y = RIDER_Y - (e * sh + n * ch) * sc;
            o[k] = (lv_point_precise_t){x, y};
            x1 = fminf(x1, x);
            y1 = fminf(y1, y);
            x2 = fmaxf(x2, x);
            y2 = fmaxf(y2, y);
        }
        // Clamp so far-away streets don't overflow int16; anything that far out is culled anyway.
        s_street_box[i] = (box16_t){(int16_t)fmaxf(x1, -10000), (int16_t)fmaxf(y1, -10000),
                                    (int16_t)fminf(x2, 10000), (int16_t)fminf(y2, 10000)};
    }
}

static void draw_streets(void)
{
    const road_set_t *r = s_shown;
    if (!s_streets_valid) {
        return;
    }
    for (int pass = 0; pass < 2; pass++) {
        for (int i = 0; i < r->nroads; i++) {
            const box16_t *b = &s_street_box[i];
            if (b->x2 < s_cx1 || b->x1 > s_cx2 || b->y2 < s_cy1 || b->y1 > s_cy2) {
                continue;
            }
            const lv_point_precise_t *p = &s_street_px[r->start[i]];
            for (int k = 1; k < r->len[i]; k++) {
                line(p[k - 1].x, p[k - 1].y, p[k].x, p[k].y, pass ? 6 : 9, pass ? C_STREET : C_STREET_CASING);
            }
        }
    }
}

static void draw_route(void)
{
    const nav_msg_t *m = &s.nav;
    float ax, ay, bx, by;
    for (int pass = 0; pass < 2; pass++) {
        for (int i = 0; i + 1 < m->n; i++) {
            route_px(i, &ax, &ay);
            route_px(i + 1, &bx, &by);
            line(ax, ay, bx, by, pass ? 11 : 16, pass ? C_ROUTE : C_ROUTE_CASING);
        }
    }
    if (m->maneuver_idx != PROTO_NO_INDEX && m->maneuver_idx < m->n) {
        route_px(m->maneuver_idx, &ax, &ay);
        disc(ax, ay, 7, lv_color_hex(0xFFFFFF));
        disc(ax, ay, 3, C_ROUTE);
    }
}

/** Badges beside the route at the start of each medium/sharp bend (up to three), on the outside of the bend. */
static void draw_curve_badges(void)
{
    const nav_msg_t *m = &s.nav;
    int shown = 0;
    for (int i = 1; i < m->n && shown < 3; i++) {
        if (m->points[i].cls < CURVE_MEDIUM || m->points[i - 1].cls >= CURVE_MEDIUM) {
            continue;
        }
        int end = i, cls = m->points[i].cls;
        while (end + 1 < m->n && m->points[end + 1].cls >= CURVE_MEDIUM) {
            end++;
            if (m->points[end].cls > cls) {
                cls = m->points[end].cls;
            }
        }
        // Turn direction from the summed cross product (x right / y up frame: > 0 means left).
        float sum = 0;
        for (int k = (i > 1 ? i - 1 : 1); k <= end && k + 1 < m->n; k++) {
            const shape_point_t *a = &m->points[k - 1], *b = &m->points[k], *c = &m->points[k + 1];
            sum += (float)(b->x - a->x) * (c->y - b->y) - (float)(b->y - a->y) * (c->x - b->x);
        }
        int dir = sum > 0 ? -1 : 1;
        float x, y, nx, ny;
        route_px(i, &x, &y);
        route_px(i + 1 < m->n ? i + 1 : i, &nx, &ny);
        float tx = nx - x, ty = ny - y, tl = sqrtf(tx * tx + ty * ty);
        if (tl < 0.01f) {
            tl = 1;
        }
        float bx = x + (-ty / tl) * -dir * 17, by = y + (tx / tl) * -dir * 17;
        disc(bx, by, 11, C_MAP_BG);
        disc(bx, by, 9, lv_color_hex(CURVE_COLORS[cls <= CURVE_SHARP ? cls : CURVE_SHARP]));
        chevron(bx, by, dir, 0, -1, lv_color_hex(0x000000), 4.5f, 3);
        shown++;
        i = end;
    }
}

static void draw_puck(void)
{
    // Navigation arrow: two triangles around a notch, then a blue outline.
    triangle(CX, RIDER_Y - 12, CX + 9, RIDER_Y + 9, CX, RIDER_Y + 4, lv_color_hex(0xFFFFFF));
    triangle(CX, RIDER_Y - 12, CX, RIDER_Y + 4, CX - 9, RIDER_Y + 9, lv_color_hex(0xFFFFFF));
    line(CX, RIDER_Y - 12, CX + 9, RIDER_Y + 9, 3, C_ROUTE);
    line(CX + 9, RIDER_Y + 9, CX, RIDER_Y + 4, 3, C_ROUTE);
    line(CX, RIDER_Y + 4, CX - 9, RIDER_Y + 9, 3, C_ROUTE);
    line(CX - 9, RIDER_Y + 9, CX, RIDER_Y - 12, 3, C_ROUTE);
}

static void map_draw_cb(lv_event_t *e)
{
    lv_obj_t *obj = lv_event_get_target(e);
    lv_area_t a;
    lv_obj_get_coords(obj, &a);
    s_layer = lv_event_get_layer(e);
    s_ox = a.x1;
    s_oy = a.y1;
    const lv_area_t *clip = &s_layer->_clip_area;
    s_cx1 = clip->x1 - s_ox - CULL_MARGIN;
    s_cy1 = clip->y1 - s_oy - CULL_MARGIN;
    s_cx2 = clip->x2 - s_ox + CULL_MARGIN;
    s_cy2 = clip->y2 - s_oy + CULL_MARGIN;
    if (s.have_nav) {
        draw_streets();
        draw_route();
        draw_curve_badges();
    }
    draw_puck();
}

// ---------- tiles ----------

static void back_to_nav(lv_event_t *e)
{
    lv_tileview_set_tile_by_index(s.tv, 0, 0, LV_ANIM_ON);
}

static void demo_long_press(lv_event_t *e)
{
    if (s.on_demo_toggle) {
        s.on_demo_toggle();
    }
}

/** Circle outline of diameter d centred on the placeholder icon. */
static lv_obj_t *ph_ring(lv_obj_t *parent, int32_t d, lv_color_t c, int32_t w)
{
    lv_obj_t *r = lv_obj_create(parent);
    lv_obj_remove_style_all(r);
    lv_obj_set_size(r, d, d);
    lv_obj_align(r, LV_ALIGN_TOP_MID, 0, PH_ICON_Y - d / 2);
    lv_obj_set_style_radius(r, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_border_color(r, c, 0);
    lv_obj_set_style_border_width(r, w, 0);
    lv_obj_set_style_border_opa(r, LV_OPA_COVER, 0);
    lv_obj_set_clickable(r, false);
    return r;
}

static void ph_pulse_cb(void *obj, int32_t v)
{
    // v: 0..1000 over one pulse. The ring grows out of the icon and fades as it goes.
    int32_t d = PH_ICON_D + (PH_PULSE_MAX_D - PH_ICON_D) * v / 1000;
    lv_obj_set_size(obj, d, d);
    lv_obj_align(obj, LV_ALIGN_TOP_MID, 0, PH_ICON_Y - d / 2);
    lv_obj_set_style_border_opa(obj, (lv_opa_t)(LV_OPA_70 * (1000 - v) / 1000), 0);
}

static void build_placeholder(lv_obj_t *t)
{
    // Opaque and full-tile: LVGL starts rendering from the topmost opaque cover, so the map isn't drawn under it.
    // Not clickable, so taps and swipes still reach the tileview.
    s.ph = lv_obj_create(t);
    lv_obj_remove_style_all(s.ph);
    lv_obj_set_size(s.ph, W, H);
    lv_obj_set_style_bg_color(s.ph, C_MAP_BG, 0);
    lv_obj_set_style_bg_opa(s.ph, LV_OPA_COVER, 0);
    lv_obj_set_clickable(s.ph, false);

    ph_ring(s.ph, 196, C_PH_RING, 1);
    ph_ring(s.ph, 136, C_PH_RING, 2);
    s.ph_pulse = ph_ring(s.ph, PH_ICON_D, C_ACCENT, 2);

    lv_obj_t *disc = lv_obj_create(s.ph);
    lv_obj_remove_style_all(disc);
    lv_obj_set_size(disc, PH_ICON_D, PH_ICON_D);
    lv_obj_align(disc, LV_ALIGN_TOP_MID, 0, PH_ICON_Y - PH_ICON_D / 2);
    lv_obj_set_style_radius(disc, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_bg_color(disc, lv_color_hex(0x0E2A36), 0); // C_ACCENT at ~20% over C_MAP_BG, pre-mixed
    lv_obj_set_style_bg_opa(disc, LV_OPA_COVER, 0);
    lv_obj_set_style_border_color(disc, C_ACCENT, 0);
    lv_obj_set_style_border_width(disc, 2, 0);
    lv_obj_set_clickable(disc, false);
    s.ph_icon = label(disc, &lv_font_montserrat_28, C_ACCENT);
    lv_obj_center(s.ph_icon);

    s.ph_title = label(s.ph, &lv_font_montserrat_20, C_TEXT);
    lv_obj_align(s.ph_title, LV_ALIGN_TOP_MID, 0, 140);
    s.ph_sub = label(s.ph, &lv_font_montserrat_14, C_DIM);
    lv_obj_set_width(s.ph_sub, 170);
    lv_obj_set_style_text_align(s.ph_sub, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_long_mode(s.ph_sub, LV_LABEL_LONG_WRAP);
    lv_obj_align(s.ph_sub, LV_ALIGN_TOP_MID, 0, 168);

    // Device name pill: the name to pick in the app's device list.
    s.ph_name = label(s.ph, &lv_font_montserrat_14, C_ACCENT);
    lv_obj_set_style_bg_color(s.ph_name, C_PANEL, 0);
    lv_obj_set_style_bg_opa(s.ph_name, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(s.ph_name, 10, 0);
    lv_obj_set_style_pad_hor(s.ph_name, 10, 0);
    lv_obj_set_style_pad_ver(s.ph_name, 3, 0);
    lv_obj_align(s.ph_name, LV_ALIGN_TOP_MID, 0, 172); // only shown while waiting, right under the title

    s.ph_mode = PH_UNSET;
}

static void refresh_placeholder(void)
{
    int mode = !s.connected && !s.demo                  ? PH_WAITING
               : s.nav_state == NAV_IDLE || !s.have_nav ? PH_READY
                                                        : PH_HIDDEN;
    if (mode == s.ph_mode) {
        return; // don't restart the pulse on every refresh
    }
    s.ph_mode = mode;
    lv_anim_delete(s.ph_pulse, ph_pulse_cb);
    lv_obj_set_hidden(s.ph, mode == PH_HIDDEN);
    if (mode == PH_HIDDEN) {
        return;
    }
    bool waiting = mode == PH_WAITING;
    lv_label_set_text(s.ph_icon, waiting ? LV_SYMBOL_BLUETOOTH : LV_SYMBOL_GPS);
    lv_label_set_text(s.ph_title, waiting ? "Waiting for phone" : "Ready to ride");
    lv_label_set_text(s.ph_sub, "Pick a destination\nin the app");
    lv_obj_set_hidden(s.ph_sub, waiting);
    lv_label_set_text(s.ph_name, s.device_name);
    lv_obj_set_hidden(s.ph_name, !waiting);
    lv_obj_set_hidden(s.ph_pulse, !waiting);
    if (waiting) {
        lv_anim_t a;
        lv_anim_init(&a);
        lv_anim_set_var(&a, s.ph_pulse);
        lv_anim_set_exec_cb(&a, ph_pulse_cb);
        lv_anim_set_values(&a, 0, 1000);
        lv_anim_set_duration(&a, PH_PULSE_MS);
        lv_anim_set_path_cb(&a, lv_anim_path_ease_out);
        lv_anim_set_repeat_count(&a, LV_ANIM_REPEAT_INFINITE);
        lv_anim_start(&a);
    }
}

static void build_nav(lv_obj_t *t)
{
    style_tile(t);
    lv_obj_set_style_bg_color(t, C_MAP_BG, 0);
    s.map = lv_obj_create(t);
    lv_obj_remove_style_all(s.map);
    lv_obj_set_size(s.map, W, H);
    lv_obj_set_pos(s.map, 0, 0);
    lv_obj_set_clickable(s.map, false);
    lv_obj_add_event_cb(s.map, map_draw_cb, LV_EVENT_DRAW_MAIN, NULL);

    // Top: arrow + distance
    s.dist_box = lv_obj_create(t);
    lv_obj_remove_style_all(s.dist_box);
    lv_obj_set_size(s.dist_box, 176, 64);
    lv_obj_align(s.dist_box, LV_ALIGN_TOP_MID, 0, 14);
    lv_obj_set_style_bg_color(s.dist_box, C_BG, 0);
    lv_obj_set_style_bg_opa(s.dist_box, LV_OPA_70, 0);
    lv_obj_set_style_radius(s.dist_box, 20, 0);
    lv_obj_set_clickable(s.dist_box, false);

    lv_obj_t *arrow_box = lv_obj_create(s.dist_box);
    lv_obj_remove_style_all(arrow_box);
    lv_obj_set_size(arrow_box, 56, 56);
    lv_obj_align(arrow_box, LV_ALIGN_LEFT_MID, 8, 0);
    s.arrow = lv_line_create(arrow_box);
    lv_obj_set_style_line_width(s.arrow, 7, 0);
    lv_obj_set_style_line_color(s.arrow, C_TEXT, 0);
    lv_obj_set_style_line_rounded(s.arrow, true, 0);
    s.exit_lbl = label(arrow_box, &lv_font_montserrat_20, C_ACCENT);
    lv_obj_align(s.exit_lbl, LV_ALIGN_CENTER, 0, 0);

    // Number large, unit small: "1.4 km" in the 40 px font would not fit inside the round edge.
    s.dist_lbl = label(s.dist_box, &lv_font_montserrat_40, C_TEXT);
    lv_obj_align(s.dist_lbl, LV_ALIGN_LEFT_MID, 68, 2);
    lv_label_set_text(s.dist_lbl, "--");
    s.dist_unit = label(s.dist_box, &lv_font_montserrat_20, C_TEXT);

    s.curve_lbl = label(t, &lv_font_montserrat_14, C_TEXT);
    lv_obj_set_style_bg_opa(s.curve_lbl, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(s.curve_lbl, 8, 0);
    lv_obj_set_style_pad_hor(s.curve_lbl, 8, 0);
    lv_obj_set_style_pad_ver(s.curve_lbl, 3, 0);
    lv_obj_align(s.curve_lbl, LV_ALIGN_TOP_MID, 0, 84);
    lv_obj_set_hidden(s.curve_lbl, true);

    // Speed (left), limit (right), street (bottom)
    s.speed_lbl = label(t, &lv_font_montserrat_28, C_TEXT);
    lv_obj_align(s.speed_lbl, LV_ALIGN_LEFT_MID, 22, 34);
    s.speed_unit = label(t, &lv_font_montserrat_14, C_DIM);
    lv_label_set_text(s.speed_unit, "km/h");
    lv_obj_align_to(s.speed_unit, s.speed_lbl, LV_ALIGN_OUT_BOTTOM_LEFT, 0, -2);

    s.limit_ring = lv_obj_create(t);
    lv_obj_remove_style_all(s.limit_ring);
    lv_obj_set_size(s.limit_ring, 44, 44);
    lv_obj_align(s.limit_ring, LV_ALIGN_RIGHT_MID, -20, 38);
    lv_obj_set_style_radius(s.limit_ring, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_bg_color(s.limit_ring, lv_color_hex(0xFFFFFF), 0);
    lv_obj_set_style_bg_opa(s.limit_ring, LV_OPA_COVER, 0);
    lv_obj_set_style_border_color(s.limit_ring, lv_color_hex(0xE00000), 0);
    lv_obj_set_style_border_width(s.limit_ring, 5, 0);
    s.limit_lbl = label(s.limit_ring, &lv_font_montserrat_20, lv_color_hex(0x000000));
    lv_obj_center(s.limit_lbl);
    lv_obj_set_hidden(s.limit_ring, true);

    s.street_lbl = label(t, &lv_font_montserrat_14, C_TEXT);
    lv_label_set_long_mode(s.street_lbl, LV_LABEL_LONG_DOT);
    lv_obj_set_width(s.street_lbl, 150);
    lv_obj_set_style_text_align(s.street_lbl, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_align(s.street_lbl, LV_ALIGN_BOTTOM_MID, 0, -22);

    draw_arrow(MAN_STRAIGHT);
    s.scale = 0.3f;

    build_placeholder(t); // last, so it covers everything above
}

static void build_trip(lv_obj_t *t)
{
    style_tile(t);
    lv_obj_add_event_cb(t, back_to_nav, LV_EVENT_CLICKED, NULL);
    s.clock_lbl = label(t, &lv_font_montserrat_40, C_TEXT);
    lv_obj_align(s.clock_lbl, LV_ALIGN_TOP_MID, 0, 40);
    lv_label_set_text(s.clock_lbl, "--:--");
    lv_obj_t *eta_cap = label(t, &lv_font_montserrat_14, C_DIM);
    lv_label_set_text(eta_cap, "ARRIVAL");
    lv_obj_align(eta_cap, LV_ALIGN_CENTER, 0, -18);
    s.eta_lbl = label(t, &lv_font_montserrat_28, C_ACCENT);
    lv_obj_align(s.eta_lbl, LV_ALIGN_CENTER, 0, 8);
    lv_label_set_text(s.eta_lbl, "--:--");
    s.remain_lbl = label(t, &lv_font_montserrat_20, C_TEXT);
    lv_obj_align(s.remain_lbl, LV_ALIGN_CENTER, 0, 44);
    s.trip_speed_lbl = label(t, &lv_font_montserrat_14, C_DIM);
    lv_obj_align(s.trip_speed_lbl, LV_ALIGN_BOTTOM_MID, 0, -34);
}

static lv_obj_t *batt_arc(lv_obj_t *t, int32_t start, int32_t end, lv_arc_mode_t mode)
{
    // LVGL arc angles: 0° = 3 o'clock, increasing clockwise on screen.
    lv_obj_t *a = lv_arc_create(t);
    lv_obj_set_size(a, W, H);
    lv_obj_center(a);
    lv_arc_set_bg_angles(a, start, end);
    lv_arc_set_mode(a, mode);
    lv_arc_set_range(a, 0, 100);
    lv_arc_set_value(a, 0);
    lv_obj_remove_style(a, NULL, LV_PART_KNOB);
    lv_obj_set_clickable(a, false); // taps/long-press belong to the tile
    lv_obj_set_style_pad_all(a, BATT_ARC_INSET, 0);
    lv_obj_set_style_arc_width(a, BATT_ARC_W, LV_PART_MAIN);
    lv_obj_set_style_arc_color(a, C_PH_RING, LV_PART_MAIN);
    lv_obj_set_style_arc_rounded(a, true, LV_PART_MAIN);
    lv_obj_set_style_arc_width(a, BATT_ARC_W, LV_PART_INDICATOR);
    lv_obj_set_style_arc_rounded(a, true, LV_PART_INDICATOR);
    return a;
}

/** Caption, big percentage and a small sub-line, stacked from y (top edge of the caption). */
static void batt_block(lv_obj_t *t, int32_t y, const char *caption, lv_obj_t **pct, lv_obj_t **sub)
{
    lv_obj_t *cap = label(t, &lv_font_montserrat_14, C_DIM);
    lv_label_set_text(cap, caption);
    lv_obj_align(cap, LV_ALIGN_TOP_MID, 0, y);
    *pct = label(t, &lv_font_montserrat_28, C_TEXT);
    lv_label_set_text(*pct, "--");
    lv_obj_align(*pct, LV_ALIGN_TOP_MID, 0, y + 16);
    *sub = label(t, &lv_font_montserrat_14, C_DIM);
    lv_obj_align(*sub, LV_ALIGN_TOP_MID, 0, y + 48);
}

static lv_color_t batt_color(uint8_t pct)
{
    return lv_color_hex(pct <= BATT_LOW_PCT ? 0xFF2D2D : pct <= BATT_MID_PCT ? 0xFF8A00 : 0x22C55E);
}

static void batt_arc_anim_cb(void *arc, int32_t v)
{
    lv_arc_set_value(arc, v);
}

/** Show pct on a gauge (animated), or an empty track when unknown (pct > 100). */
static void batt_set(lv_obj_t *arc, lv_obj_t *pct_lbl, uint8_t pct)
{
    bool known = pct <= 100;
    int32_t to = known ? pct : 0;
    if (known) {
        lv_label_set_text_fmt(pct_lbl, "%u%%", pct);
        lv_obj_set_style_arc_color(arc, batt_color(pct), LV_PART_INDICATOR);
    } else {
        lv_label_set_text(pct_lbl, "--");
    }
    int32_t from = lv_arc_get_value(arc);
    if (from == to) {
        return;
    }
    lv_anim_delete(arc, batt_arc_anim_cb);
    lv_anim_t a;
    lv_anim_init(&a);
    lv_anim_set_var(&a, arc);
    lv_anim_set_exec_cb(&a, batt_arc_anim_cb);
    lv_anim_set_values(&a, from, to);
    lv_anim_set_duration(&a, BATT_ANIM_MS);
    lv_anim_set_path_cb(&a, lv_anim_path_ease_out);
    lv_anim_start(&a);
}

static void build_status(lv_obj_t *t)
{
    style_tile(t);
    lv_obj_add_event_cb(t, back_to_nav, LV_EVENT_CLICKED, NULL);
    lv_obj_add_event_cb(t, demo_long_press, LV_EVENT_LONG_PRESSED, NULL);
    // Top half of the edge: device (left → right over the top, clockwise); bottom half: phone (left → right
    // under the bottom: the arc runs right → left clockwise, so it fills reversed).
    s.dev_arc = batt_arc(t, 180 + BATT_ARC_GAP, 360 - BATT_ARC_GAP, LV_ARC_MODE_NORMAL);
    s.phone_arc = batt_arc(t, BATT_ARC_GAP, 180 - BATT_ARC_GAP, LV_ARC_MODE_REVERSE);

    lv_obj_t *divider = lv_obj_create(t);
    lv_obj_remove_style_all(divider);
    lv_obj_set_size(divider, BATT_DIVIDER_W, 2);
    lv_obj_align(divider, LV_ALIGN_CENTER, 0, 0);
    lv_obj_set_style_bg_color(divider, C_PH_RING, 0);
    lv_obj_set_style_bg_opa(divider, LV_OPA_COVER, 0);
    lv_obj_set_clickable(divider, false);

    batt_block(t, BATT_DEV_Y, "DEVICE", &s.dev_batt_lbl, &s.dev_sub_lbl);
    batt_block(t, BATT_PHONE_Y, "PHONE", &s.phone_batt_lbl, &s.phone_sub_lbl);
}

/** Show and apply a brightness; from_arc skips writing the arc back while the rider is dragging it. */
static void bright_set(int32_t v, bool from_arc)
{
    v = v < UI_BRIGHTNESS_MIN ? UI_BRIGHTNESS_MIN : v > 100 ? 100 : v;
    if (!from_arc) {
        lv_arc_set_value(s.bright_arc, v);
    }
    lv_label_set_text_fmt(s.bright_lbl, "%d%%", (int)v);
    if (v != s.brightness) {
        s.brightness = (uint8_t)v;
        if (s.on_brightness) {
            s.on_brightness(s.brightness);
        }
    }
}

static void bright_arc_changed(lv_event_t *e)
{
    bright_set(lv_arc_get_value(s.bright_arc), true);
}

/**
 * Only the knob takes touches. lv_arc doesn't set LV_OBJ_FLAG_ADV_HITTEST, so by default its whole 240×240 box is
 * hit-tested: every press on the page lands on the arc (which never scroll-chains, so the tileview can't swipe)
 * and a press near the edge snaps the value to that angle. Runs after lv_arc's own HIT_TEST handler and overrides it.
 */
static void bright_arc_hit_test(lv_event_t *e)
{
    lv_hit_test_info_t *info = lv_event_get_hit_test_info(e);
    lv_area_t a;
    lv_obj_get_coords(s.bright_arc, &a);
    float span = 360 - BRIGHT_ARC_START + BRIGHT_ARC_END;
    float k = (float)(lv_arc_get_value(s.bright_arc) - UI_BRIGHTNESS_MIN) / (100 - UI_BRIGHTNESS_MIN);
    float ang = (BRIGHT_ARC_START + span * k) * (float)M_PI / 180.0f;
    float r = lv_area_get_width(&a) / 2.0f - (BATT_ARC_INSET + BRIGHT_ARC_W / 2) - BRIGHT_ARC_W / 2.0f; // stroke centre
    float kx = (a.x1 + a.x2) / 2.0f + cosf(ang) * r, ky = (a.y1 + a.y2) / 2.0f + sinf(ang) * r;
    info->res = hypotf(info->point->x - kx, info->point->y - ky) <= BRIGHT_KNOB_HIT_R;
}

static void bright_step(lv_event_t *e)
{
    // Snap to the 10 % grid, so 5 → 10 → 20 and 100 → 90 → … → 10 → 5.
    int dir = (int)(intptr_t)lv_event_get_user_data(e);
    int32_t v = s.brightness;
    v = dir > 0 ? (v / BRIGHT_STEP + 1) * BRIGHT_STEP : ((v + BRIGHT_STEP - 1) / BRIGHT_STEP - 1) * BRIGHT_STEP;
    bright_set(v, false);
}

static void bright_button(lv_obj_t *t, int32_t dx, const char *symbol, int dir)
{
    lv_obj_t *b = lv_button_create(t);
    lv_obj_remove_style_all(b);
    lv_obj_set_size(b, BRIGHT_BTN_D, BRIGHT_BTN_D);
    lv_obj_align(b, LV_ALIGN_TOP_MID, dx, BRIGHT_BTN_Y);
    lv_obj_set_style_radius(b, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_bg_color(b, C_PANEL, 0);
    lv_obj_set_style_bg_opa(b, LV_OPA_COVER, 0);
    lv_obj_set_style_border_color(b, C_PH_RING, 0);
    lv_obj_set_style_border_width(b, 2, 0);
    lv_obj_set_style_bg_color(b, lv_color_hex(0x0E2A36), LV_STATE_PRESSED);
    lv_obj_set_style_border_color(b, C_ACCENT, LV_STATE_PRESSED);
    // Clicked for a tap, repeat while held to sweep the range.
    lv_obj_add_event_cb(b, bright_step, LV_EVENT_CLICKED, (void *)(intptr_t)dir);
    lv_obj_add_event_cb(b, bright_step, LV_EVENT_LONG_PRESSED_REPEAT, (void *)(intptr_t)dir);
    lv_obj_t *l = label(b, &lv_font_montserrat_28, C_TEXT);
    lv_label_set_text(l, symbol);
    lv_obj_center(l);
}

static void build_settings(lv_obj_t *t)
{
    style_tile(t);
    // No tap-to-go-back here, unlike Trip/Status: a near miss on a button would throw the rider off the screen.

    s.bright_arc = lv_arc_create(t);
    lv_obj_set_size(s.bright_arc, W, H);
    lv_obj_center(s.bright_arc);
    lv_arc_set_bg_angles(s.bright_arc, BRIGHT_ARC_START, BRIGHT_ARC_END);
    lv_arc_set_range(s.bright_arc, UI_BRIGHTNESS_MIN, 100);
    lv_obj_set_style_pad_all(s.bright_arc, BATT_ARC_INSET + BRIGHT_ARC_W / 2, 0); // room for the knob
    lv_obj_set_style_arc_width(s.bright_arc, BRIGHT_ARC_W, LV_PART_MAIN);
    lv_obj_set_style_arc_color(s.bright_arc, C_PH_RING, LV_PART_MAIN);
    lv_obj_set_style_arc_rounded(s.bright_arc, true, LV_PART_MAIN);
    lv_obj_set_style_arc_width(s.bright_arc, BRIGHT_ARC_W, LV_PART_INDICATOR);
    lv_obj_set_style_arc_color(s.bright_arc, C_ACCENT, LV_PART_INDICATOR);
    lv_obj_set_style_arc_rounded(s.bright_arc, true, LV_PART_INDICATOR);
    lv_obj_set_style_bg_color(s.bright_arc, C_TEXT, LV_PART_KNOB);
    lv_obj_set_style_bg_opa(s.bright_arc, LV_OPA_COVER, LV_PART_KNOB);
    lv_obj_set_style_pad_all(s.bright_arc, 3, LV_PART_KNOB);
    lv_obj_set_style_shadow_width(s.bright_arc, 0, LV_PART_KNOB);
    lv_obj_add_event_cb(s.bright_arc, bright_arc_changed, LV_EVENT_VALUE_CHANGED, NULL);
    lv_obj_add_flag(s.bright_arc, LV_OBJ_FLAG_ADV_HITTEST);
    lv_obj_add_event_cb(s.bright_arc, bright_arc_hit_test, LV_EVENT_HIT_TEST, NULL);

    lv_obj_t *cap = label(t, &lv_font_montserrat_14, C_DIM);
    lv_label_set_text(cap, "BRIGHTNESS");
    lv_obj_align(cap, LV_ALIGN_TOP_MID, 0, 58);
    s.bright_lbl = label(t, &lv_font_montserrat_40, C_TEXT);
    lv_obj_align(s.bright_lbl, LV_ALIGN_TOP_MID, 0, 80);

    bright_button(t, -BRIGHT_BTN_DX, LV_SYMBOL_MINUS, -1);
    bright_button(t, BRIGHT_BTN_DX, LV_SYMBOL_PLUS, 1);
}

// ---------- media ----------

static void media_button_cb(lv_event_t *e)
{
    if (s.on_media_cmd) {
        s.on_media_cmd((uint8_t)(intptr_t)lv_event_get_user_data(e));
    }
}

/** Round button centred at (cx, cy). Play is the filled accent one with a black symbol; vol buttons also repeat. */
static lv_obj_t *media_button(lv_obj_t *t, int32_t cx, int32_t cy, int32_t d, const lv_font_t *font, const char *symbol,
                              media_cmd_t cmd, bool primary, bool repeat)
{
    lv_obj_t *b = lv_button_create(t);
    lv_obj_remove_style_all(b);
    lv_obj_set_size(b, d, d);
    lv_obj_set_pos(b, cx - d / 2, cy - d / 2);
    lv_obj_set_style_radius(b, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_bg_color(b, primary ? C_ACCENT : C_PANEL, 0);
    lv_obj_set_style_bg_opa(b, LV_OPA_COVER, 0);
    lv_obj_set_style_border_color(b, primary ? C_ACCENT : C_PH_RING, 0);
    lv_obj_set_style_border_width(b, 2, 0);
    lv_obj_set_style_bg_color(b, lv_color_hex(0x0E2A36), LV_STATE_PRESSED);
    lv_obj_set_style_border_color(b, C_ACCENT, LV_STATE_PRESSED);
    lv_obj_add_event_cb(b, media_button_cb, LV_EVENT_CLICKED, (void *)(intptr_t)cmd);
    if (repeat) {
        lv_obj_add_event_cb(b, media_button_cb, LV_EVENT_LONG_PRESSED_REPEAT, (void *)(intptr_t)cmd);
    }
    lv_obj_t *l = label(b, font, primary ? C_BG : C_TEXT);
    lv_label_set_text(l, symbol);
    lv_obj_center(l);
    return l;
}

static void build_media(lv_obj_t *t)
{
    style_tile(t);
    // No tap-to-go-back, like Settings: a near miss on a button must not throw the rider off the page.

    // Volume ring: display only, full circle starting at 12 o'clock.
    s.media_ring = lv_arc_create(t);
    lv_obj_set_size(s.media_ring, W, H);
    lv_obj_center(s.media_ring);
    lv_obj_set_clickable(s.media_ring, false);
    lv_arc_set_rotation(s.media_ring, 270);
    lv_arc_set_bg_angles(s.media_ring, 0, 360);
    lv_arc_set_range(s.media_ring, 0, 100);
    lv_obj_set_style_pad_all(s.media_ring, MEDIA_RING_INSET, 0);
    lv_obj_set_style_arc_width(s.media_ring, MEDIA_RING_W, LV_PART_MAIN);
    lv_obj_set_style_arc_color(s.media_ring, C_PH_RING, LV_PART_MAIN);
    lv_obj_set_style_arc_width(s.media_ring, MEDIA_RING_W, LV_PART_INDICATOR);
    lv_obj_set_style_arc_color(s.media_ring, C_ACCENT, LV_PART_INDICATOR);
    lv_obj_set_style_bg_opa(s.media_ring, LV_OPA_TRANSP, LV_PART_KNOB); // no knob
    lv_obj_set_style_pad_all(s.media_ring, 0, LV_PART_KNOB);

    s.media_title = label(t, &lv_font_montserrat_20, C_TEXT);
    // Fixed one-line height, else LONG_DOT wraps (content-sized height) instead of ellipsizing.
    lv_obj_set_size(s.media_title, MEDIA_TITLE_W, lv_font_get_line_height(&lv_font_montserrat_20));
    lv_label_set_long_mode(s.media_title, LV_LABEL_LONG_DOT);
    lv_obj_set_style_text_align(s.media_title, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_align(s.media_title, LV_ALIGN_TOP_MID, 0, MEDIA_TITLE_Y);
    s.media_artist = label(t, &lv_font_montserrat_14, C_DIM);
    lv_obj_set_size(s.media_artist, MEDIA_ARTIST_W, lv_font_get_line_height(&lv_font_montserrat_14));
    lv_label_set_long_mode(s.media_artist, LV_LABEL_LONG_DOT);
    lv_obj_set_style_text_align(s.media_artist, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_align(s.media_artist, LV_ALIGN_TOP_MID, 0, MEDIA_ARTIST_Y);

    media_button(t, 54, MEDIA_ROW_Y, 48, &lv_font_montserrat_20, LV_SYMBOL_PREV, MEDIA_CMD_PREV, false, false);
    s.media_play_lbl =
        media_button(t, 120, MEDIA_ROW_Y, 70, &lv_font_montserrat_28, LV_SYMBOL_PLAY, MEDIA_CMD_TOGGLE, true, false);
    media_button(t, 186, MEDIA_ROW_Y, 48, &lv_font_montserrat_20, LV_SYMBOL_NEXT, MEDIA_CMD_NEXT, false, false);
    media_button(t, 92, MEDIA_VOL_Y, 44, &lv_font_montserrat_20, LV_SYMBOL_MINUS, MEDIA_CMD_VOL_DOWN, false, true);
    media_button(t, 148, MEDIA_VOL_Y, 44, &lv_font_montserrat_20, LV_SYMBOL_PLUS, MEDIA_CMD_VOL_UP, false, true);
}

static void apply_media(const media_msg_t *m)
{
    bool active = m->state == MEDIA_PLAYING || m->state == MEDIA_PAUSED; // anything else (incl. unknown) = none
    lv_label_set_text(s.media_title, active ? m->title : "Nothing playing");
    lv_label_set_text(s.media_artist, active ? m->artist : "");
    lv_arc_set_value(s.media_ring, active && m->volume_pct != PROTO_UNKNOWN_VOLUME ? (m->volume_pct > 100 ? 100 : m->volume_pct) : 0);
    lv_label_set_text(s.media_play_lbl, m->state == MEDIA_PLAYING ? LV_SYMBOL_PAUSE : LV_SYMBOL_PLAY);
}

static void notif_hide(lv_timer_t *tm)
{
    lv_obj_set_hidden(s.notif, true);
    lv_timer_pause(tm); // keep the timer alive (paused) for the next notification
}

static void notif_clicked(lv_event_t *e)
{
    lv_obj_set_hidden(s.notif, true);
}

static void build_overlays(void)
{
    lv_obj_t *top = lv_layer_top();

    s.banner = lv_obj_create(top);
    lv_obj_remove_style_all(s.banner);
    lv_obj_set_size(s.banner, 180, 44);
    lv_obj_align(s.banner, LV_ALIGN_CENTER, 0, 6);
    lv_obj_set_style_radius(s.banner, 22, 0);
    lv_obj_set_style_bg_opa(s.banner, LV_OPA_90, 0);
    lv_obj_set_clickable(s.banner, false);
    s.banner_lbl = label(s.banner, &lv_font_montserrat_20, C_TEXT);
    lv_obj_center(s.banner_lbl);
    lv_obj_set_hidden(s.banner, true);

    s.notif = lv_obj_create(top);
    lv_obj_remove_style_all(s.notif);
    lv_obj_set_size(s.notif, W, H);
    lv_obj_set_style_radius(s.notif, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_bg_color(s.notif, lv_color_hex(0x0B2A4A), 0);
    lv_obj_set_style_bg_opa(s.notif, LV_OPA_COVER, 0);
    lv_obj_set_clickable(s.notif, true);
    lv_obj_add_event_cb(s.notif, notif_clicked, LV_EVENT_CLICKED, NULL);
    s.notif_app = label(s.notif, &lv_font_montserrat_14, C_DIM);
    lv_obj_align(s.notif_app, LV_ALIGN_TOP_MID, 0, 40);
    s.notif_title = label(s.notif, &lv_font_montserrat_28, C_TEXT);
    lv_label_set_long_mode(s.notif_title, LV_LABEL_LONG_DOT);
    lv_obj_set_width(s.notif_title, 190);
    lv_obj_set_style_text_align(s.notif_title, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_align(s.notif_title, LV_ALIGN_TOP_MID, 0, 66);
    s.notif_body = label(s.notif, &lv_font_montserrat_20, C_TEXT);
    lv_label_set_long_mode(s.notif_body, LV_LABEL_LONG_DOT);
    lv_obj_set_size(s.notif_body, 180, 80);
    lv_obj_set_style_text_align(s.notif_body, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_align(s.notif_body, LV_ALIGN_TOP_MID, 0, 110);
    lv_obj_set_hidden(s.notif, true);

    s.notif_timer = lv_timer_create(notif_hide, NOTIF_SHOW_MS, NULL);
    lv_timer_pause(s.notif_timer);
}

// ---------- refresh ----------

static void refresh_banner(void)
{
    // "No phone" and "Pick a destination" are the nav placeholder's job now; the banner is for in-ride states.
    refresh_placeholder();
    const char *txt = NULL;
    uint32_t color = 0x333333;
    if (s.connected || s.demo) {
        switch (s.nav_state) {
        case NAV_REROUTING: txt = "Rerouting..."; color = 0xD97706; break;
        case NAV_GPS_LOST: txt = "GPS lost"; color = 0xB91C1C; break;
        case NAV_ARRIVED: txt = "Arrived"; color = 0x15803D; break;
        default: break;
        }
    }
    if (txt) {
        lv_label_set_text(s.banner_lbl, txt);
        lv_obj_set_style_bg_color(s.banner, lv_color_hex(color), 0);
        lv_obj_set_hidden(s.banner, false);
    } else {
        lv_obj_set_hidden(s.banner, true);
    }
}

static void refresh_status(void)
{
    bool phone_known = s.have_trip && s.trip.phone_batt != PROTO_UNKNOWN_BATT;
    batt_set(s.phone_arc, s.phone_batt_lbl, phone_known ? s.trip.phone_batt : 0xFF);
    // The link status lives here now (the nav placeholder shows the device name while waiting).
    lv_label_set_text(s.phone_sub_lbl, s.demo         ? "demo mode"
                                       : !s.connected ? "offline"
                                       : phone_known  ? "connected"
                                                      : "no data");
}

/** Start gliding the view toward the pose in m (s.scale is the new zoom target), and store m's route in the anchor frame. */
static void set_view_target(const nav_msg_t *m, bool had_nav)
{
    uint32_t now = lv_tick_get();
    // Without an anchor there is no shared frame between NAV frames: each one is its own rider frame, so snap.
    view_t to = {m->anchor_id ? m->pose_x / 10.0f : 0, m->anchor_id ? m->pose_y / 10.0f : 0,
                 m->heading_cdeg / 100.0f * (float)M_PI / 180.0f, s.scale};
    bool animate = had_nav && m->anchor_id && s_view_anchor;

    if (animate && m->anchor_id != s_view_anchor) {
        // New anchor, new origin, same east/north axes: keep the view's lag behind the target, and assume the
        // rider moved like last frame, so the hand-over doesn't jump.
        s_view.x = to.x - s_last_dx - (s_view_to.x - s_view.x);
        s_view.y = to.y - s_last_dy - (s_view_to.y - s_view.y);
    } else if (animate) {
        s_last_dx = to.x - s_view_to.x;
        s_last_dy = to.y - s_view_to.y;
    }
    if (animate && hypotf(to.x - s_view.x, to.y - s_view.y) > ANIM_SNAP_M) {
        animate = false;
    }

    if (animate) {
        // Normalise, then take the short way round so 359° → 1° turns 2°, not 358°.
        s_view.h = remainderf(s_view.h, 2 * (float)M_PI);
        to.h = s_view.h + remainderf(to.h - s_view.h, 2 * (float)M_PI);
        uint32_t dt = now - s_last_nav_ms;
        s_view_from = s_view;
        s_view_to = to;
        s_anim_t0 = now;
        s_anim_dur = dt < 50 ? 50 : dt > 1500 ? 1500 : dt; // glide over one frame interval: continuous motion
        s_anim_on = true;
    } else {
        s_view = s_view_from = s_view_to = to;
        s_last_dx = s_last_dy = 0;
        s_anim_on = false;
    }
    s_last_nav_ms = now;
    s_view_anchor = m->anchor_id;

    // Route: rider frame (dm, +x right, +y ahead) at this frame's pose → anchor frame (m, east/north).
    float ch = cosf(to.h), sh = sinf(to.h);
    for (int i = 0; i < m->n; i++) {
        float x = m->points[i].x / 10.0f, y = m->points[i].y / 10.0f;
        s_route_e[i] = to.x + x * ch + y * sh;
        s_route_n[i] = to.y - x * sh + y * ch;
    }
}

static void anim_tick(lv_timer_t *t)
{
    if (!s_anim_on) {
        return; // idle: no redraws while nothing moves
    }
    float k = (float)(lv_tick_get() - s_anim_t0) / s_anim_dur;
    if (k >= 1) {
        k = 1;
        s_anim_on = false;
    }
    s_view.x = s_view_from.x + (s_view_to.x - s_view_from.x) * k;
    s_view.y = s_view_from.y + (s_view_to.y - s_view_from.y) * k;
    s_view.h = s_view_from.h + (s_view_to.h - s_view_from.h) * k;
    s_view.scale = s_view_from.scale + (s_view_to.scale - s_view_from.scale) * k;
    project_view();
    lv_obj_invalidate(s.map);
}

static void apply_nav(const nav_msg_t *m)
{
    char buf[24];
    if (m->dist_m == PROTO_UNKNOWN_DIST) {
        lv_label_set_text(s.dist_lbl, "--");
        lv_label_set_text(s.dist_unit, "");
    } else {
        fmt_distance(buf, sizeof buf, m->dist_m);
        char *sp = strchr(buf, ' ');
        if (sp) {
            *sp = '\0';
        }
        lv_label_set_text(s.dist_lbl, buf);
        lv_label_set_text(s.dist_unit, sp ? sp + 1 : "");
        lv_obj_align_to(s.dist_unit, s.dist_lbl, LV_ALIGN_OUT_RIGHT_BOTTOM, 4, -6);
    }
    draw_arrow(m->maneuver);
    if (m->maneuver == MAN_ROUNDABOUT && m->exit) {
        lv_label_set_text_fmt(s.exit_lbl, "%u", m->exit);
        lv_obj_set_hidden(s.exit_lbl, false);
    }
    lv_label_set_text(s.street_lbl, m->street);

    if (m->curve_class >= CURVE_MEDIUM && m->curve_dist_m <= CURVE_WARN_MAX_M && m->curve_class <= CURVE_SHARP) {
        if (m->curve_dist_m < 10) {
            lv_label_set_text_fmt(s.curve_lbl, "%s %s", CURVE_NAMES[m->curve_class], m->curve_dir < 0 ? "LEFT" : "RIGHT");
        } else {
            lv_label_set_text_fmt(s.curve_lbl, "%s %s  %u m", CURVE_NAMES[m->curve_class],
                                  m->curve_dir < 0 ? "LEFT" : "RIGHT", m->curve_dist_m / 10 * 10);
        }
        lv_obj_set_style_bg_color(s.curve_lbl, lv_color_hex(CURVE_COLORS[m->curve_class]), 0);
        lv_obj_set_style_text_color(s.curve_lbl, lv_color_hex(0x000000), 0);
        lv_obj_set_hidden(s.curve_lbl, false);
    } else {
        lv_obj_set_hidden(s.curve_lbl, true);
    }

    // Auto-zoom so the route ahead fits above the rider, capped at VIEW_MAX_M so close bends stay large; smoothed.
    float max_y = 60, max_x = 30;
    for (int i = 0; i < m->n; i++) {
        float y = m->points[i].y / 10.0f, x = fabsf(m->points[i].x / 10.0f);
        if (y > max_y) {
            max_y = y;
        }
        if (x > max_x) {
            max_x = x;
        }
    }
    float target = fminf((RIDER_Y - ROAD_TOP_Y) / fminf(max_y, VIEW_MAX_M), ROAD_HALF_W / fminf(max_x, VIEW_MAX_M / 2));
    s.scale = s.scale * 0.6f + target * 0.4f;

    bool had_nav = s.have_nav;
    s.nav = *m;
    s.have_nav = true;
    set_view_target(m, had_nav);
    project_view();
    lv_obj_invalidate(s.map);
    refresh_placeholder();
}

/** Collect one ROADS frame; when every part of an anchor set has arrived, it replaces the shown set. */
static void apply_roads(const roads_msg_t *m)
{
    road_set_t *p = s_pending;
    if (m->parts > 32) {
        return;
    }
    if (p->anchor_id != m->anchor_id || p->parts != m->parts) {
        memset(p, 0, offsetof(road_set_t, start));
        p->anchor_id = m->anchor_id;
        p->parts = m->parts;
    }
    if (p->got_mask & (1u << m->part)) {
        return; // duplicate
    }
    int k = 0;
    for (int i = 0; i < m->nroads; i++) {
        if (p->nroads >= MAP_MAX_ROADS || p->npts + m->len[i] > MAP_MAX_PTS) {
            break; // out of room: keep what fits (the phone sends nearest streets first)
        }
        p->start[p->nroads] = p->npts;
        p->len[p->nroads] = m->len[i];
        memcpy(&p->pts[p->npts], &m->pts[k], m->len[i] * sizeof(road_point_t));
        p->npts += m->len[i];
        p->nroads++;
        k += m->len[i];
    }
    p->got_mask |= 1u << m->part;
    if (p->got_mask == (m->parts == 32 ? 0xFFFFFFFFu : (1u << m->parts) - 1)) {
        s_pending = s_shown;
        s_shown = p;
        memset(s_pending, 0, offsetof(road_set_t, start));
        project_view();
        lv_obj_invalidate(s.map);
    }
}

static void apply_trip(const trip_msg_t *m)
{
    s.trip = *m;
    s.have_trip = true;
    s.tz_offset_min = m->tz_offset_min;
    if (m->now_epoch) {
        struct timeval tv = {.tv_sec = m->now_epoch};
        settimeofday(&tv, NULL);
    }
    lv_label_set_text_fmt(s.speed_lbl, "%u", m->speed_kmh);
    lv_label_set_text_fmt(s.trip_speed_lbl, "%u km/h", m->speed_kmh);
    if (m->limit_kmh) {
        lv_label_set_text_fmt(s.limit_lbl, "%u", m->limit_kmh);
        lv_obj_set_hidden(s.limit_ring, false);
        lv_obj_set_style_text_color(s.speed_lbl,
                                    m->speed_kmh > m->limit_kmh + 5 ? lv_color_hex(0xFF2D2D) : C_TEXT, 0);
    } else {
        lv_obj_set_hidden(s.limit_ring, true);
        lv_obj_set_style_text_color(s.speed_lbl, C_TEXT, 0);
    }
    char buf[24];
    if (m->eta_epoch) {
        fmt_local_time(buf, sizeof buf, m->eta_epoch);
        lv_label_set_text(s.eta_lbl, buf);
    } else {
        lv_label_set_text(s.eta_lbl, "--:--");
    }
    fmt_distance(buf, sizeof buf, m->remaining_m);
    lv_label_set_text_fmt(s.remain_lbl, "%s to go", buf);
    refresh_status();
}

static void apply_notif(const notif_msg_t *m)
{
    lv_label_set_text(s.notif_app, m->app);
    lv_label_set_text(s.notif_title, m->title);
    lv_label_set_text(s.notif_body, m->body);
    lv_obj_set_style_bg_color(s.notif, lv_color_hex(m->kind == NOTIF_CALL ? 0x14532D : 0x0B2A4A), 0);
    lv_obj_set_hidden(s.notif, false);
    lv_timer_reset(s.notif_timer);
    lv_timer_resume(s.notif_timer);
}

static void clock_tick(lv_timer_t *t)
{
    struct timeval tv;
    gettimeofday(&tv, NULL);
    if (tv.tv_sec > 1700000000) { // only once synced from the phone
        char buf[8];
        fmt_local_time(buf, sizeof buf, tv.tv_sec);
        lv_label_set_text(s.clock_lbl, buf);
    }
}

// ---------- public ----------

void ui_init(lv_display_t *disp, const char *device_name, ui_demo_toggle_cb_t on_demo_toggle, uint8_t brightness,
             ui_brightness_cb_t on_brightness, ui_media_cb_t on_media_cmd)
{
    lvgl_port_lock(0);
    strncpy(s.device_name, device_name, sizeof s.device_name - 1);
    s.on_demo_toggle = on_demo_toggle;
    s.on_media_cmd = on_media_cmd;

    lv_obj_t *scr = lv_screen_active();
    lv_obj_set_style_bg_color(scr, C_BG, 0);

    s.tv = lv_tileview_create(scr);
    lv_obj_set_style_bg_color(s.tv, C_BG, 0);
    lv_obj_set_scrollbar_mode(s.tv, LV_SCROLLBAR_MODE_OFF);
    s.tile_nav = lv_tileview_add_tile(s.tv, 0, 0, LV_DIR_RIGHT);
    s.tile_media = lv_tileview_add_tile(s.tv, 1, 0, LV_DIR_LEFT | LV_DIR_RIGHT);
    s.tile_trip = lv_tileview_add_tile(s.tv, 2, 0, LV_DIR_LEFT | LV_DIR_RIGHT);
    s.tile_status = lv_tileview_add_tile(s.tv, 3, 0, LV_DIR_LEFT | LV_DIR_RIGHT);
    s.tile_settings = lv_tileview_add_tile(s.tv, 4, 0, LV_DIR_LEFT);
    build_nav(s.tile_nav);
    build_media(s.tile_media);
    apply_media(&(media_msg_t){.state = MEDIA_NONE, .volume_pct = PROTO_UNKNOWN_VOLUME});
    build_trip(s.tile_trip);
    build_status(s.tile_status);
    build_settings(s.tile_settings);
    s.brightness = brightness;
    bright_set(brightness, false); // display only: unchanged, so no callback
    s.on_brightness = on_brightness;
    build_overlays();
    lv_timer_create(clock_tick, 1000, NULL);
    lv_timer_create(anim_tick, ANIM_PERIOD_MS, NULL);

    refresh_banner();
    refresh_status();
    lv_label_set_text(s.dev_batt_lbl, "--");
    lvgl_port_unlock();
}

void ui_apply(const proto_msg_t *msg)
{
    lvgl_port_lock(0);
    switch (msg->type) {
    case MSG_NAV:
        apply_nav(&msg->u.nav);
        break;
    case MSG_TRIP:
        apply_trip(&msg->u.trip);
        break;
    case MSG_NOTIF:
        apply_notif(&msg->u.notif);
        break;
    case MSG_STATE:
        s.nav_state = msg->u.state;
        refresh_banner();
        break;
    case MSG_ROADS:
        apply_roads(&msg->u.roads);
        break;
    case MSG_MEDIA:
        apply_media(&msg->u.media);
        break;
    default:
        break;
    }
    lvgl_port_unlock();
}

void ui_lock(void)
{
    lvgl_port_lock(0);
}

void ui_unlock(void)
{
    lvgl_port_unlock();
}

void ui_set_connected(bool connected)
{
    lvgl_port_lock(0);
    s.connected = connected;
    refresh_banner();
    refresh_status();
    lvgl_port_unlock();
}

void ui_set_device_battery(uint8_t pct, uint16_t mv)
{
    lvgl_port_lock(0);
    batt_set(s.dev_arc, s.dev_batt_lbl, mv ? pct : 0xFF); // mv 0 = no ADC reading
    if (mv >= BATT_CHARGING_MV) {
        lv_label_set_text(s.dev_sub_lbl, LV_SYMBOL_CHARGE " Charging");
    } else if (mv) {
        lv_label_set_text_fmt(s.dev_sub_lbl, "%u.%02u V", mv / 1000, mv % 1000 / 10);
    } else {
        lv_label_set_text(s.dev_sub_lbl, "");
    }
    lvgl_port_unlock();
}

void ui_set_demo(bool on)
{
    lvgl_port_lock(0);
    s.demo = on;
    refresh_banner();
    refresh_status();
    lvgl_port_unlock();
}
