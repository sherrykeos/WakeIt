import { WakeItConfigError } from "./errors";
import type { NormalizedBackend, NormalizedConfig, WakeItConfig } from "./types";

// Provisional defaults (DECISIONS section 3). They are engineering proposals pending
// validation, and live in one place so changing them is a one-line edit.
export const DEFAULTS = Object.freeze({
  thresholdMs: 1500,
  method: "GET",
  probeTimeoutMs: 10_000,
  pollIntervalMs: 2000,
  pollMaxDurationMs: 60_000,
  readyTtlMs: 60_000,
  backoffMultiplier: 2,
  backoffMaxDelayMs: 30_000,
  backoffJitter: 0.2,
});

/** Largest delay `setTimeout` honors; larger values fire immediately, so they are rejected. */
export const MAX_TIMER_MS = 2_147_483_647;

const TOP_LEVEL_KEYS = ["backend", "backends", "thresholdMs", "groups"] as const;
const BACKEND_KEYS = ["health", "isReady", "poll", "mayColdStart", "readyTtlMs"] as const;
const HEALTH_KEYS = ["url", "method", "headers", "timeoutMs"] as const;
const POLL_KEYS = ["intervalMs", "maxAttempts", "maxDurationMs", "backoff"] as const;
const BACKOFF_KEYS = ["multiplier", "maxDelayMs", "jitter"] as const;
const GROUP_KEYS = ["thresholdMs"] as const;

const HEADER_NAME = /^[!#$%&'*+.^_`|~\dA-Za-z-]+$/;
const METHOD = /^[A-Za-z]+$/;

type Source = Readonly<Record<string, unknown>>;

/** A null-prototype map, so user-provided keys such as `__proto__` are plain data. */
function dict<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

// ---- error helpers --------------------------------------------------------
// Messages name the option and the kind of problem. They echo numbers and types only,
// never string values, so secrets (header values, URLs) cannot leak into errors.

function describe(value: unknown): string {
  if (typeof value === "number") return String(value);
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `type ${typeof value}`;
}

function fail(path: string, problem: string, ...received: [] | [unknown]): never {
  const suffix = received.length > 0 ? ` (received ${describe(received[0])})` : "";
  throw new WakeItConfigError(`Invalid WakeIt config: \`${path}\` ${problem}${suffix}.`);
}

const join = (path: string, key: string): string => (path === "" ? key : `${path}.${key}`);

// ---- readers ---------------------------------------------------------------

function asRecord(value: unknown, path: string): Source {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(path, "must be an object", value);
  }
  return value as Source;
}

function rejectUnknownKeys(source: Source, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(source)) {
    if (!allowed.includes(key)) {
      fail(join(path, key), `is not a supported option (supported: ${allowed.join(", ")})`);
    }
  }
}

interface NumberRule {
  readonly min: number;
  readonly max?: number;
  readonly exclusive?: boolean;
  readonly integer?: boolean;
}

/** A duration in ms that will be handed to a timer: positive and within the timer range. */
const TIMER: NumberRule = { min: 0, exclusive: true, max: MAX_TIMER_MS };
/** A threshold or TTL in ms: zero allowed. */
const TIMER_OR_ZERO: NumberRule = { min: 0, max: MAX_TIMER_MS };

function satisfies(value: unknown, rule: NumberRule): value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  if (rule.integer === true && !Number.isInteger(value)) return false;
  if (rule.max !== undefined && value > rule.max) return false;
  return rule.exclusive === true ? value > rule.min : value >= rule.min;
}

function optionalNumber(
  source: Source,
  key: string,
  path: string,
  rule: NumberRule,
): number | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (!satisfies(value, rule)) {
    const kind = rule.integer === true ? "an integer" : "a finite number";
    const upper = rule.max === undefined ? "" : ` and <= ${String(rule.max)}`;
    const bound = `${rule.exclusive === true ? ">" : ">="} ${String(rule.min)}${upper}`;
    return fail(join(path, key), `must be ${kind} ${bound}`, value);
  }
  return value;
}

function optionalBoolean(source: Source, key: string, path: string): boolean | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") return fail(join(path, key), "must be a boolean", value);
  return value;
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    return fail(path, "must be a non-empty string", value);
  }
  return value.trim();
}

// ---- backend ---------------------------------------------------------------

function normalizeHeaders(value: unknown, path: string): Readonly<Record<string, string>> {
  const out = dict<string>();
  if (value === undefined) return Object.freeze(out);
  const headers = asRecord(value, path);
  for (const name of Object.keys(headers)) {
    if (!HEADER_NAME.test(name)) fail(path, `contains an invalid header name "${name}"`);
    const headerValue = headers[name];
    if (typeof headerValue !== "string") {
      fail(join(path, name), "must be a string", headerValue);
    }
    out[name] = headerValue;
  }
  return Object.freeze(out);
}

function normalizeHealth(value: unknown, path: string): NormalizedBackend["health"] {
  if (typeof value === "string") {
    return Object.freeze({
      url: nonEmptyString(value, path),
      method: DEFAULTS.method,
      headers: Object.freeze(dict<string>()),
      timeoutMs: DEFAULTS.probeTimeoutMs,
    });
  }
  if (value === undefined) return fail(path, "is required (a URL string or { url, ... })");
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(path, "must be a URL string or { url, ... }", value);
  }
  const health = asRecord(value, path);
  rejectUnknownKeys(health, HEALTH_KEYS, path);

  let method: string = DEFAULTS.method;
  if (health["method"] !== undefined) {
    const raw = health["method"];
    if (typeof raw !== "string" || !METHOD.test(raw)) {
      fail(join(path, "method"), "must be an HTTP method name such as GET", raw);
    }
    method = raw.toUpperCase();
  }

  return Object.freeze({
    url: nonEmptyString(health["url"], join(path, "url")),
    method,
    headers: normalizeHeaders(health["headers"], join(path, "headers")),
    timeoutMs: optionalNumber(health, "timeoutMs", path, TIMER) ?? DEFAULTS.probeTimeoutMs,
  });
}

