# Compiled bridge artifacts

Place the Emscripten-compiled tilibs bridge here:

- `tilibs.mjs` — the generated JS glue, built with `-sMODULARIZE -sEXPORT_ES6`
  (must default-export the async module factory) and ASYNCIFY or JSPI so
  blocking link calls can be awaited
- `tilibs.wasm` — the matching wasm binary

`connect()` loads `tilibs.mjs` from this directory by default. The artifacts
are intentionally not committed; see `src/bridge.ts` for the exact C exports
the wrapper expects.
