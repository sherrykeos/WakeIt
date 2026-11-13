import { describe, expect, it, vi } from "vitest";
import { createStore } from "./store";

// A flush is scheduled as a microtask when it is first needed. Awaiting a resolved promise
// queues this test's continuation behind it, so after `await flushed()` the flush has run.
const flushed = (): Promise<void> => Promise.resolve();

interface Tree {
  readonly a: { readonly n: number };
  readonly b: { readonly n: number };
}

function setup<S = number, E = string>(initial: S) {
  const reportError = vi.fn();
  const store = createStore<S, E>(initial, reportError);
  return { store, reportError };
}

describe("snapshots", () => {
  it("returns the initial state and freezes object states", () => {
    const initial = { n: 0 };
    const { store } = setup(initial);
    expect(store.getState()).toBe(initial);
    expect(Object.isFrozen(store.getState())).toBe(true);
    expect(Reflect.set(store.getState(), "n", 5)).toBe(false);
  });

  it("is read-your-writes: getState reflects a commit immediately", () => {
    const { store } = setup(0);
    store.commit((n) => n + 1);
    expect(store.getState()).toBe(1);
    store.commit((n) => n + 1);
    expect(store.getState()).toBe(2);
  });

  it("keeps the same reference when the updater returns the same state", () => {
    const { store } = setup({ n: 0 });
    const before = store.getState();
    store.commit((s) => s);
    expect(store.getState()).toBe(before);
  });

  it("supports structural sharing: untouched slices keep their identity", () => {
    const { store } = setup<Tree>({ a: { n: 1 }, b: { n: 2 } });
    const before = store.getState();
    store.commit((s) => ({ ...s, b: { n: 3 } }));
    const after = store.getState();
    expect(after).not.toBe(before);
    expect(after.a).toBe(before.a);
    expect(after.b).not.toBe(before.b);
  });

  it("leaves state unchanged and does not notify when an updater throws", async () => {
    const { store } = setup(0);
    const listener = vi.fn();
    store.subscribe(listener);
    expect(() =>
      store.commit(() => {
        throw new Error("bad updater");
      }),
    ).toThrow("bad updater");
    await flushed();
    expect(store.getState()).toBe(0);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("subscribers", () => {
  it("notifies asynchronously (microtask), not synchronously", async () => {
    const { store } = setup(0);
    const listener = vi.fn();
    store.subscribe(listener);
    store.commit((n) => n + 1);
    expect(listener).not.toHaveBeenCalled();
    await flushed();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("coalesces many commits into one notification that sees the latest state", async () => {
    const { store } = setup(0);
    const seen: number[] = [];
    store.subscribe(() => seen.push(store.getState()));
    store.commit((n) => n + 1);
    store.commit((n) => n + 1);
    store.commit((n) => n + 1);
    await flushed();
    expect(seen).toEqual([3]);
  });

  it("does not notify when the state ends up unchanged (A to B to A)", async () => {
    const original = { n: 0 };
    const { store } = setup(original);
    const listener = vi.fn();
    store.subscribe(listener);
    store.commit(() => ({ n: 1 }));
    store.commit(() => original);
    await flushed();
    expect(listener).not.toHaveBeenCalled();
  });

  it("does not notify for a no-op commit", async () => {
    const { store } = setup({ n: 0 });
    const listener = vi.fn();
    store.subscribe(listener);
    store.commit((s) => s);
    await flushed();
    expect(listener).not.toHaveBeenCalled();
  });

  it("notifies every subscriber once, in subscription order", async () => {
    const { store } = setup(0);
    const order: string[] = [];
    store.subscribe(() => order.push("first"));
    store.subscribe(() => order.push("second"));
    store.commit((n) => n + 1);
    await flushed();
    expect(order).toEqual(["first", "second"]);
  });

  it("notifies again for later commits", async () => {
    const { store } = setup(0);
    const listener = vi.fn();
    store.subscribe(listener);
    store.commit((n) => n + 1);
    await flushed();
    store.commit((n) => n + 1);
    await flushed();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("stops notifying after unsubscribe, and unsubscribe is idempotent", async () => {
    const { store } = setup(0);
    const stays = vi.fn();
    const leaves = vi.fn();
    store.subscribe(stays);
    const unsubscribe = store.subscribe(leaves);
    unsubscribe();
    unsubscribe();
    store.commit((n) => n + 1);
    await flushed();
    expect(stays).toHaveBeenCalledTimes(1);
    expect(leaves).not.toHaveBeenCalled();
  });

  it("treats the same function subscribed twice as two independent subscriptions", async () => {
    const { store } = setup(0);
    const listener = vi.fn();
    const first = store.subscribe(listener);
    store.subscribe(listener);
    first();
    store.commit((n) => n + 1);
    await flushed();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("a listener unsubscribed during a notification pass is not called in that pass", async () => {
    const { store } = setup(0);
    const second = vi.fn();
    let unsubscribeSecond = (): void => undefined;
    store.subscribe(() => unsubscribeSecond());
    unsubscribeSecond = store.subscribe(second);
    store.commit((n) => n + 1);
    await flushed();
    expect(second).not.toHaveBeenCalled();
  });

  it("a listener subscribed during a notification pass is not called in that pass", async () => {
    const { store } = setup(0);
    const late = vi.fn();
    let subscribed = false;
    store.subscribe(() => {
      if (!subscribed) {
        subscribed = true;
        store.subscribe(late);
      }
    });
    store.commit((n) => n + 1);
    await flushed();
    expect(late).not.toHaveBeenCalled();
    store.commit((n) => n + 1);
    await flushed();
    expect(late).toHaveBeenCalledTimes(1);
  });

  it("contains listener exceptions: others still run, the error is reported once", async () => {
    const { store, reportError } = setup(0);
    const boom = new Error("listener failed");
    const after = vi.fn();
    store.subscribe(() => {
      throw boom;
    });
    store.subscribe(after);
    store.commit((n) => n + 1);
    await flushed();
    expect(after).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledExactlyOnceWith(boom);
    expect(store.getState()).toBe(1);
  });
});

describe("updates during notification", () => {
  it("handles a commit made by a listener within the same flush, without recursion", async () => {
    const { store } = setup(0);
    const seen: number[] = [];
    let depth = 0;
    let maxDepth = 0;
    store.subscribe(() => {
      depth++;
      maxDepth = Math.max(maxDepth, depth);
      seen.push(store.getState());
      if (store.getState() === 1) store.commit((n) => n + 1);
      depth--;
    });
    store.commit((n) => n + 1);
    await flushed();
    expect(seen).toEqual([1, 2]);
    expect(maxDepth).toBe(1);
    expect(store.getState()).toBe(2);
  });

  it("stops a listener that re-commits forever and reports it", async () => {
    const { store, reportError } = setup(0);
    store.subscribe(() => store.commit((n) => n + 1));
    store.commit((n) => n + 1);
    await flushed();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect((reportError.mock.calls[0]?.[0] as Error).message).toMatch(/notification loop stopped/);
  });
});

describe("subscriber count", () => {
  it("reports the count and notifies on every change, not on dispose", () => {
    const counts: number[] = [];
    const store = createStore<number, string>(0, vi.fn(), {
      onSubscriberCountChange: (n) => counts.push(n),
    });
    expect(store.subscriberCount()).toBe(0);
    const a = store.subscribe(() => undefined);
    const b = store.subscribe(() => undefined);
    store.observe(() => undefined); // observers are not subscribers
    a();
    a(); // idempotent: no extra notification
    b();
    expect(counts).toEqual([1, 2, 1, 0]);
    expect(store.subscriberCount()).toBe(0);
    const c = store.subscribe(() => undefined);
    store.dispose();
    c();
    expect(counts).toEqual([1, 2, 1, 0, 1]);
    expect(store.subscriberCount()).toBe(0);
  });

  it("contains errors thrown by the count callback", () => {
    const reportError = vi.fn();
    const boom = new Error("callback failed");
    const store = createStore<number, string>(0, reportError, {
      onSubscriberCountChange: () => {
        throw boom;
      },
    });
    expect(() => store.subscribe(() => undefined)).not.toThrow();
    expect(reportError).toHaveBeenCalledExactlyOnceWith(boom);
  });
});

describe("events", () => {
  it("delivers events to every observer in FIFO order", async () => {
    const { store } = setup(0);
    const first: string[] = [];
    const second: string[] = [];
    store.observe((e) => first.push(e));
    store.observe((e) => second.push(e));
    store.emit("one");
    store.emit("two");
    store.emit("three");
    expect(first).toEqual([]);
    await flushed();
    expect(first).toEqual(["one", "two", "three"]);
    expect(second).toEqual(["one", "two", "three"]);
  });

  it("delivers events before state subscribers, regardless of call order", async () => {
    const { store } = setup(0);
    const log: string[] = [];
    store.subscribe(() => log.push("subscriber"));
    store.observe((e) => log.push(`event:${e}`));
    store.commit((n) => n + 1);
    store.emit("a");
    store.emit("b");
    await flushed();
    expect(log).toEqual(["event:a", "event:b", "subscriber"]);
  });

  it("delivers events without a state change and does not notify subscribers", async () => {
    const { store } = setup(0);
    const subscriber = vi.fn();
    const observer = vi.fn();
    store.subscribe(subscriber);
    store.observe(observer);
    store.emit("only-event");
    await flushed();
    expect(observer).toHaveBeenCalledExactlyOnceWith("only-event");
    expect(subscriber).not.toHaveBeenCalled();
  });

  it("does not replay events on later flushes", async () => {
    const { store } = setup(0);
    const observer = vi.fn();
    store.observe(observer);
    store.emit("x");
    await flushed();
    store.commit((n) => n + 1);
    await flushed();
    expect(observer).toHaveBeenCalledTimes(1);
  });

  it("processes events emitted by an observer within the same flush, before subscribers", async () => {
    const { store } = setup(0);
    const log: string[] = [];
    store.observe((e) => {
      log.push(e);
      if (e === "first") store.emit("second");
    });
    store.subscribe(() => log.push("subscriber"));
    store.commit((n) => n + 1);
    store.emit("first");
    await flushed();
    expect(log).toEqual(["first", "second", "subscriber"]);
  });

  it("an observer removed during dispatch is not called for later events in that flush", async () => {
    const { store } = setup(0);
    const second = vi.fn();
    let removeSecond = (): void => undefined;
    store.observe(() => removeSecond());
    removeSecond = store.observe(second);
    store.emit("x");
    await flushed();
    expect(second).not.toHaveBeenCalled();
  });

  it("contains observer exceptions and keeps delivering", async () => {
    const { store, reportError } = setup(0);
    const boom = new Error("observer failed");
    const later = vi.fn();
    store.observe(() => {
      throw boom;
    });
    store.observe(later);
    store.emit("a");
    store.emit("b");
    await flushed();
    expect(later).toHaveBeenCalledTimes(2);
    expect(reportError).toHaveBeenCalledTimes(2);
  });

  it("observer unsubscribe is idempotent", async () => {
    const { store } = setup(0);
    const observer = vi.fn();
    const off = store.observe(observer);
    off();
    off();
    store.emit("x");
    await flushed();
    expect(observer).not.toHaveBeenCalled();
  });
});

describe("dispose", () => {
  it("drops pending notifications and events", async () => {
    const { store } = setup(0);
    const subscriber = vi.fn();
    const observer = vi.fn();
    store.subscribe(subscriber);
    store.observe(observer);
    store.commit((n) => n + 1);
    store.emit("pending");
    store.dispose();
    await flushed();
    expect(subscriber).not.toHaveBeenCalled();
    expect(observer).not.toHaveBeenCalled();
  });

  it("keeps returning the last committed state and ignores later writes", async () => {
    const { store } = setup(0);
    store.commit((n) => n + 5);
    store.dispose();
    store.commit((n) => n + 1);
    store.emit("ignored");
    await flushed();
    expect(store.getState()).toBe(5);
  });

  it("returns no-op unsubscribers after dispose and is idempotent", () => {
    const { store } = setup(0);
    store.dispose();
    store.dispose();
    const listener = vi.fn();
    expect(() => store.subscribe(listener)()).not.toThrow();
    expect(() => store.observe(listener)()).not.toThrow();
  });

  it("stops a flush in progress when a listener disposes the store", async () => {
    const { store } = setup(0);
    const second = vi.fn();
    store.subscribe(() => store.dispose());
    store.subscribe(second);
    store.commit((n) => n + 1);
    await flushed();
    expect(second).not.toHaveBeenCalled();
  });

  it("stops delivering when an observer disposes the store mid-flush", async () => {
    const { store } = setup(0);
    const subscriber = vi.fn();
    const later = vi.fn();
    store.observe(() => store.dispose());
    store.observe(later);
    store.subscribe(subscriber);
    store.commit((n) => n + 1);
    store.emit("a");
    store.emit("b");
    await flushed();
    expect(later).not.toHaveBeenCalled();
    expect(subscriber).not.toHaveBeenCalled();
  });

  it("does not start timers: nothing but a microtask is ever scheduled", async () => {
    vi.useFakeTimers();
    try {
      const { store } = setup(0);
      store.subscribe(() => undefined);
      store.commit((n) => n + 1);
      expect(vi.getTimerCount()).toBe(0);
      await flushed();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
