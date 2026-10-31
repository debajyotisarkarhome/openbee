// Host test: decode every proto-vectors/*.bin, dump canonically, diff against the .txt the TS encoder wrote.
// Build & run: firmware/test/host/run.sh
#include <dirent.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "proto.h"

static int failures;

#define CHECK(cond)                                                    \
    do {                                                               \
        if (!(cond)) {                                                 \
            fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
            failures++;                                                \
        }                                                              \
    } while (0)

static size_t read_file(const char *path, char *buf, size_t cap)
{
    FILE *f = fopen(path, "rb");
    if (!f) {
        return 0;
    }
    size_t n = fread(buf, 1, cap, f);
    fclose(f);
    return n;
}

// Must match dump() in app/src/core/proto.ts.
static int dump(const proto_msg_t *m, char *o, size_t cap)
{
    int n = 0;
#define P(...) n += snprintf(o + n, cap - n, __VA_ARGS__)
    switch (m->type) {
    case MSG_NAV: {
        const nav_msg_t *v = &m->u.nav;
        P("type=NAV\nmaneuver=%u\nexit=%u\ndist_m=%u\ncurve_dir=%d\ncurve_class=%u\ncurve_dist_m=%u\nmaneuver_idx=%u\n"
          "anchor_id=%u\npose=%d,%d,%u\nn=%u\n",
          v->maneuver, v->exit, v->dist_m, v->curve_dir, v->curve_class, v->curve_dist_m, v->maneuver_idx, v->anchor_id,
          v->pose_x, v->pose_y, v->heading_cdeg, v->n);
        for (int i = 0; i < v->n; i++) {
            P("p%d=%d,%d,%u\n", i, v->points[i].x, v->points[i].y, v->points[i].cls);
        }
        P("street=%s\n", v->street);
        break;
    }
    case MSG_TRIP: {
        const trip_msg_t *v = &m->u.trip;
        P("type=TRIP\nspeed_kmh=%u\nlimit_kmh=%u\neta_epoch=%lu\nremaining_m=%lu\nphone_batt=%u\nnow_epoch=%lu\ntz_offset_min=%d\n",
          v->speed_kmh, v->limit_kmh, (unsigned long)v->eta_epoch, (unsigned long)v->remaining_m, v->phone_batt,
          (unsigned long)v->now_epoch, v->tz_offset_min);
        break;
    }
    case MSG_NOTIF:
        P("type=NOTIF\nkind=%u\napp=%s\ntitle=%s\nbody=%s\n", m->u.notif.kind, m->u.notif.app, m->u.notif.title,
          m->u.notif.body);
        break;
    case MSG_STATE:
        P("type=STATE\nstate=%u\n", m->u.state);
        break;
    case MSG_LAYOUT:
        P("type=LAYOUT\nn=%u\npages=", m->u.layout.n);
        for (int i = 0; i < m->u.layout.n; i++) {
            P(i ? ",%u" : "%u", m->u.layout.pages[i]);
        }
        P("\n");
        break;
    case MSG_ROADS: {
        const roads_msg_t *v = &m->u.roads;
        P("type=ROADS\nanchor_id=%u\npart=%u/%u\nn=%u\n", v->anchor_id, v->part, v->parts, v->nroads);
        int k = 0;
        for (int i = 0; i < v->nroads; i++) {
            P("r%d=", i);
            for (int j = 0; j < v->len[i]; j++, k++) {
                P("%s%d,%d", j ? " " : "", v->pts[k].x, v->pts[k].y);
            }
            P("\n");
        }
        break;
    }
    case MSG_MEDIA:
        P("type=MEDIA\nstate=%u\nvolume_pct=%u\ntitle=%s\nartist=%s\n", m->u.media.state, m->u.media.volume_pct,
          m->u.media.title, m->u.media.artist);
        break;
    case MSG_MEDIA_CMD:
        P("type=MEDIA_CMD\ncmd=%u\n", m->u.media_cmd);
        break;
    case MSG_DEV_STATUS: {
        const dev_status_msg_t *v = &m->u.dev_status;
        P("type=DEV_STATUS\nbatt_pct=%u\nbatt_mv=%u\ncharging=%u\nfw_ver=%u\n", v->batt_pct, v->batt_mv, v->charging,
          v->fw_ver);
        break;
    }
    }
#undef P
    return n;
}

static void test_vectors(const char *dir)
{
    DIR *d = opendir(dir);
    CHECK(d != NULL);
    if (!d) {
        return;
    }
    int count = 0;
    struct dirent *e;
    static proto_msg_t msg;
    while ((e = readdir(d))) {
        size_t L = strlen(e->d_name);
        if (L < 5 || strcmp(e->d_name + L - 4, ".bin")) {
            continue;
        }
        char path[512], frame[512], want[8192], got[8192];
        snprintf(path, sizeof path, "%s/%s", dir, e->d_name);
        size_t flen = read_file(path, frame, sizeof frame);
        snprintf(path, sizeof path, "%s/%.*s.txt", dir, (int)(L - 4), e->d_name);
        size_t wlen = read_file(path, want, sizeof want - 1);
        want[wlen] = '\0';

        bool ok = proto_decode((const uint8_t *)frame, flen, &msg);
        if (!ok) {
            fprintf(stderr, "FAIL decode %s\n", e->d_name);
            failures++;
            continue;
        }
        dump(&msg, got, sizeof got);
        if (strcmp(got, want)) {
            fprintf(stderr, "FAIL %s\n--- want\n%s--- got\n%s", e->d_name, want, got);
            failures++;
        }
        count++;
    }
    closedir(d);
    CHECK(count >= 14);
    printf("vectors checked: %d\n", count);
}

