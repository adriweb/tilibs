#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
PREFIX=${WASM_DEPS_PREFIX:-"$ROOT/wasm-deps"}
if ! command -v emcc >/dev/null 2>&1; then
    set +u
    # shellcheck source=/dev/null
    source "${EMSDK:-$HOME/emsdk}/emsdk_env.sh"
    set -u
fi
test -f "$PREFIX/webtilp-deps.txt"
OUTPUT=$(mktemp -d "${TMPDIR:-/tmp}/webtilp-deps-smoke.XXXXXX")
echo "Smoke-test output: $OUTPUT"
# The test is C, but libusb's WebUSB backend and Embind need the C++ runtime.
emcc -sDEFAULT_TO_CXX=1 "$ROOT/deps/wasm/smoke.c" -o "$OUTPUT/smoke.js" \
    -O2 -pthread -sPTHREAD_POOL_SIZE=2 -sPROXY_TO_PTHREAD=1 \
    -sEXIT_RUNTIME=1 -sASSERTIONS=1 -sSTACK_SIZE=1048576 \
    -I"$PREFIX/include" -I"$PREFIX/include/libusb-1.0" \
    -I"$PREFIX/include/glib-2.0" -I"$PREFIX/lib/glib-2.0/include" \
    "$PREFIX/lib/libusb-1.0.a" "$PREFIX/lib/libglib-2.0.a" \
    "$PREFIX/lib/libarchive.a" "$PREFIX/lib/libz.a" \
    --bind -sASYNCIFY=1
node "$OUTPUT/smoke.js"
