import { afterEach, describe, expect, it, vi } from "vitest";
import { createEngine } from "./engine";
import { WakeItConfigError } from "./errors";
import { EMPTY_OPERATIONS } from "./state";
import type { WakeItConfig } from "./types";

const config: WakeItConfig = { backend: { health: "https://api.example.com/health" } };
const flushed = (): Promise<void> => Promise.resolve();

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("engine creation", () => {
  it("throws WakeItConfigError for an invalid config and creates nothing", () => {
    expect(() => createEngine("nope" as unknown as WakeItConfig)).toThrow(WakeItConfigError);
  });

  it("starts no timers and makes no network requests", () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const engine = createEngine(config);
    engine.store.subscribe(() => undefined);
    expect(vi.getTimerCount()).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    engine.dispose();
  });

  it("starts with every configured backend unknown and no operations", () => {
    const engine = createEngine({
      backends: { auth: { health: "/a" }, api: { health: "/b" } },
    });
    const state = engine.store.getState();
    expect(Object.keys(state.readiness).sort()).toEqual(["api", "auth"]);
    expect(state.readiness["auth"]).toEqual({ backend: "auth", status: "unknown", attempts: 0 });
    expect(state.operations).toBe(EMPTY_OPERATIONS);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.readiness)).toBe(true);
    expect(Object.isFrozen(state.readiness["auth"])).toBe(true);
  });

  it("works without any backend: empty readiness state, no backends configured (O-7)", () => {
    const engine = createEngine({});
    expect(engine.config.backends).toEqual({});
    const state = engine.store.getState();
    expect(state.readiness).toEqual({});
    expect(state.operations).toBe(EMPTY_OPERATIONS);
    engine.dispose();
  });

  it("exposes normalized, frozen configuration", () => {
    const engine = createEngine(config);
    expect(engine.config.backends["default"]?.health.url).toBe("https://api.example.com/health");
    expect(Object.isFrozen(engine)).toBe(true);
    expect(Object.isFrozen(engine.config)).toBe(true);
  });
});

describe("independence", () => {
  it("keeps state, subscribers and events separate between engines", async () => {
    const a = createEngine(config);
    const b = createEngine(config);
    const listenerA = vi.fn();
    const listenerB = vi.fn();
    a.store.subscribe(listenerA);
    b.store.subscribe(listenerB);

    a.store.commit((s) => ({ ...s, operations: [] }));
    await flushed();

    expect(listenerA).toHaveBeenCalledTimes(1);
    expect(listenerB).not.toHaveBeenCalled();
    expect(b.store.getState().operations).toBe(EMPTY_OPERATIONS);
  });

  it("disposing one engine does not affect another", async () => {
    const a = createEngine(config);
    const b = createEngine(config);
    const listenerB = vi.fn();
    b.store.subscribe(listenerB);
    a.dispose();
    b.store.commit((s) => ({ ...s, operations: [] }));
    await flushed();
    expect(b.isDisposed()).toBe(false);
    expect(listenerB).toHaveBeenCalledTimes(1);
  });

  it("does not mutate or retain the caller's config", () => {
    const input = { backend: { health: "/h" }, thresholdMs: 10 };
    const snapshot = JSON.stringify(input);
    const engine = createEngine(input);
    input.thresholdMs = 99;
    expect(JSON.stringify({ backend: input.backend, thresholdMs: 10 })).toBe(snapshot);
    expect(engine.config.thresholdMs).toBe(10);
  });
});

describe("lifecycle: active to disposed", () => {
  it("is terminal and idempotent", () => {
    const cleanup = vi.fn();
    const engine = createEngine(config);
    engine.scope.add(cleanup);
    expect(engine.isDisposed()).toBe(false);
    engine.dispose();
    engine.dispose();
    expect(engine.isDisposed()).toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("releases owned resources: timers and listeners are gone after dispose", () => {
    vi.useFakeTimers();
    const target = new EventTarget();
    const handler = vi.fn();
    const engine = createEngine(config);

    const timer = setTimeout(() => undefined, 1000);
    engine.scope.add(() => clearTimeout(timer));
    target.addEventListener("x", handler);
    engine.scope.add(() => target.removeEventListener("x", handler));
    expect(vi.getTimerCount()).toBe(1);

    engine.dispose();
    expect(vi.getTimerCount()).toBe(0);
    target.dispatchEvent(new Event("x"));
    expect(handler).not.toHaveBeenCalled();
  });

  it("runs a late-registered resource's cleanup immediately after dispose", () => {
    const cleanup = vi.fn();
    const engine = createEngine(config);
    engine.dispose();
    engine.scope.add(cleanup);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("releases scope resources before the store: cleanups can still commit", () => {
    const engine = createEngine(config);
    const marker = [{ id: "op-1" }] as unknown as never[];
    engine.scope.add(() => engine.store.commit((s) => ({ ...s, operations: marker })));
    engine.dispose();
    expect(engine.store.getState().operations).toBe(marker);
  });

  it("drops subscribers and pending notifications, and keeps the last snapshot", async () => {
    const engine = createEngine(config);
    const listener = vi.fn();
    const observer = vi.fn();
    engine.store.subscribe(listener);
    engine.store.observe(observer);
    engine.store.commit((s) => ({ ...s, operations: [] }));
    engine.dispose();
    await flushed();
    expect(listener).not.toHaveBeenCalled();
    expect(observer).not.toHaveBeenCalled();
    expect(engine.store.getState().readiness["default"]?.status).toBe("unknown");
  });

  it("contains cleanup errors and still disposes the store", () => {
    const reportError = vi.fn();
    const engine = createEngine(config, { reportError });
    const boom = new Error("cleanup failed");
    engine.scope.add(() => {
      throw boom;
    });
    expect(() => engine.dispose()).not.toThrow();
    expect(reportError).toHaveBeenCalledExactlyOnceWith(boom);
    const listener = vi.fn();
    engine.store.subscribe(listener)();
    expect(listener).not.toHaveBeenCalled();
  });

  it("routes contained listener errors to the injected reporter", async () => {
    const reportError = vi.fn();
    const engine = createEngine(config, { reportError });
    const boom = new Error("listener failed");
    engine.store.subscribe(() => {
      throw boom;
    });
    engine.store.commit((s) => ({ ...s, operations: [] }));
    await flushed();
    expect(reportError).toHaveBeenCalledExactlyOnceWith(boom);
  });
});
