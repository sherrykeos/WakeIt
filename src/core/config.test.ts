import { describe, expect, it } from "vitest";
import { DEFAULTS, normalizeConfig } from "./config";
import { WakeItConfigError } from "./errors";
import type { WakeItConfig } from "./types";

const base = { backend: { health: "https://api.example.com/health" } } as const;

function messageOf(config: unknown): string {
  try {
    normalizeConfig(config as WakeItConfig);
  } catch (error) {
    expect(error).toBeInstanceOf(WakeItConfigError);
    return (error as Error).message;
  }
  throw new Error("expected normalizeConfig to throw");
}

describe("defaults and normalization", () => {
  it("applies provisional defaults to a minimal config", () => {
    const config = normalizeConfig(base);
    expect(config.thresholdMs).toBe(DEFAULTS.thresholdMs);
    expect(config.groups).toEqual({});
    expect(Object.keys(config.backends)).toEqual(["default"]);
    expect(config.backends["default"]).toEqual({
      health: {
        url: "https://api.example.com/health",
        method: "GET",
        headers: {},
        timeoutMs: DEFAULTS.probeTimeoutMs,
      },
      isReady: undefined,
      poll: {
        intervalMs: DEFAULTS.pollIntervalMs,
        maxAttempts: undefined,
        maxDurationMs: DEFAULTS.pollMaxDurationMs,
      },
      mayColdStart: false,
      readyTtlMs: DEFAULTS.readyTtlMs,
    });
  });

  it("keeps custom values and normalizes nested health options", () => {
    const isReady = (r: Response) => r.ok;
    const config = normalizeConfig({
      thresholdMs: 0,
      groups: { auth: { thresholdMs: 300 }, bulk: {} },
      backend: {
        health: {
          url: "  /health  ",
          method: "head",
          headers: { "X-Key": "secret" },
          timeoutMs: 500,
        },
        isReady,
        poll: { intervalMs: 100, maxAttempts: 3, maxDurationMs: 5000 },
        mayColdStart: true,
        readyTtlMs: 0,
      },
    });
    expect(config.thresholdMs).toBe(0);
    expect(config.groups).toEqual({ auth: { thresholdMs: 300 }, bulk: {} });
    const backend = config.backends["default"];
    expect(backend?.health).toEqual({
      url: "/health",
      method: "HEAD",
      headers: { "X-Key": "secret" },
      timeoutMs: 500,
    });
    expect(backend?.isReady).toBe(isReady);
    expect(backend?.poll).toEqual({ intervalMs: 100, maxAttempts: 3, maxDurationMs: 5000 });
    expect(backend?.mayColdStart).toBe(true);
    expect(backend?.readyTtlMs).toBe(0);
  });

  it("accepts named backends", () => {
    const config = normalizeConfig({
      backends: { auth: { health: "/a" }, api: { health: "/b", mayColdStart: true } },
    });
    expect(Object.keys(config.backends).sort()).toEqual(["api", "auth"]);
    expect(config.backends["api"]?.mayColdStart).toBe(true);
    expect(config.backends["auth"]?.mayColdStart).toBe(false);
  });

  it("allows no backend at all: a client without readiness (O-7)", () => {
    for (const input of [{}, { thresholdMs: 200 }, { groups: { auth: { thresholdMs: 5 } } }]) {
      const config = normalizeConfig(input);
      expect(Object.keys(config.backends)).toEqual([]);
      expect(Object.isFrozen(config.backends)).toBe(true);
    }
    expect(normalizeConfig({ thresholdMs: 200 }).thresholdMs).toBe(200);
  });

  it("treats explicitly undefined backend and backends as omitted", () => {
    const config = normalizeConfig({ backend: undefined, backends: undefined } as WakeItConfig);
    expect(Object.keys(config.backends)).toEqual([]);
  });

  it("treats explicit undefined options as omitted", () => {
    const config = normalizeConfig({
      ...base,
      thresholdMs: undefined,
    } as unknown as WakeItConfig);
    expect(config.thresholdMs).toBe(DEFAULTS.thresholdMs);
  });

  it("treats user-provided keys such as __proto__ as plain data", () => {
    const groups = JSON.parse('{"__proto__": {"thresholdMs": 5}}') as Record<string, never>;
    const config = normalizeConfig({ ...base, groups });
    expect(Object.keys(config.groups)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(config.groups)).toBeNull();
    expect(({} as { thresholdMs?: number }).thresholdMs).toBeUndefined();
  });
});

