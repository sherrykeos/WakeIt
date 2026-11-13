import { afterEach, describe, expect, it, vi } from "vitest";
import { createScope } from "./scope";

afterEach(() => {
  vi.useRealTimers();
});

describe("cleanup scope", () => {
  it("runs cleanups in reverse registration order on dispose", () => {
    const order: number[] = [];
    const scope = createScope(vi.fn());
    scope.add(() => order.push(1));
    scope.add(() => order.push(2));
    scope.add(() => order.push(3));
    scope.dispose();
    expect(order).toEqual([3, 2, 1]);
    expect(scope.isDisposed).toBe(true);
  });

  it("dispose is idempotent: every cleanup runs exactly once", () => {
    const cleanup = vi.fn();
    const scope = createScope(vi.fn());
    scope.add(cleanup);
    scope.dispose();
    scope.dispose();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("release runs the cleanup now, once, and removes it from the scope", () => {
    const cleanup = vi.fn();
    const scope = createScope(vi.fn());
    const release = scope.add(cleanup);
    release();
    expect(cleanup).toHaveBeenCalledTimes(1);
    release();
    scope.dispose();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("only the released cleanup is removed; the others still run on dispose", () => {
    const a = vi.fn();
    const b = vi.fn();
    const scope = createScope(vi.fn());
    const releaseA = scope.add(a);
    scope.add(b);
    releaseA();
    scope.dispose();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("registering the same function twice creates two independent entries", () => {
    const cleanup = vi.fn();
    const scope = createScope(vi.fn());
    const first = scope.add(cleanup);
    scope.add(cleanup);
    first();
    expect(cleanup).toHaveBeenCalledTimes(1);
    scope.dispose();
    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  it("add after dispose runs the cleanup immediately and returns a no-op", () => {
    const cleanup = vi.fn();
    const scope = createScope(vi.fn());
    scope.dispose();
    const release = scope.add(cleanup);
    expect(cleanup).toHaveBeenCalledTimes(1);
    release();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("a cleanup registered during dispose runs immediately", () => {
    const late = vi.fn();
    const scope = createScope(vi.fn());
    scope.add(() => scope.add(late));
    scope.dispose();
    expect(late).toHaveBeenCalledTimes(1);
  });

  it("a throwing cleanup is reported and does not stop the others", () => {
    const reportError = vi.fn();
    const boom = new Error("boom");
    const after = vi.fn();
    const before = vi.fn();
    const scope = createScope(reportError);
    scope.add(before);
    scope.add(() => {
      throw boom;
    });
    scope.add(after);
    scope.dispose();
    expect(after).toHaveBeenCalledTimes(1);
    expect(before).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledExactlyOnceWith(boom);
  });

  it("a throwing release is contained and does not run again on dispose", () => {
    const reportError = vi.fn();
    const cleanup = vi.fn(() => {
      throw new Error("once");
    });
    const scope = createScope(reportError);
    const release = scope.add(cleanup);
    expect(() => release()).not.toThrow();
    scope.dispose();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("a throwing error reporter cannot break disposal", () => {
    const after = vi.fn();
    const scope = createScope(() => {
      throw new Error("reporter broke");
    });
    scope.add(after);
    scope.add(() => {
      throw new Error("cleanup broke");
    });
    expect(() => scope.dispose()).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("leaves no timers behind when timer cleanups are registered", () => {
    vi.useFakeTimers();
    const fired = vi.fn();
    const scope = createScope(vi.fn());
    const id = setTimeout(fired, 1000);
    scope.add(() => clearTimeout(id));
    expect(vi.getTimerCount()).toBe(1);
    scope.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(fired).not.toHaveBeenCalled();
  });

  it("leaves no event listeners behind when listener cleanups are registered", () => {
    const target = new EventTarget();
    const handler = vi.fn();
    const scope = createScope(vi.fn());
    target.addEventListener("ping", handler);
    scope.add(() => target.removeEventListener("ping", handler));
    target.dispatchEvent(new Event("ping"));
    scope.dispose();
    target.dispatchEvent(new Event("ping"));
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
