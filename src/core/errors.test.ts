import { describe, expect, it, vi } from "vitest";
import { WakeItConfigError, WakeItReadinessError } from "./errors";
import type { ReadinessErrorCode } from "./types";

describe("WakeItConfigError", () => {
  it("is an Error with a stable name and the given message", () => {
    const error = new WakeItConfigError("bad config");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(WakeItConfigError);
    expect(error.name).toBe("WakeItConfigError");
    expect(error.message).toBe("bad config");
    expect(typeof error.stack).toBe("string");
  });

  it("does not identify other values as config errors", () => {
    expect(new Error("x") instanceof WakeItConfigError).toBe(false);
    expect(new TypeError("x") instanceof WakeItConfigError).toBe(false);
    expect({ name: "WakeItConfigError", message: "x" } instanceof WakeItConfigError).toBe(false);
    for (const value of [null, undefined, 0, "WakeItConfigError", Symbol("x"), () => undefined]) {
      expect(value instanceof WakeItConfigError).toBe(false);
    }
  });

  it("is recognized across duplicated copies of the module (brand-based instanceof)", async () => {
    vi.resetModules();
    const copy = await import("./errors");
    expect(copy.WakeItConfigError).not.toBe(WakeItConfigError);

    const fromCopy = new copy.WakeItConfigError("from another copy");
    const fromThis = new WakeItConfigError("from this copy");
    expect(fromCopy instanceof WakeItConfigError).toBe(true);
    expect(fromThis instanceof copy.WakeItConfigError).toBe(true);
  });

  it("serializes without leaking anything beyond the standard error fields", () => {
    const error = new WakeItConfigError("bad config");
    expect(Object.keys(error)).toEqual([]);
    expect(JSON.stringify(error)).toBe("{}");
    expect(Object.hasOwn(error, "name")).toBe(false);
  });
});

describe("WakeItReadinessError", () => {
  const details = { backend: "api", attempts: 3, elapsedMs: 1200 };
  const codes: ReadinessErrorCode[] = [
    "not-ready",
    "unreachable",
    "offline",
    "timeout",
    "invalid-response",
    "aborted",
  ];

  it("carries a stable code, backend, attempts and elapsedMs", () => {
    const error = new WakeItReadinessError("timeout", details);
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(WakeItReadinessError);
    expect(error.name).toBe("WakeItReadinessError");
    expect(error).toMatchObject({ code: "timeout", ...details });
    expect(error.cause).toBeUndefined();
  });

  it.each(codes)("has a fixed, non-empty message for code %s", (code) => {
    const message = new WakeItReadinessError(code, details).message;
    expect(message.length).toBeGreaterThan(10);
    expect(message).not.toContain("api"); // the backend id is a field, not interpolated
  });

  it("a timeout message never claims the backend is unreachable, down or asleep", () => {
    expect(new WakeItReadinessError("timeout", details).message).not.toMatch(
      /unreachable|down|asleep|sleep|offline/i,
    );
  });

  it("allows a custom message (used for disposal)", () => {
    expect(new WakeItReadinessError("aborted", { ...details, message: "disposed" }).message).toBe(
      "disposed",
    );
  });

  it("serializes to exactly its documented fields (name and message stay off the instance)", () => {
    const error = new WakeItReadinessError("not-ready", details);
    expect(Object.keys(error).sort()).toEqual(["attempts", "backend", "code", "elapsedMs"]);
    expect(JSON.parse(JSON.stringify(error))).toEqual({ code: "not-ready", ...details });
  });

  it("is distinct from the config error, in both directions", () => {
    const readiness = new WakeItReadinessError("aborted", details);
    const config = new WakeItConfigError("x");
    expect(readiness instanceof WakeItConfigError).toBe(false);
    expect(config instanceof WakeItReadinessError).toBe(false);
    expect(new Error("x") instanceof WakeItReadinessError).toBe(false);
    expect((null as unknown) instanceof WakeItReadinessError).toBe(false);
  });

  it("is recognized across duplicated copies of the module (brand-based instanceof)", async () => {
    vi.resetModules();
    const copy = await import("./errors");
    expect(new copy.WakeItReadinessError("aborted", details) instanceof WakeItReadinessError).toBe(
      true,
    );
    expect(new WakeItReadinessError("aborted", details) instanceof copy.WakeItReadinessError).toBe(
      true,
    );
  });
});
