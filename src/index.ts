import { TilibsBridge } from "./bridge.js";
import { Calculator } from "./calculator.js";
import {
  loadDefaultModuleFactory,
  type TilibsModuleFactory,
  type TilibsModuleInit,
} from "./module.js";

export interface ConnectOptions {
  /**
   * Factory for the Emscripten bridge module — the default export of the
   * compiled `tilibs.mjs`. When omitted, the artifact shipped next to this
   * package (`wasm/tilibs.mjs`) is loaded.
   */
  createModule?: TilibsModuleFactory;
  /** Standard Emscripten hook to resolve the `.wasm` URL, forwarded to the factory. */
  locateFile?: (path: string, prefix: string) => string;
}

/**
 * Prompts for a calculator over WebUSB and opens a link session with it.
 *
 * Must be called from a user gesture (e.g. a click handler): browsers only
 * show the WebUSB device chooser in response to user activation.
 */
export async function connect(options: ConnectOptions = {}): Promise<Calculator> {
  if (typeof navigator === "undefined" || !("usb" in navigator)) {
    throw new Error(
      "WebUSB is not available in this environment; webtilp-core requires a browser with WebUSB support.",
    );
  }
  const createModule = options.createModule ?? (await loadDefaultModuleFactory());
  const init: TilibsModuleInit = {};
  if (options.locateFile) init.locateFile = options.locateFile;
  const module = await createModule(init);
  const bridge = new TilibsBridge(module);
  bridge.init();
  await bridge.open();
  return new Calculator(bridge);
}

export { Calculator } from "./calculator.js";
export { StatusEvent, type CalculatorEventMap } from "./events.js";
export { DisconnectedError, TilibsError } from "./errors.js";
export type { TilibsModule, TilibsModuleFactory, TilibsModuleInit } from "./module.js";
export type {
  DirectoryListing,
  FileInput,
  FileLocation,
  MemoryInfo,
  OperationOptions,
  SendFileOptions,
  VariableEntry,
} from "./types.js";
