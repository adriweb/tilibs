# Makefile for webtilp (WASM build of tilibs)

# Tools
EMCC = em++

# Project structure
ROOT_DIR = ..
LIBTICABLES_DIR = $(ROOT_DIR)/libticables/trunk
LIBTICALCS_DIR  = $(ROOT_DIR)/libticalcs/trunk
LIBHPCALCS_DIR  = $(ROOT_DIR)/hplp/libhpcalcs
CAHUTE_DIR      = $(ROOT_DIR)/cahute
LIBTIFILES_DIR  = $(ROOT_DIR)/libtifiles/trunk
LIBTICONV_DIR   = $(ROOT_DIR)/libticonv/trunk
LIBUSB_DIR      = $(ROOT_DIR)/libusb
LIBARCHIVE_DIR  = $(ROOT_DIR)/libarchive
GLIB_DIR        = $(ROOT_DIR)/glib-emscripten-built
BUILD_DIR       = $(ROOT_DIR)/build-emscripten
WASM_DEPS_PREFIX ?= $(ROOT_DIR)/wasm-deps
TIVARS_DIR     ?= $(ROOT_DIR)/../tivars_lib_cpp
LUNA_DIR       ?= $(ROOT_DIR)/../Luna/emscripten

# Prefer the complete, pinned install produced by build_wasm_deps.sh.
# Keep the original checkout layout usable until that install is available.
ifneq ($(wildcard $(WASM_DEPS_PREFIX)/webtilp-deps.txt),)
GLIB_DIR = $(WASM_DEPS_PREFIX)
LIBUSB_INCLUDE_DIR = $(WASM_DEPS_PREFIX)/include/libusb-1.0
LIBUSB_ARCHIVE = $(WASM_DEPS_PREFIX)/lib/libusb-1.0.a
LIBARCHIVE_STAGE = $(WASM_DEPS_PREFIX)
else
LIBUSB_INCLUDE_DIR = $(LIBUSB_DIR)/libusb
LIBUSB_ARCHIVE = $(LIBUSB_DIR)/libusb/.libs/libusb-1.0.a
LIBARCHIVE_STAGE = $(LIBARCHIVE_DIR)/build-wasm/stage
endif

# Include paths
INCLUDES = \
	-I$(LIBTICABLES_DIR)/src \
	-I$(LIBTICALCS_DIR)/src \
	-I$(LIBHPCALCS_DIR)/src \
	-I$(CAHUTE_DIR)/include \
	-I$(BUILD_DIR)/cahute/include \
	-I$(LIBTIFILES_DIR)/src \
	-I$(LIBTICONV_DIR)/src \
	-I$(LIBUSB_INCLUDE_DIR) \
	-I$(LIBARCHIVE_STAGE)/include \
	-I$(GLIB_DIR)/include/glib-2.0 \
	-I$(GLIB_DIR)/lib/glib-2.0/include

# Libraries
LIBS = \
	$(BUILD_DIR)/libticalcs/trunk/libticalcs2.a \
	$(BUILD_DIR)/hplp/libhpcalcs/libhpcalcs.a \
	$(BUILD_DIR)/cahute/libcahute-static.a \
	$(BUILD_DIR)/libtifiles/trunk/libtifiles2.a \
	$(BUILD_DIR)/libticables/trunk/libticables2.a \
	$(BUILD_DIR)/libticonv/trunk/libticonv.a \
	$(LIBUSB_ARCHIVE) \
	$(LIBARCHIVE_STAGE)/lib/libarchive.a \
	$(GLIB_DIR)/lib/libglib-2.0.a \
	$(GLIB_DIR)/lib/libz.a

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
SRC = webtilp.cpp hp_prime_bridge.cpp hp_prime_app.cpp casio_bridge.cpp
PREJS = webtilp_prejs.js
PREJS_DEV = webtilp_prejs_dev.js
PREJS_PROD = webtilp_prejs_prod.js
APP_JS_SRC = app.js
APP_JS_BUNDLE = app.bundle.js
HP_LEGACY_JS_SRC = hp_legacy_backend.js
NUMWORKS_JS_SRC = numworks_backend.js
NUMWORKS_JS_ENTRY = numworks_backend_entry.mjs
NUMWORKS_JS_BUNDLE = numworks_backend.bundle.js
NUMWORKS_JS_MODULES = numworks_storage.js numworks_platform.js numworks_transport.js
NUMWORKS_JS_BANNER = /*! Bundles Upsilon.js 1.5.0 and WebDFU 1.0.5 under MIT; see third_party/NUMWORKS-PROVENANCE.md. */
BUILD_PROFILE_CSS = build-profile.css
PYTHON_CONVERTER_ASSETS = TIVarsLib.js TIVarsLib.wasm WebLuna.js WebLuna.wasm

BUILD_SHA ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo "unknown")
BUILD_DATE ?= $(shell date -u +"%Y-%m-%d %H:%M UTC")

all: dev

dev: prepare_dev
	$(MAKE) $(TARGET)
	$(MAKE) stamp

