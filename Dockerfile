# syntax=docker/dockerfile:1.7
#
# Multi-stage build for WebTILP (the Emscripten/WASM build of tilibs).
# See build_wasm.sh and webtilp/Makefile for the reference (non-container)
# build this mirrors.
#
#   docker build -t webtilp .
#   docker run --rm -p 8080:80 webtilp
#   open http://localhost:8080/webtilp.html
#
# Build args:
#   EMSDK_VERSION  - Emscripten SDK version (default 4.0.15)
#   BUILD_PROFILE  - "dev" (default, no bundler needed) or "prod" (minifies
#                    app.js via bun; slower build, smaller payload)
#   BUILD_SHA      - stamped into version.json (default "docker")

ARG EMSDK_VERSION=4.0.15

########################################################################
# base: shared toolchain image the independent builder stages fan out from
########################################################################
FROM emscripten/emsdk:${EMSDK_VERSION} AS base
RUN apt-get update && apt-get install -y --no-install-recommends \
        git ca-certificates curl python3 \
    && rm -rf /var/lib/apt/lists/*

########################################################################
# deps: glib (+ zlib + libffi), libusb (WebUSB), libarchive - the native
# dependencies tilibs itself is compiled against. This is the slow stage;
# it builds independently of the tivars/luna converters below so BuildKit
# runs them concurrently.
########################################################################
FROM base AS deps
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential pkg-config ninja-build cmake autoconf automake \
        libtool gettext patch python3-pip \
    && (pip3 install --break-system-packages meson || pip3 install meson) \
    && rm -rf /var/lib/apt/lists/*

# Built at the same absolute path ("/work/tilibs/...") that later stages
# COPY it to, since the .pc files generated below bake in absolute prefixes
# and are not relocatable.
WORKDIR /work/tilibs
RUN git clone --depth 1 https://github.com/adriweb/libusb.git libusb \
 && git clone --depth 1 https://github.com/libarchive/libarchive.git libarchive

ENV GLIB_TARGET=/work/tilibs/glib-emscripten-built
RUN <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$GLIB_TARGET" /tmp/glib-deps

cat > /tmp/emscripten-cross.ini <<'INI'
[binaries]
c = 'emcc'
cpp = 'em++'
ar = 'emar'
ranlib = 'emranlib'
pkg-config = ['pkg-config', '--static']
exe_wrapper = 'node'

[properties]
needs_exe_wrapper = true

[built-in options]
c_thread_count = 0
cpp_thread_count = 0

[host_machine]
system = 'emscripten'
cpu_family = 'wasm32'
cpu = 'wasm32'
endian = 'little'
INI

export CFLAGS="-O3"
export CXXFLAGS="$CFLAGS"
export LDFLAGS="-L$GLIB_TARGET/lib -O3"
export CPATH="$GLIB_TARGET/include"
export PKG_CONFIG_PATH="$GLIB_TARGET/lib/pkgconfig"
export EM_PKG_CONFIG_PATH="$PKG_CONFIG_PATH"
export CHOST="wasm32-unknown-linux"
export MESON_ARGS="--cross-file=/tmp/emscripten-cross.ini"
export MAKEFLAGS="-j$(nproc)"
export PKG_CONFIG="pkg-config --static"

VERSION_ZLIB=1.3.1
VERSION_FFI=3.5.2
VERSION_GLIB=2.86.0

# --- zlib ---
mkdir -p /tmp/glib-deps/zlib
curl -Ls "https://github.com/madler/zlib/releases/download/v$VERSION_ZLIB/zlib-$VERSION_ZLIB.tar.xz" | tar xJC /tmp/glib-deps/zlib --strip-components=1
(cd /tmp/glib-deps/zlib && emconfigure ./configure --prefix="$GLIB_TARGET" --static && make install)

# --- libffi ---
mkdir -p /tmp/glib-deps/ffi
curl -Ls "https://github.com/libffi/libffi/releases/download/v$VERSION_FFI/libffi-$VERSION_FFI.tar.gz" | tar xzC /tmp/glib-deps/ffi --strip-components=1
(cd /tmp/glib-deps/ffi && \
    sed -i 's/ -fexceptions//g' configure && \
    emconfigure ./configure --host="$CHOST" --prefix="$GLIB_TARGET" --enable-static --disable-shared --disable-dependency-tracking \
        --disable-builddir --disable-multi-os-directory --disable-raw-api --disable-structs --disable-docs && \
    make install)

# --- glib (cross-compiled via meson, per https://gist.github.com/adriweb/af7430340be5b29a7c7fca50f01d9493) ---
mkdir -p /tmp/glib-deps/glib
curl -Ls "https://download.gnome.org/sources/glib/2.86/glib-$VERSION_GLIB.tar.xz" | tar xJC /tmp/glib-deps/glib --strip-components=1
(cd /tmp/glib-deps/glib && \
    curl -Ls "https://github.com/GNOME/glib/compare/$VERSION_GLIB...kleisauke:wasm-vips-$VERSION_GLIB.patch" | patch -p1 && \
    CFLAGS="$CFLAGS -pthread" meson setup _build --prefix="$GLIB_TARGET" $MESON_ARGS --default-library=static --buildtype=release \
        --force-fallback-for=pcre2,gvdb -Dintrospection=disabled -Dselinux=disabled -Dxattr=false -Dlibmount=disabled -Dsysprof=disabled -Dnls=disabled \
        -Dglib_debug=disabled -Dtests=false -Dglib_assert=false -Dglib_checks=false && \
    meson install -C _build --tag devel)

# glib >= 2.74 compiles PCRE2 directly into libglib-2.0.a instead of emitting
# a standalone archive, but tilibs' Makefile still links against
# libpcre2-8.a explicitly (and nothing in tilibs actually uses GRegex) - an
# empty archive satisfies that link input without pulling in real pcre2.
emar rcs "$GLIB_TARGET/lib/libpcre2-8.a"
EOF

RUN <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cd /work/tilibs/libusb
./bootstrap.sh
CFLAGS="-O3 -pthread" CXXFLAGS="-O3 -pthread" CPPFLAGS="-O3 -pthread" LDFLAGS="-pthread" \
    emconfigure ./configure --host=wasm32-emscripten --enable-static --disable-shared
CFLAGS="-O3 -pthread" CXXFLAGS="-O3 -pthread" CPPFLAGS="-O3 -pthread" LDFLAGS="-pthread" \
    emmake make -j"$(nproc)"

# webtilp/Makefile expects a libusb-1.0.pc next to this checkout so
# pkg-config can resolve the just-built static archive (see build_wasm.sh).
cat > libusb-1.0.pc <<PC
prefix=/work/tilibs/libusb/libusb
exec_prefix=\${prefix}
libdir=\${exec_prefix}/.libs
includedir=\${prefix}

Name: libusb-1.0
Description: C API for USB device access from Linux, Mac OS X, Windows, OpenBSD/NetBSD and Solaris userspace
Version: 1.0.29
Libs: -L\${libdir} -lusb-1.0
Libs.private:  --bind -s ASYNCIFY
Cflags: -I\${includedir}/
PC
EOF

RUN <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
mkdir -p /work/tilibs/libarchive/build-wasm
cd /work/tilibs/libarchive/build-wasm
emcmake cmake .. -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$PWD/stage" -DBUILD_SHARED_LIBS=OFF \
    -DENABLE_TEST=OFF -DENABLE_TAR=OFF -DENABLE_CPIO=OFF -DENABLE_CAT=OFF -DENABLE_ACL=OFF -DENABLE_XATTR=OFF \
    -DENABLE_ICONV=OFF -DENABLE_OPENSSL=OFF -DENABLE_NETTLE=OFF -DENABLE_LIBB2=OFF -DENABLE_LZ4=OFF \
    -DENABLE_ZSTD=OFF -DENABLE_LZMA=OFF -DENABLE_BZip2=OFF -DENABLE_EXPAT=OFF
emmake make -j"$(nproc)" install
EOF

########################################################################
# tivars: TIVarsLib.js/.wasm (Python-file <-> calculator-format converter),
# vendored from the adriweb/tivars_lib_cpp fork per webtilp/Makefile.
# Independent of `deps`, so it builds concurrently with it.
########################################################################
FROM base AS tivars
RUN git clone --depth 1 https://github.com/adriweb/tivars_lib_cpp.git /work/tivars_lib_cpp
WORKDIR /work/tivars_lib_cpp
RUN make -f Makefile.emscripten wasm

########################################################################
# luna: WebLuna.js/.wasm (legacy .8xp/.tns conversion), vendored from the
# adriweb/Luna fork per webtilp/Makefile. Also independent of `deps`.
########################################################################
FROM base AS luna
RUN git clone --depth 1 https://github.com/adriweb/Luna.git /work/Luna
WORKDIR /work/Luna/emscripten
RUN make wasm

########################################################################
# tilibs: the four static libs (ticonv/tifiles/ticables/ticalcs), built
# against `deps`' glib/libusb/libarchive.
########################################################################
FROM base AS tilibs
RUN apt-get update && apt-get install -y --no-install-recommends \
        cmake ninja-build pkg-config gettext \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /work/tilibs
COPY .cmake ./.cmake
COPY CMakeLists.txt ./
COPY libticables ./libticables
COPY libticalcs ./libticalcs
COPY libtifiles ./libtifiles
COPY libticonv ./libticonv
COPY hplp ./hplp
COPY --from=deps /work/tilibs/glib-emscripten-built ./glib-emscripten-built
COPY --from=deps /work/tilibs/libusb ./libusb
COPY --from=deps /work/tilibs/libarchive ./libarchive

RUN <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
mkdir -p build-emscripten
cd build-emscripten
export PKG_CONFIG_PATH=/work/tilibs/libusb
export CMAKE_PREFIX_PATH=/work/tilibs/glib-emscripten-built:/work/tilibs/libarchive/build-wasm/stage
emcmake cmake .. -GNinja \
    -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_SHARED_LIBS=OFF \
    -DBUILD_TESTS=OFF \
    -DBUILD_TIFILEUTIL=OFF \
    -DCMAKE_C_FLAGS=-pthread \
    -DCMAKE_CXX_FLAGS=-pthread
cmake --build .
EOF

########################################################################
# webtilp-builder: final em++ link + web asset prep (app.bundle.js,
# build-profile.css, version.json, sw.js), i.e. `make dev`/`make prod`.
########################################################################
FROM base AS webtilp-builder
ARG BUILD_PROFILE=dev
ARG BUILD_SHA=docker

WORKDIR /work/tilibs
COPY --from=deps /work/tilibs/glib-emscripten-built ./glib-emscripten-built
COPY --from=deps /work/tilibs/libusb ./libusb
COPY --from=deps /work/tilibs/libarchive ./libarchive
COPY --from=tilibs /work/tilibs/build-emscripten ./build-emscripten
COPY --from=tivars /work/tivars_lib_cpp ./tivars_lib_cpp_src
COPY --from=luna /work/Luna ./Luna_src
COPY libticables ./libticables
COPY libticalcs ./libticalcs
COPY libtifiles ./libtifiles
COPY libticonv ./libticonv
COPY hplp ./hplp
COPY webtilp ./webtilp

# bun bundles the NumWorks backend (numworks_backend.bundle.js) for both
# profiles, and additionally minifies app.js for "prod".
RUN curl -fsSL https://bun.sh/install | bash && \
    ln -s /root/.bun/bin/bun /usr/local/bin/bun

WORKDIR /work/tilibs/webtilp
RUN make "$BUILD_PROFILE" \
        TIVARS_DIR=/work/tilibs/tivars_lib_cpp_src \
        LUNA_DIR=/work/tilibs/Luna_src/emscripten \
        BUILD_SHA="$BUILD_SHA"

# Drop build-only files that shouldn't be served at runtime. third_party/
# and NUMWORKS.md are kept: the bundle's license banner points readers at
# third_party/NUMWORKS-PROVENANCE.md, so it needs to still resolve.
RUN rm -f webtilp.cpp hp_prime_bridge.cpp hp_prime_app.cpp hp_prime_app.h \
        Makefile .htaccess sw.js.in \
        webtilp_prejs.js webtilp_prejs_dev.js webtilp_prejs_prod.js \
        webtilp.png webtilp_medium.png webtilp_noshadow.png \
        numworks_backend.js numworks_backend_entry.mjs \
        numworks_storage.js numworks_platform.js numworks_transport.js \
        i18n/check.py \
    && rm -rf tests

########################################################################
# runner: nginx serving the built app with the COOP/COEP headers the wasm
# module's pthreads (SharedArrayBuffer) require.
########################################################################
FROM nginx:1.27-alpine AS runner
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=webtilp-builder /work/tilibs/webtilp /usr/share/nginx/html

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1/version.json >/dev/null || exit 1
