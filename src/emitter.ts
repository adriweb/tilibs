export type Listener<T> = (event: T) => void;

/**
 * Minimal strongly-typed event emitter. Deliberately not Node's
 * `EventEmitter` — this package is browser-only and dependency-free.
 */
export class Emitter<Events extends Record<string, unknown>> {
  #listeners = new Map<keyof Events, Set<Listener<never>>>();

  /** Registers a listener. Returns a function that removes it again. */
  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    let bucket = this.#listeners.get(event);
    if (!bucket) {
      bucket = new Set();
      this.#listeners.set(event, bucket);
    }
    bucket.add(listener as Listener<never>);
    return () => this.off(event, listener);
  }

  /** Registers a listener that is removed after its first invocation. */
  once<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    const off = this.on(event, (payload) => {
      off();
      listener(payload);
    });
    return off;
  }

  off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void {
    this.#listeners.get(event)?.delete(listener as Listener<never>);
  }

  protected emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const bucket = this.#listeners.get(event);
    if (!bucket) return;
    for (const listener of [...bucket]) {
      (listener as Listener<Events[K]>)(payload);
    }
  }
}