prod: prepare_prod
	$(MAKE) $(TARGET)
	$(MAKE) stamp

prepare_dev: prepare_python_converters
	cp -a $(PREJS_DEV) $(PREJS)
	cp -a $(APP_JS_SRC) $(APP_JS_BUNDLE)
	bun build $(NUMWORKS_JS_ENTRY) --outfile $(NUMWORKS_JS_BUNDLE) --format=iife --sourcemap=linked --banner='$(NUMWORKS_JS_BANNER)'
	printf "%s\n" ".brand-mark { background: linear-gradient(135deg, #ff8a8a, #ff3b3b); box-shadow: 0 10px 24px rgba(255, 59, 59, 0.25); } .brand-mark > span.brand-beta { font-size: 0; } .brand-mark > span.brand-beta::after { content: \"DEV\"; font-size: 8px; }" > $(BUILD_PROFILE_CSS)

prepare_prod: prepare_python_converters
	cp -a $(PREJS_PROD) $(PREJS)
	bun build $(APP_JS_SRC) --outfile $(APP_JS_BUNDLE) --minify --sourcemap=linked
	bun build $(NUMWORKS_JS_ENTRY) --outfile $(NUMWORKS_JS_BUNDLE) --format=iife --minify --sourcemap=linked --banner='$(NUMWORKS_JS_BANNER)'
	printf "%s\n" "/* prod build profile */" > $(BUILD_PROFILE_CSS)

prepare_python_converters:
	$(MAKE) -C $(TIVARS_DIR) -f Makefile.emscripten wasm
	$(MAKE) -C $(LUNA_DIR) wasm
	cp -a $(TIVARS_DIR)/TIVarsLib.js $(TIVARS_DIR)/TIVarsLib.wasm .
	cp -a $(LUNA_DIR)/WebLuna.js $(LUNA_DIR)/WebLuna.wasm .

$(PREJS):
	cp -a $(PREJS_DEV) $(PREJS)

stamp:
	@BUILD_SHA="$(BUILD_SHA)" BUILD_DATE="$(BUILD_DATE)" python3 -c "import hashlib, json, os, pathlib; root=pathlib.Path('.'); files=['app.css','build-profile.css','app.bundle.js','app.js','numworks_backend.bundle.js','numworks_backend.js','hp_legacy_backend.js','highlighter.min.js','webtilp.html','webtilp.js','webtilp.wasm','webtilp_prejs.js','TIVarsLib.js','TIVarsLib.wasm','WebLuna.js','WebLuna.wasm','site.webmanifest','sw.js.in']; files += [str(p.relative_to(root)) for p in sorted((root/'i18n').glob('*.json'))] if (root/'i18n').exists() else []; h=hashlib.sha256(); [h.update((root/f).read_bytes()) for f in files if (root/f).exists()]; content_hash=h.hexdigest()[:12]; build_sha=os.environ.get('BUILD_SHA','unknown'); build_date=os.environ.get('BUILD_DATE','unknown'); build_id=f'{build_sha}-{content_hash}'; version={'buildId':build_id,'gitSha':build_sha,'buildDate':build_date,'contentHash':content_hash}; (root/'version.json').write_text(json.dumps(version, indent=2)+'\\n', encoding='utf-8'); sw_in=root/'sw.js.in'; sw_out=root/'sw.js'; sw_out.write_text(sw_in.read_text(encoding='utf-8').replace('__BUILD_ID__', build_id), encoding='utf-8') if sw_in.exists() else None"

test:
	$(CXX) -std=c++17 -Wall -Wextra -Werror hp_prime_app.cpp tests/test_hp_prime_app.cpp -o tests/test_hp_prime_app
	./tests/test_hp_prime_app
	rm -f tests/test_hp_prime_app
	node --check < sw.js.in
	node tests/test_service_worker.js
	node --check $(APP_JS_SRC)
	node --check $(HP_LEGACY_JS_SRC)
	node --check tests/hp_legacy_frontend_harness.js
	node --check $(NUMWORKS_JS_SRC)
	@for file in $(NUMWORKS_JS_MODULES); do node --check $$file || exit 1; done
	node --check $(NUMWORKS_JS_ENTRY)
	node tests/test_hp_prime_frontend.js
	node tests/test_numworks_backend.js
	node tests/test_numworks_frontend.js
	node tests/test_casio_frontend.js
	node tests/test_hp_legacy_backend.js
	node tests/test_hp_legacy_frontend.js
	python3 i18n/check.py

$(TARGET): $(SRC) $(LIBS) $(PREJS)
	$(EMCC) $(CXXFLAGS) $(SRC) $(INCLUDES) $(LIBS) -o $(TARGET) $(EMCCFLAGS)

clean:
	rm -f $(TARGET) webtilp.wasm webtilp.worker.js sw.js version.json $(APP_JS_BUNDLE) $(NUMWORKS_JS_BUNDLE) $(BUILD_PROFILE_CSS) $(PYTHON_CONVERTER_ASSETS)

.PHONY: all dev prod prepare_dev prepare_prod prepare_python_converters test clean stamp
