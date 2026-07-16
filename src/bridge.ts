import { TilibsError } from "./errors.js";
import type { TilibsModule } from "./module.js";
import type { Screenshot } from "./types.js";

/**
 * Low-level, typed façade over the flat C API exported by the tilibs
 * Emscripten bridge.
 *
 * This file is the single integration seam with the compiled artifact: if
 * your bridge exports different symbol names or signatures, this is the only
 * file that needs to change. The expected exports are:
 *
 * ```c
 * int   wtc_init(void);
 * int   wtc_open(void);                          // async: WebUSB pick + cable/calc open
 * int   wtc_close(void);                         // async
 * char *wtc_model_name(void);                    // caller-owned, release with wtc_free
 * int   wtc_send_file(const char *name, const uint8_t *data,
 *                     size_t len, int to_archive);            // async
 * int   wtc_recv_file(const char *name,
 *                     uint8_t **out_data, size_t *out_len);   // async
 * int   wtc_dirlist(const char *folder, char **out_json);     // async
 * int   wtc_screenshot(uint8_t **out_rgba, size_t *out_len,
 *                      int *out_width, int *out_height);      // async
 * void  wtc_cancel(void);                        // flips ticalcs' update cancel flag
 * char *wtc_error_message(int code);             // caller-owned, release with wtc_free
 * void  wtc_free(void *ptr);
 * ```
 *
 * Every `int` return is `0` on success or a tilibs error code. Functions
 * marked "async" must be reachable through ASYNCIFY/JSPI so `ccall` can
 * await them. During transfers the bridge reports through
 * `Module.onProgress(transferred, total)` and `Module.onStatus(text)`.
 */
export class TilibsBridge {
  readonly #module: TilibsModule;

  constructor(module: TilibsModule) {
    this.#module = module;
  }

  setProgressHandler(handler: (transferred: number, total: number) => void): void {
    this.#module.onProgress = handler;
  }

  setStatusHandler(handler: (text: string) => void): void {
    this.#module.onStatus = handler;
  }

  init(): void {
    this.#check(this.#callSync("wtc_init"));
  }

  async open(): Promise<void> {
    this.#check(await this.#call("wtc_open"));
  }

  async close(): Promise<void> {
    this.#check(await this.#call("wtc_close"));
  }

  modelName(): string {
    return this.#takeString(this.#callSync("wtc_model_name")) ?? "unknown";
  }

  /** Requests cancellation of the operation currently in flight. */
  cancel(): void {
    this.#module.ccall("wtc_cancel", null, [], []);
  }

  async sendFile(name: string, data: Uint8Array, toArchive: boolean): Promise<void> {
    const namePtr = this.#allocString(name);
    const dataPtr = this.#allocBytes(data);
    try {
      this.#check(
        await this.#call(
          "wtc_send_file",
          ["number", "number", "number", "number"],
          [namePtr, dataPtr, data.byteLength, toArchive ? 1 : 0],
        ),
      );
    } finally {
      this.#module._free(dataPtr);
      this.#module._free(namePtr);
    }
  }

  async receiveFile(name: string): Promise<Uint8Array> {
    const namePtr = this.#allocString(name);
    const out = this.#allocOut(2); // [data*, len]
    try {
      this.#check(
        await this.#call(
          "wtc_recv_file",
          ["number", "number", "number"],
          [namePtr, out, out + 4],
        ),
      );
      return this.#takeBytes(this.#readWord(out, 0), this.#readWord(out, 1));
    } finally {
      this.#module._free(out);
      this.#module._free(namePtr);
    }
  }

  /** Returns the raw JSON listing produced by the bridge. */
  async dirlist(folder: string): Promise<string> {
    const folderPtr = this.#allocString(folder);
    const out = this.#allocOut(1); // [json*]
    try {
      this.#check(
        await this.#call("wtc_dirlist", ["number", "number"], [folderPtr, out]),
      );
      const json = this.#takeString(this.#readWord(out, 0));
      if (json === null) {
        throw new TilibsError("The bridge returned an empty directory listing.", -1);
      }
      return json;
    } finally {
      this.#module._free(out);
      this.#module._free(folderPtr);
    }
  }

  async screenshot(): Promise<Screenshot> {
    const out = this.#allocOut(4); // [rgba*, len, width, height]
    try {
      this.#check(
        await this.#call(
          "wtc_screenshot",
          ["number", "number", "number", "number"],
          [out, out + 4, out + 8, out + 12],
        ),
      );
      const rgba = this.#takeBytes(this.#readWord(out, 0), this.#readWord(out, 1));
      return { width: this.#readWord(out, 2), height: this.#readWord(out, 3), rgba };
    } finally {
      this.#module._free(out);
    }
  }

  #callSync(name: string, argTypes: readonly "number"[] = [], args: readonly number[] = []): number {
    return this.#module.ccall(name, "number", argTypes, args) as number;
  }

  async #call(name: string, argTypes: readonly "number"[] = [], args: readonly number[] = []): Promise<number> {
    return (await this.#module.ccall(name, "number", argTypes, args, { async: true })) as number;
  }

  #check(code: number): void {
    if (code !== 0) {
      throw new TilibsError(this.#errorMessage(code), code);
    }
  }

  #errorMessage(code: number): string {
    return (
      this.#takeString(this.#callSync("wtc_error_message", ["number"], [code])) ??
      `tilibs error ${code}`
    );
  }

  #allocString(text: string): number {
    const bytes = this.#module.lengthBytesUTF8(text) + 1;
    const ptr = this.#module._malloc(bytes);
    this.#module.stringToUTF8(text, ptr, bytes);
    return ptr;
  }

  #allocBytes(data: Uint8Array): number {
    const ptr = this.#module._malloc(Math.max(data.byteLength, 1));
    this.#module.HEAPU8.set(data, ptr);
    return ptr;
  }

  /** Allocates zeroed 32-bit out-parameter slots. */
  #allocOut(slots: number): number {
    const ptr = this.#module._malloc(slots * 4);
    this.#module.HEAPU8.fill(0, ptr, ptr + slots * 4);
    return ptr;
  }

  #readWord(ptr: number, slot: number): number {
    return this.#module.getValue(ptr + slot * 4, "i32") >>> 0;
  }

  /** Copies a bridge-owned C string out of the heap, then frees it. */
  #takeString(ptr: number): string | null {
    if (ptr === 0) return null;
    try {
      return this.#module.UTF8ToString(ptr);
    } finally {
      this.#bridgeFree(ptr);
    }
  }

  /** Copies a bridge-owned buffer out of the heap, then frees it. */
  #takeBytes(ptr: number, length: number): Uint8Array {
    const copy = new Uint8Array(length);
    if (ptr !== 0) {
      copy.set(this.#module.HEAPU8.subarray(ptr, ptr + length));
      this.#bridgeFree(ptr);
    }
    return copy;
  }

  /** Frees memory that was allocated by the bridge (not by this wrapper). */
  #bridgeFree(ptr: number): void {
    this.#module.ccall("wtc_free", null, ["number"], [ptr]);
  }
}
