/** Raised when the underlying tilibs bridge reports a failure. */
export class TilibsError extends Error {
  override readonly name: string = "TilibsError";
  /** Raw tilibs error code. */
  readonly code: number;

  constructor(message: string, code: number) {
    super(message);
    this.code = code;
  }
}

/** Thrown when an operation is attempted on a closed connection. */
export class DisconnectedError extends Error {
  override readonly name: string = "DisconnectedError";

  constructor() {
    super("The calculator connection has been closed.");
  }
}

/** @internal */
export function abortReason(signal: AbortSignal): unknown {
  return (
    (signal.reason as unknown) ??
    new DOMException("The operation was aborted.", "AbortError")
  );
}
