# Bundled dependency licenses

The desktop package stages the repository's original `COPYING` files for
libticables, libticalcs, libticonv, libtifiles and libhpcalcs, and the vendored
Upsilon.js, WebDFU and Feather license texts.
The additional license texts in this directory were copied verbatim from:

| Dependency | License source |
| --- | --- |
| GLib 2.88.3 | `glib-2.88.3/LICENSES/*.txt` from the archive pinned in `deps/wasm/sources.lock` |
| libusb 1.0.30 | `libusb-1.0.30/COPYING` from the same lock file |
| libarchive 3.8.9 | `libarchive-3.8.9/COPYING` from the same lock file |
| zlib 1.3.2 | `zlib-1.3.2/LICENSE` from the same lock file |
| TIVarsLib | [adriweb/tivars_lib_cpp/LICENSE](https://github.com/adriweb/tivars_lib_cpp/blob/master/LICENSE) |
| Luna | [ndless-nspire/Luna/LICENSE](https://github.com/ndless-nspire/Luna/blob/master/LICENSE) |

Keep these texts in sync when updating the pinned dependencies or converters.
GLib's complete license directory is retained; some entries apply to tools,
documentation or tests rather than the linked `libglib-2.0` runtime.
The staged `wasm-sources.lock` records native dependency archive URLs and
SHA-256 hashes. `webtilp-deps.txt` and `build-sources.json` are also included
when provided by the WASM build.

Electron's distribution supplies its own `LICENSE` and `LICENSES.chromium.html`.
The packaging hook preserves those exact target-platform files under
`resources/electron-licenses` (`Contents/Resources/electron-licenses` on macOS).
WebTILP and its desktop wrapper are distributed under GPLv2. Corresponding
sources and build instructions are in <https://github.com/adriweb/tilibs>;
publishers must make the corresponding sources for their exact release
available in accordance with the bundled licenses.
