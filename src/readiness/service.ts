import { hasAbortController, now, platformFetch, platformOnlineSource } from "../core/env";
import { WakeItConfigError, WakeItReadinessError } from "../core/errors";
import type { Store } from "../core/store";
import type {
  CoreState,
  EngineEvent,
  FetchLike,
  NormalizedConfig,
  OnlineSource,
  ReadinessSnapshot,
} from "../core/types";
import type { ErrorReporter } from "../shared/contain";
import type { CleanupScope } from "../shared/scope";
import { createController, type ReadinessController } from "./controller";
import { normalize } from "./validity";

export interface ReadinessServiceDeps {
  readonly config: NormalizedConfig;
  readonly store: Store<CoreState, EngineEvent>;
  readonly scope: CleanupScope;
  readonly isDisposed: () => boolean;
  /** Injected transport (tests). Default: the platform `fetch`, looked up per attempt. */
  readonly fetch?: FetchLike;
  /** Injected connectivity source (tests). Default: platform `navigator.onLine` + `online` event. */
  readonly online?: OnlineSource;
  readonly reportError: ErrorReporter;
}

/** The readiness subsystem as seen by the engine: backend selection plus per-backend controllers. */
export interface ReadinessService {
  /** Never throws synchronously: every failure is a rejection (STATE_MACHINES section 3). */
  ensureReady(options?: unknown): Promise<void>;
  /** Throws `WakeItConfigError` for no/unknown/ambiguous backend. */
  getReadiness(backend?: unknown): ReadinessSnapshot;
  /** The store's subscriber count changed: re-sync observed-expiry timers. */
  onSubscriberCountChange(): void;
}

const DEFAULT_BACKEND = "default";

function configError(message: string): WakeItConfigError {
  return new WakeItConfigError(`Invalid WakeIt usage: ${message}`);
}

export function createReadinessService(deps: ReadinessServiceDeps): ReadinessService {
  const { config, store, scope } = deps;
  // Controllers are created lazily, one per backend id (AD-4; the map exists from day one).
  const controllers = new Map<string, ReadinessController>();

  /** AD-18: never chooses a backend arbitrarily. */
  const resolveBackend = (requested: unknown): string => {
    const ids = Object.keys(config.backends);
    if (ids.length === 0) {
      throw configError(
        "no readiness backend is configured; pass `backend` or `backends` to createWakeIt.",
      );
    }
    if (requested !== undefined) {
      if (typeof requested !== "string" || requested === "") {
        throw configError("`backend` must be a non-empty string.");
      }
      if (config.backends[requested] === undefined) {
        throw configError(`unknown backend "${requested}" (configured: ${ids.join(", ")}).`);
      }
      return requested;
    }
    if (config.backends[DEFAULT_BACKEND] !== undefined) return DEFAULT_BACKEND;
    throw configError(
      `a backend id is required because none is named "${DEFAULT_BACKEND}" (configured: ${ids.join(", ")}).`,
    );
  };

  const readOptions = (options: unknown): { backend: unknown; signal: AbortSignal | undefined } => {
    if (options === undefined) return { backend: undefined, signal: undefined };
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
      throw configError("`ensureReady` options must be an object.");
    }
    const { backend, signal, ...rest } = options as Record<string, unknown>;
    const unknown = Object.keys(rest);
    if (unknown.length > 0) {
      throw configError(
        `\`${unknown[0] as string}\` is not an ensureReady option (supported: backend, signal).`,
      );
    }
    if (signal !== undefined) {
      const candidate = signal as Partial<AbortSignal>;
      if (
        typeof candidate !== "object" ||
        candidate === null ||
        typeof candidate.aborted !== "boolean" ||
        typeof candidate.addEventListener !== "function"
      ) {
        throw configError("`signal` must be an AbortSignal.");
      }
    }
    return { backend, signal: signal as AbortSignal | undefined };
  };

  const controllerFor = (id: string): ReadinessController => {
    let controller = controllers.get(id);
    if (controller === undefined) {
      controller = createController({
        id,
        backend: config.backends[id] as NonNullable<(typeof config.backends)[string]>,
        store,
        // Resolved per attempt so a global `fetch` stubbed later is honored; the up-front
        // check in ensureReady guarantees one exists.
        fetch: (input, init) => {
          const transport = deps.fetch ?? platformFetch();
          if (transport === undefined) return Promise.reject(new TypeError("fetch is unavailable"));
          return transport(input, init);
        },
        online: deps.online ?? platformOnlineSource,
        subscriberCount: () => store.subscriberCount(),
        reportError: deps.reportError,
      });
      controllers.set(id, controller);
      const created = controller;
      scope.add(() => created.dispose());
    }
    return controller;
  };

  return {
    // `async`: every failure below is a rejection, never a synchronous throw.
    async ensureReady(options) {
      const { backend, signal } = readOptions(options);
      const id = resolveBackend(backend);
      if (deps.isDisposed()) {
        throw new WakeItReadinessError("aborted", {
          backend: id,
          attempts: 0,
          elapsedMs: 0,
          message: "The WakeIt client was disposed.",
        });
      }
      if ((deps.fetch ?? platformFetch()) === undefined) {
        throw configError("no `fetch` implementation is available to probe the backend.");
      }
      if (!hasAbortController()) {
        throw configError("`AbortController` is not available in this environment.");
      }
      await controllerFor(id).ensureReady(signal);
    },

    getReadiness(backend) {
      const id = resolveBackend(backend);
      const snapshot = store.getState().readiness[id] as ReadinessSnapshot;
      // Read-time normalization; no controller needed (and none is created) just to read.
      return normalize(snapshot, now());
    },

    onSubscriberCountChange() {
      for (const controller of controllers.values()) controller.syncExpiry();
    },
  };
}
