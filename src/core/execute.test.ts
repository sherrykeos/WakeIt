import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { assembleClient } from "./client";
import { createEngine } from "./engine";
import { WakeItConfigError, WakeItReadinessError } from "./errors";
import { EMPTY_OPERATIONS } from "./state";
import type { EngineEvent, FetchLike, OperationSnapshot, WakeIt, WakeItConfig } from "./types";
import { createOnline, hangingFetch, outcome, res } from "../../tests/helpers/readiness";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}
function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

const withBackend = (poll: Record<string, unknown> = {}, extra: Partial<WakeItConfig> = {}) =>
  ({
    backend: { health: "https://api.test/health", poll: { intervalMs: 100, ...poll } },
    ...extra,
  }) as WakeItConfig;

function setup(
  config: WakeItConfig = withBackend(),
  fetch: FetchLike = () => Promise.resolve(res(200)),
) {
  const reportError = vi.fn();
  const online = createOnline();
  const engine = createEngine(config, { fetch, online: online.source, reportError });
  const client: WakeIt = assembleClient(engine);
  const events: EngineEvent[] = [];
  engine.store.observe((event) => events.push(event));
  return { engine, client, reportError, events };
}

const ops = (client: WakeIt): readonly OperationSnapshot[] => client.getOperations();

