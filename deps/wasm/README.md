# WebTILP WASM dependencies

Build the pinned dependencies, then rebuild tilibs and WebTILP:

```sh
./build_wasm_deps.sh
./deps/wasm/test.sh
./build_wasm.sh
./deps/wasm/test-tilibs.sh
source "$HOME/emsdk/emsdk_env.sh"
make -C webtilp dev
make -C webtilp test
node webtilp/tests/test_wasm_startup.cjs
```

The dependency builder needs Emscripten, Meson >= 1.4, Ninja, CMake, Make,
pkg-config, Python 3, curl, tar, and patch. It uses an already activated SDK,
or sources `${EMSDK:-$HOME/emsdk}/emsdk_env.sh`. CI uses Emscripten 6.0.9;
the exact compiler version is recorded in the install manifest. Rebuild the
dependencies and tilibs when updating the SDK so old compiler outputs are
not reused.

| Dependency | Version | Purpose |
| --- | --- | --- |
| GLib | 2.88.3 + wasm-vips patches | Shared utility library |
| zlib | 1.3.2 | Compressed calculator payloads and ZIP files |
| libusb | 1.0.30 (unpatched upstream) | Browser USB transport |
| libarchive | 3.8.9 | ZIP/group/backup file handling |
| libffi | 3.8.0 | GLib's GObject build dependency; not linked into WebTILP |

`sources.lock` pins download URLs and SHA-256 hashes. Sources and build logs
are kept under `build-wasm-deps/`, and installed files go to `wasm-deps/`.
These directories are ignored by Git. A `webtilp-deps.txt` manifest is written
only after all dependencies build successfully. Both consumer build commands
prefer an install with that manifest, otherwise retaining the original
`glib-emscripten-built/`, `libusb/`, and `libarchive/build-wasm/stage/` layout.

Set `WASM_DEPS_PREFIX` to an absolute path to build and use another install.
Pass it to Make as well, for example
`make -C webtilp WASM_DEPS_PREFIX=/absolute/path dev`.
Completed installs are immutable to keep the previous libraries available
while trying another version. Rebuild tilibs when changing the dependency
prefix.

## Patches and compatibility

- GLib uses Kleis Auke Wolthuizen's ten `wasm-vips-2.88.1` patches, pinned to
  commit `1afd0d285774f342e0aadcda5cc2c2721d47506c`. They apply to 2.88.3.
  This follows [the original recipe](https://gist.github.com/kleisauke/acfa1c09522705efa5eb0541d2d00887)
  and [Adriweb's earlier recipe](https://gist.github.com/adriweb/af7430340be5b29a7c7fca50f01d9493).
  GLib's source archive includes its pinned GVDB subproject; Meson downloads
  are disabled. The patch set removes GRegex, so PCRE2 is neither built nor linked.
- `glib-list-callbacks.patch` removes incompatible callback casts from
  `g_list_free_full` and `g_slist_free_full`. Destructors are called directly
  with their declared one-argument signature, as required by WASM.
- libusb is built from the unmodified upstream release. The UniTI-specific
  explicit-device registry patch from the old local checkout is not used by
  WebTILP or applied by this recipe. The old checkout remains untouched.
- libusb's C configure probes enable Embind, which needs the C++ runtime.
  The recipe and C dependency smoke test explicitly select
  `-sDEFAULT_TO_CXX=1`; Emscripten 6.0.6 stopped linking that runtime implicitly
  through `emcc`. WebTILP and the Evo test already link through `em++`.
- libarchive 3.8.9 is a stable replacement for the former May 2026 development
  snapshot (`1546fbff`, which reported 3.9.0). This is a change to the stable
  release line, not a numerical version increase. Optional compression,
  crypto, XML and PCRE libraries and command-line tools are disabled; zlib
  remains enabled for ZIP/deflate support.
- All libraries are static WASM builds with pthread support. WebTILP retains
  its existing Asyncify and worker-pool settings. CMake consumers use the same
  installed zlib as the final WebTILP link, with the SDK port retained as a
  fallback for standalone configurations without an external zlib install.

`test.sh` executes a Node/WASM smoke test of runtime/header versions, GLib
Unicode conversion, threading and list destructors, zlib compression, and ZIP writing/reading.
It does not access USB devices. Real browser/hardware transfer testing is
still needed when qualifying a release.

`webtilp/tests/test_wasm_startup.cjs` checks the built WebTILP module's
initialization and MEMFS. It accepts an optional path to another `webtilp.js`.
`test-tilibs.sh` runs the existing Evo file tests in WASM.
`evo-files-smoke.cpp` wraps their registration with correctly typed
GTest fixture callbacks: the upstream `g_test_add_func` callback cast is not
valid under WASM's strict function signatures.

The HP WebHID mock regression can also run without a connected calculator:

```sh
cmake --build build-emscripten --target hpcalcs_webhid_mock_test
node build-emscripten/hplp/libhpcalcs/hpcalcs_webhid_mock_test.js
```

## GitHub Actions integration

[`build.webtilp.workflow.yml`](../../.github/workflows/build.webtilp.workflow.yml)
builds the production site on Ubuntu 24.04 for pushes, pull requests, and
manual dispatch. It installs Emscripten 6.0.9, Meson 1.12.0, Node 24.19.0,
and Bun 1.4.2, and checks out pinned TIVarsLib and Luna revisions below
`build-wasm-deps/`. No sibling checkouts or prebuilt local libraries are needed.
The converter outputs are cleaned before building because their repositories
track generated binaries.

The dependency cache key includes the platform, tool versions, recipe,
patches, source lock, and workflow. An exact cache hit skips the dependency
builder; tests and consumer builds still run. There are no partial restores.

The job runs dependency, Evo file, HP WebHID mock, frontend, and module-startup
tests, then uploads `webtilp-<commit>` with the service worker's required site
assets, every translation, third-party notices, `webtilp-deps.txt`, and a
`build-sources.json` recording source revisions and tool versions. Packaging
fails if any precached asset is missing. The workflow builds an artifact;
it does not deploy it. Hosting must provide the cross-origin isolation
headers needed by the pthread build: `Cross-Origin-Opener-Policy: same-origin`
and `Cross-Origin-Embedder-Policy: require-corp`.

The dependency recipe and production commands have been validated locally
with Emscripten 6.0.9, Node 24.19.0, and Bun 1.4.2. Execution on a GitHub runner
remains to be verified after the workflow is pushed.
