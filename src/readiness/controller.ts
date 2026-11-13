import { now, random, startTimer } from "../core/env";
import { reportSafely, type ErrorReporter } from "../shared/contain";
import { WakeItReadinessError } from "../core/errors";
import { withReadiness } from "../core/state";
import type { Store } from "../core/store";
import type {
  CoreState,
  EngineEvent,
  FetchLike,
  NormalizedBackend,
  OnlineSource,
  ReadinessSnapshot,
} from "../core/types";
import { retryDelayMs } from "./policy";
import { probe } from "./probe";
import { IDLE_RUN, step, type RunEffect, type RunEvent, type RunState } from "./run";
import { expired, isFresh } from "./validity";

export interface ControllerDeps {
  readonly id: string;
  readonly backend: NormalizedBackend;
  readonly store: Store<CoreState, EngineEvent>;
  readonly fetch: FetchLike;
  readonly online: OnlineSource;
  /** Public store subscribers right now (the expiry timer exists only while this is > 0). */
  readonly subscriberCount: () => number;
  /** Receives unexpected errors from asynchronous attempt callbacks (contained, never thrown). */
  readonly reportError: ErrorReporter;
}

export interface ReadinessController {
  /** Resolves when ready (fresh), sharing one probe run with concurrent callers. */
  ensureReady(signal: AbortSignal | undefined): Promise<void>;
  /** Re-evaluates the observed-expiry timer after a subscriber-count change. */
  syncExpiry(): void;
  /** Stops everything and rejects waiters with `aborted`. Idempotent. */
  dispose(): void;
}

interface Waiter {
  readonly resolve: () => void;
  readonly reject: (error: WakeItReadinessError) => void;
  detach: () => void;
}

/**
 * One controller per backend id (ARCHITECTURE section 6). It interprets the pure run machine:
 * it owns the probe timers (attempt, retry, deadline), the attempt `AbortController`, the
 * `online` subscription, the waiters and the expiry timer, and writes snapshots to the store.
 *
 * Resource ownership: everything per run is released by `endRun()` on every exit (ready,
 * exhausted, last waiter left, dispose); the expiry timer lives only while the store has
 * subscribers and the snapshot is fresh.
 */
