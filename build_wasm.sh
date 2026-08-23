#!/bin/bash
# Build script for the tilibs WebAssembly module using existing CMakeLists.txt

# step 0 : get emscripten

# step 1 : get the emscripten glib build
# https://gist.github.com/adriweb/af7430340be5b29a7c7fca50f01d9493

# step 2 : build libusb for wasm with webusb:
# CFLAGS="-O3 -pthread" CXXFLAGS="-O3 -pthread" CPPFLAGS="-O3 -pthread" LDFLAGS="-pthread" emconfigure ./configure --host=wasm32-emscripten --enable-static --disable-shared
# CFLAGS="-O3 -pthread" CXXFLAGS="-O3 -pthread" CPPFLAGS="-O3 -pthread" LDFLAGS="-pthread" emmake make -j

# step 3 : build minimal LibArchive for wasm
# mkdir build-wasm && cd build-wasm
# emcmake cmake .. -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$PWD/stage" -DBUILD_SHARED_LIBS=OFF -DENABLE_TEST=OFF -DENABLE_TAR=OFF -DENABLE_CPIO=OFF -DENABLE_CAT=OFF -DENABLE_ACL=OFF -DENABLE_XATTR=OFF -DENABLE_ICONV=OFF -DENABLE_OPENSSL=OFF -DENABLE_NETTLE=OFF -DENABLE_LIBB2=OFF -DENABLE_LZ4=OFF -DENABLE_ZSTD=OFF -DENABLE_LZMA=OFF -DENABLE_BZip2=OFF -DENABLE_EXPAT=OFF
# emmake make -j8 install && emmake make install

# The generated libusb .pc file normally contains its configure-time prefix
# (often /usr/local). This script creates a temporary pkg-config override with
# the actual checkout paths so CMake cannot accidentally select host libusb.

# step 4 : run this file

# step 5 : webtilp/makefile


###### Note

# You may want to use something like this for a main "bridge":
#
# int main(int argc, char **argv)
# {
#     (void)argc;
#     (void)argv;
#
#     g_setenv("G_MESSAGES_DEBUG", "all", TRUE);
#
#     printf("Testing libs init()...\n");
#     int result = ticables_library_init();
#     printf("ticables_library_init: %d\n", result);
#     result = tifiles_library_init();
#     printf("tifiles_library_init: %d\n", result);
#     result = ticalcs_library_init();
#     printf("ticalcs_library_init: %d\n", result);
#
#     printf("ticonv version: %s\n", ticonv_version_get());
#     printf("ticables version: %s\n", ticables_version_get());
#     printf("tifiles version: %s\n", tifiles_version_get());
#     printf("ticalcs version: %s\n", ticalcs_version_get());
#
#     return 0;
# }

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== TiLibs WebAssembly Build Script ===${NC}"

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Check if Emscripten is sourced
if ! command -v emcc &> /dev/null; then
    echo -e "${YELLOW}Emscripten not found. Sourcing emsdk...${NC}"
    if [ -f "$HOME/emsdk/emsdk_env.sh" ]; then
        source "$HOME/emsdk/emsdk_env.sh"
    else
        echo -e "${RED}Error: Emscripten SDK not found at $HOME/emsdk${NC}"
        echo "Please install Emscripten first or source the emsdk_env.sh manually"
        exit 1
    fi
fi

echo -e "${GREEN}Using Emscripten: $(emcc --version | head -n1)${NC}"

# Set up PKG_CONFIG_PATH for emscripten-ready libraries
echo -e "${BLUE}Setting up library paths...${NC}"

LIBUSB_ROOT="$SCRIPT_DIR/libusb"
LIBUSB_SOURCE="$LIBUSB_ROOT/libusb"
LIBUSB_PC_SOURCE="$LIBUSB_ROOT/libusb-1.0.pc"
LIBUSB_ARCHIVE="$LIBUSB_SOURCE/.libs/libusb-1.0.a"

if [ ! -f "$LIBUSB_PC_SOURCE" ] || [ ! -f "$LIBUSB_ARCHIVE" ] || [ ! -f "$LIBUSB_SOURCE/libusb.h" ]; then
    echo -e "${RED}Error: Emscripten libusb build artifacts are missing${NC}"
    echo -e "Expected pkg-config file: $LIBUSB_PC_SOURCE"
    echo -e "Expected archive: $LIBUSB_ARCHIVE"
    echo -e "Build libusb with emconfigure/emmake as described at the top of this script."
    exit 1
fi

LIBUSB_VERSION="$(sed -n 's/^Version:[[:space:]]*//p' "$LIBUSB_PC_SOURCE" | head -n1)"
if [ -z "$LIBUSB_VERSION" ]; then
    echo -e "${RED}Error: could not determine the libusb version from $LIBUSB_PC_SOURCE${NC}"
    exit 1
