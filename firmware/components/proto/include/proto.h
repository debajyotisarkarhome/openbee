// OpenBee BLE protocol v1 decoder — see docs/protocol.md. Plain C, no ESP-IDF deps (host-testable).
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define PROTO_VER 1
#define PROTO_MAX_PAYLOAD 240
#define PROTO_MAX_FRAME (4 + PROTO_MAX_PAYLOAD)
#define PROTO_MAX_POINTS 36
#define PROTO_MAX_ROADS_PER_FRAME 60
#define PROTO_MAX_ROAD_POINTS_PER_FRAME 58
#define PROTO_UNKNOWN_DIST 0xFFFF
#define PROTO_NO_INDEX 0xFF
#define PROTO_UNKNOWN_BATT 0xFF

typedef enum {
    MSG_NAV = 0x01,
    MSG_TRIP = 0x02,
    MSG_NOTIF = 0x03,
    MSG_STATE = 0x04,
    MSG_ROADS = 0x05,
    MSG_DEV_STATUS = 0x81,
} msg_type_t;

typedef enum {
    MAN_NONE = 0,
    MAN_STRAIGHT,
    MAN_SLIGHT_LEFT,
    MAN_LEFT,
    MAN_SHARP_LEFT,
    MAN_SLIGHT_RIGHT,
    MAN_RIGHT,
    MAN_SHARP_RIGHT,
    MAN_UTURN_LEFT,
    MAN_UTURN_RIGHT,
    MAN_KEEP_LEFT,
    MAN_KEEP_RIGHT,
    MAN_ROUNDABOUT,
    MAN_ARRIVE,
    MAN_DEPART,
} maneuver_t;

typedef enum { CURVE_STRAIGHT = 0, CURVE_GENTLE, CURVE_MEDIUM, CURVE_SHARP } curve_class_t;

typedef enum { NAV_IDLE = 0, NAV_NAVIGATING, NAV_REROUTING, NAV_ARRIVED, NAV_GPS_LOST } nav_state_t;

typedef enum { NOTIF_MESSAGE = 0, NOTIF_CALL, NOTIF_OTHER } notif_kind_t;

typedef struct {
    int16_t x;   // dm, + = rider's right
    int16_t y;   // dm, + = ahead
    uint8_t cls; // curve_class_t of the segment ending here
} shape_point_t;

typedef struct {
    uint8_t maneuver;
    uint8_t exit;
    uint16_t dist_m;
    int8_t curve_dir;
    uint8_t curve_class;
    uint16_t curve_dist_m;
    uint8_t maneuver_idx;
    uint8_t anchor_id;      // ROADS set the pose refers to; 0 = none
    int16_t pose_x;         // dm east of the anchor
    int16_t pose_y;         // dm north of the anchor
    uint16_t heading_cdeg;  // centidegrees clockwise from north ("up" on screen)
    uint8_t n;
    shape_point_t points[PROTO_MAX_POINTS];
    char street[PROTO_MAX_PAYLOAD + 1]; // NUL-terminated copy
} nav_msg_t;

typedef struct {
    uint8_t speed_kmh;
    uint8_t limit_kmh;
    uint32_t eta_epoch;
    uint32_t remaining_m;
    uint8_t phone_batt;
    uint32_t now_epoch;
    int16_t tz_offset_min;
} trip_msg_t;

typedef struct {
    uint8_t kind;
    char app[PROTO_MAX_PAYLOAD + 1];
    char title[PROTO_MAX_PAYLOAD + 1];
    char body[PROTO_MAX_PAYLOAD + 1];
} notif_msg_t;

typedef struct {
    int16_t x; // m east of the anchor
    int16_t y; // m north of the anchor
} road_point_t;

/** One ROADS frame: part `part` of `parts` for anchor `anchor_id`. Road i has len[i] points, packed in `pts`. */
typedef struct {
    uint8_t anchor_id;
    uint8_t part;
    uint8_t parts;
    uint8_t nroads;
    uint8_t len[PROTO_MAX_ROADS_PER_FRAME];
    uint16_t npoints;
    road_point_t pts[PROTO_MAX_ROAD_POINTS_PER_FRAME];
} roads_msg_t;

typedef struct {
    uint8_t batt_pct;
    uint16_t batt_mv;
    uint8_t charging;
    uint8_t fw_ver;
} dev_status_msg_t;

typedef struct {
    msg_type_t type;
    union {
        nav_msg_t nav;
        trip_msg_t trip;
        notif_msg_t notif;
        uint8_t state;
        roads_msg_t roads;
        dev_status_msg_t dev_status;
    } u;
} proto_msg_t;

/** Decode one frame. Returns false on any malformed input; *out is then unspecified. */
bool proto_decode(const uint8_t *frame, size_t len, proto_msg_t *out);

/** Encode DEV_STATUS into buf (≥ 9 bytes). Returns frame length. */
size_t proto_encode_dev_status(const dev_status_msg_t *m, uint8_t *buf);

#ifdef __cplusplus
}
#endif
