#!/usr/bin/env bash
# Build the pinned native dependencies used by WebTILP into one WASM prefix.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
RECIPE="$ROOT/deps/wasm"
WORK="$ROOT/build-wasm-deps"
PREFIX=${WASM_DEPS_PREFIX:-"$ROOT/wasm-deps"}
JOBS=${JOBS:-$(getconf _NPROCESSORS_ONLN)}

if ! command -v emcc >/dev/null 2>&1; then
    # emsdk_env.sh is not compatible with nounset on every SDK version.
    set +u
    # shellcheck source=/dev/null
    source "${EMSDK:-$HOME/emsdk}/emsdk_env.sh"
    set -u
fi
for tool in emcc emcmake emconfigure emmake meson ninja cmake pkg-config python3 curl patch; do
    command -v "$tool" >/dev/null || { echo "Missing build tool: $tool" >&2; exit 1; }
done

mkdir -p "$WORK/downloads" "$PREFIX"
PREFIX=$(cd "$PREFIX" && pwd)
# A completed install is immutable. Use another prefix for a subsequent build.
if [ -f "$PREFIX/webtilp-deps.txt" ]; then
    echo "Already built: $PREFIX. Set WASM_DEPS_PREFIX to a new directory to rebuild." >&2
    exit 1
fi
BUILD=$(mktemp -d "$WORK/build.XXXXXX")
echo "Building with $(emcc --version | head -n 1)"
echo "Sources/build logs: $BUILD"
echo "Install prefix: $PREFIX"

while read -r filename sha256 url; do
    case "$filename" in ''|'#'*) continue ;; esac
    archive="$WORK/downloads/$filename"
    if [ ! -f "$archive" ]; then
        curl --fail --location --retry 3 "$url" -o "$archive.part"
        mv "$archive.part" "$archive"
    fi
    python3 - "$archive" "$sha256" <<'PY'
import hashlib, pathlib, sys
path = pathlib.Path(sys.argv[1])
if hashlib.sha256(path.read_bytes()).hexdigest() != sys.argv[2]:
    raise SystemExit(f"Checksum mismatch: {path}")
PY
    case "$filename" in
        *.patch) cp "$archive" "$BUILD/$filename" ;;
        *) tar -xf "$archive" -C "$BUILD" ;;
    esac
done < "$RECIPE/sources.lock"

export CFLAGS="-O3 -pthread"
export CXXFLAGS="$CFLAGS"
export CPPFLAGS="-I$PREFIX/include"
export LDFLAGS="-L$PREFIX/lib -O3 -pthread"
export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig"
export PKG_CONFIG_LIBDIR="$PKG_CONFIG_PATH"
export EM_PKG_CONFIG_PATH="$PKG_CONFIG_PATH"
export EM_PKG_CONFIG_LIBDIR="$PKG_CONFIG_LIBDIR"
# Avoid zlib's Darwin branch, which overrides emar with Apple's libtool.
export CHOST=wasm32-unknown-linux

cd "$BUILD/zlib-1.3.2"
emconfigure ./configure --prefix="$PREFIX" --static
emmake make -j"$JOBS" install

# GLib's full Meson configuration requires libffi for GObject, even though
# WebTILP itself links only libglib-2.0, not GObject or libffi.
cd "$BUILD/libffi-3.8.0"
python3 - <<'PY'
from pathlib import Path
p = Path('configure')
p.write_text(p.read_text().replace(' -fexceptions', ''))
PY
emconfigure ./configure --host=wasm32-unknown-linux --prefix="$PREFIX" \
    --enable-static --disable-shared --disable-dependency-tracking \
    --disable-builddir --disable-multi-os-directory --disable-raw-api \
    --disable-structs --disable-docs
emmake make -j"$JOBS" install

