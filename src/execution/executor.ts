import { hasAbortController, now, startTimer } from "../core/env";
import { MAX_TIMER_MS } from "../core/config";
import { WakeItConfigError, WakeItReadinessError } from "../core/errors";
import { withOperations } from "../core/state";
import type { Store } from "../core/store";
import type {
  CoreState,
  EngineEvent,
  ExecuteContext,
  ExecuteOptions,
  NormalizedConfig,
  OperationSnapshot,
  ReadinessErrorCode,
  ReadinessSnapshot,
} from "../core/types";
import { reportSafely, type ErrorReporter } from "../shared/contain";
import type { CleanupScope } from "../shared/scope";

/**
 * What execution needs from readiness. The engine adapts the readiness service to this shape;
 * execution never imports readiness (ARCHITECTURE section 2).
 */
export interface ReadinessPort {
  /** Throws `WakeItConfigError` for an invalid request; returns the backend id. No side effects. */
  prepare(backend?: unknown): string;
  /** Current snapshot; never reports `ready` once expired. */
  read(backend: string): ReadinessSnapshot;
  /** Resolves when ready. Rejects with `WakeItReadinessError`; `signal` removes only this caller. */
  ensureReady(options: { backend: string; signal: AbortSignal }): Promise<void>;
}

export interface ExecutorDeps {
  readonly config: NormalizedConfig;
  readonly store: Store<CoreState, EngineEvent>;
  readonly scope: CleanupScope;
  readonly readiness: ReadinessPort;
  readonly isDisposed: () => boolean;
  readonly reportError: ErrorReporter;
}

export interface Executor {
  execute<T>(
    fn: (context: ExecuteContext) => T | PromiseLike<T>,
    options?: ExecuteOptions,
  ): Promise<Awaited<T>>;
  getOperations(): readonly OperationSnapshot[];
  cancel(operationId: string): void;
}

const DEFAULT_GROUP = "default";
const OPTION_KEYS = ["group", "thresholdMs", "readiness", "cancellable", "signal", "experience"];

const configError = (message: string): WakeItConfigError =>
  new WakeItConfigError(`Invalid WakeIt usage: ${message}`);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function isSignal(value: unknown): value is AbortSignal {
  const candidate = value as Partial<AbortSignal> | null;
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof candidate.aborted === "boolean" &&
    typeof candidate.addEventListener === "function"
  );
}

interface Parsed {
  readonly group: string;
  readonly thresholdMs: number | undefined;
  /** `undefined`: plain monitoring, no readiness. */
  readonly readiness: { readonly backend: unknown; readonly proceed: boolean } | undefined;
  readonly cancellable: boolean;
  readonly signal: AbortSignal | undefined;
  readonly experience: boolean;
}

/** Validates the call. Every failure is a `WakeItConfigError` and happens before anything starts. */
function parse(fn: unknown, options: unknown): Parsed {
  if (typeof fn !== "function") throw configError("`execute` expects a function.");
  if (options !== undefined && !isRecord(options)) {
    throw configError("`execute` options must be an object.");
  }
  const o = options ?? {};
  for (const key of Object.keys(o)) {
    if (!OPTION_KEYS.includes(key)) {
      throw configError(
        `\`${key}\` is not an execute option (supported: ${OPTION_KEYS.join(", ")}).`,
      );
    }
  }
  const { group = DEFAULT_GROUP, thresholdMs, readiness, cancellable = false, signal } = o;
  if (typeof group !== "string" || group === "") {
    throw configError("`group` must be a non-empty string.");
  }
  if (
    thresholdMs !== undefined &&
    !(typeof thresholdMs === "number" && thresholdMs >= 0 && thresholdMs <= MAX_TIMER_MS)
  ) {
    throw configError("`thresholdMs` must be a number between 0 and 2147483647.");
  }
  if (typeof cancellable !== "boolean") throw configError("`cancellable` must be a boolean.");
  if (o["experience"] !== undefined && o["experience"] !== false) {
    throw configError("`experience` can only be `false`.");
  }
  if (signal !== undefined) {
    if (!isSignal(signal)) {
      throw configError("`signal` must be an AbortSignal.");
    }
  }
  let wait: Parsed["readiness"];
  if (readiness === true) wait = { backend: undefined, proceed: false };
  else if (readiness !== undefined && readiness !== false) {
    if (!isRecord(readiness)) throw configError("`readiness` must be a boolean or an object.");
    const { backend, onFailure, ...rest } = readiness;
    const unknown = Object.keys(rest)[0];
    if (unknown !== undefined) {
      throw configError(
        `\`${unknown}\` is not a readiness option (supported: backend, onFailure).`,
      );
    }
    if (onFailure !== undefined && onFailure !== "reject" && onFailure !== "proceed") {
      throw configError('`onFailure` must be "reject" or "proceed".');
    }
    wait = { backend, proceed: onFailure === "proceed" };
  }
  return {
    group,
    thresholdMs: thresholdMs,
    readiness: wait,
    cancellable,
    signal: signal,
    experience: o["experience"] === undefined,
  };
}

