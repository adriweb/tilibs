import type { TilibsBridge } from "./bridge.js";
import { Emitter } from "./emitter.js";
import { DisconnectedError, abortReason } from "./errors.js";
import type {
  CalculatorEvents,
  DirectoryListing,
  FileInput,
  OperationOptions,
  ReceivedFile,
  Screenshot,
  SendFileOptions,
  VariableEntry,
} from "./types.js";

/**
 * A connected calculator. Create instances with {@link connect}.
 *
 * Operations run one at a time — concurrent calls are queued in order, so
 * the link cable is never driven by two transfers at once.
 */
export class Calculator extends Emitter<CalculatorEvents> {
  /** Model name reported by tilibs, e.g. `"TI-84 Plus CE"`. */
  readonly model: string;

  readonly #bridge: TilibsBridge;
  #connected = true;
  #queue: Promise<unknown> = Promise.resolve();

  /** @internal Use {@link connect} instead. */
  constructor(bridge: TilibsBridge) {
    super();
    this.#bridge = bridge;
    this.model = bridge.modelName();
    bridge.setProgressHandler((transferred, total) =>
      this.emit("progress", { transferred, total }),
    );
    bridge.setStatusHandler((text) => this.emit("status", text));
  }

  /** Whether the connection is still open. */
  get connected(): boolean {
    return this.#connected;
  }

  /** Sends a variable/app file image (e.g. `.8xp`, `.8xk`) to the calculator. */
  async sendFile(file: File | FileInput, options: SendFileOptions = {}): Promise<void> {
    const { name, data } = await normalizeFileInput(file);
    await this.#enqueue(options.signal, () =>
      this.#bridge.sendFile(name, data, options.location === "archive"),
    );
  }

  /** Reads a variable off the calculator as a file image. */
  async receiveFile(name: string, options: OperationOptions = {}): Promise<ReceivedFile> {
    const data = await this.#enqueue(options.signal, () => this.#bridge.receiveFile(name));
    return { name, data };
  }

  /** Lists variables, optionally scoped to one folder (68k models). */
  async listDirectory(folder?: string, options: OperationOptions = {}): Promise<DirectoryListing> {
    const json = await this.#enqueue(options.signal, () => this.#bridge.dirlist(folder ?? ""));
    return parseDirectoryListing(json);
  }

  /** Captures the calculator's screen. */
  async screenshot(options: OperationOptions = {}): Promise<Screenshot> {
    return this.#enqueue(options.signal, () => this.#bridge.screenshot());
  }

  /** Closes the connection. Safe to call more than once. */
  async disconnect(): Promise<void> {
    if (!this.#connected) return;
    this.#connected = false;
    try {
      await this.#bridge.close();
    } finally {
      this.emit("disconnect", undefined);
    }
  }

  /** Serializes operations on the cable and wires up cancellation. */
  #enqueue<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(async () => {
      if (!this.#connected) throw new DisconnectedError();
      if (signal?.aborted) throw abortReason(signal);
      const onAbort = () => this.#bridge.cancel();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const result = await operation();
        if (signal?.aborted) throw abortReason(signal);
        return result;
      } catch (error) {
        // A cancelled transfer surfaces as a tilibs error; report the abort instead.
        throw signal?.aborted ? abortReason(signal) : error;
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    });
    this.#queue = run.then(noop, noop);
    return run;
  }
}

const noop = (): void => undefined;

async function normalizeFileInput(
  file: File | FileInput,
): Promise<{ name: string; data: Uint8Array }> {
  if (file instanceof File) {
    return { name: file.name, data: new Uint8Array(await file.arrayBuffer()) };
  }
  const { name, data } = file;
  if (data instanceof Blob) {
    return { name, data: new Uint8Array(await data.arrayBuffer()) };
  }
  if (data instanceof ArrayBuffer) {
    return { name, data: new Uint8Array(data) };
  }
  return { name, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
}

interface RawListing {
  entries?: {
    name: string;
    folder?: string | null;
    type: string;
    size: number;
    archived?: boolean;
  }[];
  memory?: { ramFree: number; flashFree: number };
}

function parseDirectoryListing(json: string): DirectoryListing {
  let raw: RawListing;
  try {
    raw = JSON.parse(json) as RawListing;
  } catch (cause) {
    throw new Error("The bridge returned a malformed directory listing.", { cause });
  }
  const entries: VariableEntry[] = (raw.entries ?? []).map((entry) => ({
    name: entry.name,
    folder: entry.folder ?? null,
    type: entry.type,
    size: entry.size,
    location: entry.archived ? "archive" : "ram",
  }));
  return raw.memory ? { entries, memory: raw.memory } : { entries };
}
