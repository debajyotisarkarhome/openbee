// Host test for the AMS Entity Update parser. Build via run.sh.
#include <stdio.h>
#include <string.h>

#include "ams_parse.h"

static int failures;

#define CHECK(cond)                                                     \
    do {                                                                \
        if (!(cond)) {                                                  \
            printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);      \
            failures++;                                                 \
        }                                                               \
    } while (0)

static bool upd(media_msg_t *m, uint8_t ent, uint8_t attr, const char *val) {
    uint8_t buf[256];
    size_t n = strlen(val);
    buf[0] = ent;
    buf[1] = attr;
    buf[2] = 0;
    memcpy(buf + 3, val, n);
    return ams_parse_entity_update(buf, 3 + n, m);
}

int main(void) {
    media_msg_t m;
    memset(&m, 0, sizeof m);

    // Title
    CHECK(upd(&m, AMS_ENTITY_TRACK, AMS_TRACK_TITLE, "Hey"));
    CHECK(strcmp(m.title, "Hey") == 0);
    CHECK(!upd(&m, AMS_ENTITY_TRACK, AMS_TRACK_TITLE, "Hey"));

    // Artist
    CHECK(upd(&m, AMS_ENTITY_TRACK, AMS_TRACK_ARTIST, "Ana"));
    CHECK(strcmp(m.artist, "Ana") == 0);

    // Playback info
    CHECK(upd(&m, AMS_ENTITY_PLAYER, AMS_PLAYER_PLAYBACK_INFO, "1,1.0,3.5"));
    CHECK(m.state == MEDIA_PLAYING);
    CHECK(!upd(&m, AMS_ENTITY_PLAYER, AMS_PLAYER_PLAYBACK_INFO, "1,1.0,9.5"));
    CHECK(upd(&m, AMS_ENTITY_PLAYER, AMS_PLAYER_PLAYBACK_INFO, "0,1.0,3.5"));
    CHECK(m.state == MEDIA_PAUSED);
    CHECK(upd(&m, AMS_ENTITY_PLAYER, AMS_PLAYER_PLAYBACK_INFO, "2,1.0,3.5"));
    CHECK(m.state == MEDIA_PLAYING);
    CHECK(!upd(&m, AMS_ENTITY_PLAYER, AMS_PLAYER_PLAYBACK_INFO, "3,1.0,3.5"));
    CHECK(m.state == MEDIA_PLAYING);
    {
        uint8_t e[] = {0, 1, 0};
        CHECK(ams_parse_entity_update(e, sizeof e, &m));
        CHECK(m.state == MEDIA_NONE);
    }

    // Volume
    CHECK(upd(&m, AMS_ENTITY_PLAYER, AMS_PLAYER_VOLUME, "0.5"));
    CHECK(m.volume_pct == 50);
    CHECK(upd(&m, AMS_ENTITY_PLAYER, AMS_PLAYER_VOLUME, "0.4375"));
    CHECK(m.volume_pct == 44);
    CHECK(upd(&m, AMS_ENTITY_PLAYER, AMS_PLAYER_VOLUME, "1.0"));
    CHECK(m.volume_pct == 100);
    CHECK(upd(&m, AMS_ENTITY_PLAYER, AMS_PLAYER_VOLUME, "0"));
    CHECK(m.volume_pct == 0);
    CHECK(upd(&m, AMS_ENTITY_PLAYER, AMS_PLAYER_VOLUME, "7"));
    CHECK(m.volume_pct == 100);
    CHECK(upd(&m, AMS_ENTITY_PLAYER, AMS_PLAYER_VOLUME, "abc"));
    CHECK(m.volume_pct == 255);

    // UTF-8 boundary truncation: 95 x 'a' + e-acute (97 bytes) -> 95 bytes
    {
        char s[98];
        memset(s, 'a', 95);
        s[95] = (char)0xC3;
        s[96] = (char)0xA9;
        s[97] = 0;
        CHECK(upd(&m, AMS_ENTITY_TRACK, AMS_TRACK_TITLE, s));
        CHECK(strlen(m.title) == 95);
        CHECK(m.title[94] == 'a');
    }
    // Exactly fitting multibyte char is kept (94 x 'a' + e-acute = 96)
    {
        char s[98];
        memset(s, 'a', 94);
        s[94] = (char)0xC3;
        s[95] = (char)0xA9;
        s[96] = (char)0xC3;
        s[97] = 0;
        CHECK(upd(&m, AMS_ENTITY_TRACK, AMS_TRACK_TITLE, s));
        CHECK(strlen(m.title) == 96);
    }

    // Rejections leave m untouched
    {
        media_msg_t before = m;
        uint8_t one[] = {2};
        uint8_t two[] = {2, 2};
        CHECK(!ams_parse_entity_update(one, sizeof one, &m));
        CHECK(!ams_parse_entity_update(two, sizeof two, &m));
        CHECK(!upd(&m, 7, 0, "x"));
        CHECK(!upd(&m, AMS_ENTITY_TRACK, AMS_TRACK_ALBUM, "x"));
        CHECK(!upd(&m, AMS_ENTITY_PLAYER, AMS_PLAYER_NAME, "x"));
        CHECK(memcmp(&before, &m, sizeof m) == 0);
    }

    // Remote command mapping
    CHECK(ams_remote_cmd(MEDIA_CMD_TOGGLE) == 2);
    CHECK(ams_remote_cmd(MEDIA_CMD_NEXT) == 3);
    CHECK(ams_remote_cmd(MEDIA_CMD_PREV) == 4);
    CHECK(ams_remote_cmd(MEDIA_CMD_VOL_UP) == 5);
    CHECK(ams_remote_cmd(MEDIA_CMD_VOL_DOWN) == 6);
    CHECK(ams_remote_cmd(9) == 0xFF);

    if (failures) {
        printf("ams_parse_test: %d failure(s)\n", failures);
        return 1;
    }
    printf("ams_parse_test: all passed\n");
    return 0;
}
