import type { ReadinessSnapshot } from "../core/types";

/** True while a `ready` snapshot is still valid. Expiry is `now >= validUntil`. */
export function isFresh(snapshot: ReadinessSnapshot, now: number): boolean {
  return (
    snapshot.status === "ready" && snapshot.validUntil !== undefined && now < snapshot.validUntil
  );
}

// Derived expired snapshots are cached per source snapshot so repeated reads are identity-stable
// and the object committed by the expiry timer is the very object reads already returned.
const expiredCache = new WeakMap<ReadinessSnapshot, ReadinessSnapshot>();

/** The `unknown` / `expired` form of a ready snapshot. `checkedAt` is kept, `validUntil` dropped. */
export function expired(snapshot: ReadinessSnapshot): ReadinessSnapshot {
  let derived = expiredCache.get(snapshot);
  if (derived === undefined) {
    derived = Object.freeze({
      backend: snapshot.backend,
      status: "unknown",
      reason: "expired",
      attempts: snapshot.attempts,
      ...(snapshot.checkedAt === undefined ? {} : { checkedAt: snapshot.checkedAt }),
    } as const);
    expiredCache.set(snapshot, derived);
  }
  return derived;
}

/**
 * Read-time normalization (AD-5, AD-21): a stored `ready` snapshot at or after `validUntil` is
 * returned as expired, with no timer involved, so it is correct even when timers are throttled.
 */
export function normalize(snapshot: ReadinessSnapshot, now: number): ReadinessSnapshot {
  return snapshot.status === "ready" && !isFresh(snapshot, now) ? expired(snapshot) : snapshot;
}