export function createController(deps: ControllerDeps): ReadinessController {
  const { id, backend, store } = deps;
  const policy = {
    maxAttempts: backend.poll.maxAttempts,
    retryDelayMs: (failed: number) => retryDelayMs(backend.poll, failed, random),
  };

  let run: RunState = IDLE_RUN;
  let disposed = false;
  /** Set while a run exists, so error timing survives the reducer already being idle. */
  let runStartedAt: number | undefined;
  let beforeRun: ReadinessSnapshot | undefined;
  const waiters = new Set<Waiter>();

  let cancelDeadline: (() => void) | undefined;
  let cancelRetry: (() => void) | undefined;
  let cancelAttemptTimer: (() => void) | undefined;
  let abortAttempt: (() => void) | undefined;
  let stopListeningOnline: (() => void) | undefined;
  let cancelExpiry: (() => void) | undefined;
  let expiryArmedFor: number | undefined;

  const read = (): ReadinessSnapshot => store.getState().readiness[id] as ReadinessSnapshot;

  // ---- snapshots and freshness ---------------------------------------------

  const syncExpiry = (): void => {
    const snapshot = read();
    const t = now();
    const shouldArm = !disposed && deps.subscriberCount() > 0 && isFresh(snapshot, t);
    if (!shouldArm) {
      cancelExpiry?.();
      cancelExpiry = undefined;
      expiryArmedFor = undefined;
      return;
    }
    if (expiryArmedFor === snapshot.validUntil) return; // already armed for this validity
    cancelExpiry?.();
    expiryArmedFor = snapshot.validUntil;
    cancelExpiry = startTimer(
      () => {
        cancelExpiry = undefined;
        expiryArmedFor = undefined;
        const current = read();
        // The timer may fire early or late; read time is the truth (AD-21).
        if (current.status === "ready" && !isFresh(current, now())) commit(expired(current));
        else syncExpiry();
      },
      (snapshot.validUntil as number) - t,
      true,
    );
  };

  const commit = (snapshot: ReadinessSnapshot): void => {
    // Snapshots are immutable once published.
    const frozen = Object.freeze(snapshot);
    store.commit((state) => withReadiness(state, frozen));
    syncExpiry();
  };

  // ---- run resources ---------------------------------------------------------

  const endAttempt = (): void => {
    cancelAttemptTimer?.();
    cancelAttemptTimer = undefined;
    abortAttempt?.();
    abortAttempt = undefined;
  };

  const endRun = (): void => {
    endAttempt();
    cancelRetry?.();
    cancelRetry = undefined;
    cancelDeadline?.();
    cancelDeadline = undefined;
    stopListeningOnline?.();
    stopListeningOnline = undefined;
    runStartedAt = undefined;
  };

  // ---- waiters ---------------------------------------------------------------

  const error = (code: WakeItReadinessError["code"], message?: string): WakeItReadinessError =>
    new WakeItReadinessError(code, {
      backend: id,
      attempts: read().attempts,
      elapsedMs: runStartedAt === undefined ? 0 : now() - runStartedAt,
      ...(message === undefined ? {} : { message }),
    });

  const settleAll = (outcome: WakeItReadinessError | undefined): void => {
    const all = [...waiters];
    waiters.clear();
    for (const waiter of all) {
      waiter.detach();
      if (outcome === undefined) waiter.resolve();
      else waiter.reject(outcome);
    }
  };

  // ---- the interpreter -------------------------------------------------------

  const startAttempt = (token: number): void => {
    const controller = new AbortController();
    abortAttempt = () => controller.abort();
    // The attempt timer covers the request AND the validator; a late result is discarded by token.
    cancelAttemptTimer = startTimer(
      () => dispatch({ type: "ATTEMPT_FAILED", token, reason: "timeout", online: true }),
      backend.health.timeoutMs,
    );
    // `probe` never rejects; the catch is for unexpected errors in this callback or the
    // dispatch it triggers (for example a throwing online source). The attempt timer still ends
    // the attempt, so the run cannot hang.
    probe(backend, deps.fetch, controller.signal)
      .then((result) =>
        dispatch(
          result.ok
            ? { type: "ATTEMPT_READY", token }
            : {
                type: "ATTEMPT_FAILED",
                token,
                reason: result.reason,
                online: deps.online.isOnline(),
              },
        ),
      )
      .catch((error: unknown) => reportSafely(deps.reportError, error));
  };

  const apply = (effect: RunEffect): void => {
    switch (effect.type) {
      case "begin":
        runStartedAt = now();
        beforeRun = read();
        commit({ backend: id, status: "checking", attempts: 0 });
        cancelDeadline = startTimer(
          () => dispatch({ type: "DEADLINE" }),
          backend.poll.maxDurationMs,
        );
        stopListeningOnline = deps.online.onOnline(() => dispatch({ type: "ONLINE" }));
        break;
      case "attempt":
        startAttempt(effect.token);
        break;
      case "status":
        commit({
          backend: id,
          status: effect.status,
          reason: effect.reason,
          attempts: effect.attempts,
          checkedAt: now(),
        });
        break;
      case "wait":
        cancelRetry = startTimer(
          () => dispatch({ type: "RETRY_DUE", token: effect.token }),
          effect.ms,
        );
        break;
      case "ready": {
        endRun();
        const t = now();
        commit({
          backend: id,
          status: "ready",
          attempts: effect.attempts,
          checkedAt: t,
          validUntil: t + backend.readyTtlMs,
        });
        settleAll(undefined);
        break;
      }
      case "exhausted": {
        const failure = error(effect.code);
        endRun();
        settleAll(failure);
        break;
      }
      case "stop":
        endRun();
        // No evidence came from this run: do not leave the status claiming a check is running.
        if (read().status === "checking" && beforeRun !== undefined) commit(beforeRun);
        break;
    }
  };

  function dispatch(event: RunEvent): void {
    if (disposed) return;
    const transition = step(run, event, policy);
    if (transition.state === run) return; // ignored: invalid in this state, or a stale token
    run = transition.state;
    // Leaving a phase releases that phase's timers before the effects start new ones.
    endAttempt();
    cancelRetry?.();
    cancelRetry = undefined;
    for (const effect of transition.effects) apply(effect);
  }

  // ---- public ----------------------------------------------------------------

  const leave = (waiter: Waiter): void => {
    // Reached only through the waiter's own abort listener, which is removed whenever the
    // waiter settles, so the waiter is always still registered here.
    waiters.delete(waiter);
    waiter.detach();
    waiter.reject(error("aborted"));
    // Only this waiter is removed. The shared run stops only when nobody is left (AD-22).
    if (waiters.size === 0) dispatch({ type: "STOP" });
  };

  return {
    ensureReady(signal) {
      if (signal?.aborted === true) return Promise.reject(error("aborted"));
      if (isFresh(read(), now())) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const waiter: Waiter = { resolve, reject, detach: () => undefined };
        if (signal !== undefined) {
          const onAbort = (): void => leave(waiter);
          signal.addEventListener("abort", onAbort, { once: true });
          waiter.detach = () => signal.removeEventListener("abort", onAbort);
        }
        waiters.add(waiter);
        if (run.phase === "idle") dispatch({ type: "JOIN" });
      });
    },

    syncExpiry,

    dispose() {
      if (disposed) return;
      const wasRunning = run.phase !== "idle";
      const failure = error("aborted", "The WakeIt client was disposed.");
      disposed = true;
      endRun();
      cancelExpiry?.();
      cancelExpiry = undefined;
      run = IDLE_RUN;
      if (wasRunning && read().status === "checking" && beforeRun !== undefined) {
        store.commit((state) => withReadiness(state, beforeRun as ReadinessSnapshot));
      }
      settleAll(failure);
    },
  };
}
