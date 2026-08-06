# NumWorks WebUSB backend

WebTILP's NumWorks support runs directly in the browser through WebUSB. It
does not call the native tilibs/WASM bridge: the frontend dispatches NumWorks
operations to `numworks_backend.js` and keeps the existing native path for TI
calculators and HP Prime.

The browser backend vendors and bundles the MIT-licensed projects below:

- Yaya-Cout's Upsilon.js 1.5.0 revision
  `aeb3fd281ee973f3ddff29559055eee7ac53cae0`, the exact fork revision used by
  Upsilon Workshop, including its Epsilon 24+ alternate-interface and UTF-8
  storage fixes
- webdfu 1.0.5, integrity
  `sha512-aZ7FwAq5qCUMas6wpkISQzb+DuE+9dCdpIWejZuQGzsNqr0UlaVCvz4oezoGDoGtTKmRaXjpUlTBung+lGAHVQ==`

Their complete runtime source snapshots and license notices are preserved under
`third_party/`; `third_party/NUMWORKS-PROVENANCE.md` records the exact origins
and the one integration-only module-resolution change.

`bun build` combines Upsilon.js, WebDFU, and the WebTILP adapter into the final
browser IIFE. WebTILP uses the vendored code for WebUSB/DFU setup, DfuSe
transfers, memory-map parsing, model detection, and the firmware-specific
alternate interface. The adapter retains the narrower file-management API,
strict integrity checks, raw corrupt-storage recovery, and staged storage
rewrites.

The resulting global deliberately exposes a smaller, linking-oriented surface:

- connect to normal-mode NumWorks devices (`0483:a291`);
- identify N0100, N0110, N0115, and N0120 hardware where descriptors permit;
- read firmware, slot, commit, and script-storage information;
- list, download, upload, overwrite, rename, and delete Python scripts;
- download a raw read-only backup of the complete storage image;
- preserve non-Python records during every script-storage rewrite.

Firmware flashing, recovery-mode access, arbitrary reads/writes, and the
Upsilon crash helper are intentionally not exposed. Writes are bounded to the
RAM-backed storage address published by the calculator's validated platform
header. Header, record, range, size, and footer integrity are checked before a
storage mutation.