fi

PKG_CONFIG_OVERRIDE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/tilibs-wasm-pkgconfig.XXXXXX")"
cleanup_pkg_config_override() {
    rm -rf "$PKG_CONFIG_OVERRIDE_DIR"
}
trap cleanup_pkg_config_override EXIT

cat > "$PKG_CONFIG_OVERRIDE_DIR/libusb-1.0.pc" <<EOF
prefix=$LIBUSB_SOURCE
exec_prefix=\${prefix}
libdir=\${exec_prefix}/.libs
includedir=\${prefix}

Name: libusb-1.0
Description: C API for USB device access from Linux, Mac OS X, Windows, OpenBSD/NetBSD and Solaris userspace
Version: $LIBUSB_VERSION
Libs: -L\${libdir} -lusb-1.0
Libs.private: --bind -s ASYNCIFY
Cflags: -I\${includedir}/
EOF

# Path to pre-built Emscripten libraries
GLIB_EMSCRIPTEN="$SCRIPT_DIR/glib-emscripten-built"
if [ -d "$GLIB_EMSCRIPTEN" ]; then
    echo -e "${GREEN}Found glib-emscripten-built at: $GLIB_EMSCRIPTEN${NC}"
    # Also set CMAKE_PREFIX_PATH for find_package
    export CMAKE_PREFIX_PATH="$GLIB_EMSCRIPTEN:${CMAKE_PREFIX_PATH}"
else
    echo -e "${RED}Error: glib-emscripten-built not found${NC}"
    echo -e "Expected location: $GLIB_EMSCRIPTEN"
    echo -e "Please build glib for Emscripten first"
    exit 1
fi

# Path to pre-built LibArchive
LIBARCHIVE_EMSCRIPTEN="$SCRIPT_DIR/libarchive/build-wasm/stage"
if [ -d "$LIBARCHIVE_EMSCRIPTEN" ]; then
    echo -e "${GREEN}Found libarchive-emscripten-built at: $LIBARCHIVE_EMSCRIPTEN${NC}"
    # Also set CMAKE_PREFIX_PATH for find_package
    export CMAKE_PREFIX_PATH="$LIBARCHIVE_EMSCRIPTEN:${CMAKE_PREFIX_PATH}"
else
    echo -e "${RED}Error: libarchive-emscripten-built not found${NC}"
    echo -e "Expected location: $LIBARCHIVE_EMSCRIPTEN"
    echo -e "Please build libarchive for Emscripten first"
    exit 1
fi

export PKG_CONFIG_PATH="$PKG_CONFIG_OVERRIDE_DIR:$GLIB_EMSCRIPTEN/lib/pkgconfig:$LIBARCHIVE_EMSCRIPTEN/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"

RESOLVED_LIBUSB_PREFIX="$(pkg-config --variable=prefix libusb-1.0)"
if [ "$RESOLVED_LIBUSB_PREFIX" != "$LIBUSB_SOURCE" ]; then
    echo -e "${RED}Error: pkg-config resolved the wrong libusb build${NC}"
    echo -e "Expected: $LIBUSB_SOURCE"
    echo -e "Resolved: $RESOLVED_LIBUSB_PREFIX"
    exit 1
fi

echo -e "${GREEN}Using Emscripten libusb $LIBUSB_VERSION at: $RESOLVED_LIBUSB_PREFIX${NC}"
echo -e "${BLUE}PKG_CONFIG_PATH=$PKG_CONFIG_PATH${NC}"

# Create build directory
BUILD_DIR="build-emscripten"
if [ -d "$BUILD_DIR" ]; then
    echo -e "${YELLOW}Removing existing build directory...${NC}"
    rm -rf "$BUILD_DIR"
fi

mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

echo -e "${GREEN}Configuring build with emcmake...${NC}"
echo -e "${BLUE}Configuration:${NC}"
echo -e "  Build Type: Release"
echo -e "  Shared Libs: OFF (static only for WASM)"
echo -e "  Tests: OFF"
echo -e "  WebUSB: Enabled"
echo ""

# Configure with CMake
emcmake cmake .. \
    -GNinja \
    -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_SHARED_LIBS=OFF \
    -DBUILD_TESTS=OFF \
    -DBUILD_TIFILEUTIL=OFF \
    -DCMAKE_C_FLAGS="-pthread" \
    -DCMAKE_CXX_FLAGS="-pthread"

if [ $? -ne 0 ]; then
    echo -e "${RED}CMake configuration failed!${NC}"
    exit 1
fi

echo ""
echo -e "${GREEN}Building static libraries...${NC}"
cmake --build .

if [ $? -ne 0 ]; then
    echo -e "${RED}Build failed!${NC}"
    exit 1
fi

echo ""
echo -e "${GREEN}Static libraries built successfully!${NC}"
echo ""

exit 0
