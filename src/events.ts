/** Carries a human-readable status message from the link library. */
export class StatusEvent extends Event {
  readonly message: string;

  constructor(message: string) {
    super("status");
    this.message = message;
  }
}

/**
 * Events dispatched by a connected calculator.
 *
 * - `progress` — native {@link ProgressEvent}, fired repeatedly during
 *   transfers (`loaded`/`total` are byte counts)
 * - `status` — {@link StatusEvent} with status text from the link library
 * - `disconnect` — plain {@link Event}, fired once when the session closes
 */
export interface CalculatorEventMap {
  progress: ProgressEvent;
  status: StatusEvent;
  disconnect: Event;
}
