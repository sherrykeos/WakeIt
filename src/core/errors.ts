import type { ReadinessErrorCode } from "./types";

// Brand-based identification (AD-8): `instanceof` keeps working when two copies of the
// package are loaded (ESM/CJS or bundler duplication), because identity is a registry-symbol
// brand on the prototype rather than constructor identity.

const CONFIG_ERROR_BRAND = Symbol.for("wakeit.WakeItConfigError");

function hasBrand(value: unknown, brand: symbol): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Readonly<Record<symbol, unknown>>)[brand] === true
  );
}

/**
 * Invalid configuration or invalid arguments passed to WakeIt. Thrown synchronously by
 * `createWakeIt`; never carries probe headers, response bodies or other sensitive data.
 */
export class WakeItConfigError extends Error {
  static override [Symbol.hasInstance](value: unknown): boolean {
    return hasBrand(value, CONFIG_ERROR_BRAND);
  }

  constructor(message: string) {
    super(message);
  }
}

// Defined on the prototype so they are not own enumerable properties and never serialize.
Object.defineProperty(WakeItConfigError.prototype, "name", {
  value: "WakeItConfigError",
  writable: true,
  configurable: true,
});
Object.defineProperty(WakeItConfigError.prototype, CONFIG_ERROR_BRAND, { value: true });

// ---------------------------------------------------------------------------
// WakeItReadinessError (AD-8, AD-24)
// ---------------------------------------------------------------------------

const READINESS_ERROR_BRAND = Symbol.for("wakeit.WakeItReadinessError");

/**
 * Fixed messages: they never include URLs, headers, response content or error text from the
 * network or from the developer's validator. A `timeout` is not a claim that the backend is
 * down or asleep.
 */
const READINESS_MESSAGES: Readonly<Record<ReadinessErrorCode, string>> = {
  "not-ready": "The backend answered but is not ready yet.",
  unreachable: "No response could be obtained from the backend.",
  offline: "The environment reports no network connectivity.",
  timeout: "The backend did not give a usable response within the time limit.",
  "invalid-response":
    "The backend response could not be interpreted; check the `isReady` option of the backend.",
  aborted: "The readiness wait was aborted.",
};

export interface ReadinessErrorDetails {
  readonly backend: string;
  /** Probe attempts that finished (offline waits excluded) in the run that produced the error. */
  readonly attempts: number;
  /** Milliseconds since the readiness run started (0 when no run was active). */
  readonly elapsedMs: number;
  /** Overrides the default message for the code (still must not contain sensitive data). */
  readonly message?: string;
}

/**
 * Readiness could not be established. Rejects `ensureReady` (and, in the execution phase,
 * combined `execute`) **before** any application function runs. `cause` is intentionally never
 * set: network and validator errors can embed hostnames or response content.
 */
export class WakeItReadinessError extends Error {
  static override [Symbol.hasInstance](value: unknown): boolean {
    return hasBrand(value, READINESS_ERROR_BRAND);
  }

  readonly code: ReadinessErrorCode;
  readonly backend: string;
  readonly attempts: number;
  readonly elapsedMs: number;

  constructor(code: ReadinessErrorCode, details: ReadinessErrorDetails) {
    super(details.message ?? READINESS_MESSAGES[code]);
    this.code = code;
    this.backend = details.backend;
    this.attempts = details.attempts;
    this.elapsedMs = details.elapsedMs;
  }
}

Object.defineProperty(WakeItReadinessError.prototype, "name", {
  value: "WakeItReadinessError",
  writable: true,
  configurable: true,
});
Object.defineProperty(WakeItReadinessError.prototype, READINESS_ERROR_BRAND, { value: true });
