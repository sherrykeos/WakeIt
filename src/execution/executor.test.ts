import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeConfig } from "../core/config";
import { WakeItReadinessError } from "../core/errors";
import type { CoreState, EngineEvent } from "../core/types";
import { createInitialState } from "../core/state";
import { createStore } from "../core/store";
import { createScope } from "../shared/scope";
import { createExecutor, type ReadinessPort } from "./executor";

afterEach(() => vi.restoreAllMocks());

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
const outcome = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

// ---------------------------------------------------------------------------
// Exact race windows, driven through a fake ReadinessPort so each interleaving is deterministic.
describe("races at the readiness boundary (fake ReadinessPort)", () => {
  function harness() {
    const config = normalizeConfig({ backend: { health: "https://api.test/h" } });
    const reportError = vi.fn();
    const store = createStore<CoreState, EngineEvent>(createInitialState(config), reportError, {
      equals: (a, b) => a.readiness === b.readiness && a.operations === b.operations,
    });
    const scope = createScope(reportError);
    const wait = deferred();
    let disposed = false;
    const port: ReadinessPort = {
      prepare: () => "default",
      read: () => ({ backend: "default", status: "unknown", attempts: 2 }),
      ensureReady: () => wait.promise,
    };
    const executor = createExecutor({
      config,
      store,
      scope,
      readiness: port,
      isDisposed: () => disposed,
      reportError,
    });
    return { executor, wait, store, dispose: () => (disposed = true), reportError };
  }

  it("an abort between readiness resolving and the invocation wins (final abort check)", async () => {
    const { executor, wait } = harness();
    const external = new AbortController();
    const fn = vi.fn();
    const failure = outcome(executor.execute(fn, { readiness: true, signal: external.signal }));
    wait.resolve(); // readiness succeeded; the continuation is queued...
    external.abort(); // ...and the abort lands before it runs
    const error = (await failure) as WakeItReadinessError;
    expect(fn).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(WakeItReadinessError);
    expect(error.code).toBe("aborted");
    expect(error.attempts).toBe(2);
  });

  it("disposal between readiness resolving and the invocation wins", async () => {
    const { executor, wait, dispose } = harness();
    const fn = vi.fn();
    const failure = outcome(executor.execute(fn, { readiness: true }));
    wait.resolve();
    dispose();
    expect(((await failure) as WakeItReadinessError).message).toMatch(/disposed/);
    expect(fn).not.toHaveBeenCalled();
  });

  it('"proceed" never bypasses an aborted code, even when nothing else shows an abort', async () => {
    const { executor, wait } = harness();
    const fn = vi.fn();
    const failure = outcome(executor.execute(fn, { readiness: { onFailure: "proceed" } }));
    const aborted = new WakeItReadinessError("aborted", {
      backend: "default",
      attempts: 0,
      elapsedMs: 0,
    });
    wait.reject(aborted);
    expect(await failure).toBe(aborted);
    expect(fn).not.toHaveBeenCalled();
  });

  it('"proceed" bypasses an ordinary failure and passes any other rejection through', async () => {
    const a = harness();
    const fn = vi.fn(() => "ran");
    const proceeded = a.executor.execute(fn, { readiness: { onFailure: "proceed" } });
    a.wait.reject(
      new WakeItReadinessError("unreachable", { backend: "default", attempts: 1, elapsedMs: 5 }),
    );
    await expect(proceeded).resolves.toBe("ran");

    const b = harness();
    const other = new Error("unexpected");
    const rejected = outcome(b.executor.execute(fn, { readiness: { onFailure: "proceed" } }));
    b.wait.reject(other);
    expect(await rejected).toBe(other);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