/** One in-flight operation, as the executor tracks it for `cancel(id)` and disposal. */
interface Live {
  readonly cancellable: boolean;
  request(): void;
  stopTimer(): void;
}

/**
 * Runs the application's functions (STATE_MACHINES section 3). Each `execute` call is an
 * operation with its own `AbortController`, threshold timer and caller-signal link, all of
 * which are released exactly once, in `settle`.
 *
 * Promise integrity: once `fn` is invoked, the returned promise is settled only from `fn`'s own
 * outcome, with the identical value or reason. Everything WakeIt does around it (state commits,
 * events, cleanup) is individually contained, so a monitoring failure can be reported but can
 * never replace or delay the business outcome.
 */
export function createExecutor(deps: ExecutorDeps): Executor {
  const { config, store, readiness, isDisposed, reportError } = deps;
  const live = new Map<string, Live>();
  let counter = 0;

  // Threshold timers stop on dispose; running functions and caller-signal links are untouched.
  deps.scope.add(() => {
    for (const operation of live.values()) operation.stopTimer();
  });

  const contained = (action: () => void): void => {
    try {
      action();
    } catch (error) {
      reportSafely(reportError, error);
    }
  };

  function execute<T>(
    fn: (context: ExecuteContext) => T | PromiseLike<T>,
    options?: ExecuteOptions,
  ): Promise<Awaited<T>> {
    let parsed: Parsed;
    let backend: string | undefined;
    try {
      parsed = parse(fn, options);
      if (!hasAbortController()) {
        throw configError("`AbortController` is not available in this environment.");
      }
      if (parsed.readiness !== undefined) backend = readiness.prepare(parsed.readiness.backend);
    } catch (error) {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- `error` is a WakeItConfigError
      return Promise.reject(error);
    }
    const { group, readiness: wait, cancellable, signal: external } = parsed;
    const startedAt = now();

    const abortedError = (): WakeItReadinessError =>
      new WakeItReadinessError("aborted", {
        backend: backend as string,
        attempts: readiness.read(backend as string).attempts,
        elapsedMs: now() - startedAt,
        ...(isDisposed() ? { message: "The WakeIt client was disposed." } : {}),
      });

    // Combined execution never starts `fn` for an already-aborted signal (O-4).
    if (wait !== undefined && external?.aborted === true) return Promise.reject(abortedError());

    return new Promise<Awaited<T>>((resolve, reject) => {
      const id = `op-${++counter}`;
      const controller = new AbortController();
      let settled = false;
      let stopTimer: (() => void) | undefined;
      // Plain execution only (combined returned above): `fn` still runs, once, with an
      // already-aborted signal.
      const preAborted = external?.aborted === true;
      let snapshot: OperationSnapshot = Object.freeze({
        id,
        kind: "request",
        group,
        ...(backend === undefined ? {} : { backend }),
        stage: wait === undefined ? "running" : "awaiting-readiness",
        slowness: "quiet",
        startedAt,
        cancellable,
        cancelRequested: preAborted,
        experience: parsed.experience,
      } satisfies OperationSnapshot);

      const update = (next: OperationSnapshot): void => {
        snapshot = Object.freeze(next);
        store.commit((state) => {
          const index = state.operations.findIndex((o) => o.id === id);
          if (index < 0) return state;
          const operations = [...state.operations];
          operations[index] = snapshot;
          return withOperations(state, operations);
        });
      };

      const request = (reason?: unknown): void => {
        if (settled || snapshot.cancelRequested) return;
        update({ ...snapshot, cancelRequested: true });
        controller.abort(reason);
      };
      const onExternalAbort = (): void => request(external?.reason);

      // Fixed order (STATE_MACHINES section 0): release resources, commit removal, queue the
      // event, then settle the caller's promise. Each internal step is contained.
      const settle = (
        ok: boolean,
        value: unknown,
        origin: "readiness" | "application",
        code?: ReadinessErrorCode,
      ): void => {
        if (settled) return;
        settled = true;
        contained(() => {
          stopTimer?.();
          stopTimer = undefined;
          external?.removeEventListener("abort", onExternalAbort);
          live.delete(id);
        });
        contained(() =>
          store.commit((state) => {
            const index = state.operations.findIndex((o) => o.id === id);
            if (index < 0) return state;
            return withOperations(
              state,
              state.operations.filter((o) => o.id !== id),
            );
          }),
        );
        contained(() =>
          store.emit({
            type: "operation-settled",
            id,
            kind: "request",
            group,
            ...(backend === undefined ? {} : { backend }),
            outcome: ok ? "fulfilled" : "rejected",
            origin,
            ...(code === undefined ? {} : { code }),
            slowness: snapshot.slowness,
          }),
        );
        if (ok) resolve(value as Awaited<T>);
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- promise integrity: the application's own rejection value, whatever it is
        else reject(value);
      };

      // Register: visible in the store from here until it settles.
      store.commit((state) => withOperations(state, [...state.operations, snapshot]));
      live.set(id, {
        cancellable,
        request: () => request(),
        stopTimer: () => {
          stopTimer?.();
          stopTimer = undefined;
        },
      });
      if (!isDisposed()) {
        const threshold =
          parsed.thresholdMs ?? config.groups[group]?.thresholdMs ?? config.thresholdMs;
        stopTimer = startTimer(
          () => {
            stopTimer = undefined;
            if (!settled) contained(() => update({ ...snapshot, slowness: "slow" }));
          },
          threshold,
          true,
        );
      }

      if (preAborted) controller.abort(external?.reason);
      else external?.addEventListener("abort", onExternalAbort, { once: true });

      /** Invokes `fn` exactly once. From here on every outcome is `fn`'s own. */
      const invoke = (): void => {
        if (snapshot.stage !== "running")
          contained(() => update({ ...snapshot, stage: "running" }));
        try {
          void Promise.resolve(fn(Object.freeze({ signal: controller.signal }))).then(
            (value) => settle(true, value, "application"),
            (reason: unknown) => settle(false, reason, "application"),
          );
        } catch (thrown) {
          settle(false, thrown, "application");
        }
      };

      if (wait === undefined) {
        invoke();
        return;
      }

      // Final abort check immediately before the invocation: an aborted or disposed operation
      // is never started (STATE_MACHINES section 5.1).
      const start = (): void => {
        if (controller.signal.aborted || isDisposed())
          settle(false, abortedError(), "readiness", "aborted");
        else invoke();
      };
      const failed = (error: unknown): void => {
        const readinessError = error instanceof WakeItReadinessError ? error : undefined;
        if (
          wait.proceed &&
          readinessError !== undefined &&
          readinessError.code !== "aborted" &&
          !controller.signal.aborted &&
          !isDisposed()
        ) {
          invoke(); // the failure stays visible in getReadiness() only
        } else settle(false, error, "readiness", readinessError?.code);
      };

      if (readiness.read(backend as string).status === "ready") start();
      else {
        void readiness
          .ensureReady({ backend: backend as string, signal: controller.signal })
          .then(start, failed);
      }
    });
  }

  return {
    execute,
    getOperations: () => store.getState().operations,
    cancel(operationId) {
      if (isDisposed()) return;
      const operation = live.get(operationId);
      if (operation?.cancellable === true) operation.request();
    },
  };
}