static void test_malformed(void)
{
    static proto_msg_t m;
    const uint8_t bad_ver[] = {2, 4, 1, 0, 0};
    const uint8_t bad_len[] = {1, 4, 2, 0, 1};
    const uint8_t bad_type[] = {1, 0x55, 0, 0};
    const uint8_t short_nav[] = {1, 1, 3, 0, 3, 0, 1};
    const uint8_t too_many_pts[] = {1, 1, 16, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0xFF, 0, 0, 0, 0, 0, 0, 0, 37};
    const uint8_t roads_bad_part[] = {1, 5, 4, 0, 1, 2, 2, 0};
    const uint8_t roads_short[] = {1, 5, 9, 0, 1, 0, 1, 1, 2, 0, 0, 0, 0};
    const uint8_t str_overrun[] = {1, 3, 4, 0, 0, 1, 'a', 9};
    CHECK(!proto_decode(bad_ver, sizeof bad_ver, &m));
    CHECK(!proto_decode(bad_len, sizeof bad_len, &m));
    CHECK(!proto_decode(bad_type, sizeof bad_type, &m));
    CHECK(!proto_decode(short_nav, sizeof short_nav, &m));
    CHECK(!proto_decode(too_many_pts, sizeof too_many_pts, &m));
    CHECK(!proto_decode(str_overrun, sizeof str_overrun, &m));
    CHECK(!proto_decode(roads_bad_part, sizeof roads_bad_part, &m));
    CHECK(!proto_decode(roads_short, sizeof roads_short, &m));
    CHECK(!proto_decode(bad_ver, 3, &m));

    // MEDIA: title 97 bytes (max 96), artist empty; then title empty, artist 65 bytes (max 64).
    uint8_t media_bad[4 + 4 + 97 + 65];
    size_t k = 0;
    media_bad[k++] = 1; media_bad[k++] = MSG_MEDIA; media_bad[k++] = 0; media_bad[k++] = 0;
    media_bad[k++] = 1; media_bad[k++] = 10; media_bad[k++] = 97;
    memset(media_bad + k, 'a', 97); k += 97;
    media_bad[k++] = 0;
    media_bad[2] = (uint8_t)(k - 4);
    CHECK(!proto_decode(media_bad, k, &m));
    k = 4;
    media_bad[k++] = 1; media_bad[k++] = 10; media_bad[k++] = 0; media_bad[k++] = 65;
    memset(media_bad + k, 'b', 65); k += 65;
    media_bad[2] = (uint8_t)(k - 4);
    CHECK(!proto_decode(media_bad, k, &m));

    // LAYOUT: more than 8 pages, or fewer page bytes than n, is malformed.
    static const uint8_t layout_many[] = {1, MSG_LAYOUT, 10, 0, 9, 0, 1, 2, 3, 4, 0, 1, 2};
    CHECK(!proto_decode(layout_many, sizeof layout_many, &m));
    static const uint8_t layout_short[] = {1, MSG_LAYOUT, 3, 0, 3, 0, 1};
    CHECK(!proto_decode(layout_short, sizeof layout_short, &m));
    static const uint8_t layout_empty[] = {1, MSG_LAYOUT, 1, 0, 0};
    CHECK(proto_decode(layout_empty, sizeof layout_empty, &m) && m.u.layout.n == 0);
}

static void test_dev_status_encode(const char *dir)
{
    dev_status_msg_t s = {.batt_pct = 84, .batt_mv = 4012, .charging = 1, .fw_ver = 1};
    uint8_t buf[16];
    char want[16], path[512];
    size_t n = proto_encode_dev_status(&s, buf);
    snprintf(path, sizeof path, "%s/dev_status.bin", dir);
    size_t wn = read_file(path, want, sizeof want);
    CHECK(n == wn && memcmp(buf, want, n) == 0);
}

static void test_media_cmd_encode(const char *dir)
{
    uint8_t buf[16];
    char want[16], path[512];
    size_t n = proto_encode_media_cmd(MEDIA_CMD_NEXT, buf);
    snprintf(path, sizeof path, "%s/media_cmd_next.bin", dir);
    size_t wn = read_file(path, want, sizeof want);
    CHECK(n == 5 && n == wn && memcmp(buf, want, n) == 0);
}

int main(int argc, char **argv)
{
    const char *dir = argc > 1 ? argv[1] : "../../../proto-vectors";
    test_vectors(dir);
    test_malformed();
    test_dev_status_encode(dir);
    test_media_cmd_encode(dir);
    if (failures) {
        printf("%d FAILURE(S)\n", failures);
        return 1;
    }
    printf("all host tests passed\n");
    return 0;
}
