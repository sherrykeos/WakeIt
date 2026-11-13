import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultErrorReporter,
  hasAbortController,
  now,
  platformFetch,
  platformOnlineSource,
  random,
  startTimer,
} from "./env";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("defaultErrorReporter", () => {
  it("resolves the platform reportError lazily, at call time", () => {
    // Stubbed AFTER the module was imported: proves nothing was captured at import.
    const reportError = vi.fn();
    vi.stubGlobal("reportError", reportError);
    const error = new Error("contained");
    defaultErrorReporter(error);
    expect(reportError).toHaveBeenCalledExactlyOnceWith(error);
  });

  it("drops the error without throwing when reportError is unavailable", () => {
    vi.stubGlobal("reportError", undefined);
    expect(() => defaultErrorReporter(new Error("x"))).not.toThrow();
  });

  it("ignores a non-function reportError", () => {
    vi.stubGlobal("reportError", "not a function");
    expect(() => defaultErrorReporter(new Error("x"))).not.toThrow();
  });
});

describe("startTimer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires once after the delay", () => {
    vi.useFakeTimers();
    const fired = vi.fn();
    startTimer(fired, 100);
    vi.advanceTimersByTime(99);
    expect(fired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it("cancel prevents the callback and is idempotent", () => {
    vi.useFakeTimers();
    const fired = vi.fn();
    const cancel = startTimer(fired, 100);
    cancel();
    cancel();
    vi.advanceTimersByTime(1000);
    expect(fired).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("unrefs the timer when asked, where the platform supports it", () => {
    const unref = vi.fn();
    vi.spyOn(globalThis, "setTimeout").mockReturnValue({ unref } as never);
    vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => undefined);
    startTimer(() => undefined, 10, true);
    startTimer(() => undefined, 10, false);
    expect(unref).toHaveBeenCalledTimes(1);
  });

  it("tolerates timer handles without unref (browsers)", () => {
    vi.spyOn(globalThis, "setTimeout").mockReturnValue(7 as never);
    vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => undefined);
    expect(() => startTimer(() => undefined, 10, true)()).not.toThrow();
  });
});

describe("clock, random, transport and capability lookups", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reads the clock and randomness at call time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(12_345);
    expect(now()).toBe(12_345);
    vi.spyOn(Math, "random").mockReturnValue(0.25);
    expect(random()).toBe(0.25);
  });

  it("finds the platform fetch lazily and returns undefined when absent", async () => {
    const fetchSpy = vi.fn().mockResolvedValue("response");
    vi.stubGlobal("fetch", fetchSpy);
    const transport = platformFetch();
    expect(await transport?.("https://x.test", {})).toBe("response");
    expect(fetchSpy).toHaveBeenCalledExactlyOnceWith("https://x.test", {});
    vi.stubGlobal("fetch", undefined);
    expect(platformFetch()).toBeUndefined();
  });

  it("detects AbortController availability", () => {
    expect(hasAbortController()).toBe(true);
    vi.stubGlobal("AbortController", undefined);
    expect(hasAbortController()).toBe(false);
  });
});

describe("platformOnlineSource", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is online and registers nothing where browser globals do not exist (Node, SSR)", () => {
    vi.stubGlobal("navigator", undefined);
    vi.stubGlobal("addEventListener", undefined);
    expect(platformOnlineSource.isOnline()).toBe(true);
    const off = platformOnlineSource.onOnline(() => undefined);
    expect(() => off()).not.toThrow();
  });

  it("treats a navigator without a boolean onLine as online", () => {
    vi.stubGlobal("navigator", { userAgent: "node" });
    expect(platformOnlineSource.isOnline()).toBe(true);
  });

  it("reports navigator.onLine when it exists", () => {
    vi.stubGlobal("navigator", { onLine: false });
    expect(platformOnlineSource.isOnline()).toBe(false);
    vi.stubGlobal("navigator", { onLine: true });
    expect(platformOnlineSource.isOnline()).toBe(true);
  });

  it("subscribes to the global online event and removes exactly that listener", () => {
    const add = vi.fn();
    const remove = vi.fn();
    vi.stubGlobal("addEventListener", add);
    vi.stubGlobal("removeEventListener", remove);
    const listener = vi.fn();
    const off = platformOnlineSource.onOnline(listener);
    expect(add).toHaveBeenCalledExactlyOnceWith("online", listener);
    off();
    off();
    expect(remove).toHaveBeenCalledExactlyOnceWith("online", listener);
  });

  it("tolerates a target without removeEventListener", () => {
    vi.stubGlobal("addEventListener", vi.fn());
    vi.stubGlobal("removeEventListener", undefined);
    expect(() => platformOnlineSource.onOnline(() => undefined)()).not.toThrow();
  });
});
