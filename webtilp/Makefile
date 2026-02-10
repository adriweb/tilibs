# Makefile for webtilp (WASM build of tilibs)

# Tools
EMCC = em++

# Project structure
ROOT_DIR = ..
LIBTICABLES_DIR = $(ROOT_DIR)/libticables/trunk
LIBTICALCS_DIR  = $(ROOT_DIR)/libticalcs/trunk
LIBTIFILES_DIR  = $(ROOT_DIR)/libtifiles/trunk
LIBTICONV_DIR   = $(ROOT_DIR)/libticonv/trunk
LIBUSB_DIR      = $(ROOT_DIR)/libusb
LIBARCHIVE_DIR  = $(ROOT_DIR)/libarchive
GLIB_DIR        = $(ROOT_DIR)/glib-emscripten-built
BUILD_DIR       = $(ROOT_DIR)/build-emscripten

# Include paths
INCLUDES = \
	-I$(LIBTICABLES_DIR)/src \
	-I$(LIBTICALCS_DIR)/src \
	-I$(LIBTIFILES_DIR)/src \
	-I$(LIBTICONV_DIR)/src \
	-I$(LIBUSB_DIR)/libusb \
	-I$(LIBARCHIVE_DIR)/build-wasm/stage/include \
	-I$(GLIB_DIR)/include/glib-2.0 \
	-I$(GLIB_DIR)/lib/glib-2.0/include

# Libraries
LIBS = \
	$(BUILD_DIR)/libticalcs/trunk/libticalcs2.a \
	$(BUILD_DIR)/libtifiles/trunk/libtifiles2.a \
	$(BUILD_DIR)/libticables/trunk/libticables2.a \
	$(BUILD_DIR)/libticonv/trunk/libticonv.a \
	$(LIBUSB_DIR)/libusb/.libs/libusb-1.0.a \
	$(LIBARCHIVE_DIR)/build-wasm/stage/lib/libarchive.a \
	$(GLIB_DIR)/lib/libglib-2.0.a \
	$(GLIB_DIR)/lib/libz.a \
	$(GLIB_DIR)/lib/libpcre2-8.a

# Compiler flags
CXXFLAGS = -O3 -std=gnu++17 -flto -pthread

# Emscripten specific flags
EMCCFLAGS = \
	-s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","FS"]' \
	-s MODULARIZE=1 \
	-s EXPORT_NAME='TILibsModule' \
	-s ASYNCIFY=1 \
	-s ALLOW_MEMORY_GROWTH=1 \
	-s INITIAL_MEMORY=33554432 \
	-s STACK_SIZE=5242880 \
	-s PTHREAD_POOL_SIZE=4 \
	-s PROXY_TO_PTHREAD=1 \
	-s FORCE_FILESYSTEM=1 \
	-s INVOKE_RUN=0 \
	-s EXIT_RUNTIME=0 \
	--bind \
	--pre-js webtilp_prejs.js

# Targets
TARGET = webtilp.js
SRC = webtilp.cpp
PREJS = webtilp_prejs.js
PREJS_DEV = webtilp_prejs_dev.js
PREJS_PROD = webtilp_prejs_prod.js
APP_JS_SRC = app.js
APP_JS_BUNDLE = app.bundle.js

BUILD_SHA ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo "unknown")
BUILD_DATE ?= $(shell date -u +"%Y-%m-%d %H:%M UTC")

all: dev

dev: prepare_dev
	$(MAKE) $(TARGET)
	$(MAKE) stamp

prod: prepare_prod
	$(MAKE) $(TARGET)
	$(MAKE) stamp

prepare_dev:
	cp -a $(PREJS_DEV) $(PREJS)
	cp -a $(APP_JS_SRC) $(APP_JS_BUNDLE)

prepare_prod:
	cp -a $(PREJS_PROD) $(PREJS)
	bun build $(APP_JS_SRC) --outfile $(APP_JS_BUNDLE) --minify --sourcemap=linked

$(PREJS):
	cp -a $(PREJS_DEV) $(PREJS)

stamp:
	@BUILD_SHA="$(BUILD_SHA)" BUILD_DATE="$(BUILD_DATE)" python3 -c "import hashlib, json, os, pathlib; root=pathlib.Path('.'); files=['app.css','app.bundle.js','app.js','webtilp.html','webtilp.js','webtilp.wasm','webtilp_prejs.js','site.webmanifest','sw.js.in']; files += [str(p.relative_to(root)) for p in sorted((root/'i18n').glob('*.json'))] if (root/'i18n').exists() else []; h=hashlib.sha256(); [h.update((root/f).read_bytes()) for f in files if (root/f).exists()]; content_hash=h.hexdigest()[:12]; build_sha=os.environ.get('BUILD_SHA','unknown'); build_date=os.environ.get('BUILD_DATE','unknown'); build_id=f'{build_sha}-{content_hash}'; version={'buildId':build_id,'gitSha':build_sha,'buildDate':build_date,'contentHash':content_hash}; (root/'version.json').write_text(json.dumps(version, indent=2)+'\\n', encoding='utf-8'); sw_in=root/'sw.js.in'; sw_out=root/'sw.js'; sw_out.write_text(sw_in.read_text(encoding='utf-8').replace('__BUILD_ID__', build_id), encoding='utf-8') if sw_in.exists() else None"

$(TARGET): $(SRC) $(LIBS) $(PREJS)
	$(EMCC) $(CXXFLAGS) $(SRC) $(INCLUDES) $(LIBS) -o $(TARGET) $(EMCCFLAGS)

clean:
	rm -f $(TARGET) webtilp.wasm webtilp.worker.js sw.js version.json $(APP_JS_BUNDLE)

.PHONY: all dev prod prepare_dev prepare_prod clean stamp
