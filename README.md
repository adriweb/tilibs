# webtilp-core

An idiomatic TypeScript wrapper around the [tilibs](https://github.com/debrouxl/tilibs)
Emscripten bridge — link with TI calculators over WebUSB, straight from the
browser.

- **Promise-based** API built on web platform primitives: `EventTarget` +
  native `ProgressEvent` for progress/status (no polling), `File` for
  transfers, `ImageData` for screenshots
- **`AbortSignal`** support on all long-running operations
- **`await using`** support (async disposable sessions)
- **Browser-only, pure library** — no DOM assumptions, no UI, no dependencies
- **ESM only**, fully typed

```ts
import { connect } from "webtilp-core";

const calc = await connect(); // must run inside a user gesture (WebUSB)

console.log(calc.model); // "TI-84 Plus CE"

calc.addEventListener("progress", (e) => {
  console.log(`${e.loaded}/${e.total} bytes`); // native ProgressEvent
});

await calc.sendFile(file, { location: "archive" }); // file: File | { name, data }

const { entries } = await calc.listDirectory();
const file = await calc.receiveFile("PRGM.8xp"); // → File
const image = await calc.screenshot(); // → ImageData
ctx.putImageData(image, 0, 0);

await calc.disconnect();
```

Sessions are async-disposable, so they can be scoped to a block:

```ts
await using calc = await connect();
await calc.sendFile(file);
// disconnects automatically when the block exits
```

Cancel a transfer with a standard `AbortSignal`:

```ts
const controller = new AbortController();
cancelButton.onclick = () => controller.abort();

try {
  await calc.sendFile(file, { signal: controller.signal });
} catch (error) {
  if (error instanceof DOMException && error.name === "AbortError") {
    // transfer cancelled
  }
}
```

## Installation

```sh
pnpm add webtilp-core
```

## Providing the compiled bridge

This package wraps compiled Emscripten artifacts; it does not build them.
Drop `tilibs.mjs` and `tilibs.wasm` into the package's `wasm/` directory (see
[`wasm/README.md`](wasm/README.md)), or load them yourself and pass the module
factory in:

```ts
import createTilibs from "./artifacts/tilibs.mjs";

const calc = await connect({ createModule: createTilibs });
```

If your bundler relocates the `.wasm` file, forward Emscripten's standard
`locateFile` hook:

```ts
const calc = await connect({
  locateFile: (path) => new URL(`./wasm/${path}`, import.meta.url).href,
});
```

The exact C symbols the wrapper expects from the bridge (names, signatures,
ownership rules, and the `Module.onProgress`/`Module.onStatus` callbacks) are
documented in [`src/bridge.ts`](src/bridge.ts) — that file is the single
integration seam if your bridge's exports differ.

## API

### `connect(options?): Promise<Calculator>`

Prompts for a device via WebUSB and opens a link session. Must be called from
a user gesture. Options: `createModule`, `locateFile` (both optional).

### `Calculator`

Operations are queued internally and run one at a time, so the cable is never
driven by two transfers at once.

| Member | Description |
| --- | --- |
| `model: string` | Model name reported by tilibs |
| `connected: boolean` | Whether the session is still open |
| `sendFile(file, options?)` | Send a variable/app file image. `file` is a `File` or `{ name, data }`; `options.location` is `"ram"` (default) or `"archive"` |
| `receiveFile(name, options?): Promise<File>` | Read a variable off the calculator as a file image |
| `listDirectory(folder?, options?)` | List variables (folder applies to 68k models) |
| `screenshot(options?): Promise<ImageData>` | Capture the screen, ready for `ctx.putImageData()` |
| `disconnect()` | Close the session (idempotent); also runs via `await using` |

All long-running methods accept `{ signal?: AbortSignal }`.

### Events

`Calculator` is an `EventTarget` with typed events, so the platform's
subscription options apply: `{ once: true }` for one-shot listeners and
`{ signal }` for automatic listener cleanup.

| Event | Type | When |
| --- | --- | --- |
| `progress` | `ProgressEvent` (`loaded`/`total` in bytes) | Repeatedly during transfers |
| `status` | `StatusEvent` (`message: string`) | Status text from the link library |
| `disconnect` | `Event` | Once, when the session closes |

### Errors

- `TilibsError` — the bridge reported a failure; carries the raw tilibs `code`
- `DisconnectedError` — an operation was attempted after `disconnect()`
- Aborted operations reject with the signal's reason (an `"AbortError"` `DOMException` by default)

## Development

Tools are managed with [mise](https://mise.jdx.dev) and packages with pnpm:

```sh
mise install     # node + pnpm, pinned in mise.toml
pnpm install
pnpm typecheck
pnpm build       # tsup → dist/
```

## License

[GPL-2.0-only](LICENSE), same as tilibs.