// ---------------------------------------------------------------------------
describe("basic execution and promise integrity", () => {
  it("returns a synchronous function's value and types it", async () => {
    const { client } = setup();
    const result = client.execute(() => 42);
    expectTypeOf(result).toEqualTypeOf<Promise<number>>();
    await expect(result).resolves.toBe(42);
  });

  it("returns an asynchronous function's value with the identical object", async () => {
    const { client } = setup();
    const value = { nested: [1] };
    const result = client.execute(() => Promise.resolve(value));
    expectTypeOf(result).toEqualTypeOf<Promise<{ nested: number[] }>>();
    expect(await result).toBe(value);
  });

  it("invokes fn once, synchronously, with a single { signal } argument", () => {
    const { client } = setup();
    const fn = vi.fn((_ctx: { signal: AbortSignal }) => 1);
    void client.execute(fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0]).toHaveLength(1);
    expect(fn.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);
    expect(fn.mock.calls[0]?.[0].signal.aborted).toBe(false);
  });

  it.each([
    ["Error", new Error("boom")],
    ["string", "text"],
    ["number", 0],
    ["undefined", undefined],
    ["null", null],
    ["frozen object", Object.freeze({ code: 7 })],
  ])("a synchronous throw of %s rejects with the identical value", async (_name, thrown) => {
    const { client, reportError } = setup();
    const fn = vi.fn(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- the point: any thrown value
      throw thrown;
    });
    let promise!: Promise<unknown>;
    expect(() => {
      promise = client.execute(fn);
    }).not.toThrow();
    await expect(promise).rejects.toBe(thrown);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(ops(client)).toBe(EMPTY_OPERATIONS);
    expect(reportError).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a rejected promise rejects with the identical reason, never a WakeIt error", async () => {
    const { client } = setup();
    const reason = new Error("api down");
    await expect(client.execute(() => Promise.reject(reason))).rejects.toBe(reason);
  });

  it("supports plain values, already-settled promises and thenables", async () => {
    const { client } = setup();
    await expect(client.execute(() => "plain")).resolves.toBe("plain");
    await expect(client.execute(() => Promise.resolve(1))).resolves.toBe(1);
    const thenable = { then: (ok: (v: number) => void) => ok(5) } as unknown as PromiseLike<number>;
    await expect(client.execute(() => thenable)).resolves.toBe(5);
    const failing = {
      then: (_ok: unknown, bad: (e: unknown) => void) => bad("no"),
    } as unknown as PromiseLike<number>;
    await expect(client.execute(() => failing)).rejects.toBe("no");
    const getter = {
      get then(): never {
        throw new Error("getter");
      },
    };
    await expect(client.execute(() => getter)).rejects.toThrow("getter");
  });

  it("first-wins for a thenable that settles repeatedly", async () => {
    const { client } = setup();
    const thenable = {
      then(ok: (v: string) => void, bad: (e: unknown) => void) {
        ok("first");
        ok("second");
        bad("third");
      },
    } as unknown as PromiseLike<string>;
    await expect(client.execute(() => thenable)).resolves.toBe("first");
  });

  it("never replays or retries: one invocation however long it takes", async () => {
    const { client } = setup();
    const d = deferred<string>();
    const fn = vi.fn(() => d.promise);
    const promise = client.execute(fn);
    await vi.advanceTimersByTimeAsync(60_000);
    d.reject(new Error("late"));
    await expect(promise).rejects.toThrow("late");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("a throwing subscriber or observer cannot change the outcome (monitoring isolation)", async () => {
    const { client, engine, reportError } = setup();
    client.subscribe(() => {
      throw new Error("subscriber");
    });
    engine.store.observe(() => {
      throw new Error("observer");
    });
    const reason = new Error("business");
    await expect(client.execute(() => Promise.reject(reason))).rejects.toBe(reason);
    await expect(client.execute(() => 7)).resolves.toBe(7);
    await flush();
    expect(reportError).toHaveBeenCalled();
  });

  it("a failing store commit during settlement cannot replace the business outcome", async () => {
    const { client, engine, reportError } = setup();
    const d = deferred<string>();
    const promise = client.execute(() => d.promise);
    vi.spyOn(engine.store, "commit").mockImplementation(() => {
      throw new Error("store broke");
    });
    d.resolve("business value");
    await expect(promise).resolves.toBe("business value");
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
describe("invalid usage", () => {
  it.each([
    ["non-function fn", () => undefined, "nope"],
    ["unknown option", { colour: 1 }, undefined],
    ["bad group", { group: "" }, undefined],
    ["bad threshold", { thresholdMs: -1 }, undefined],
    ["bad cancellable", { cancellable: "yes" }, undefined],
    ["bad signal", { signal: {} }, undefined],
    ["experience true", { experience: true }, undefined],
    ["bad readiness", { readiness: "yes" }, undefined],
    ["bad onFailure", { readiness: { onFailure: "retry" } }, undefined],
    ["unknown readiness option", { readiness: { retries: 3 } }, undefined],
    ["options not an object", [], undefined],
  ])("%s rejects with WakeItConfigError, never throws, creates nothing", async (name, a, b) => {
    const { client } = setup();
    const fn = vi.fn();
    const call =
      name === "non-function fn"
        ? () => (client.execute as (...args: unknown[]) => Promise<unknown>)(b ?? a)
        : () => (client.execute as (...args: unknown[]) => Promise<unknown>)(fn, a);
    let promise!: Promise<unknown>;
    expect(() => {
      promise = call();
    }).not.toThrow();
    await expect(promise).rejects.toBeInstanceOf(WakeItConfigError);
    expect(fn).not.toHaveBeenCalled();
    expect(ops(client)).toBe(EMPTY_OPERATIONS);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects when AbortController is unavailable, without invoking fn", async () => {
    vi.stubGlobal("AbortController", undefined);
    const { client } = setup();
    const fn = vi.fn();
    await expect(client.execute(fn)).rejects.toBeInstanceOf(WakeItConfigError);
    expect(fn).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

// ---------------------------------------------------------------------------
describe("operation lifecycle and snapshots", () => {
  it("registers a running operation immediately and removes it on settlement", async () => {
    const { client } = setup();
    const d = deferred<number>();
    const promise = client.execute(() => d.promise, { group: "auth" });
    const [op] = ops(client);
    expect(ops(client)).toHaveLength(1);
    expect(op).toMatchObject({
      kind: "request",
      group: "auth",
      stage: "running",
      slowness: "quiet",
      cancellable: false,
      cancelRequested: false,
      experience: true,
    });
    expect(op?.backend).toBeUndefined();
    expect(Object.isFrozen(op)).toBe(true);
    expect(Object.isFrozen(ops(client))).toBe(true);
    d.resolve(1);
    await promise;
    expect(ops(client)).toBe(EMPTY_OPERATIONS);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("assigns unique stable ids and keeps concurrent operations independent", async () => {
    const { client } = setup();
    const a = deferred<string>();
    const b = deferred<string>();
    const pa = client.execute(() => a.promise);
    const pb = client.execute(() => b.promise, { cancellable: true });
    const [first, second] = ops(client);
    expect(first?.id).not.toBe(second?.id);
    b.resolve("b");
    await pb;
    expect(ops(client)).toHaveLength(1);
    expect(ops(client)[0]).toBe(first); // identity preserved for the untouched operation
    a.resolve("a");
    await expect(pa).resolves.toBe("a");
  });

  it("the operation becomes slow at the threshold (call > group > client) and never reverts", async () => {
    const { client } = setup(
      withBackend({}, { thresholdMs: 1000, groups: { g: { thresholdMs: 200 } } }),
    );
    const d = deferred();
    const byClient = client.execute(() => d.promise);
    const byGroup = client.execute(() => d.promise, { group: "g" });
    const byCall = client.execute(() => d.promise, { group: "g", thresholdMs: 50 });
    const slow = () => ops(client).map((o) => o.slowness);
    expect(slow()).toEqual(["quiet", "quiet", "quiet"]);
    await vi.advanceTimersByTimeAsync(50);
    expect(slow()).toEqual(["quiet", "quiet", "slow"]);
    await vi.advanceTimersByTimeAsync(150);
    expect(slow()).toEqual(["quiet", "slow", "slow"]);
    await vi.advanceTimersByTimeAsync(800);
    expect(slow()).toEqual(["slow", "slow", "slow"]);
    d.resolve();
    await Promise.all([byClient, byGroup, byCall]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a previously returned snapshot is never mutated", async () => {
    const { client } = setup();
    const d = deferred();
    const promise = client.execute(() => d.promise, { cancellable: true, thresholdMs: 10 });
    const before = ops(client);
    const op = before[0] as OperationSnapshot;
    await vi.advanceTimersByTimeAsync(10);
    client.cancel(op.id);
    expect(op.slowness).toBe("quiet");
    expect(op.cancelRequested).toBe(false);
    expect(ops(client)[0]).toMatchObject({ slowness: "slow", cancelRequested: true });
    expect(before).toHaveLength(1);
    d.resolve();
    await promise;
    expect(before[0]).toBe(op);
  });

  it("records experience: false and the settled event", async () => {
    const { client, events } = setup();
    const d = deferred();
    const promise = client.execute(() => d.promise, { experience: false, group: "upload" });
    expect(ops(client)[0]?.experience).toBe(false);
    d.resolve();
    await promise;
    await flush();
    expect(events).toEqual([
      expect.objectContaining({
        type: "operation-settled",
        kind: "request",
        group: "upload",
        outcome: "fulfilled",
        origin: "application",
        slowness: "quiet",
      }),
    ]);
  });

  it("the settled event carries origin, code and slowness without error objects", async () => {
    const { client, events } = setup(withBackend({ maxAttempts: 1 }), () =>
      Promise.resolve(res(503)),
    );
    const failure = outcome(client.execute(() => 1, { readiness: true }));
    await vi.runAllTimersAsync();
    await failure;
    const app = outcome(client.execute(() => Promise.reject(new Error("x"))));
    await app;
    await flush();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      outcome: "rejected",
      origin: "readiness",
      code: "not-ready",
    });
    expect(events[1]).toMatchObject({ outcome: "rejected", origin: "application" });
    expect(events[1]).not.toHaveProperty("code");
    expect(JSON.stringify(events)).not.toContain("Error");
  });
});

// ---------------------------------------------------------------------------
describe("subscriptions", () => {
  it("notifies once for registration and once for settlement, events before subscribers", async () => {
    const { client, engine } = setup();
    const order: string[] = [];
    engine.store.observe((e) => order.push(`event:${e.type}`));
    client.subscribe(() => order.push(`state:${ops(client).length}`));
    const d = deferred();
    const promise = client.execute(() => d.promise);
    await flush();
    expect(order).toEqual(["state:1"]);
    d.resolve();
    await promise;
    await flush();
    expect(order).toEqual(["state:1", "event:operation-settled", "state:0"]);
  });

  it("does not notify for an operation that begins and ends in one synchronous frame", async () => {
    const { client } = setup();
    const listener = vi.fn();
    client.subscribe(listener);
    await outcome(
      client.execute(() => {
        throw new Error("sync");
      }),
    );
    await flush();
    expect(listener).not.toHaveBeenCalled();
  });

  it("does not notify when a cancellation request is repeated", async () => {
    const { client } = setup();
    const d = deferred();
    const promise = client.execute(() => d.promise, { cancellable: true });
    const id = ops(client)[0]?.id as string;
    await flush();
    const listener = vi.fn();
    client.subscribe(listener);
    client.cancel(id);
    await flush();
    client.cancel(id);
    client.cancel(id);
    await flush();
    expect(listener).toHaveBeenCalledTimes(1);
    d.resolve();
    await promise;
  });

  it("a listener can start and cancel operations re-entrantly", async () => {
    const { client } = setup();
    let started = false;
    client.subscribe(() => {
      if (!started) {
        started = true;
        void client.execute(() => 1);
      }
    });
    await client.execute(() => 0);
    await flush();
    expect(ops(client)).toBe(EMPTY_OPERATIONS);
  });
});

// ---------------------------------------------------------------------------
describe("cancellation", () => {
  it("cancel(id) on a cancellable operation aborts the signal; the outcome stays fn's", async () => {
    const { client } = setup();
    let signal!: AbortSignal;
    const d = deferred<string>();
    const promise = client.execute(
      (ctx) => {
        signal = ctx.signal;
        return d.promise;
      },
      { cancellable: true },
    );
    const id = ops(client)[0]?.id as string;
    client.cancel(id);
    expect(signal.aborted).toBe(true);
    expect(ops(client)[0]).toMatchObject({ cancelRequested: true, stage: "running" });
    d.resolve("finished anyway"); // fn ignores its signal
    await expect(promise).resolves.toBe("finished anyway");
    expect(ops(client)).toBe(EMPTY_OPERATIONS);
  });

  it("does not fabricate a rejection when fn rejects with its own error after the abort", async () => {
    const { client } = setup();
    const own = new Error("own");
    const d = deferred();
    const promise = client.execute(() => d.promise, { cancellable: true });
    client.cancel(ops(client)[0]?.id as string);
    d.reject(own);
    await expect(promise).rejects.toBe(own);
  });

  it("is idempotent and a no-op for non-cancellable, unknown and settled operations", async () => {
    const { client } = setup();
    let signal!: AbortSignal;
    const d = deferred();
    const plain = client.execute((c) => ((signal = c.signal), d.promise));
    const id = ops(client)[0]?.id as string;
    client.cancel(id);
    client.cancel("op-999");
    client.cancel(undefined as unknown as string);
    expect(signal.aborted).toBe(false);
    expect(ops(client)[0]?.cancelRequested).toBe(false);
    d.resolve();
    await plain;
    client.cancel(id);

    const onAbort = vi.fn();
    const e = deferred();
    const cancellable = client.execute(
      (c) => (c.signal.addEventListener("abort", onAbort), e.promise),
      { cancellable: true },
    );
    const cid = ops(client)[0]?.id as string;
    client.cancel(cid);
    client.cancel(cid);
    expect(onAbort).toHaveBeenCalledTimes(1);
    e.resolve();
    await cancellable;
    client.cancel(cid);
  });

  it("never cancels another operation", async () => {
    const { client } = setup();
    const signals: AbortSignal[] = [];
    const d = deferred();
    const run = () =>
      client.execute((c) => (signals.push(c.signal), d.promise), { cancellable: true });
    const promises = [run(), run(), run()];
    client.cancel(ops(client)[1]?.id as string);
    expect(signals.map((s) => s.aborted)).toEqual([false, true, false]);
    d.resolve();
    await Promise.all(promises);
  });

  it("an external signal aborting during execution aborts fn's signal with the same reason", async () => {
    const { client } = setup();
    const external = new AbortController();
    let signal!: AbortSignal;
    const d = deferred();
    const promise = client.execute((c) => ((signal = c.signal), d.promise), {
      signal: external.signal,
    });
    expect(signal).not.toBe(external.signal);
    external.abort("because");
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe("because");
    expect(ops(client)[0]?.cancelRequested).toBe(true);
    d.resolve();
    await promise;
  });

  it("WakeIt never aborts the caller's signal", async () => {
    const { client } = setup();
    const external = new AbortController();
    const d = deferred();
    const promise = client.execute(() => d.promise, { signal: external.signal, cancellable: true });
    client.cancel(ops(client)[0]?.id as string);
    expect(external.signal.aborted).toBe(false);
    d.resolve();
    await promise;
    expect(external.signal.aborted).toBe(false);
  });

  it("plain execute with an already-aborted signal invokes fn once with an aborted signal", async () => {
    const { client } = setup();
    const external = new AbortController();
    external.abort("early");
    const fn = vi.fn((c: { signal: AbortSignal }) => c.signal.aborted);
    await expect(client.execute(fn, { signal: external.signal })).resolves.toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("removes the caller-signal listener exactly once on every exit path", async () => {
    const { client } = setup();
    const paths: Array<(ctl: AbortController) => Promise<unknown>> = [
      (ctl) => client.execute(() => 1, { signal: ctl.signal }),
      (ctl) =>
        outcome(
          client.execute(
            () => {
              throw new Error("x");
            },
            { signal: ctl.signal },
          ),
        ),
      (ctl) =>
        outcome(client.execute(() => Promise.reject(new Error("y")), { signal: ctl.signal })),
    ];
    for (const run of paths) {
      const ctl = new AbortController();
      const add = vi.spyOn(ctl.signal, "addEventListener");
      const remove = vi.spyOn(ctl.signal, "removeEventListener");
      await run(ctl);
      expect(add).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledTimes(1);
      expect(remove.mock.calls[0]?.[1]).toBe(add.mock.calls[0]?.[1]);
    }
  });
});

// ---------------------------------------------------------------------------
describe("combined readiness and execution", () => {
  it("waits for readiness, then invokes fn once; backend readiness alone does not settle", async () => {
    const answer = deferred<Response>();
    const fetch = vi.fn<FetchLike>(() => answer.promise);
    const { client } = setup(withBackend(), fetch);
    const fn = vi.fn(() => "value");
    const promise = client.execute(fn, { readiness: true, group: "auth" });
    expect(fn).not.toHaveBeenCalled();
    expect(ops(client)[0]).toMatchObject({
      stage: "awaiting-readiness",
      backend: "default",
      group: "auth",
    });
    answer.resolve(res(200));
    await flush();
    expect(fn).toHaveBeenCalledTimes(1);
    await expect(promise).resolves.toBe("value");
    expect(client.getReadiness().status).toBe("ready");
    expect(ops(client)).toBe(EMPTY_OPERATIONS);
  });

  it("after readiness, the operation is running until fn settles", async () => {
    const { client } = setup();
    const d = deferred<string>();
    const promise = client.execute(() => d.promise, { readiness: true });
    await flush();
    expect(ops(client)[0]).toMatchObject({ stage: "running", backend: "default" });
    d.resolve("ok");
    await promise;
  });

  it("invokes fn synchronously when readiness is already fresh, with no probe", async () => {
    const fetch = vi.fn<FetchLike>(() => Promise.resolve(res(200)));
    const { client } = setup(withBackend(), fetch);
    await client.ensureReady();
    const fn = vi.fn(() => 1);
    const promise = client.execute(fn, { readiness: true });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    await promise;
  });

  it("shares one probe run between concurrent operations", async () => {
    const fetch = vi.fn<FetchLike>(() => Promise.resolve(res(200)));
    const { client } = setup(withBackend(), fetch);
    const all = [1, 2, 3].map((n) => client.execute(() => n, { readiness: true }));
    await expect(Promise.all(all)).resolves.toEqual([1, 2, 3]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("selects the named backend", async () => {
    const urls: string[] = [];
    const fetch: FetchLike = (url) => (urls.push(url), Promise.resolve(res(200)));
    const { client } = setup(
      {
        backends: {
          auth: { health: "https://auth.test/h" },
          api: { health: "https://api.test/h" },
        },
      },
      fetch,
    );
    await client.execute(() => 1, { readiness: { backend: "api" } });
    expect(urls).toEqual(["https://api.test/h"]);
    await expect(client.execute(() => 1, { readiness: true })).rejects.toBeInstanceOf(
      WakeItConfigError,
    );
  });

  it.each([
    ["not-ready", () => Promise.resolve(res(503))],
    ["unreachable", () => Promise.reject(new TypeError("net"))],
    ["timeout", hangingFetch],
  ] as const)("a %s readiness failure rejects and never invokes fn", async (code, fetch) => {
    const { client } = setup(withBackend({ maxAttempts: 1 }, {}), fetch);
    const fn = vi.fn();
    const failure = outcome(client.execute(fn, { readiness: true }));
    await vi.runAllTimersAsync();
    const error = await failure;
    expect(error).toBeInstanceOf(WakeItReadinessError);
    expect((error as WakeItReadinessError).code).toBe(code);
    expect(fn).not.toHaveBeenCalled();
    expect(ops(client)).toBe(EMPTY_OPERATIONS);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a probe timing out at the run deadline rejects with code timeout", async () => {
    const { client } = setup(withBackend({ maxDurationMs: 500 }), hangingFetch);
    const failure = outcome(client.execute(() => 1, { readiness: true }));
    await vi.runAllTimersAsync();
    expect(((await failure) as WakeItReadinessError).code).toBe("timeout");
  });

  it('onFailure "proceed" invokes fn once after an ordinary readiness failure', async () => {
    const { client } = setup(withBackend({ maxAttempts: 1 }), () => Promise.resolve(res(503)));
    const fn = vi.fn(() => "best effort");
    const promise = client.execute(fn, { readiness: { onFailure: "proceed" } });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("best effort");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(client.getReadiness().status).toBe("not-ready"); // failure recorded in readiness only
  });

  it('"proceed" does not shorten the wait', async () => {
    const { client } = setup(withBackend({ maxAttempts: 3, intervalMs: 1000 }), () =>
      Promise.resolve(res(503)),
    );
    const fn = vi.fn();
    void client.execute(fn, { readiness: { onFailure: "proceed" } });
    await vi.advanceTimersByTimeAsync(1500);
    expect(fn).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('"proceed" does not bypass a caller abort', async () => {
    const { client } = setup(withBackend(), hangingFetch);
    const external = new AbortController();
    const fn = vi.fn();
    const failure = outcome(
      client.execute(fn, { readiness: { onFailure: "proceed" }, signal: external.signal }),
    );
    external.abort();
    const error = await failure;
    expect((error as WakeItReadinessError).code).toBe("aborted");
    expect(fn).not.toHaveBeenCalled();
  });

  it('"proceed" does not bypass client disposal', async () => {
    const { client } = setup(withBackend(), hangingFetch);
    const fn = vi.fn();
    const failure = outcome(client.execute(fn, { readiness: { onFailure: "proceed" } }));
    client.dispose();
    const error = (await failure) as WakeItReadinessError;
    expect(error.code).toBe("aborted");
    expect(error.message).toMatch(/disposed/);
    expect(fn).not.toHaveBeenCalled();
  });

  it('"proceed" does not bypass configuration errors', async () => {
    const { client } = setup({});
    const fn = vi.fn();
    await expect(
      client.execute(fn, { readiness: { onFailure: "proceed" } }),
    ).rejects.toBeInstanceOf(WakeItConfigError);
    expect(fn).not.toHaveBeenCalled();
  });

  it("no backend configured: rejects WakeItConfigError, nothing created; plain execute still works", async () => {
    const { client } = setup({});
    const fn = vi.fn(() => 1);
    await expect(client.execute(fn, { readiness: true })).rejects.toBeInstanceOf(WakeItConfigError);
    expect(fn).not.toHaveBeenCalled();
    expect(ops(client)).toBe(EMPTY_OPERATIONS);
    await expect(client.execute(fn)).resolves.toBe(1);
  });

  it("an unknown backend rejects before creating an operation", async () => {
    const { client } = setup();
    await expect(
      client.execute(() => 1, { readiness: { backend: "nope" } }),
    ).rejects.toBeInstanceOf(WakeItConfigError);
    expect(ops(client)).toBe(EMPTY_OPERATIONS);
  });

  it("missing fetch rejects with WakeItConfigError and invokes nothing", async () => {
    vi.stubGlobal("fetch", undefined);
    const engine = createEngine(withBackend(), { reportError: vi.fn() });
    const client = assembleClient(engine);
    const fn = vi.fn();
    await expect(client.execute(fn, { readiness: true })).rejects.toBeInstanceOf(WakeItConfigError);
    expect(fn).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  describe("cancellation around readiness", () => {
    it("an external abort during the wait rejects aborted, never invokes fn, stops the probe", async () => {
      const { client } = setup(withBackend(), hangingFetch);
      const external = new AbortController();
      const fn = vi.fn();
      const failure = outcome(client.execute(fn, { readiness: true, signal: external.signal }));
      await flush();
      external.abort();
      expect(((await failure) as WakeItReadinessError).code).toBe("aborted");
      expect(fn).not.toHaveBeenCalled();
      expect(ops(client)).toBe(EMPTY_OPERATIONS);
      await vi.runAllTimersAsync();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("cancel(id) during the wait works only for a cancellable operation", async () => {
      const { client } = setup(withBackend(), hangingFetch);
      const fn = vi.fn();
      const locked = outcome(client.execute(fn, { readiness: true }));
      const open = outcome(client.execute(fn, { readiness: true, cancellable: true }));
      const [lockedOp, openOp] = ops(client) as [OperationSnapshot, OperationSnapshot];
      client.cancel(lockedOp.id);
      expect(ops(client)).toHaveLength(2);
      client.cancel(openOp.id);
      expect(((await open) as WakeItReadinessError).code).toBe("aborted");
      expect(ops(client)).toHaveLength(1);
      expect(ops(client)[0]?.id).toBe(lockedOp.id); // the other operation is unaffected
      client.dispose();
      await locked;
      expect(fn).not.toHaveBeenCalled();
    });

    it("one operation leaving does not stop the probe for the others", async () => {
      const probe = deferred<Response>();
      const { client } = setup(withBackend(), () => probe.promise);
      const external = new AbortController();
      const leaving = outcome(
        client.execute(() => 1, { readiness: true, signal: external.signal }),
      );
      const staying = client.execute(() => 2, { readiness: true });
      external.abort();
      await leaving;
      probe.resolve(res(200));
      await expect(staying).resolves.toBe(2);
    });

    it("an already-aborted signal rejects aborted without invoking fn, even when readiness is fresh", async () => {
      const { client } = setup();
      const external = new AbortController();
      external.abort();
      const fn = vi.fn();
      const cold = await outcome(client.execute(fn, { readiness: true, signal: external.signal }));
      expect((cold as WakeItReadinessError).code).toBe("aborted");
      await client.ensureReady();
      const warm = await outcome(client.execute(fn, { readiness: true, signal: external.signal }));
      expect((warm as WakeItReadinessError).code).toBe("aborted");
      expect(fn).not.toHaveBeenCalled();
      expect(ops(client)).toBe(EMPTY_OPERATIONS);
    });

    it("an abort in the same tick as readiness never starts fn (final abort check)", async () => {
      const probe = deferred<Response>();
      const { client } = setup(withBackend(), () => probe.promise);
      const external = new AbortController();
      const fn = vi.fn();
      const failure = outcome(client.execute(fn, { readiness: true, signal: external.signal }));
      await flush();
      probe.resolve(res(200));
      external.abort(); // readiness resolution is already queued
      const error = await failure;
      expect(fn).not.toHaveBeenCalled();
      expect((error as WakeItReadinessError).code).toBe("aborted");
    });

    it("an abort after fn started only requests cancellation", async () => {
      const { client } = setup();
      const external = new AbortController();
      const d = deferred<string>();
      const promise = client.execute(() => d.promise, { readiness: true, signal: external.signal });
      await flush();
      external.abort();
      expect(ops(client)[0]).toMatchObject({ stage: "running", cancelRequested: true });
      d.resolve("done");
      await expect(promise).resolves.toBe("done");
    });
  });

  it("disposal during the wait rejects aborted, never invokes fn, and leaves no timers", async () => {
    const { client, reportError } = setup(withBackend(), hangingFetch);
    const fn = vi.fn();
    const failure = outcome(client.execute(fn, { readiness: true }));
    await flush();
    client.dispose();
    expect(((await failure) as WakeItReadinessError).code).toBe("aborted");
    expect(fn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(reportError).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe("disposal", () => {
  it("leaves a running function untouched and stops notifying", async () => {
    const { client, events } = setup();
    const listener = vi.fn();
    client.subscribe(listener);
    let signal!: AbortSignal;
    const d = deferred<string>();
    const promise = client.execute((c) => ((signal = c.signal), d.promise), { thresholdMs: 100 });
    await flush();
    expect(listener).toHaveBeenCalledTimes(1);
    client.dispose();
    expect(vi.getTimerCount()).toBe(0); // threshold timer released
    expect(signal.aborted).toBe(false);
    d.resolve("survives");
    await expect(promise).resolves.toBe("survives");
    await flush();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
    expect(ops(client)).toHaveLength(1); // last snapshot is kept
  });

  it("the caller-signal link survives disposal and is released on settlement", async () => {
    const { client } = setup();
    const external = new AbortController();
    const remove = vi.spyOn(external.signal, "removeEventListener");
    let signal!: AbortSignal;
    const d = deferred();
    const promise = client.execute((c) => ((signal = c.signal), d.promise), {
      signal: external.signal,
    });
    client.dispose();
    external.abort();
    expect(signal.aborted).toBe(true);
    d.resolve();
    await promise;
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("after disposal plain execute passes through untracked; readiness is aborted; cancel is a no-op", async () => {
    const { client } = setup();
    client.dispose();
    const listener = vi.fn();
    client.subscribe(listener);
    const fn = vi.fn(() => "through");
    await expect(client.execute(fn)).resolves.toBe("through");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(ops(client)).toBe(EMPTY_OPERATIONS);
    expect(vi.getTimerCount()).toBe(0);
    const blocked = vi.fn();
    const error = await outcome(client.execute(blocked, { readiness: true }));
    expect((error as WakeItReadinessError).code).toBe("aborted");
    expect(blocked).not.toHaveBeenCalled();
    client.cancel("op-1");
    await flush();
    expect(listener).not.toHaveBeenCalled();
  });

  it("an operation settling after disposal commits nothing and reports nothing", async () => {
    const { client, reportError } = setup();
    const d = deferred();
    const promise = client.execute(() => d.promise);
    client.dispose();
    const before = ops(client);
    d.resolve();
    await promise;
    expect(ops(client)).toBe(before);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("fn can dispose, cancel and inspect re-entrantly", async () => {
    const { client } = setup();
    const result = await client.execute(
      () => {
        const id = ops(client)[0]?.id as string;
        client.cancel(id);
        client.dispose();
        return ops(client).length;
      },
      { cancellable: true },
    );
    expect(result).toBe(1);
  });
});