describe("poll.backoff and timer ranges", () => {
  const backoff = (value: unknown, poll: Record<string, unknown> = {}) =>
    normalizeConfig({
      backend: { health: "/h", poll: { ...poll, backoff: value } },
    } as WakeItConfig).backends["default"]?.poll;

  it("is off by default and when false", () => {
    expect(normalizeConfig(base).backends["default"]?.poll.backoff).toBeUndefined();
    expect(backoff(false)?.backoff).toBeUndefined();
    expect(backoff(undefined)?.backoff).toBeUndefined();
  });

  it("true enables the documented defaults", () => {
    expect(backoff(true)?.backoff).toEqual({
      multiplier: DEFAULTS.backoffMultiplier,
      maxDelayMs: DEFAULTS.backoffMaxDelayMs,
      jitter: DEFAULTS.backoffJitter,
    });
  });

  it("accepts a custom object and keeps it frozen", () => {
    const poll = backoff({ multiplier: 1.5, maxDelayMs: 9000, jitter: 0.5 }, { intervalMs: 500 });
    expect(poll?.backoff).toEqual({ multiplier: 1.5, maxDelayMs: 9000, jitter: 0.5 });
    expect(Object.isFrozen(poll?.backoff)).toBe(true);
  });

  it("raises the default cap to the interval when the interval is larger than 30s", () => {
    expect(backoff(true, { intervalMs: 45_000 })?.backoff?.maxDelayMs).toBe(45_000);
  });

  it("allows jitter 0 (deterministic) and the 0.5 bound", () => {
    expect(backoff({ jitter: 0 })?.backoff?.jitter).toBe(0);
    expect(backoff({ jitter: 0.5 })?.backoff?.jitter).toBe(0.5);
  });

  const bad: [string, unknown, Record<string, unknown>, RegExp][] = [
    ["a string", "yes", {}, /`backend.poll.backoff` must be true, false or an object/],
    ["null", null, {}, /`backend.poll.backoff` must be true, false or an object/],
    ["multiplier 1", { multiplier: 1 }, {}, /multiplier` must be a finite number > 1/],
    ["multiplier 0.5", { multiplier: 0.5 }, {}, /multiplier/],
    ["jitter above 0.5", { jitter: 0.51 }, {}, /jitter` must be a finite number >= 0 and <= 0.5/],
    ["negative jitter", { jitter: -0.1 }, {}, /jitter/],
    ["a zero cap", { maxDelayMs: 0 }, {}, /maxDelayMs/],
    [
      "a cap below the interval",
      { maxDelayMs: 100 },
      { intervalMs: 500 },
      /maxDelayMs` must be >= poll.intervalMs/,
    ],
    ["an unknown option", { factor: 2 }, {}, /`backend.poll.backoff.factor` is not a supported/],
  ];
  it.each(bad)("rejects %s", (_name, value, poll, expected) => {
    expect(() => backoff(value, poll)).toThrow(expected);
  });

  it("rejects durations a timer cannot honor (they would fire immediately)", () => {
    for (const backend of [
      { health: { url: "/h", timeoutMs: 2_147_483_648 } },
      { health: "/h", poll: { intervalMs: 2_147_483_648 } },
      { health: "/h", poll: { maxDurationMs: 2 ** 40 } },
      { health: "/h", readyTtlMs: 2_147_483_648 },
    ]) {
      expect(() => normalizeConfig({ backend })).toThrow(/<= 2147483647/);
    }
    expect(() => normalizeConfig({ ...base, thresholdMs: 2_147_483_648 })).toThrow(/<= 2147483647/);
    expect(() =>
      normalizeConfig({ ...base, groups: { g: { thresholdMs: 2_147_483_648 } } }),
    ).toThrow(/<= 2147483647/);
    expect(
      normalizeConfig({ backend: { health: "/h", readyTtlMs: 2_147_483_647 } }).backends["default"]
        ?.readyTtlMs,
    ).toBe(2_147_483_647);
  });
});

describe("immutability", () => {
  it("returns deeply frozen normalized configuration", () => {
    const config = normalizeConfig({
      ...base,
      groups: { g: { thresholdMs: 1 } },
      backend: { health: { url: "/h", headers: { a: "b" } } },
    });
    const backend = config.backends["default"];
    for (const value of [
      config,
      config.groups,
      config.groups["g"],
      config.backends,
      backend,
      backend?.health,
      backend?.health.headers,
      backend?.poll,
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
  });

  it("does not mutate the caller's config, even when it is frozen", () => {
    const input = Object.freeze({
      groups: Object.freeze({ g: Object.freeze({ thresholdMs: 1 }) }),
      backend: Object.freeze({
        health: Object.freeze({ url: "/h", headers: Object.freeze({ a: "b" }) }),
        poll: Object.freeze({}),
      }),
    });
    expect(() => normalizeConfig(input)).not.toThrow();
  });

  it("does not retain references to the caller's objects", () => {
    const headers = { a: "1" };
    const input = { backend: { health: { url: "/h", headers } } };
    const config = normalizeConfig(input);
    headers.a = "changed";
    input.backend.health.url = "/changed";
    expect(config.backends["default"]?.health.url).toBe("/h");
    expect(config.backends["default"]?.health.headers).toEqual({ a: "1" });
  });
});

describe("validation", () => {
  const invalid: [string, unknown, RegExp][] = [
    ["a non-object config", "nope", /`config` must be an object \(received type string\)/],
    ["a null config", null, /`config` must be an object \(received null\)/],
    ["an array config", [], /`config` must be an object \(received an array\)/],
    [
      "an unknown top-level option",
      { ...base, thresholdms: 1 },
      /`thresholdms` is not a supported/,
    ],
    [
      "both backend and backends",
      { ...base, backends: { a: { health: "/h" } } },
      /mutually exclusive/,
    ],
    [
      "empty backends",
      { backends: {} },
      /`backends` must contain at least one backend \(omit it to configure none\)/,
    ],
    ["an empty backend id", { backends: { "": { health: "/h" } } }, /empty backend id/],
    [
      "a negative threshold",
      { ...base, thresholdMs: -1 },
      /`thresholdMs` must be a finite number >= 0 and <= 2147483647 \(received -1\)/,
    ],
    ["a NaN threshold", { ...base, thresholdMs: Number.NaN }, /`thresholdMs`.*received NaN/],
    [
      "an infinite threshold",
      { ...base, thresholdMs: Infinity },
      /`thresholdMs`.*received Infinity/,
    ],
    ["a string threshold", { ...base, thresholdMs: "1500" }, /`thresholdMs`.*received type string/],
    ["groups that is not an object", { ...base, groups: 3 }, /`groups` must be an object/],
    ["an empty group name", { ...base, groups: { "": {} } }, /empty group name/],
    [
      "a group with unknown options",
      { ...base, groups: { g: { x: 1 } } },
      /`groups.g.x` is not a supported/,
    ],
    [
      "a negative group threshold",
      { ...base, groups: { g: { thresholdMs: -5 } } },
      /`groups.g.thresholdMs`/,
    ],
    ["a missing health", { backend: {} }, /`backend.health` is required/],
    [
      "an empty health url",
      { backend: { health: "   " } },
      /`backend.health` must be a non-empty string/,
    ],
    ["a health object without url", { backend: { health: {} } }, /`backend.health.url`/],
    [
      "a bad method",
      { backend: { health: { url: "/h", method: "G ET" } } },
      /`backend.health.method`/,
    ],
    [
      "a zero probe timeout",
      { backend: { health: { url: "/h", timeoutMs: 0 } } },
      /`backend.health.timeoutMs` must be a finite number > 0/,
    ],
    [
      "a bad header name",
      { backend: { health: { url: "/h", headers: { "bad name": "v" } } } },
      /invalid header name/,
    ],
    [
      "a non-string header value",
      { backend: { health: { url: "/h", headers: { a: 1 } } } },
      /`backend.health.headers.a` must be a string/,
    ],
    [
      "an unknown backend option",
      { backend: { health: "/h", retries: 3 } },
      /`backend.retries` is not a supported/,
    ],
    [
      "a non-function isReady",
      { backend: { health: "/h", isReady: true } },
      /`backend.isReady` must be a function/,
    ],
    [
      "a zero poll interval",
      { backend: { health: "/h", poll: { intervalMs: 0 } } },
      /`backend.poll.intervalMs`/,
    ],
    [
      "fractional maxAttempts",
      { backend: { health: "/h", poll: { maxAttempts: 1.5 } } },
      /`backend.poll.maxAttempts` must be an integer >= 1/,
    ],
    [
      "zero maxAttempts",
      { backend: { health: "/h", poll: { maxAttempts: 0 } } },
      /`backend.poll.maxAttempts`/,
    ],
    [
      "a negative max duration",
      { backend: { health: "/h", poll: { maxDurationMs: -1 } } },
      /`backend.poll.maxDurationMs`/,
    ],
    [
      "an unknown backoff option",
      { backend: { health: "/h", poll: { backoff: { speed: 2 } } } },
      /`backend.poll.backoff.speed` is not a supported/,
    ],
    [
      "a non-boolean mayColdStart",
      { backend: { health: "/h", mayColdStart: "yes" } },
      /`backend.mayColdStart` must be a boolean/,
    ],
    [
      "a negative readyTtlMs",
      { backend: { health: "/h", readyTtlMs: -1 } },
      /`backend.readyTtlMs`/,
    ],
    [
      "an invalid named backend",
      { backends: { api: { health: 5 } } },
      /`backends.api.health` must be a URL string or { url/,
    ],
  ];

  it.each(invalid)("rejects %s", (_name, config, expected) => {
    expect(messageOf(config)).toMatch(expected);
  });

  it("never echoes string values (URLs, header values) in error messages", () => {
    const secret = "super-secret-token";
    const messages = [
      messageOf({ backend: { health: { url: `https://x/${secret}`, timeoutMs: -1 } } }),
      messageOf({ backend: { health: { url: "/h", headers: { Authorization: 5 } } } }),
      messageOf({ backend: { health: secret, poll: { intervalMs: secret } } }),
      messageOf({ backend: { health: { url: "/h", headers: { Authorization: secret, bad: 1 } } } }),
    ];
    for (const message of messages) expect(message).not.toContain(secret);
  });

  it("reports the first problem as a WakeItConfigError", () => {
    expect(() => normalizeConfig(42 as unknown as WakeItConfig)).toThrow(WakeItConfigError);
  });
});
