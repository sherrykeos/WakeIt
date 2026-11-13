import { type ErrorReporter, reportSafely } from "../shared/contain";

/**
 * One external, immutable state tree plus an internal event queue (AD-3).
 * Framework-free: shaped for `useSyncExternalStore` (`subscribe` + `getState`) without
 * importing React.
 *
 * Semantics:
 * - `getState` is read-your-writes: it always returns the latest committed state.
 * - `commit` that returns the same reference is a no-op (no notification).
 * - Notification is coalesced: any number of commits/events in one synchronous run lead to
 *   ONE flush in a microtask. A flush delivers, in order, (1) queued events to observers in
 *   FIFO order, then (2) one call to every subscriber, only if the state differs from what
 *   subscribers last saw. Listeners take no payload; they read `getState()`.
 * - Commits/events made by listeners during a flush are handled by further passes of the
 *   same flush (no recursion, no extra microtask).
 * - Listener/observer exceptions are contained and reported; they never affect other
 *   listeners or the committed state.
 * - `dispose` drops all listeners and pending work; `getState` keeps returning the last state.
 */
export interface Store<S, E> {
  getState(): S;
  /** Replaces the state with `update(previous)`. Structural sharing is the updater's job. */
  commit(update: (previous: S) => S): void;
  /** Queues an internal event for observers. */
  emit(event: E): void;
  subscribe(listener: () => void): () => void;
  observe(observer: (event: E) => void): () => void;
  /** Number of public subscribers (observers are not counted). */
  subscriberCount(): number;
  dispose(): void;
}

export interface StoreOptions {
  /** Called synchronously after a subscriber is added or removed (not on dispose). */
  readonly onSubscriberCountChange?: (count: number) => void;
}

/** Upper bound on passes per flush, so listeners that always re-commit cannot hang the thread. */
const MAX_PASSES = 100;

const NOOP = (): void => undefined;

function freezeShallow<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
  }
  return value;
}

export function createStore<S, E>(
  initial: S,
  reportError: ErrorReporter,
  options: StoreOptions = {},
): Store<S, E> {
  let state = freezeShallow(initial);
  let notified = state; // the state subscribers were last called for
  let disposed = false;
  let scheduled = false;
  let flushing = false;

  // Entries (not bare functions) so the same function can subscribe twice independently.
  const listeners = new Set<{ readonly call: () => void }>();
  const observers = new Set<{ readonly call: (event: E) => void }>();
  let queue: E[] = [];

  const notifyCount = (): void => {
    try {
      options.onSubscriberCountChange?.(listeners.size);
    } catch (error) {
      reportSafely(reportError, error);
    }
  };

  const schedule = (): void => {
    if (scheduled || flushing || disposed) return;
    scheduled = true;
    void Promise.resolve().then(flush);
  };

  const drainEvents = (): void => {
    while (queue.length > 0 && !disposed) {
      const batch = queue;
      queue = [];
      for (const event of batch) {
        for (const entry of [...observers]) {
          if (!observers.has(entry)) continue; // removed by an earlier observer
          try {
            entry.call(event);
          } catch (error) {
            reportSafely(reportError, error);
          }
        }
      }
    }
  };

  const notifySubscribers = (): void => {
    for (const entry of [...listeners]) {
      if (!listeners.has(entry)) continue; // unsubscribed during this pass
      try {
        entry.call();
      } catch (error) {
        reportSafely(reportError, error);
      }
    }
  };

  function flush(): void {
    scheduled = false;
    if (disposed) return;
    flushing = true;
    try {
      for (let pass = 0; queue.length > 0 || state !== notified; pass++) {
        if (pass === MAX_PASSES) {
          reportSafely(
            reportError,
            new Error("WakeIt: listeners kept committing state; notification loop stopped."),
          );
          return;
        }
        drainEvents();
        if (disposed) return;
        if (state !== notified) {
          notified = state; // set first: commits made by listeners start a new pass
          notifySubscribers();
        }
        if (disposed) return;
      }
    } finally {
      flushing = false;
    }
  }

  return {
    getState: () => state,

    commit(update) {
      if (disposed) return;
      const next = update(state);
      if (Object.is(next, state)) return;
      state = freezeShallow(next);
      schedule();
    },

    emit(event) {
      if (disposed) return;
      queue.push(event);
      schedule();
    },

    subscribe(listener) {
      if (disposed) return NOOP;
      const entry = { call: listener };
      listeners.add(entry);
      notifyCount();
      return () => {
        if (listeners.delete(entry)) notifyCount();
      };
    },

    observe(observer) {
      if (disposed) return NOOP;
      const entry = { call: observer };
      observers.add(entry);
      return () => {
        observers.delete(entry);
      };
    },

    subscriberCount: () => listeners.size,

    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      observers.clear();
      queue = [];
    },
  };
}
