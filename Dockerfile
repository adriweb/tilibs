# syntax=docker/dockerfile:1.7
#
# Build WebTILP with the same dependency recipe and converter revisions as CI.
#   docker build -t webtilp .
#   docker run --rm -p 8080:80 webtilp
#   open http://localhost:8080/webtilp.html
#
# BUILD_PROFILE accepts dev (default) or prod; BUILD_SHA labels version.json.
ARG EMSDK_VERSION=6.0.9

FROM emscripten/emsdk:$EMSDK_VERSION AS base
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential git ca-certificates curl python3 cmake ninja-build \
        pkg-config gettext unzip xz-utils bzip2 \
    && rm -rf /var/lib/apt/lists/*

# The generated pkg-config files contain absolute paths. All consumer stages
# keep the install at /work/tilibs/wasm-deps.
FROM base AS deps
ARG MESON_VERSION=1.12.0
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3-venv patch \
    && python3 -m venv /opt/meson \
    && /opt/meson/bin/pip install --no-cache-dir "meson==$MESON_VERSION" \
    && rm -rf /var/lib/apt/lists/*
ENV PATH="/opt/meson/bin:$PATH"
WORKDIR /work/tilibs
COPY build_wasm_deps.sh ./
COPY deps/wasm ./deps/wasm
RUN ./build_wasm_deps.sh

# Build converters independently of the native dependencies. Both repositories
# track generated binaries, so clean them before compiling with this SDK.
FROM base AS tivars
ARG TIVARS_REF=865dd74a1abff0a8cb27a4cab1ca4267b0024e8d
WORKDIR /work/tivars_lib_cpp
RUN git init . \
    && git fetch --depth=1 https://github.com/adriweb/tivars_lib_cpp.git "$TIVARS_REF" \
    && git checkout --detach FETCH_HEAD \
    && make -f Makefile.emscripten clean \
    && make -f Makefile.emscripten wasm

FROM base AS luna
ARG LUNA_REF=a9924a9a968954eba9adcc161a58ac607f97ce8c
WORKDIR /work/Luna
RUN git init . \
    && git fetch --depth=1 https://github.com/ndless-nspire/Luna.git "$LUNA_REF" \
    && git checkout --detach FETCH_HEAD \
    && make -C emscripten clean \
    && make -C emscripten wasm

FROM base AS tilibs
WORKDIR /work/tilibs
COPY .cmake ./.cmake
COPY CMakeLists.txt build_wasm.sh ./
COPY libticables ./libticables
COPY libticalcs ./libticalcs
COPY libtifiles ./libtifiles
COPY libticonv ./libticonv
COPY hplp ./hplp
COPY --from=deps /work/tilibs/wasm-deps ./wasm-deps
RUN ./build_wasm.sh

FROM base AS webtilp-builder
ARG BUILD_PROFILE=dev
ARG BUILD_SHA=docker
ARG BUN_VERSION=1.4.2
WORKDIR /work/tilibs
COPY --from=deps /work/tilibs/wasm-deps ./wasm-deps
COPY --from=tilibs /work/tilibs/build-emscripten ./build-emscripten
COPY --from=tivars /work/tivars_lib_cpp /work/tivars_lib_cpp
COPY --from=luna /work/Luna /work/Luna
COPY libticables ./libticables
COPY libticalcs ./libticalcs
COPY libtifiles ./libtifiles
COPY libticonv ./libticonv
COPY hplp ./hplp
COPY webtilp ./webtilp

# Bun bundles the NumWorks backend in both profiles and minifies app.js in prod.
RUN case "$BUILD_PROFILE" in dev|prod) ;; *) echo "BUILD_PROFILE must be dev or prod" >&2; exit 1 ;; esac \
    && curl -fsSL https://bun.sh/install | bash -s "bun-v$BUN_VERSION" \
    && ln -s /root/.bun/bin/bun /usr/local/bin/bun

WORKDIR /work/tilibs/webtilp
RUN make "$BUILD_PROFILE" \
        TIVARS_DIR=/work/tivars_lib_cpp \
        LUNA_DIR=/work/Luna/emscripten \
        BUILD_SHA="$BUILD_SHA"

# Package the service worker's complete asset list, just like CI. Fail if a
# required asset is absent, and serve only this output rather than the source
# tree (which can contain local, untracked files).
RUN <<'EOF'
python3 - <<'PY'
import ast
from pathlib import Path
import re
import shutil

source = Path('.')
output = Path('/work/site')
precache = re.search(r'const PRECACHE_URLS = (\[.*?\]);', (source / 'sw.js').read_text(), re.S)
assets = set(ast.literal_eval(precache.group(1)))
assets.update(['sw.js', 'version.json', 'NUMWORKS.md'])
assets.update(str(p.relative_to(source)) for p in source.glob('i18n/*.json'))
assets.update(str(p.relative_to(source)) for p in source.glob('*.map'))
assets.update(str(p.relative_to(source)) for p in source.glob('third_party/**/LICENSE'))
assets.add('third_party/NUMWORKS-PROVENANCE.md')
for name in sorted(assets):
    destination = output / name
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source / name, destination)
shutil.copy2('../wasm-deps/webtilp-deps.txt', output / 'webtilp-deps.txt')
print(f'Packaged {len(assets)} site assets')
PY
EOF

FROM nginx:1.27-alpine AS runner
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=webtilp-builder /work/site /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1/version.json >/dev/null || exit 1
