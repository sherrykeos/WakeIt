// Public configuration and client types are re-exported by src/index.ts through an
// explicit allow-list. Everything under "Internal" is never exported from any entry.

// ---------------------------------------------------------------------------
// Public: configuration (API_DESIGN section 3)
// ---------------------------------------------------------------------------

/** Probe request settings. A plain string is shorthand for `{ url }`. */
export interface HealthRequestConfig {
  readonly url: string;
  /** HTTP method of the probe. Default `"GET"`. */
  readonly method?: string;
  /** Headers sent only to the health URL. Never logged or placed in errors. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Per-attempt time limit in ms. Default 10000 (provisional). */
  readonly timeoutMs?: number;
}

/**
 * Exponential backoff for probe retries. The initial delay is `poll.intervalMs`; the delay
 * before retry n is `min(maxDelayMs, intervalMs * multiplier^(n-1))`, shortened by up to
 * `jitter` (a fraction) at random. Retries are always delayed; the first attempt is immediate.
 */
export interface BackoffConfig {
  /** Growth factor per failed attempt, > 1. Default 2 (provisional). */
  readonly multiplier?: number;
  /** Upper bound of one delay in ms, >= `intervalMs`. Default max(30000, intervalMs) (provisional). */
  readonly maxDelayMs?: number;
  /** Fraction of each delay that may be randomly removed, 0 to 0.5. Default 0.2 (provisional). */
  readonly jitter?: number;
}

/** Probe retry policy. Applies to WakeIt's own probes only, never to application requests. */
export interface PollConfig {
  /** Delay between attempts in ms. Default 2000 (provisional). */
  readonly intervalMs?: number;
  /** Maximum attempts per run. Default: bounded by `maxDurationMs` only. */
  readonly maxAttempts?: number;
  /** Run deadline in ms. Default 60000 (provisional). */
  readonly maxDurationMs?: number;
  /** `true` enables backoff with defaults; an object tunes it; absent or `false` = fixed interval. */
  readonly backoff?: boolean | BackoffConfig;
}

export interface BackendConfig {
  readonly health: string | HealthRequestConfig;
  /** Decides readiness from the probe response. Default (applied by readiness): HTTP 2xx. */
  readonly isReady?: (response: Response) => boolean | Promise<boolean>;
  readonly poll?: PollConfig;
  /** Developer declaration that this backend may sleep; gates cold-start wording. */
  readonly mayColdStart?: boolean;
  /** In-memory validity of a "ready" result in ms. Default 60000 (provisional). */
  readonly readyTtlMs?: number;
}

export interface GroupConfig {
  readonly thresholdMs?: number;
}

interface CommonConfig {
  /** Slow-operation threshold in ms. Default 1500 (provisional). */
  readonly thresholdMs?: number;
  /** Per-group overrides. Precedence: call > group > client > default. */
  readonly groups?: Readonly<Record<string, GroupConfig>>;
}

/**
 * At most one of `backend` / `backends` may be provided. With neither, the client has no
 * readiness backend: plain monitoring works, while readiness operations are rejected with
 * `WakeItConfigError` by the phases that implement them (O-7).
 */
export type WakeItConfig = CommonConfig &
  (
    | { readonly backend: BackendConfig; readonly backends?: never }
    | {
        readonly backends: Readonly<Record<string, BackendConfig>>;
        readonly backend?: never;
      }
    | { readonly backend?: never; readonly backends?: never }
  );

// ---------------------------------------------------------------------------
// Public: client
// ---------------------------------------------------------------------------

export interface EnsureReadyOptions {
  /** Backend id. Default: the backend named `"default"` (a single `backend` is `"default"`). */
  readonly backend?: string;
  /** Aborts only this caller's wait (rejects with code `aborted`); never aborts a shared probe. */
  readonly signal?: AbortSignal;
}

/**
 * The WakeIt client. Members are function-typed properties (closures), so they are safe to
 * destructure: `const { subscribe } = client`.
 * `execute`, `getOperations` and `cancel` are added by the execution phase.
 */
