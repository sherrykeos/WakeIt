/** Receives errors that WakeIt contained instead of propagating (listener, cleanup failures). */
export type ErrorReporter = (error: unknown) => void;

/** Reports a contained error. A failing reporter must never break WakeIt itself. */
export function reportSafely(reporter: ErrorReporter, error: unknown): void {
  try {
    reporter(error);
  } catch {
    // Nothing sensible left to do: the reporter itself is broken.
  }
}
