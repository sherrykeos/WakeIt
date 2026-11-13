import type { NormalizedBackend } from "../core/types";

/**
 * Delay before the next probe attempt (AD-19). Pure given `random`.
 *
 * @param failedAttempts counted failed attempts so far in this run, >= 1
 * @param random uniform random in [0, 1)
 *
 * Without backoff the delay is the fixed `intervalMs`. With backoff the delay grows as
 * `intervalMs * multiplier^(failedAttempts - 1)`, capped at `maxDelayMs`, and is then shortened
 * by up to `jitter` of itself, so the result is within `[delay * (1 - jitter), delay]` and
 * never exceeds `maxDelayMs`.
 */
export function retryDelayMs(
  poll: NormalizedBackend["poll"],
  failedAttempts: number,
  random: () => number,
): number {
  const { backoff, intervalMs } = poll;
  if (backoff === undefined) return intervalMs;
  const grown = intervalMs * backoff.multiplier ** (failedAttempts - 1);
  const capped = Math.min(backoff.maxDelayMs, grown);
  return capped * (1 - backoff.jitter * random());
}
