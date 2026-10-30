// Host test for the ELM327 reply parser. Replies are the ones a real adapter ("OBDBLE", ELM327 v2.1, CAN 11-bit
// 500k) gave with ignition on, engine off, plus the usual error shapes.
#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "obd_parse.h"

static int32_t decode(const char *reply, uint8_t pid)
{
    uint8_t d[4];
    size_t n = obd_parse_mode01(reply, pid, d, sizeof d);
    int32_t v = -9999;
    assert(n > 0);
    assert(obd_decode(pid, d, n, &v));
    return v;
}

int main(void)
{
    // Captured from the adapter (ATS0, so no spaces), with the prompt still attached.
    assert(decode("410C0000\r\r>", OBD_PID_RPM) == 0);
    assert(decode("410547\r\r>", OBD_PID_COOLANT) == 31);
    assert(decode("410D00\r\r>", OBD_PID_SPEED) == 0);
    assert(decode("411119\r\r>", OBD_PID_THROTTLE) == 10);
    assert(decode("410400\r\r>", OBD_PID_LOAD) == 0);

    // Spaces (ATS1), a running engine, and a SEARCHING line before the answer.
    assert(decode("SEARCHING...\r41 0C 1A F8\r\r>", OBD_PID_RPM) == 1726);
    assert(decode("41 05 00\r>", OBD_PID_COOLANT) == -40);
    assert(decode("4111FF\r>", OBD_PID_THROTTLE) == 100);

    // The answer for another PID, or none at all, yields nothing.
    uint8_t d[4];
    assert(obd_parse_mode01("410D00\r>", OBD_PID_RPM, d, sizeof d) == 0);
    assert(obd_parse_mode01("NO DATA\r\r>", OBD_PID_RPM, d, sizeof d) == 0);
    assert(obd_parse_mode01("?\r>", OBD_PID_RPM, d, sizeof d) == 0);
    int32_t v;
    assert(!obd_decode(OBD_PID_RPM, d, 1, &v)); // RPM needs two bytes

    // Supported-PID bitmap from the real 0100 reply.
    assert(obd_parse_mode01("SEARCHING...\r4100BE3EF813\r\r>", OBD_PID_SUPPORTED, d, sizeof d) == 4);
    assert(obd_pid_supported(d, OBD_PID_LOAD) && obd_pid_supported(d, OBD_PID_COOLANT));
    assert(obd_pid_supported(d, OBD_PID_RPM) && obd_pid_supported(d, OBD_PID_SPEED));
    assert(obd_pid_supported(d, OBD_PID_THROTTLE));
    assert(!obd_pid_supported(d, 0x02) && !obd_pid_supported(d, 0x08) && !obd_pid_supported(d, 0x10));
    assert(obd_pid_supported(d, 0x20) && !obd_pid_supported(d, 0x21));

    // Ignition off / bus trouble.
    assert(obd_reply_no_ecu("NO DATA\r\r>"));
    assert(obd_reply_no_ecu("SEARCHING...\rUNABLE TO CONNECT\r\r>"));
    assert(obd_reply_no_ecu("CAN ERROR\r>"));
    assert(obd_reply_no_ecu("BUS INIT: ...ERROR\r>"));
    assert(!obd_reply_no_ecu("BUS INIT: ...OK\r410C0000\r>"));
    assert(!obd_reply_no_ecu("410C0000\r\r>"));

    // Battery voltage.
    uint16_t mv = 0;
    assert(obd_parse_voltage("12.4V\r>", &mv) && mv == 12400);
    assert(obd_parse_voltage("ATRV\r14.15V\r>", &mv) && mv == 14150);
    assert(obd_parse_voltage("13V\r>", &mv) && mv == 13000);
    assert(!obd_parse_voltage("?\r>", &mv));
    assert(!obd_parse_voltage("OK\r>", &mv));

    // Multi-PID: all five Engine-page values in one request, replies captured from the real adapter + ECU.
    {
        static const uint8_t pids[] = {OBD_PID_RPM, OBD_PID_SPEED, OBD_PID_THROTTLE, OBD_PID_COOLANT, OBD_PID_LOAD};
        int32_t v[5];
        bool got[5];
        assert(obd_parse_mode01_multi("00C\r0:410C00000D00\r1:111905550400\r\r", pids, 5, v, got) == 5);
        assert(v[0] == 0 && v[1] == 0 && v[2] == 10 && v[3] == 45 && v[4] == 0);
        // A clone repeated the second frame as "2:": the declared byte count (00C) cuts it off.
        assert(obd_parse_mode01_multi("00C\r0:410C1AF80D20\r1:111905550400\r2:11190555040000\r\r", pids, 5, v, got) == 5);
        assert(v[0] == 1726 && v[1] == 32);
        // Two PIDs fit one frame: no byte count, no frame numbers. Missing PIDs stay unset.
        assert(obd_parse_mode01_multi("410C00000D00\r\r", pids, 5, v, got) == 2);
        assert(got[0] && got[1] && !got[2] && !got[3] && !got[4]);
        // With spaces (ATS1), and a frame out of order is ignored.
        assert(obd_parse_mode01_multi("00C\r0: 41 0C 0F A0 0D 3C\r1: 11 FF 05 7D 04 80\r", pids, 5, v, got) == 5);
        assert(v[0] == 1000 && v[1] == 60 && v[2] == 100 && v[3] == 85 && v[4] == 50);
        assert(obd_parse_mode01_multi("00C\r1:111905550400\r0:410C00000D00\r", pids, 5, v, got) == 2);
        // Nothing usable.
        assert(obd_parse_mode01_multi("NO DATA\r\r", pids, 5, v, got) == 0);
        assert(obd_parse_mode01_multi("?\r", pids, 5, v, got) == 0);
    }

    printf("obd_parse_test: all passed\n");
    return 0;
}
