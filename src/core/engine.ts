import { createExecutor, type Executor } from "../execution/executor";
import { type ErrorReporter } from "../shared/contain";
import { createScope, type CleanupScope } from "../shared/scope";
import { createReadinessService, type ReadinessService } from "../readiness/service";
import { normalizeConfig } from "./config";
import { defaultErrorReporter } from "./env";
import { createInitialState } from "./state";
import { createStore, type Store } from "./store";
import type {
  CoreState,
  EngineEvent,
  FetchLike,
  NormalizedConfig,
  OnlineSource,
  WakeItConfig,
} from "./types";

/** Injectable dependencies. Used by tests through the internal factory only (AD-14). */
export interface EngineDeps {
  /** Receives contained listener/cleanup errors. Default: the platform's `reportError`. */
  readonly reportError?: ErrorReporter;
  /** Probe transport. Default: the platform `fetch`, looked up at call time. */
  readonly fetch?: FetchLike;
  /** Connectivity source. Default: `navigator.onLine` and the `online` event, looked up lazily. */
  readonly online?: OnlineSource;
}

/**
 * Composition root of one client (internal; never exported). Owns configuration, the store
 * and the root cleanup scope, and the lifecycle `active -> disposed` (STATE_MACHINES section 1).
 * Later subsystems (readiness, execution) are composed here and register their resources
 * with `scope`.
 */
export interface Engine {
  readonly config: NormalizedConfig;
  readonly store: Store<CoreState, EngineEvent>;
  /** Root owner of resources; released in reverse order on dispose, before the store. */
  readonly scope: CleanupScope;
  readonly readiness: ReadinessService;
  readonly executor: Executor;
  isDisposed(): boolean;
  /** Terminal and idempotent. */
  dispose(): void;
}

/**
 * Builds an engine. Validates configuration (throws `WakeItConfigError`) and then only
 * allocates objects: no network, timers, listeners or global access.
 */
export function createEngine(config: WakeItConfig, deps: EngineDeps = {}): Engine {
  const normalized = normalizeConfig(config);
  const reportError = deps.reportError ?? defaultErrorReporter;
  const scope = createScope(reportError);
  const holder: { readiness?: ReadinessService } = {};
  const store = createStore<CoreState, EngineEvent>(createInitialState(normalized), reportError, {
    // Observed-expiry timers exist only while the store has subscribers (AD-21).
    onSubscriberCountChange: () => holder.readiness?.onSubscriberCountChange(),
    // Add-then-remove of an operation in one synchronous run is not an observable change.
    equals: (a, b) => a.readiness === b.readiness && a.operations === b.operations,
  });
  let disposed = false;
  const readiness = createReadinessService({
    config: normalized,
    store,
    scope,
    isDisposed: () => disposed,
    reportError,
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    ...(deps.online === undefined ? {} : { online: deps.online }),
  });
  holder.readiness = readiness;
  const executor = createExecutor({
    config: normalized,
    store,
    scope,
    // The only coupling between execution and readiness (ReadinessPort).
    readiness: {
      prepare: (backend) => readiness.prepare(backend),
      read: (backend) => readiness.getReadiness(backend),
      ensureReady: (options) => readiness.ensureReady(options),
    },
    isDisposed: () => disposed,
    reportError,
  });

  return Object.freeze({
    config: normalized,
    store,
    scope,
    readiness,
    executor,
    isDisposed: () => disposed,
    dispose() {
      if (disposed) return;
      disposed = true;
      // Subsystem resources first, the store last, so cleanups can still commit; their
      // pending notifications are then dropped together with the subscribers.
      scope.dispose();
      store.dispose();
    },
  });
}
