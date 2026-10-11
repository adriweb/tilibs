# WebTILP architecture

WebTILP keeps calculator protocols in their existing libraries and browser
backends. The C++ and JavaScript entry points compose those implementations.

## Native bridge

| Module | Owns |
| --- | --- |
| `webtilp.cpp`, `webtilp.h` | Exported C ABI and argument forwarding. Existing export names and signatures remain stable. |
| `ti_session` | Cable/calculator handles, attachment, readiness, settings, model changes, warnings, and progress. |
| `ti_operations` | Calculator operations, directory traversal, receive paths, clock, screenshot, and backup operations. |
| `ti_file_catalog` | Typed file/entry descriptions and serialization for file inspection, extracted bundles, and directory entries. |
| `ti_file_io` | Owning file-reader adapters and selected-entry construction. |
| `ti_transfers` | Transfer dispatch, shared preparation, folder/location overrides, and TI-82/85 batch completion. |
| `ti_backup_vat` | Dependency-free TI-82/85 backup parsing. |
| `webtilp_json` | Bounded JSON escaping shared by the TI, HP Prime, and Casio bridges. |

File metadata distinguishes the source model that defines a variable's type,
the representation into which its name was converted by the reader, and the
destination model that determines transfer policy. These are separate concerns
even when they happen to have the same model value.

The public regular/flash reader API consumes its content allocation on parsing
failure. Owning adapters relinquish that allocation on an error; callers must
not delete it a second time. The Evo dispatcher follows the same ownership
contract as the legacy readers.

Exported strings are borrowed native buffers. JavaScript copies them through
`ccall` before using their contents; it must not retain a native pointer across
subsequent calls. Binary results continue to use MEMFS.

## Browser application

`app_entry.mjs` imports `app.js` for side effects. Both development and production
builds bundle this entry as an IIFE. `app.js` creates state, DOM references,
runtime/session owners, and the application dependency context, then starts
bootstrap. `frontend.js` composes the feature and view factories without
starting the application.

Factories receive live dependencies instead of importing the browser entry
point. This lets tests import production methods with controlled transports,
dialogs, clocks, and rendering callbacks. `runtime/context.js` wires those
dependencies and binds browser methods that require a Window receiver.

| Directory/module | Responsibility |
| --- | --- |
| `catalog/` | Calculator/device definitions, keymaps, file policies, locales, and themes. |
| `transport/browser-devices.js` | Browser device discovery and permission requests. |
| `session.js`, `features/connections.js` | Connection identity, initialization, authorization, and recovery. |
| `runtime/` | Asyncify entry, retirement, browser transport cleanup, diagnostics, and downloads. |
| `backends/` | TI, HP Prime, NumWorks, Casio, legacy HP, and Sharp file-operation adapters; normalized identities and capabilities. |
| `features/` | Transfer planning/execution, conversion, file actions, previews, screenshots, settings, and other workflows. |
| `ui/` | DOM rendering, controls, dialogs, selection, progress, themes, and event binding. |
| `offline.js` | Service-worker startup, cache controls, and build information. |

The existing NumWorks, legacy HP, Sharp, and Evo transport implementations remain
the protocol implementations. Adapters expose shared file operations while
specialized operations such as OS transfer, HP application resources, and raw
storage backup remain explicit.

`backends/capabilities.js` describes support and entry permissions. Native
directory listing, manual backup listing, and cached listing remain distinct.
`features/capability-ui.js` renders control availability and preserves loading
state. Family-specific labels and keymap presentation stay in the views.

`features/file-model.js` owns entry identity and selection. Checkboxes carry an
entry ID rather than a second copy of variable metadata. Batch actions use the
checked visible rows; a filtered-out selection is not silently downloaded or
deleted. Backend references preserve family-specific identities such as HP
cache indices and application children.

## Lifecycle rules

- Each WASM module has a FIFO. Only one Asyncify-capable native call may be
  active in that module.
- A JavaScript timeout does not cancel native execution. Its slot stays occupied
  until the underlying native call settles, or the module is retired.
- Use `runWasmOperation` when a native call and consumption of its MEMFS result
  must be atomic. TI receive and preview paths hold their slot through reading
  the result marker and copying the bytes.
- Synchronous progress readers can poll while native work is suspended. They
  must not become Asyncify-capable operations.
- Session generations fence delayed permission, initialization, conversion,
  file-reading, and dialog results. An abandoned result cannot publish into a
  replacement connection.
- Emergency reset invalidates immediately. Browser transport cleanup is bounded
  and does not enter a retired WASM module.
- Permission choosers that require transient user activation start from the
  click handler before module initialization awaits.
- TI-82/85 EOT completion, HP snapshot generations, and expected Nspire reset
  behavior remain explicit protocol/lifecycle policies.

## Validation

```sh
./deps/wasm/test-tilibs.sh
make -C webtilp test
make -C webtilp test-wasm
make -C webtilp test-browser
make -C webtilp test-browser-prod
```

The library smoke script verifies Evo file formats and grouping cleanup,
including malformed inputs after successful reads. The `test` target runs
native parser/JSON tests, direct-import JavaScript tests, dependency wiring
checks, transport/backend tests, and locale checks. The WASM target links the real
libraries and verifies packet sequencing, reader ownership, metadata, session
behavior, startup, and backup parsing. It requires the Emscripten dependencies
and library builds described by the existing build scripts.

Browser targets require Bun, Playwright, Chromium, and built site assets. They
check the bundled desktop/mobile application and mocked family workflows in
both development and minified production builds. Test-only application access
is appended by `tests/build_frontend_test_bundle.cjs`; production does not expose
that hook. Physical calculator checks remain useful for protocol changes.
