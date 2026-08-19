# HPLP source import

This directory contains the HPLP sources used by WebTILP's HP Prime backend.

- Upstream repository: <https://github.com/debrouxl/hplp>
- Imported from local checkout: `/Users/adriweb/Documents/hplp`
- Imported revision: `7b07ea9790ef253aafa39bf75d994fb996282048`
- Import date: 2026-08-06
- License: GPL-2.0-or-later; see `libhpcalcs/COPYING`

The upstream source layout is intentionally preserved under `libhpcalcs/` so
that protocol and platform changes can be reviewed separately from WebTILP's
frontend integration. Web-specific build files and the Emscripten WebHID cable
backend live alongside the imported sources and are selected only for the WASM
build. Native HPLP continues to use its existing HIDAPI backend. The imported
C sources and headers were mechanically converted from ISO-8859-1 to UTF-8 so
they can be edited and compiled consistently with the rest of this repository.

When refreshing this snapshot, first compare the imported tree against the
recorded revision, then keep upstream-source changes, WebHID changes, and
WebTILP adapter changes in separate commits.

## Clean-room protocol evidence

The proprietary HP Connectivity Kit is used only as black-box protocol and
compatibility evidence. No Connectivity Kit source or decompiled implementation
is copied into this tree. Observable packet layouts, HID capabilities, file
extensions, state transitions, and error behavior are independently
reimplemented and covered by repository-owned tests.

The remote-key implementation combines public, independently reproducible
evidence: issue #6 records the legacy `EC 01` single-key message and PrimeWeb
publishes the physical key IDs plus the modern `EC 03` command parameter. The
library retains the legacy body verbatim and transports the modern body through
the repository-owned V2 framing/ACK implementation. No Connectivity Kit code
or GitHub issue snippet is embedded in the implementation.
