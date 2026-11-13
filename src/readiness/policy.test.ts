import { describe, expect, it } from "vitest";
import { normalizeConfig } from "../core/config";
import { retryDelayMs } from "./policy";

function poll(p: Record<string, unknown>) {
  const config = normalizeConfig({ backend: { health: "/h", poll: p } });
  return (config.backends["default"] as { poll: Parameters<typeof retryDelayMs>[0] }).poll;
}

describe("retryDelayMs", () => {
  it("is the fixed interval without backoff, regardless of attempt count or randomness", () => {
    const fixed = poll({ intervalMs: 250 });
    for (const attempt of [1, 2, 10]) {
      expect(retryDelayMs(fixed, attempt, () => 0.99)).toBe(250);
    }
  });

  it("grows by the multiplier from the interval and is capped at maxDelayMs", () => {
    const backoff = poll({
      intervalMs: 100,
      backoff: { multiplier: 2, maxDelayMs: 1000, jitter: 0 },
    });
    const delays = [1, 2, 3, 4, 5, 6, 7].map((n) => retryDelayMs(backoff, n, () => 0));
    expect(delays).toEqual([100, 200, 400, 800, 1000, 1000, 1000]);
  });

  it("applies jitter only downwards, within [delay*(1-jitter), delay]", () => {
    const backoff = poll({
      intervalMs: 1000,
      backoff: { multiplier: 2, maxDelayMs: 4000, jitter: 0.5 },
    });
    expect(retryDelayMs(backoff, 2, () => 0)).toBe(2000); // no jitter drawn: full delay
    expect(retryDelayMs(backoff, 2, () => 0.5)).toBe(1500);
    expect(retryDelayMs(backoff, 2, () => 0.999999)).toBeCloseTo(1000.001, 2);
    for (let r = 0; r < 1; r += 0.1) {
      const delay = retryDelayMs(backoff, 3, () => r);
      expect(delay).toBeGreaterThanOrEqual(2000);
      expect(delay).toBeLessThanOrEqual(4000);
    }
  });

  it("never exceeds maxDelayMs, even with a huge exponent", () => {
    const backoff = poll({
      intervalMs: 100,
      backoff: { multiplier: 10, maxDelayMs: 5000, jitter: 0 },
    });
    expect(retryDelayMs(backoff, 1000, () => 0)).toBe(5000);
  });

  it("uses documented defaults for `backoff: true`", () => {
    const backoff = poll({ intervalMs: 1000, backoff: true });
    expect(backoff.backoff).toEqual({ multiplier: 2, maxDelayMs: 30_000, jitter: 0.2 });
    expect(retryDelayMs(backoff, 1, () => 0)).toBe(1000);
    expect(retryDelayMs(backoff, 2, () => 0)).toBe(2000);
    expect(retryDelayMs(backoff, 2, () => 0.999999)).toBeCloseTo(1600, 0);
  });
});