cd "$BUILD/glib-2.88.3"
patch --batch --fuzz=0 -p1 < "$BUILD/glib-wasm.patch"
patch --batch --fuzz=0 -p1 < "$RECIPE/glib-list-callbacks.patch"
meson setup _build --prefix="$PREFIX" --libdir=lib \
    --cross-file="$RECIPE/emscripten-cross.ini" --wrap-mode=nodownload \
    --default-library=static --buildtype=release \
    -Dintrospection=disabled -Dselinux=disabled -Dxattr=false \
    -Dlibmount=disabled -Dsysprof=disabled -Dnls=disabled \
    -Dglib_debug=disabled -Dtests=false -Dglib_assert=false -Dglib_checks=false
meson compile -C _build -j "$JOBS"
meson install -C _build --tags devel

cd "$BUILD/libusb-1.0.30"
# libusb adds Embind to its C configure probes. Emscripten >= 6.0.6 no
# longer links the C++ runtime implicitly when those probes use emcc.
LDFLAGS="$LDFLAGS -sDEFAULT_TO_CXX=1" emconfigure ./configure --host=wasm32-emscripten --prefix="$PREFIX" \
    --enable-static --disable-shared
emmake make -j"$JOBS" install

cd "$BUILD/libarchive-3.8.9"
# Release adds -O3 to the library build. Keep it out of CMake's serial
# feature probes, which would otherwise optimize every temporary WASM module.
LDFLAGS="-L$PREFIX/lib -pthread" emcmake cmake -S . -B _build -G Ninja \
    -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$PREFIX" \
    -DCMAKE_C_FLAGS="-pthread" -DCMAKE_CXX_FLAGS="-pthread" \
    -DZLIB_INCLUDE_DIR="$PREFIX/include" -DZLIB_LIBRARY="$PREFIX/lib/libz.a" \
    -DBUILD_SHARED_LIBS=OFF -DENABLE_TEST=OFF -DENABLE_TAR=OFF \
    -DENABLE_CPIO=OFF -DENABLE_CAT=OFF -DENABLE_UNZIP=OFF \
    -DENABLE_ACL=OFF -DENABLE_XATTR=OFF -DENABLE_ICONV=OFF \
    -DENABLE_OPENSSL=OFF -DENABLE_NETTLE=OFF -DENABLE_MBEDTLS=OFF \
    -DENABLE_LIBB2=OFF -DENABLE_LZ4=OFF -DENABLE_LZO=OFF -DENABLE_ZSTD=OFF \
    -DENABLE_LZMA=OFF -DENABLE_BZip2=OFF -DENABLE_EXPAT=OFF \
    -DENABLE_LIBXML2=OFF -DENABLE_PCREPOSIX=OFF -DENABLE_PCRE2POSIX=OFF \
    -DENABLE_ZLIB=ON
cmake --build _build -j "$JOBS"
cmake --install _build

for library in libglib-2.0.a libz.a libusb-1.0.a libarchive.a; do
    test -s "$PREFIX/lib/$library"
    test -n "$(emar t "$PREFIX/lib/$library")"
done
{
    emcc --version | head -n 1
    for library in glib-2.0 zlib libusb-1.0 libarchive libffi; do
        version=$(pkg-config --modversion "$library")
        echo "$library $version"
    done
    cat "$RECIPE/sources.lock"
    python3 - "$RECIPE" <<'PY'
import hashlib, pathlib, sys
recipe = pathlib.Path(sys.argv[1])
print('# Local build inputs (sha256)')
for path in [recipe.parent.parent / 'build_wasm_deps.sh',
             recipe / 'emscripten-cross.ini',
             recipe / 'glib-list-callbacks.patch']:
    print(path.name, hashlib.sha256(path.read_bytes()).hexdigest())
PY
} > "$PREFIX/webtilp-deps.txt.tmp"
mv "$PREFIX/webtilp-deps.txt.tmp" "$PREFIX/webtilp-deps.txt"
echo "Built WebTILP dependencies: $PREFIX"
