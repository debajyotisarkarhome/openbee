#!/bin/sh
# Builds and runs the firmware host tests with the system C compiler.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
root="$here/../../.."
out="${TMPDIR:-/tmp}/openbee-host-tests"
mkdir -p "$out"
${CC:-gcc} -std=c11 -Wall -Wextra -Werror -O1 -g \
    -I "$root/firmware/components/proto/include" \
    "$root/firmware/components/proto/proto.c" \
    "$here/proto_vectors_test.c" \
    -o "$out/proto_vectors_test"
"$out/proto_vectors_test" "$root/proto-vectors"

${CC:-gcc} -std=c11 -Wall -Wextra -Werror -O1 -g \
    -I "$root/firmware/components/proto/include" \
    -I "$root/firmware/components/ams/include" \
    "$root/firmware/components/ams/ams_parse.c" \
    "$here/ams_parse_test.c" \
    -o "$out/ams_parse_test"
"$out/ams_parse_test"

${CC:-gcc} -std=c11 -Wall -Wextra -Werror -O1 -g \
    -I "$root/firmware/components/obd/include" \
    "$root/firmware/components/obd/obd_parse.c" \
    "$here/obd_parse_test.c" \
    -o "$out/obd_parse_test"
"$out/obd_parse_test"

${CC:-gcc} -std=c11 -Wall -Wextra -Werror -O1 -g \
    -I "$root/firmware/components/imu/include" \
    "$root/firmware/components/imu/knock.c" \
    "$here/knock_test.c" \
    -lm -o "$out/knock_test"
"$out/knock_test"
