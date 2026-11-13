import type { FetchLike, OnlineSource } from "../../src/core/types";

/** A response with the given status. 204/205 carry no body, as in real HTTP. */
export function res(status: number, body = ""): Response {
  return new Response(status === 204 || status === 205 ? null : body, { status });
}

/** A fetch that never answers but rejects like the platform when its signal aborts. */
export const hangingFetch: FetchLike = (_url, init) =>
  new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => {
      reject(new DOMException("The operation was aborted.", "AbortError"));
    });
  });

/** A controllable connectivity source that tracks how many listeners are registered. */
export function createOnline(initial = true) {
  let online = initial;
  const listeners = new Set<() => void>();
  const source: OnlineSource = {
    isOnline: () => online,
    onOnline(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    source,
    /** Changes connectivity; going online notifies listeners, like the browser `online` event. */
    set(next: boolean): void {
      online = next;
      if (next) for (const listener of [...listeners]) listener();
    },
    listenerCount: () => listeners.size,
  };
}

/** Resolves to the rejection reason (or `undefined` if the promise fulfilled). Never rejects. */
export function outcome(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}
