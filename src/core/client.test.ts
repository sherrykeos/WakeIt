import { describe, expect, it, vi } from "vitest";
import { assembleClient, createWakeIt } from "./client";
import { createEngine } from "./engine";
import { WakeItConfigError } from "./errors";
import type { WakeItConfig } from "./types";

const config: WakeItConfig = { backend: { health: "https://api.example.com/health" } };
const flushed = (): Promise<void> => Promise.resolve();

describe("createWakeIt", () => {
  it("returns a frozen client exposing only the approved core methods", () => {
    const client = createWakeIt(config);
    expect(Object.isFrozen(client)).toBe(true);
    expect(Object.keys(client).sort()).toEqual([
      "cancel",
      "dispose",
      "ensureReady",
      "execute",
      "getOperations",
      "getReadiness",
      "subscribe",
    ]);
  });

  it("throws WakeItConfigError synchronously for invalid configuration", () => {
    expect(() => createWakeIt(undefined as unknown as WakeItConfig)).toThrow(WakeItConfigError);
    expect(() => createWakeIt(null as unknown as WakeItConfig)).toThrow(WakeItConfigError);
    expect(() =>
      createWakeIt({
        backend: { health: "/h" },
        backends: { a: { health: "/h" } },
      } as unknown as WakeItConfig),
    ).toThrow(/mutually exclusive/);
    expect(() => createWakeIt({ backend: { health: "/h" }, thresholdMs: -1 })).toThrow(
      /thresholdMs/,
    );
  });

  it("creates a working client without a backend (O-7)", async () => {
    const engine = createEngine({});
    const client = assembleClient(engine);
    expect(Object.keys(createWakeIt({ thresholdMs: 100 })).sort()).toEqual([
      "cancel",
      "dispose",
      "ensureReady",
      "execute",
      "getOperations",
      "getReadiness",
      "subscribe",
    ]);
    const listener = vi.fn();
    client.subscribe(listener);
    engine.store.commit((s) => ({ ...s, operations: [] }));
    await flushed();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(() => client.dispose()).not.toThrow();
  });

  it("methods do not depend on `this`", () => {
    const { subscribe, dispose } = createWakeIt(config);
    const unsubscribe = subscribe(() => undefined);
    expect(() => unsubscribe()).not.toThrow();
    expect(() => dispose()).not.toThrow();
  });

  it("creates independent clients that work simultaneously", async () => {
    const engineA = createEngine(config);
    const engineB = createEngine(config);
    const a = assembleClient(engineA);
    const b = assembleClient(engineB);
    const listenerA = vi.fn();
    const listenerB = vi.fn();
    a.subscribe(listenerA);
    b.subscribe(listenerB);

    engineA.store.commit((s) => ({ ...s, operations: [] }));
    await flushed();
    expect(listenerA).toHaveBeenCalledTimes(1);
    expect(listenerB).not.toHaveBeenCalled();

    a.dispose();
    engineB.store.commit((s) => ({ ...s, operations: [] }));
    await flushed();
    expect(listenerB).toHaveBeenCalledTimes(1);
  });
});

describe("subscribe", () => {
  it("rejects a non-function listener with WakeItConfigError", () => {
    const client = createWakeIt(config);
    expect(() => client.subscribe(undefined as unknown as () => void)).toThrow(WakeItConfigError);
  });

  it("notifies through the public client when engine state changes", async () => {
    const engine = createEngine(config);
    const client = assembleClient(engine);
    const listener = vi.fn();
    const unsubscribe = client.subscribe(listener);
    engine.store.commit((s) => ({ ...s, operations: [] }));
    await flushed();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    engine.store.commit((s) => ({ ...s, operations: [] }));
    await flushed();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("dispose", () => {
  it("is idempotent", () => {
    const client = createWakeIt(config);
    client.dispose();
    expect(() => client.dispose()).not.toThrow();
  });

  it("makes subscribe return a harmless no-op and never notify", async () => {
    const engine = createEngine(config);
    const client = assembleClient(engine);
    client.dispose();
    const listener = vi.fn();
    const unsubscribe = client.subscribe(listener);
    engine.store.commit((s) => ({ ...s, operations: [] }));
    await flushed();
    expect(listener).not.toHaveBeenCalled();
    expect(() => unsubscribe()).not.toThrow();
  });

  it("drops subscribers registered before disposal", async () => {
    const engine = createEngine(config);
    const client = assembleClient(engine);
    const listener = vi.fn();
    client.subscribe(listener);
    engine.store.commit((s) => ({ ...s, operations: [] }));
    client.dispose();
    await flushed();
    expect(listener).not.toHaveBeenCalled();
  });
});
