// Lazy access to environment capabilities (AD-10, AD-23). Nothing here runs at import time and
// every capability is resolved at call time, so importing WakeIt is safe in Node and SSR.

import type { ErrorReporter } from "../shared/contain";
import type { FetchLike, OnlineSource } from "./types";

/**
 * Default sink for contained errors (listener or cleanup failures). Uses the platform's
 * `reportError` when it exists (browsers: logged as an uncaught error without throwing);
 * otherwise the error is dropped. WakeIt never logs by itself.
 */
export const defaultErrorReporter: ErrorReporter = (error) => {
  const report = (globalThis as { reportError?: unknown }).reportError;
  if (typeof report === "function") {
    (report as (error: unknown) => void).call(globalThis, error);
  }
};

/** Wall clock in ms. Resolved per call so test clocks (fake timers) apply. */
export const now = (): number => Date.now();

/** Uniform random in [0, 1). Used only for retry jitter. */
export const random = (): number => Math.random();

/**
 * Starts a one-shot timer and returns an idempotent cancel. With `unref`, the timer does not
 * keep a Node process alive (no-op in browsers).
 */
export function startTimer(callback: () => void, ms: number, unref = false): () => void {
  const handle: unknown = setTimeout(callback, ms);
  if (unref && typeof handle === "object" && handle !== null && "unref" in handle) {
    (handle as { unref(): void }).unref();
  }
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    clearTimeout(handle as Parameters<typeof clearTimeout>[0]);
  };
}

/** The platform `fetch`, looked up at call time; `undefined` when there is none. */
export function platformFetch(): FetchLike | undefined {
  const candidate = (globalThis as { fetch?: unknown }).fetch;
  if (typeof candidate !== "function") return undefined;
  return (input, init) => (candidate as FetchLike).call(globalThis, input, init);
}

export function hasAbortController(): boolean {
  return typeof (globalThis as { AbortController?: unknown }).AbortController === "function";
}

interface BrowserLike {
  navigator?: { onLine?: unknown };
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
}

/**
 * Default connectivity source. Where `navigator.onLine` or the global `online` event do not
 * exist (Node, SSR) it reports online and registers nothing.
 */
export const platformOnlineSource: OnlineSource = {
  isOnline() {
    const onLine = (globalThis as BrowserLike).navigator?.onLine;
    return typeof onLine === "boolean" ? onLine : true;
  },
  onOnline(listener) {
    const target = globalThis as BrowserLike;
    if (typeof target.addEventListener !== "function") return () => undefined;
    target.addEventListener("online", listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      target.removeEventListener?.("online", listener);
    };
  },
};
