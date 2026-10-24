#pragma once

#include <stdint.h>

#include "proto.h"

#define DEMO_ANCHOR_ID 1
#define DEMO_MAX_ROAD_FRAMES 8

void demo_init(uint32_t now_s);

/** Streets around the demo road as ROADS frames (anchor DEMO_ANCHOR_ID). Returns the number of frames. */
int demo_roads(roads_msg_t *out, int max_frames);

/** Advance the demo ride by dt_s seconds and fill NAV + TRIP like the phone would. */
void demo_step(float dt_s, uint32_t now_s, nav_msg_t *nav, trip_msg_t *trip);
