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

# You'll have to adjust the libusb .pc file with something like this:
#
#   prefix=/path/to/libusb/libusb
#   exec_prefix=${prefix}
#   libdir=${exec_prefix}/.libs
#   includedir=${prefix}
#
#   Name: libusb-1.0
#   Description: C API for USB device access from Linux, Mac OS X, Windows, OpenBSD/NetBSD and Solaris userspace
#   Version: 1.0.29
#   Libs: -L${libdir} -lusb-1.0
#   Libs.private:  --bind -s ASYNCIFY
#   Cflags: -I${includedir}/

# step 4 : run this file


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
export PKG_CONFIG_PATH="$SCRIPT_DIR/libusb:${PKG_CONFIG_PATH}"

# Path to pre-built Emscripten libraries
GLIB_EMSCRIPTEN="$SCRIPT_DIR/glib-emscripten-built"
if [ -d "$GLIB_EMSCRIPTEN" ]; then
    echo -e "${GREEN}Found glib-emscripten-built at: $GLIB_EMSCRIPTEN${NC}"
    export PKG_CONFIG_PATH="$GLIB_EMSCRIPTEN/lib/pkgconfig:${PKG_CONFIG_PATH}"
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
if [ -d "$GLIB_EMSCRIPTEN" ]; then
    echo -e "${GREEN}Found libarchive-emscripten-built at: $LIBARCHIVE_EMSCRIPTEN${NC}"
    export PKG_CONFIG_PATH="$LIBARCHIVE_EMSCRIPTEN/lib/pkgconfig:${PKG_CONFIG_PATH}"
    # Also set CMAKE_PREFIX_PATH for find_package
    export CMAKE_PREFIX_PATH="$LIBARCHIVE_EMSCRIPTEN:${CMAKE_PREFIX_PATH}"
else
    echo -e "${RED}Error: libarchive-emscripten-built not found${NC}"
    echo -e "Expected location: $LIBARCHIVE_EMSCRIPTEN"
    echo -e "Please build libarchive for Emscripten first"
    exit 1
fi

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
emmake make -j$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)

if [ $? -ne 0 ]; then
    echo -e "${RED}Build failed!${NC}"
    exit 1
fi

echo ""
echo -e "${GREEN}Static libraries built successfully!${NC}"
echo ""

exit 0