export interface WakeIt {
  /**
   * Resolves when the backend is ready (fresh within `readyTtlMs`), probing if needed.
   * Concurrent callers for one backend share a single probe run. Rejects with
   * `WakeItReadinessError` (before any application code) or `WakeItConfigError` (no backend
   * configured, unknown backend, invalid options); never throws synchronously.
   */
  readonly ensureReady: (options?: EnsureReadyOptions) => Promise<void>;
  /**
   * Current readiness of a backend. Never reports `ready` at or after `validUntil`: an expired
   * result reads as `unknown` with reason `expired`. Identity-stable while nothing changes.
   * Throws `WakeItConfigError` for no backend configured or an unknown/ambiguous backend id.
   */
  readonly getReadiness: (backend?: string) => ReadinessSnapshot;
  /**
   * Registers a listener that is called, at most once per microtask, after the client's
   * observable state changes (for example a readiness change). The listener receives no
   * arguments: read the new state with `getReadiness()` inside the listener. This is the
   * contract React's `useSyncExternalStore` needs.
   *
   * Returns an idempotent unsubscribe. A throwing listener cannot affect other listeners.
   * After `dispose()`, `subscribe` returns a no-op and the listener is never called.
   */
  readonly subscribe: (listener: () => void) => () => void;
  /** Releases everything the client owns. Terminal and idempotent. */
  readonly dispose: () => void;
}

// ---------------------------------------------------------------------------
// Internal: normalized configuration (never exported)
// ---------------------------------------------------------------------------

export interface NormalizedBackend {
  readonly health: {
    readonly url: string;
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
  };
  readonly isReady: ((response: Response) => boolean | Promise<boolean>) | undefined;
  readonly poll: {
    readonly intervalMs: number;
    readonly maxAttempts: number | undefined;
    readonly maxDurationMs: number;
    /** `undefined` means a fixed interval. */
    readonly backoff:
      | {
          readonly multiplier: number;
          readonly maxDelayMs: number;
          readonly jitter: number;
        }
      | undefined;
  };
  readonly mayColdStart: boolean;
  readonly readyTtlMs: number;
}

export interface NormalizedConfig {
  readonly thresholdMs: number;
  readonly groups: Readonly<Record<string, { readonly thresholdMs?: number }>>;
  /** Backend id to settings. A single `backend` is stored under the id `"default"`. */
  readonly backends: Readonly<Record<string, NormalizedBackend>>;
}

// ---------------------------------------------------------------------------
// Internal: injectable environment seams (AD-14, AD-23)
// ---------------------------------------------------------------------------

/** The probe transport: the signature of the platform `fetch`, with a string URL. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Connectivity source. The default reads `navigator.onLine` and the `online` event lazily. */
export interface OnlineSource {
  isOnline(): boolean;
  /** Calls `listener` when connectivity returns. Returns an idempotent unsubscribe. */
  onOnline(listener: () => void): () => void;
}

// ---------------------------------------------------------------------------
// State snapshots (ARCHITECTURE section 4.2). Readiness types are public (getReadiness).
// ---------------------------------------------------------------------------

export type ReadinessStatus =
  "unknown" | "checking" | "ready" | "not-ready" | "unreachable" | "offline";

export type ReadinessReason =
  "rejected" | "invalid-response" | "timeout" | "network-error" | "offline" | "expired";

export interface ReadinessSnapshot {
  readonly backend: string;
  readonly status: ReadinessStatus;
  readonly reason?: ReadinessReason;
  readonly attempts: number;
  readonly checkedAt?: number;
  readonly validUntil?: number;
}

export interface OperationSnapshot {
  readonly id: string;
  readonly kind: "request" | "readiness";
  readonly group: string;
  readonly backend?: string;
  readonly stage: "awaiting-readiness" | "running";
  readonly slowness: "quiet" | "slow";
  readonly startedAt: number;
  readonly cancellable: boolean;
  readonly cancelRequested: boolean;
}

/** The single immutable state tree of one client. Written only by engine commits. */
export interface CoreState {
  readonly readiness: Readonly<Record<string, ReadinessSnapshot>>;
  readonly operations: readonly OperationSnapshot[];
}

// ---------------------------------------------------------------------------
// Internal: events (ARCHITECTURE section 2.1). Payload carries no errors, responses or URLs.
// ---------------------------------------------------------------------------

export type ReadinessErrorCode =
  "not-ready" | "unreachable" | "offline" | "timeout" | "invalid-response" | "aborted";

export interface OperationSettledEvent {
  readonly type: "operation-settled";
  readonly id: string;
  readonly kind: "request" | "readiness";
  readonly group: string;
  readonly backend?: string;
  readonly outcome: "fulfilled" | "rejected";
  readonly origin: "readiness" | "application";
  readonly code?: ReadinessErrorCode;
  readonly slowness: "quiet" | "slow";
}

export type EngineEvent = OperationSettledEvent;
