# Cahute source import

This directory contains the Cahute sources used by WebTILP's Casio backend.

- Upstream repository: <https://gitlab.com/cahuteproject/cahute>
- Imported revision: `10c389c8917438ae64335f34613bd4e45f6e8a30`
- Import date: 2026-08-20
- Version: 0.6 development branch
- License: CeCILL 2.1; see `LICENSE.txt`

The upstream source layout is preserved so Cahute protocol changes remain
reviewable independently from WebTILP. Two build-system paths use
`PROJECT_SOURCE_DIR` rather than `CMAKE_SOURCE_DIR`; this allows the upstream
project to be built as a subdirectory of tilibs without changing Cahute's
runtime behavior. The parent build also suppresses Linux serial-device
discovery for Emscripten while retaining Cahute's POSIX file backend for the
browser virtual filesystem.

WebTILP links Cahute only in its Emscripten build. Cahute's existing libusb
backend then uses this repository's WebUSB-enabled libusb port, including its
vendor-specific control transfer and bulk endpoints. No browser-only protocol
fork is maintained.

Only CASIO's vendor-specific `07cf:6101` USB mode is exposed by WebTILP.
Mass-storage interfaces (`07cf:6102` and `07cf:6103`) remain deliberately out
of scope because WebUSB blocks protected USB Mass Storage interfaces.
