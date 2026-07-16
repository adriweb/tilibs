/**
 * Types for the Emscripten-generated tilibs bridge, plus the default
 * artifact loader.
 *
 * The compiled artifacts are expected to be built with
 * `-sMODULARIZE -sEXPORT_ES6` and ASYNCIFY/JSPI, so that the generated file
 * default-exports an async module factory and blocking link calls can be
 * awaited from JavaScript.
 */

/** The subset of the Emscripten runtime this wrapper relies on. */
export interface TilibsModule {
  ccall(
    name: string,
    returnType: "number" | "string" | null,
    argTypes: readonly ("number" | "string")[],
    args: readonly (number | string)[],
    options?: { async?: boolean },
  ): unknown;
  _malloc(size: number): number;
  _free(ptr: number): void;
  HEAPU8: Uint8Array;
  getValue(ptr: number, type: "i32"): number;
  UTF8ToString(ptr: number): string;
  stringToUTF8(text: string, ptr: number, maxBytes: number): void;
  lengthBytesUTF8(text: string): number;

  /** Installed by the wrapper; invoked by the C++ bridge during transfers. */
  onProgress?: (transferred: number, total: number) => void;
  /** Installed by the wrapper; invoked by the C++ bridge with status text. */
  onStatus?: (text: string) => void;
}

export interface TilibsModuleInit {
  /** Standard Emscripten hook used to resolve the `.wasm` file URL. */
  locateFile?: (path: string, prefix: string) => string;
}

/** The default export of the compiled Emscripten artifact. */
export type TilibsModuleFactory = (init?: TilibsModuleInit) => Promise<TilibsModule>;

/** Location of the bundled artifact, relative to the built `dist/` output. */
const DEFAULT_ARTIFACT_PATH = "../wasm/tilibs.mjs";

/** Loads the module factory from the artifact shipped in `wasm/`. */
export async function loadDefaultModuleFactory(): Promise<TilibsModuleFactory> {
  const url = new URL(DEFAULT_ARTIFACT_PATH, import.meta.url).href;
  let artifact: { default?: unknown };
  try {
    artifact = (await import(
      /* @vite-ignore */ /* webpackIgnore: true */ url
    )) as { default?: unknown };
  } catch (cause) {
    throw new Error(
      `Failed to load the tilibs Emscripten artifact from ${url}. ` +
        `Place the compiled tilibs.mjs and tilibs.wasm in this package's wasm/ ` +
        `directory, or pass your own factory via connect({ createModule }).`,
      { cause },
    );
  }
  if (typeof artifact.default !== "function") {
    throw new Error(
      `The tilibs artifact at ${url} does not default-export an Emscripten module factory; ` +
        `was it built with -sMODULARIZE -sEXPORT_ES6?`,
    );
  }
  return artifact.default as TilibsModuleFactory;
}
