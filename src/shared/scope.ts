import { type ErrorReporter, reportSafely } from "./contain";

/**
 * Owns cleanup callbacks for resources (timers, listeners, subscriptions) and
 * releases them deterministically. One scope per owner; the engine owns the root.
 */
export interface CleanupScope {
  /**
   * Registers `cleanup`. Returns `release`, which runs the cleanup now (at most once)
   * and unregisters it. If the scope is already disposed the cleanup runs immediately,
   * so a resource created late is never leaked.
   */
  add(cleanup: () => void): () => void;
  /** Runs every registered cleanup in reverse registration order. Idempotent. */
  dispose(): void;
  readonly isDisposed: boolean;
}

export function createScope(reportError: ErrorReporter): CleanupScope {
  // Insertion-ordered; each entry is removed before it runs, so it can never run twice.
  const pending = new Set<() => void>();
  let disposed = false;

  const run = (cleanup: () => void): void => {
    try {
      cleanup();
    } catch (error) {
      // One failing cleanup must not prevent the others from running.
      reportSafely(reportError, error);
    }
  };

  return {
    add(cleanup) {
      if (disposed) {
        run(cleanup);
        return () => undefined;
      }
      // Wrap so that registering the same function twice yields two independent entries.
      const entry = (): void => cleanup();
      pending.add(entry);
      return () => {
        if (pending.delete(entry)) run(entry);
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const entries = [...pending].reverse();
      pending.clear();
      for (const entry of entries) run(entry);
    },
    get isDisposed() {
      return disposed;
    },
  };
}
