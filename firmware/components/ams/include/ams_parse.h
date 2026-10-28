// Pure-C parser for Apple Media Service (AMS) Entity Update notifications.
// No ESP-IDF dependencies so it can be tested on the host.
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "proto.h"

#ifdef __cplusplus
extern "C" {
#endif

// Apple AMS IDs (Apple "AMS Specification").
enum { AMS_ENTITY_PLAYER = 0, AMS_ENTITY_QUEUE = 1, AMS_ENTITY_TRACK = 2 };
enum { AMS_PLAYER_NAME = 0, AMS_PLAYER_PLAYBACK_INFO = 1, AMS_PLAYER_VOLUME = 2 };
enum { AMS_TRACK_ARTIST = 0, AMS_TRACK_ALBUM = 1, AMS_TRACK_TITLE = 2, AMS_TRACK_DURATION = 3 };

/** Apply one Entity Update notification (EntityID, AttributeID, Flags, value...) to m.
 *  Returns true if m changed. Short or unknown updates return false and leave m untouched. */
bool ams_parse_entity_update(const uint8_t *data, size_t len, media_msg_t *m);

/** media_cmd_t -> AMS RemoteCommandID (Toggle 2, Next 3, Prev 4, VolUp 5, VolDown 6); 0xFF if unknown. */
uint8_t ams_remote_cmd(uint8_t media_cmd);

#ifdef __cplusplus
}
#endif
