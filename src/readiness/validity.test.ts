import { describe, expect, it } from "vitest";
import type { ReadinessSnapshot } from "../core/types";
import { expired, isFresh, normalize } from "./validity";

const ready: ReadinessSnapshot = Object.freeze({
  backend: "default",
  status: "ready",
  attempts: 2,
  checkedAt: 1000,
  validUntil: 2000,
});

describe("freshness", () => {
  it("is fresh strictly before validUntil and expired exactly at it", () => {
    expect(isFresh(ready, 1999)).toBe(true);
    expect(isFresh(ready, 2000)).toBe(false);
    expect(isFresh(ready, 2001)).toBe(false);
  });

  it("only a ready snapshot can be fresh", () => {
    expect(isFresh({ backend: "d", status: "checking", attempts: 0 }, 0)).toBe(false);
    expect(isFresh({ backend: "d", status: "unknown", attempts: 0 }, 0)).toBe(false);
  });

  it("normalize returns a fresh snapshot unchanged (same identity)", () => {
    expect(normalize(ready, 1500)).toBe(ready);
  });

  it("normalize derives unknown/expired at or after validUntil, keeping checkedAt", () => {
    const derived = normalize(ready, 2000);
    expect(derived).toEqual({
      backend: "default",
      status: "unknown",
      reason: "expired",
      attempts: 2,
      checkedAt: 1000,
    });
    expect("validUntil" in derived).toBe(false);
    expect(Object.isFrozen(derived)).toBe(true);
  });

  it("the derived snapshot is identity-stable across reads and equals the committed one", () => {
    expect(normalize(ready, 2500)).toBe(normalize(ready, 9999));
    expect(expired(ready)).toBe(normalize(ready, 2500));
  });

  it("never alters non-ready snapshots", () => {
    const failed: ReadinessSnapshot = {
      backend: "d",
      status: "not-ready",
      reason: "rejected",
      attempts: 1,
    };
    expect(normalize(failed, 1e12)).toBe(failed);
  });

  it("works without checkedAt", () => {
    const bare: ReadinessSnapshot = { backend: "d", status: "ready", attempts: 1, validUntil: 10 };
    expect("checkedAt" in expired(bare)).toBe(false);
  });
});
