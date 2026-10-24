#include "ui.h"

#include <math.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>

#include "esp_lvgl_port.h"

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

static const uint32_t CURVE_COLORS[] = {0xC8CCD2, 0xFFD400, 0xFF8A00, 0xFF2D2D};
static const char *CURVE_NAMES[] = {"", "GENTLE", "MEDIUM", "SHARP"};

static struct {
    lv_obj_t *tv;
    lv_obj_t *tile_nav, *tile_trip, *tile_status;

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

    // Trip
    lv_obj_t *clock_lbl, *eta_lbl, *remain_lbl, *trip_speed_lbl;

    // Status
    lv_obj_t *dev_batt_lbl, *phone_batt_lbl, *link_lbl, *demo_lbl;

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

static void line(float ax, float ay, float bx, float by, int32_t w, lv_color_t c)
{
    // Skip segments entirely off screen (with margin for the stroke).
    if ((ax < -20 && bx < -20) || (ax > W + 20 && bx > W + 20) || (ay < -20 && by < -20) ||
        (ay > H + 20 && by > H + 20)) {
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

static void route_px(int i, float *x, float *y)
{
    *x = CX + s.nav.points[i].x / 10.0f * s.scale;
    *y = RIDER_Y - s.nav.points[i].y / 10.0f * s.scale;
}

static void draw_streets(void)
{
    const road_set_t *r = s_shown;
    if (!s.nav.anchor_id || r->anchor_id != s.nav.anchor_id) {
        return;
    }
    // Anchor frame (x east, y north) → rider frame (heading up) → screen. Same transform as the phone's road shape.
    float h = s.nav.heading_cdeg / 100.0f * (float)M_PI / 180.0f;
    float ch = cosf(h), sh = sinf(h);
    float px = s.nav.pose_x / 10.0f, py = s.nav.pose_y / 10.0f;
    for (int pass = 0; pass < 2; pass++) {
        for (int i = 0; i < r->nroads; i++) {
            const road_point_t *p = &r->pts[r->start[i]];
            float lx = 0, ly = 0;
            for (int k = 0; k < r->len[i]; k++) {
                float e = p[k].x - px, n = p[k].y - py;
                float x = CX + (e * ch - n * sh) * s.scale;
                float y = RIDER_Y - (e * sh + n * ch) * s.scale;
                if (k) {
                    line(lx, ly, x, y, pass ? 6 : 9, pass ? C_STREET : C_STREET_CASING);
                }
                lx = x;
                ly = y;
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

static void build_status(lv_obj_t *t)
{
    style_tile(t);
    lv_obj_add_event_cb(t, back_to_nav, LV_EVENT_CLICKED, NULL);
    lv_obj_add_event_cb(t, demo_long_press, LV_EVENT_LONG_PRESSED, NULL);
    s.link_lbl = label(t, &lv_font_montserrat_20, C_TEXT);
    lv_obj_set_width(s.link_lbl, 180);
    lv_obj_set_style_text_align(s.link_lbl, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_long_mode(s.link_lbl, LV_LABEL_LONG_WRAP);
    lv_obj_align(s.link_lbl, LV_ALIGN_TOP_MID, 0, 46);
    s.dev_batt_lbl = label(t, &lv_font_montserrat_20, C_TEXT);
    lv_obj_align(s.dev_batt_lbl, LV_ALIGN_CENTER, 0, 10);
    s.phone_batt_lbl = label(t, &lv_font_montserrat_20, C_TEXT);
    lv_obj_align(s.phone_batt_lbl, LV_ALIGN_CENTER, 0, 40);
    s.demo_lbl = label(t, &lv_font_montserrat_14, C_DIM);
    lv_obj_align(s.demo_lbl, LV_ALIGN_BOTTOM_MID, 0, -30);
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
    const char *txt = NULL;
    uint32_t color = 0x333333;
    if (!s.connected && !s.demo) {
        txt = "No phone";
        color = 0x3A3F47;
    } else {
        switch (s.nav_state) {
        case NAV_REROUTING: txt = "Rerouting..."; color = 0xD97706; break;
        case NAV_GPS_LOST: txt = "GPS lost"; color = 0xB91C1C; break;
        case NAV_ARRIVED: txt = "Arrived"; color = 0x15803D; break;
        case NAV_IDLE: txt = "Pick a destination"; color = 0x3A3F47; break;
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
    if (s.demo) {
        lv_label_set_text(s.link_lbl, "Demo mode");
    } else if (s.connected) {
        lv_label_set_text(s.link_lbl, "Phone connected");
    } else {
        lv_label_set_text_fmt(s.link_lbl, "Waiting for phone\n%s", s.device_name);
    }
    lv_label_set_text(s.demo_lbl, s.demo ? "Long-press: exit demo" : "Long-press: demo");
    if (s.have_trip && s.trip.phone_batt != PROTO_UNKNOWN_BATT) {
        lv_label_set_text_fmt(s.phone_batt_lbl, "Phone  %u%%", s.trip.phone_batt);
    } else {
        lv_label_set_text(s.phone_batt_lbl, "Phone  --");
    }
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

    s.nav = *m;
    s.have_nav = true;
    lv_obj_invalidate(s.map);
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

void ui_init(lv_display_t *disp, const char *device_name, ui_demo_toggle_cb_t on_demo_toggle)
{
    lvgl_port_lock(0);
    strncpy(s.device_name, device_name, sizeof s.device_name - 1);
    s.on_demo_toggle = on_demo_toggle;

    lv_obj_t *scr = lv_screen_active();
    lv_obj_set_style_bg_color(scr, C_BG, 0);

    s.tv = lv_tileview_create(scr);
    lv_obj_set_style_bg_color(s.tv, C_BG, 0);
    lv_obj_set_scrollbar_mode(s.tv, LV_SCROLLBAR_MODE_OFF);
    s.tile_nav = lv_tileview_add_tile(s.tv, 0, 0, LV_DIR_RIGHT);
    s.tile_trip = lv_tileview_add_tile(s.tv, 1, 0, LV_DIR_LEFT | LV_DIR_RIGHT);
    s.tile_status = lv_tileview_add_tile(s.tv, 2, 0, LV_DIR_LEFT);
    build_nav(s.tile_nav);
    build_trip(s.tile_trip);
    build_status(s.tile_status);
    build_overlays();
    lv_timer_create(clock_tick, 1000, NULL);

    refresh_banner();
    refresh_status();
    lv_label_set_text(s.dev_batt_lbl, "Device  --");
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
    default:
        break;
    }
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
    lv_label_set_text_fmt(s.dev_batt_lbl, "Device  %u%%", pct);
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
