/** Where a variable lives on the calculator. */
export type FileLocation = "ram" | "archive";

/** Options shared by all long-running calculator operations. */
export interface OperationOptions {
  /**
   * Aborts the operation. The transfer is cancelled on the link side and the
   * returned promise rejects with the signal's abort reason (a
   * `DOMException` named `"AbortError"` by default).
   */
  signal?: AbortSignal;
}

export interface SendFileOptions extends OperationOptions {
  /**
   * Whether the variable should be stored in RAM or archived to flash.
   * @default "ram"
   */
  location?: FileLocation;
}

/**
 * A file to send when you don't have a `File` object at hand — for example
 * bytes generated in memory.
 */
export interface FileInput {
  /** File name including its extension, e.g. `"PRGM.8xp"`. */
  name: string;
  data: Blob | ArrayBuffer | ArrayBufferView;
}

/** A single variable or application as reported by the calculator. */
export interface VariableEntry {
  name: string;
  /** Containing folder, or `null` on models without folders. */
  folder: string | null;
  /** Variable type as reported by tilibs, e.g. `"PRGM"` or `"APPL"`. */
  type: string;
  /** Size in bytes. */
  size: number;
  location: FileLocation;
}

export interface MemoryInfo {
  /** Free RAM in bytes. */
  ramFree: number;
  /** Free flash/archive memory in bytes. */
  flashFree: number;
}

export interface DirectoryListing {
  entries: VariableEntry[];
  /** Present when the calculator reports free memory alongside the listing. */
  memory?: MemoryInfo;
}