function normalizeBackoff(
  value: unknown,
  path: string,
  intervalMs: number,
): NormalizedBackend["poll"]["backoff"] {
  if (value === undefined || value === false) return undefined;
  if (value !== true && (typeof value !== "object" || value === null || Array.isArray(value))) {
    return fail(path, "must be true, false or an object", value);
  }
  const backoff = value === true ? {} : (value as Source);
  rejectUnknownKeys(backoff, BACKOFF_KEYS, path);

  const maxDelayMs =
    optionalNumber(backoff, "maxDelayMs", path, TIMER) ??
    Math.min(MAX_TIMER_MS, Math.max(DEFAULTS.backoffMaxDelayMs, intervalMs));
  if (maxDelayMs < intervalMs) fail(join(path, "maxDelayMs"), "must be >= poll.intervalMs");

  return Object.freeze({
    multiplier:
      optionalNumber(backoff, "multiplier", path, { min: 1, exclusive: true }) ??
      DEFAULTS.backoffMultiplier,
    maxDelayMs,
    jitter: optionalNumber(backoff, "jitter", path, { min: 0, max: 0.5 }) ?? DEFAULTS.backoffJitter,
  });
}

function normalizePoll(value: unknown, path: string): NormalizedBackend["poll"] {
  const poll = value === undefined ? {} : asRecord(value, path);
  rejectUnknownKeys(poll, POLL_KEYS, path);
  const intervalMs = optionalNumber(poll, "intervalMs", path, TIMER) ?? DEFAULTS.pollIntervalMs;
  return Object.freeze({
    intervalMs,
    maxAttempts: optionalNumber(poll, "maxAttempts", path, { min: 1, integer: true }),
    maxDurationMs: optionalNumber(poll, "maxDurationMs", path, TIMER) ?? DEFAULTS.pollMaxDurationMs,
    backoff: normalizeBackoff(poll["backoff"], join(path, "backoff"), intervalMs),
  });
}

function normalizeBackend(value: unknown, path: string): NormalizedBackend {
  const backend = asRecord(value, path);
  rejectUnknownKeys(backend, BACKEND_KEYS, path);

  const isReady = backend["isReady"];
  if (isReady !== undefined && typeof isReady !== "function") {
    fail(join(path, "isReady"), "must be a function", isReady);
  }

  return Object.freeze({
    health: normalizeHealth(backend["health"], join(path, "health")),
    isReady: isReady as NormalizedBackend["isReady"],
    poll: normalizePoll(backend["poll"], join(path, "poll")),
    mayColdStart: optionalBoolean(backend, "mayColdStart", path) ?? false,
    readyTtlMs: optionalNumber(backend, "readyTtlMs", path, TIMER_OR_ZERO) ?? DEFAULTS.readyTtlMs,
  });
}

// ---- top level -------------------------------------------------------------

function normalizeGroups(value: unknown): NormalizedConfig["groups"] {
  const out = dict<{ readonly thresholdMs?: number }>();
  if (value === undefined) return Object.freeze(out);
  const groups = asRecord(value, "groups");
  for (const name of Object.keys(groups)) {
    if (name === "") fail("groups", "must not contain an empty group name");
    const path = join("groups", name);
    const group = asRecord(groups[name], path);
    rejectUnknownKeys(group, GROUP_KEYS, path);
    const thresholdMs = optionalNumber(group, "thresholdMs", path, TIMER_OR_ZERO);
    out[name] = Object.freeze(thresholdMs === undefined ? {} : { thresholdMs });
  }
  return Object.freeze(out);
}

function normalizeBackends(source: Source): NormalizedConfig["backends"] {
  const out = dict<NormalizedBackend>();
  const { backend, backends } = source;

  if (backend !== undefined && backends !== undefined) {
    return fail("backend", "and `backends` are mutually exclusive; provide exactly one");
  }
  if (backend !== undefined) {
    out["default"] = normalizeBackend(backend, "backend");
  } else if (backends !== undefined) {
    const map = asRecord(backends, "backends");
    const ids = Object.keys(map);
    if (ids.length === 0)
      fail("backends", "must contain at least one backend (omit it to configure none)");
    for (const id of ids) {
      if (id === "") fail("backends", "must not contain an empty backend id");
      out[id] = normalizeBackend(map[id], join("backends", id));
    }
  }
  // Neither provided: no readiness backend (valid). Plain monitoring needs none.
  return Object.freeze(out);
}

/**
 * Validates a caller-provided configuration and returns an immutable, fully defaulted copy.
 * The input is never mutated or retained. Throws `WakeItConfigError` on the first problem.
 */
export function normalizeConfig(config: WakeItConfig): NormalizedConfig {
  const source = asRecord(config, "config");
  rejectUnknownKeys(source, TOP_LEVEL_KEYS, "");

  return Object.freeze({
    thresholdMs: optionalNumber(source, "thresholdMs", "", TIMER_OR_ZERO) ?? DEFAULTS.thresholdMs,
    groups: normalizeGroups(source["groups"]),
    backends: normalizeBackends(source),
  });
}
