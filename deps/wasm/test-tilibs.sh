#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
PREFIX=${WASM_DEPS_PREFIX:-"$ROOT/wasm-deps"}
BUILD="$ROOT/build-emscripten"
if ! command -v emcc >/dev/null 2>&1; then
    set +u
    # shellcheck source=/dev/null
    source "${EMSDK:-$HOME/emsdk}/emsdk_env.sh"
    set -u
fi
test -f "$PREFIX/webtilp-deps.txt"
OUTPUT=$(mktemp -d "${TMPDIR:-/tmp}/webtilp-evo-smoke.XXXXXX")
echo "Evo file-test output: $OUTPUT"
em++ "$ROOT/deps/wasm/evo-files-smoke.cpp" -o "$OUTPUT/evo-files.js" \
    -std=c++17 -O2 -pthread -sPTHREAD_POOL_SIZE=2 -sPROXY_TO_PTHREAD=1 \
    -sEXIT_RUNTIME=1 -sASSERTIONS=1 -sSTACK_SIZE=5242880 -sASYNCIFY=1 \
    -I"$ROOT/libtifiles/trunk/src" -I"$ROOT/libticonv/trunk/src" \
    -I"$PREFIX/include" -I"$PREFIX/include/glib-2.0" \
    -I"$PREFIX/lib/glib-2.0/include" \
    "$BUILD/libtifiles/trunk/libtifiles2.a" "$BUILD/libticonv/trunk/libticonv.a" \
    "$PREFIX/lib/libarchive.a" "$PREFIX/lib/libglib-2.0.a" "$PREFIX/lib/libz.a"
node "$OUTPUT/evo-files.js"
