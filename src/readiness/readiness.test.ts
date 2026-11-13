import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assembleClient } from "../core/client";
import { createEngine } from "../core/engine";
import { createController } from "./controller";
import { WakeItConfigError, WakeItReadinessError } from "../core/errors";
import type { FetchLike, WakeItConfig } from "../core/types";
import { createOnline, hangingFetch, outcome, res } from "../../tests/helpers/readiness";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type Poll = Record<string, unknown>;
const config = (poll: Poll = {}, extra: Record<string, unknown> = {}): WakeItConfig => ({
  backend: { health: "https://api.test/health", poll: { intervalMs: 100, ...poll }, ...extra },
});

function setup(cfg: WakeItConfig, fetch: FetchLike, online = createOnline()) {
  const reportError = vi.fn();
  const engine = createEngine(cfg, { fetch, online: online.source, reportError });
  const client = assembleClient(engine);
  return { engine, client, online, reportError };
}

/** A fetch that records call times and answers from a script (last entry repeats). */
function scripted(...answers: Array<Response | Error | "hang">) {
  const times: number[] = [];
  const signals: AbortSignal[] = [];
  let i = 0;
  const fetch = vi.fn<FetchLike>((_url, init) => {
    times.push(Date.now());
    signals.push(init.signal as AbortSignal);
    const answer = answers[Math.min(i++, answers.length - 1)];
    if (answer === "hang") return hangingFetch(_url, init);
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve((answer as Response).clone());
  });
  return { fetch, times, signals };
}

const noTimers = (): void => expect(vi.getTimerCount()).toBe(0);

describe("detection", () => {
  it("HTTP 200 accepted by the default validator: ensureReady resolves and state is ready", async () => {
    const { fetch } = scripted(res(200));
    const { client } = setup(config(), fetch);
    await client.ensureReady();
    const snapshot = client.getReadiness();
    expect(snapshot).toMatchObject({ backend: "default", status: "ready", attempts: 1 });
    expect(snapshot.validUntil).toBe((snapshot.checkedAt as number) + 60_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    noTimers();
  });

  it("HTTP 200 rejected by a custom validator is not ready (rejected -> not-ready)", async () => {
    const { fetch } = scripted(res(200, '{"status":"warming"}'));
    const cfg = config(
      { maxAttempts: 2 },
      {
        isReady: async (r: Response) => ((await r.json()) as { status: string }).status === "ready",
      },
    );
    const { client } = setup(cfg, fetch);
    const failure = outcome(client.ensureReady());
    await vi.runAllTimersAsync();
    const error = (await failure) as WakeItReadinessError;
    expect(error).toBeInstanceOf(WakeItReadinessError);
    expect(error).toMatchObject({ code: "not-ready", backend: "default", attempts: 2 });
    expect(client.getReadiness()).toMatchObject({
      status: "not-ready",
      reason: "rejected",
      attempts: 2,
    });
  });

  it("HTTP 204 without a body is ready under the default validator", async () => {
    const { fetch } = scripted(res(204));
    const { client } = setup(config(), fetch);
    await client.ensureReady();
    expect(client.getReadiness().status).toBe("ready");
  });

  it("a validator that throws is invalid-response", async () => {
    const { fetch } = scripted(res(200));
    const cfg = config(
      { maxAttempts: 1 },
      {
        isReady: () => {
          throw new Error("token=secret");
        },
      },
    );
    const { client } = setup(cfg, fetch);
    const error = (await outcome(client.ensureReady())) as WakeItReadinessError;
    expect(error.code).toBe("invalid-response");
    expect(client.getReadiness()).toMatchObject({
      status: "not-ready",
      reason: "invalid-response",
    });
    expect(error.message).not.toContain("secret");
  });

  it("non-success status: not-ready after the attempt budget", async () => {
    const { fetch } = scripted(res(503));
    const { client } = setup(config({ maxAttempts: 3 }), fetch);
    const failure = outcome(client.ensureReady());
    await vi.runAllTimersAsync();
    expect(await failure).toMatchObject({ code: "not-ready", attempts: 3 });
    expect(fetch).toHaveBeenCalledTimes(3);
    noTimers();
  });

  it("503 N times then 200: resolves after the first 200 with N+1 probes (AC-R1)", async () => {
    const { fetch } = scripted(res(503), res(503), res(200));
    const { client } = setup(config(), fetch);
    const done = client.ensureReady();
    await vi.advanceTimersByTimeAsync(250);
    await done;
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(client.getReadiness()).toMatchObject({ status: "ready", attempts: 3 });
  });

  it("network error: unreachable / network-error", async () => {
    const { fetch } = scripted(new TypeError("fetch failed"));
    const { client } = setup(config({ maxAttempts: 2 }), fetch);
    const failure = outcome(client.ensureReady());
    await vi.runAllTimersAsync();
    expect(await failure).toMatchObject({ code: "unreachable" });
    expect(client.getReadiness()).toMatchObject({ status: "unreachable", reason: "network-error" });
  });

  it("status is `checking` while the first attempt is pending, then keeps the last failure", async () => {
    const { fetch } = scripted(res(503), "hang");
    const { client } = setup(config(), fetch);
    void outcome(client.ensureReady());
    expect(client.getReadiness()).toMatchObject({ status: "checking", attempts: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.getReadiness()).toMatchObject({ status: "not-ready", attempts: 1 });
    await vi.advanceTimersByTimeAsync(100); // second attempt in flight: no flicker back to checking
    expect(client.getReadiness()).toMatchObject({ status: "not-ready", attempts: 1 });
  });
});

describe("timeouts and deadline", () => {
  it("an attempt that exceeds timeoutMs is a `timeout`: unreachable/timeout, request aborted", async () => {
    const { fetch, signals } = scripted("hang");
    const { client } = setup(
      config({ maxAttempts: 1 }, { health: { url: "https://api.test/h", timeoutMs: 50 } }),
      fetch,
    );
    const failure = outcome(client.ensureReady());
    await vi.advanceTimersByTimeAsync(50);
    const error = (await failure) as WakeItReadinessError;
    expect(error.code).toBe("timeout");
    expect(error.message).not.toMatch(/unreachable|asleep|down/i);
    expect(client.getReadiness()).toMatchObject({ status: "unreachable", reason: "timeout" });
    expect(signals[0]?.aborted).toBe(true);
    noTimers();
  });

  it("a hanging validator is covered by the attempt timeout", async () => {
    const { fetch } = scripted(res(200));
    const { client } = setup(
      config(
        { maxAttempts: 1 },
        {
          health: { url: "https://api.test/h", timeoutMs: 40 },
          isReady: () => new Promise<boolean>(() => undefined),
        },
      ),
      fetch,
    );
    const failure = outcome(client.ensureReady());
    await vi.advanceTimersByTimeAsync(40);
    expect(await failure).toMatchObject({ code: "timeout" });
  });

  it("the overall deadline ends a run that keeps failing, with the last evidence", async () => {
    const { fetch } = scripted(res(503));
    const { client } = setup(config({ maxDurationMs: 250 }), fetch);
    const failure = outcome(client.ensureReady());
    await vi.advanceTimersByTimeAsync(249);
    expect(client.getReadiness().status).toBe("not-ready"); // still within the deadline
    await vi.advanceTimersByTimeAsync(1);
    const error = (await failure) as WakeItReadinessError;
    expect(error).toMatchObject({ code: "not-ready", elapsedMs: 250 });
    expect(fetch).toHaveBeenCalledTimes(3); // t = 0, 100, 200
    noTimers();
  });

  it("the deadline abandons an attempt still in flight and reports a timeout", async () => {
    const { fetch, signals } = scripted("hang");
    const { client } = setup(
      config({ maxDurationMs: 100 }, { health: { url: "https://api.test/h", timeoutMs: 10_000 } }),
      fetch,
    );
    const failure = outcome(client.ensureReady());
    await vi.advanceTimersByTimeAsync(100);
    expect(await failure).toMatchObject({ code: "timeout", attempts: 0 });
    expect(client.getReadiness()).toMatchObject({ status: "unreachable", reason: "timeout" });
    expect(signals[0]?.aborted).toBe(true);
    noTimers();
  });

  it("a late result of a timed-out attempt is discarded", async () => {
    let releaseFirst!: (r: Response) => void;
    const first = new Promise<Response>((resolve) => (releaseFirst = resolve));
    const fetch = vi
      .fn<FetchLike>()
      .mockImplementationOnce(() => first) // ignores the abort signal on purpose
      .mockResolvedValue(res(503));
    const { client } = setup(
      config({ maxAttempts: 2 }, { health: { url: "https://api.test/h", timeoutMs: 50 } }),
      fetch,
    );
    const failure = outcome(client.ensureReady());
    await vi.advanceTimersByTimeAsync(200);
    expect(await failure).toMatchObject({ code: "not-ready", attempts: 2 });
    releaseFirst(res(200)); // arrives long after it was abandoned
    await vi.advanceTimersByTimeAsync(0);
    expect(client.getReadiness()).toMatchObject({ status: "not-ready", attempts: 2 });
  });
});

describe("retry and backoff", () => {
  it("fixed interval: attempts happen at 0, 100, 200", async () => {
    const { fetch, times } = scripted(res(503));
    const { client } = setup(config({ maxAttempts: 3 }), fetch);
    const failure = outcome(client.ensureReady());
    const t0 = Date.now();
    await vi.runAllTimersAsync();
    await failure;
    expect(times.map((t) => t - t0)).toEqual([0, 100, 200]);
  });

  it("backoff progression without jitter: 100, 200, 400, then capped at 500", async () => {
    const { fetch, times } = scripted(res(503));
    const { client } = setup(
      config({ maxAttempts: 6, backoff: { multiplier: 2, maxDelayMs: 500, jitter: 0 } }),
      fetch,
    );
    const failure = outcome(client.ensureReady());
    const t0 = Date.now();
    await vi.runAllTimersAsync();
    await failure;
    const gaps = times.slice(1).map((t, i) => t - (times[i] as number));
    expect(gaps).toEqual([100, 200, 400, 500, 500]);
    expect(times[0]).toBe(t0);
  });

  it("jitter boundaries: draws 0 and ~1 give the full delay and the shortened delay", async () => {
    for (const [draw, expectedGap] of [
      [0, 1000],
      [0.999999, 500],
    ] as const) {
      vi.spyOn(Math, "random").mockReturnValue(draw);
      const { fetch, times } = scripted(res(503));
      const { client } = setup(
        config({ intervalMs: 1000, maxAttempts: 2, backoff: { jitter: 0.5 } }),
        fetch,
      );
      const failure = outcome(client.ensureReady());
      await vi.runAllTimersAsync();
      await failure;
      expect((times[1] as number) - (times[0] as number)).toBeCloseTo(expectedGap, -1);
      vi.restoreAllMocks();
    }
  });

  it("maxAttempts bounds the number of probes exactly", async () => {
    const { fetch } = scripted(res(503));
    const { client } = setup(config({ maxAttempts: 4 }), fetch);
    const failure = outcome(client.ensureReady());
    await vi.runAllTimersAsync();
    expect(await failure).toMatchObject({ attempts: 4 });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("is bounded by default: without maxAttempts the 60s deadline still ends the run", async () => {
    const { fetch } = scripted(res(503));
    const { client } = setup(config({ intervalMs: 2000 }), fetch);
    const failure = outcome(client.ensureReady());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await failure).toMatchObject({ code: "not-ready" });
    noTimers();
  });
});

describe("freshness", () => {
  const ttl = { readyTtlMs: 1000 };

  it("without subscribers there is no timer, yet read-time normalization is truthful (TR-F1)", async () => {
    const { fetch } = scripted(res(200));
    const { client } = setup(config({}, ttl), fetch);
    await client.ensureReady();
    expect(vi.getTimerCount()).toBe(0);
    vi.setSystemTime(Date.now() + 999);
    expect(client.getReadiness().status).toBe("ready");
    vi.setSystemTime(Date.now() + 1);
    const expired = client.getReadiness();
    expect(expired).toMatchObject({ status: "unknown", reason: "expired", attempts: 1 });
    expect("validUntil" in expired).toBe(false);
    expect(client.getReadiness()).toBe(expired); // identity-stable
  });

  it("a late or throttled timer cannot make an expired snapshot read as ready (TR-F3)", async () => {
    const { fetch } = scripted(res(200));
    const { client } = setup(config({}, ttl), fetch);
    client.subscribe(() => undefined);
    await client.ensureReady();
    vi.setSystemTime(Date.now() + 5000); // clock jumps; the timer has not run yet
    expect(client.getReadiness().status).toBe("unknown");
  });

  it("with a subscriber: exactly one timer, notified at expiry, cleared on unsubscribe (TR-F2)", async () => {
    const { fetch } = scripted(res(200));
    const { client } = setup(config({}, ttl), fetch);
    const listener = vi.fn(() => client.getReadiness());
    const unsubscribe = client.subscribe(listener);
    await client.ensureReady();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1); // the expiry timer only
    const calls = listener.mock.calls.length;

    await vi.advanceTimersByTimeAsync(1000);
    expect(listener.mock.calls.length).toBe(calls + 1);
    expect(client.getReadiness()).toMatchObject({ status: "unknown", reason: "expired" });
    expect(vi.getTimerCount()).toBe(0);

    unsubscribe();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("unsubscribing while ready clears the expiry timer; subscribing again re-arms it", async () => {
    const { fetch } = scripted(res(200));
    const { client } = setup(config({}, ttl), fetch);
    await client.ensureReady();
    const off = client.subscribe(() => undefined);
    expect(vi.getTimerCount()).toBe(1);
    off();
    expect(vi.getTimerCount()).toBe(0);
    client.subscribe(() => undefined);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("a fresh result resolves ensureReady with no new probe", async () => {
    const { fetch } = scripted(res(200));
    const { client } = setup(config(), fetch);
    await client.ensureReady();
    await client.ensureReady();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("at exactly validUntil a new ensureReady starts a new run (TR-F4)", async () => {
    const { fetch } = scripted(res(200));
    const { client } = setup(config({}, ttl), fetch);
    await client.ensureReady();
    vi.setSystemTime(Date.now() + 999);
    await client.ensureReady();
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 1);
    await client.ensureReady();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("concurrent callers right after expiry share one new run", async () => {
    const { fetch } = scripted(res(200));
    const { client } = setup(config({}, ttl), fetch);
    await client.ensureReady();
    vi.setSystemTime(Date.now() + 1000);
    await Promise.all([client.ensureReady(), client.ensureReady(), client.ensureReady()]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("readyTtlMs of 0 expires immediately but still releases the waiting caller", async () => {
    const { fetch } = scripted(res(200));
    const { client } = setup(config({}, { readyTtlMs: 0 }), fetch);
    await client.ensureReady();
    expect(client.getReadiness()).toMatchObject({ status: "unknown", reason: "expired" });
  });

  it("renewing readiness re-arms the timer for the new validity", async () => {
    const { fetch } = scripted(res(200));
    const { client } = setup(config({}, ttl), fetch);
    client.subscribe(() => undefined);
    await client.ensureReady();
    await vi.advanceTimersByTimeAsync(1000); // expires, committed
    await client.ensureReady(); // new run, ready again
    await vi.advanceTimersByTimeAsync(0);
    expect(client.getReadiness().status).toBe("ready");
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.getReadiness().status).toBe("unknown");
  });
});

describe("shared runs and waiter cancellation", () => {
  it("ten simultaneous callers share one probe in flight (AC-R5)", async () => {
    const { fetch } = scripted(res(200));
    const { client } = setup(config(), fetch);
    await Promise.all(Array.from({ length: 10 }, () => client.ensureReady()));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("callers joining a running run share its budget and result", async () => {
    const { fetch } = scripted(res(503), res(503), res(200));
    const { client } = setup(config(), fetch);
    const a = client.ensureReady();
    await vi.advanceTimersByTimeAsync(100);
    const b = client.ensureReady(); // joins mid-run
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all([a, b]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("one waiter aborting rejects only that waiter; the shared probe continues", async () => {
    const { fetch, signals } = scripted(res(503), res(200));
    const { client } = setup(config(), fetch);
    const controller = new AbortController();
    const a = outcome(client.ensureReady({ signal: controller.signal }));
    const b = client.ensureReady();
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    const error = (await a) as WakeItReadinessError;
    expect(error).toMatchObject({ code: "aborted", backend: "default" });
    await vi.advanceTimersByTimeAsync(100);
    await b; // resolves
    expect(client.getReadiness().status).toBe("ready");
    expect(signals[0]?.aborted).toBe(true); // the first attempt finished; later cleanup aborts it
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("an aborting waiter does not abort the in-flight attempt while others wait", () => {
    const { fetch, signals } = scripted("hang");
    const { client } = setup(config(), fetch);
    const controller = new AbortController();
    void outcome(client.ensureReady({ signal: controller.signal }));
    void outcome(client.ensureReady());
    controller.abort();
    expect(signals[0]?.aborted).toBe(false);
  });

  it("all waiters aborting stops the run: attempt aborted, no timers or listeners, status restored", async () => {
    const { fetch, signals } = scripted("hang");
    const { client, online } = setup(config(), fetch);
    const a = new AbortController();
    const b = new AbortController();
    const pa = outcome(client.ensureReady({ signal: a.signal }));
    const pb = outcome(client.ensureReady({ signal: b.signal }));
    expect(online.listenerCount()).toBe(1);
    expect(client.getReadiness().status).toBe("checking");

    a.abort();
    expect(signals[0]?.aborted).toBe(false);
    b.abort();
    expect(signals[0]?.aborted).toBe(true);
    expect(await pa).toMatchObject({ code: "aborted" });
    expect(await pb).toMatchObject({ code: "aborted" });
    expect(client.getReadiness()).toMatchObject({ status: "unknown", attempts: 0 });
    expect(online.listenerCount()).toBe(0);
    noTimers();
  });

  it("when the last waiter leaves, failure evidence from the run is kept", async () => {
    const { fetch } = scripted(res(503), "hang");
    const { client } = setup(config(), fetch);
    const controller = new AbortController();
    const p = outcome(client.ensureReady({ signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await p;
    expect(client.getReadiness()).toMatchObject({ status: "not-ready", reason: "rejected" });
    noTimers();
  });

  it("a later caller after everyone left starts a fresh run", async () => {
    const { fetch } = scripted("hang", res(200));
    const { client } = setup(config(), fetch);
    const controller = new AbortController();
    const p = outcome(client.ensureReady({ signal: controller.signal }));
    controller.abort();
    await p;
    await client.ensureReady();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(client.getReadiness().status).toBe("ready");
  });

  it("a pre-aborted signal rejects `aborted` without any probe, even when readiness is fresh", async () => {
    const { fetch } = scripted(res(200));
    const { client } = setup(config(), fetch);
    const pre = AbortSignal.abort();
    expect(await outcome(client.ensureReady({ signal: pre }))).toMatchObject({ code: "aborted" });
    expect(fetch).not.toHaveBeenCalled();
    await client.ensureReady();
    expect(await outcome(client.ensureReady({ signal: pre }))).toMatchObject({ code: "aborted" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("aborting after the waiter already settled is harmless and removes the listener", async () => {
    const { fetch } = scripted(res(200));
    const { client } = setup(config(), fetch);
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
    await client.ensureReady({ signal: controller.signal });
    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(() => controller.abort()).not.toThrow();
  });
});

describe("disposal", () => {
  it("during an active probe: waiters reject `aborted`, everything is released", async () => {
    const { fetch, signals } = scripted("hang");
    const { client, online } = setup(config(), fetch);
    const waiting = outcome(client.ensureReady());
    expect(online.listenerCount()).toBe(1);
    client.dispose();
    const error = (await waiting) as WakeItReadinessError;
    expect(error).toMatchObject({ code: "aborted" });
    expect(error.message).toMatch(/disposed/);
    expect(signals[0]?.aborted).toBe(true);
    expect(online.listenerCount()).toBe(0);
    noTimers();
  });

  it("restores the pre-run status and makes no further state updates or notifications", async () => {
    let release!: (r: Response) => void;
    const pending = new Promise<Response>((resolve) => (release = resolve));
    const { client } = setup(config(), () => pending);
    const listener = vi.fn();
    client.subscribe(listener);
    const waiting = outcome(client.ensureReady());
    await vi.advanceTimersByTimeAsync(0);
    listener.mockClear();

    client.dispose();
    await waiting;
    release(res(200)); // the abandoned attempt answers after disposal
    await vi.advanceTimersByTimeAsync(10_000);
    expect(client.getReadiness()).toMatchObject({ status: "unknown", attempts: 0 });
    expect(listener).not.toHaveBeenCalled();
    noTimers();
  });

  it("ensureReady after dispose rejects `aborted`; getReadiness keeps the last snapshot", async () => {
    const { fetch } = scripted(res(200));
    const { client } = setup(config(), fetch);
    await client.ensureReady();
    client.dispose();
    expect(await outcome(client.ensureReady())).toMatchObject({ code: "aborted" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(client.getReadiness().status).toBe("ready");
  });

  it("disposing while paused offline releases the listener and the deadline", async () => {
    const { fetch } = scripted(new TypeError("offline"));
    const online = createOnline(false);
    const { client } = setup(config(), fetch, online);
    const waiting = outcome(client.ensureReady());
    await vi.advanceTimersByTimeAsync(0);
    expect(client.getReadiness().status).toBe("offline");
    client.dispose();
    expect(await waiting).toMatchObject({ code: "aborted" });
    expect(online.listenerCount()).toBe(0);
    noTimers();
  });

  it("dispose is idempotent and clears the expiry timer", async () => {
    const { fetch } = scripted(res(200));
    const { client } = setup(config(), fetch);
    client.subscribe(() => undefined);
    await client.ensureReady();
    expect(vi.getTimerCount()).toBe(1);
    client.dispose();
    client.dispose();
    noTimers();
  });
});

describe("offline and online", () => {
  it("a network error while offline is `offline` and consumes no attempt", async () => {
    const { fetch } = scripted(new TypeError("down"));
    const online = createOnline(false);
    const { client } = setup(config({ maxAttempts: 2 }), fetch, online);
    void outcome(client.ensureReady());
    await vi.advanceTimersByTimeAsync(0);
    expect(client.getReadiness()).toMatchObject({
      status: "offline",
      reason: "offline",
      attempts: 0,
    });
  });

  it("while offline nothing is probed and no retry timer runs, however long it waits", async () => {
    const { fetch } = scripted(new TypeError("down"));
    const online = createOnline(false);
    const { client } = setup(config({ maxAttempts: 2, maxDurationMs: 1_000_000 }), fetch, online);
    void outcome(client.ensureReady());
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1); // only the run deadline
    await vi.advanceTimersByTimeAsync(500_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(client.getReadiness().attempts).toBe(0);
  });

  it("recovery probes immediately and the full attempt budget is still available", async () => {
    const { fetch } = scripted(new TypeError("down"), res(503), res(200));
    const online = createOnline(false);
    const { client } = setup(config({ maxAttempts: 2 }), fetch, online);
    const done = client.ensureReady();
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.getReadiness().status).toBe("offline");

    online.set(true); // connectivity returns
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(2); // immediate, no interval wait
    await vi.advanceTimersByTimeAsync(100);
    await done; // second counted attempt succeeds, within maxAttempts 2
    expect(client.getReadiness()).toMatchObject({ status: "ready", attempts: 2 });
    expect(online.listenerCount()).toBe(0);
    noTimers();
  });

  it("goes offline again later in the same run without consuming attempts", async () => {
    const { fetch } = scripted(res(503), new TypeError("down"), res(200));
    const online = createOnline(true);
    const { client } = setup(config({ maxAttempts: 2 }), fetch, online);
    const done = client.ensureReady();
    await vi.advanceTimersByTimeAsync(0); // attempt 1: 503, counted
    online.set(false);
    await vi.advanceTimersByTimeAsync(100); // attempt 2: network error while offline
    expect(client.getReadiness()).toMatchObject({ status: "offline", attempts: 1 });
    online.set(true);
    await vi.advanceTimersByTimeAsync(0);
    await done;
    expect(client.getReadiness()).toMatchObject({ status: "ready", attempts: 2 });
  });

  it("the deadline bounds an offline wait and ends it with code `offline`", async () => {
    const { fetch } = scripted(new TypeError("down"));
    const online = createOnline(false);
    const { client } = setup(config({ maxDurationMs: 5000 }), fetch, online);
    const failure = outcome(client.ensureReady());
    await vi.advanceTimersByTimeAsync(5000);
    expect(await failure).toMatchObject({ code: "offline", attempts: 0 });
    expect(online.listenerCount()).toBe(0);
    noTimers();
  });

  it("never pre-blocks on an offline report: it still tries, and succeeds if the request works", async () => {
    const { fetch } = scripted(res(200));
    const { client } = setup(config(), fetch, createOnline(false));
    await client.ensureReady();
    expect(client.getReadiness().status).toBe("ready");
  });

  it("without browser globals (Node) the default source reports online and registers nothing", async () => {
    vi.stubGlobal("navigator", undefined);
    const { fetch } = scripted(new TypeError("refused"));
    const engine = createEngine(config({ maxAttempts: 1 }), { fetch });
    const client = assembleClient(engine);
    const failure = outcome(client.ensureReady());
    await vi.runAllTimersAsync();
    expect(await failure).toMatchObject({ code: "unreachable" }); // not misread as offline
  });
});

describe("backend selection and configuration errors", () => {
  it("no backend configured: ensureReady rejects WakeItConfigError, nothing is probed", async () => {
    const fetch = vi.fn<FetchLike>();
    const { client } = setup({}, fetch);
    const error = await outcome(client.ensureReady());
    expect(error).toBeInstanceOf(WakeItConfigError);
    expect((error as Error).message).toMatch(/no readiness backend is configured/);
    expect(fetch).not.toHaveBeenCalled();
    expect(() => client.getReadiness()).toThrow(WakeItConfigError);
    noTimers();
  });

  it("ensureReady never throws synchronously: even invalid usage is a rejection", async () => {
    const { client } = setup(config(), scripted(res(200)).fetch);
    let promise!: Promise<void>;
    expect(() => {
      promise = client.ensureReady({ backend: 5 } as never);
    }).not.toThrow();
    expect(await outcome(promise)).toBeInstanceOf(WakeItConfigError);
  });

  it("an unknown backend id is a WakeItConfigError naming the configured ids", async () => {
    const { client } = setup(config(), scripted(res(200)).fetch);
    const error = (await outcome(client.ensureReady({ backend: "nope" }))) as Error;
    expect(error).toBeInstanceOf(WakeItConfigError);
    expect(error.message).toMatch(/unknown backend "nope" \(configured: default\)/);
    expect(() => client.getReadiness("nope")).toThrow(/unknown backend/);
  });

  it("inherited property names are not backends", async () => {
    const { client } = setup(config(), scripted(res(200)).fetch);
    for (const id of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      expect(await outcome(client.ensureReady({ backend: id }))).toBeInstanceOf(WakeItConfigError);
      expect(() => client.getReadiness(id)).toThrow(WakeItConfigError);
    }
  });

  const named = (fetch: FetchLike, extra: Record<string, unknown> = {}) =>
    setup(
      {
        backends: {
          auth: { health: "https://auth.test/health", poll: { intervalMs: 100 } },
          api: { health: "https://api.test/health", poll: { intervalMs: 100 } },
          ...extra,
        },
      },
      fetch,
    );

  it("several named backends and none called `default`: an id is required (never arbitrary)", async () => {
    const { client } = named(scripted(res(200)).fetch);
    const error = (await outcome(client.ensureReady())) as Error;
    expect(error).toBeInstanceOf(WakeItConfigError);
    expect(error.message).toMatch(/a backend id is required.*configured: auth, api/);
    expect(() => client.getReadiness()).toThrow(WakeItConfigError);
  });

  it("even a single named backend is not chosen implicitly", async () => {
    const { client } = setup({ backends: { only: { health: "/h" } } }, scripted(res(200)).fetch);
    expect(await outcome(client.ensureReady())).toBeInstanceOf(WakeItConfigError);
  });

  it("a backend named `default` is the implicit choice", async () => {
    const script = scripted(res(200));
    const { client } = named(script.fetch, { default: { health: "https://d.test/health" } });
    await client.ensureReady();
    expect(script.fetch.mock.calls[0]?.[0]).toBe("https://d.test/health");
    expect(client.getReadiness().backend).toBe("default");
  });

  it("named backends are independent: probes, state and freshness", async () => {
    const script = scripted(res(200));
    const { client } = named(script.fetch);
    await client.ensureReady({ backend: "auth" });
    expect(script.fetch).toHaveBeenCalledTimes(1);
    expect(script.fetch.mock.calls[0]?.[0]).toBe("https://auth.test/health");
    expect(client.getReadiness("auth").status).toBe("ready");
    expect(client.getReadiness("api")).toMatchObject({ status: "unknown", attempts: 0 });
    await client.ensureReady({ backend: "api" });
    expect(script.fetch).toHaveBeenCalledTimes(2);
  });

  it("invalid options are WakeItConfigErrors", async () => {
    const { client } = setup(config(), scripted(res(200)).fetch);
    for (const options of [
      "x",
      [],
      { backend: "" },
      { signal: {} },
      { signal: "abort" },
      { unknown: 1 },
    ]) {
      expect(await outcome(client.ensureReady(options as never))).toBeInstanceOf(WakeItConfigError);
    }
  });

  it("a missing fetch implementation is a WakeItConfigError, checked before any work", async () => {
    vi.stubGlobal("fetch", undefined);
    const engine = createEngine(config());
    const client = assembleClient(engine);
    const error = (await outcome(client.ensureReady())) as Error;
    expect(error).toBeInstanceOf(WakeItConfigError);
    expect(error.message).toMatch(/fetch/);
    noTimers();
  });

  it("a missing AbortController is a WakeItConfigError", async () => {
    vi.stubGlobal("AbortController", undefined);
    const { client } = setup(config(), scripted(res(200)).fetch);
    expect(await outcome(client.ensureReady())).toBeInstanceOf(WakeItConfigError);
  });

  it("uses the platform fetch when none is injected", async () => {
    const platform = vi.fn<FetchLike>().mockResolvedValue(res(200));
    vi.stubGlobal("fetch", platform);
    const client = assembleClient(createEngine(config()));
    await client.ensureReady();
    expect(platform).toHaveBeenCalledTimes(1);
    expect(platform.mock.calls[0]?.[0]).toBe("https://api.test/health");
  });
});

describe("notifications and isolation", () => {
  it("subscribers see each committed readiness change, coalesced per microtask", async () => {
    const { fetch } = scripted(res(200));
    const { client } = setup(config(), fetch);
    const seen: string[] = [];
    client.subscribe(() => seen.push(client.getReadiness().status));
    const done = client.ensureReady();
    await Promise.resolve(); // `checking` was committed synchronously: one batch
    expect(seen).toEqual(["checking"]);
    await done;
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual(["checking", "ready"]);
  });

  it("getReadiness is identity-stable while nothing changes and changes with the state", async () => {
    const { fetch } = scripted(res(200));
    const { client } = setup(config(), fetch);
    const before = client.getReadiness();
    expect(client.getReadiness()).toBe(before);
    await client.ensureReady();
    const after = client.getReadiness();
    expect(after).not.toBe(before);
    expect(client.getReadiness()).toBe(after);
    expect(Object.isFrozen(after)).toBe(true);
  });

  it("independent clients keep independent runs and state", async () => {
    const a = scripted(res(200));
    const b = scripted(res(503));
    const one = setup(config({ maxAttempts: 1 }), a.fetch);
    const two = setup(config({ maxAttempts: 1 }), b.fetch);
    await one.client.ensureReady();
    expect(await outcome(two.client.ensureReady())).toMatchObject({ code: "not-ready" });
    expect(one.client.getReadiness().status).toBe("ready");
    expect(two.client.getReadiness().status).toBe("not-ready");
    one.client.dispose();
    expect(two.client.getReadiness().status).toBe("not-ready");
  });

  it("error objects carry only code, backend, attempts and elapsedMs, never the URL or headers", async () => {
    const { fetch } = scripted(res(503));
    const { client } = setup(
      config(
        { maxAttempts: 1 },
        {
          health: {
            url: "https://api.test/h?token=SECRET",
            headers: { Authorization: "Bearer SECRET" },
          },
        },
      ),
      fetch,
    );
    const error = (await outcome(client.ensureReady())) as WakeItReadinessError;
    const text = `${error.message} ${JSON.stringify(error)} ${error.stack ?? ""}`;
    expect(text).not.toContain("SECRET");
    expect(Object.keys(error).sort()).toEqual(["attempts", "backend", "code", "elapsedMs"]);
    expect(error.cause).toBeUndefined();
  });

  it("every terminal path leaves zero timers and zero listeners", async () => {
    const online = createOnline();
    const scenarios: Array<() => Promise<unknown>> = [
      async () => setup(config(), scripted(res(200)).fetch, online).client.ensureReady(),
      async () =>
        outcome(
          setup(config({ maxAttempts: 2 }), scripted(res(503)).fetch, online).client.ensureReady(),
        ),
      async () =>
        outcome(
          setup(
            config({ maxAttempts: 1 }),
            scripted(new TypeError("x")).fetch,
            online,
          ).client.ensureReady(),
        ),
    ];
    for (const run of scenarios) {
      const p = run();
      await vi.runAllTimersAsync();
      await p;
      expect(online.listenerCount()).toBe(0);
      noTimers();
    }
  });
});

describe("resilience", () => {
  it("an expiry timer that fires early re-arms for the remainder instead of expiring early", async () => {
    const { fetch } = scripted(res(200));
    const { client } = setup(config({}, { readyTtlMs: 1000 }), fetch);
    const listener = vi.fn();
    client.subscribe(listener);
    await client.ensureReady();
    await vi.advanceTimersByTimeAsync(0);
    const calls = listener.mock.calls.length;

    vi.setSystemTime(Date.now() - 600); // the clock is behind when the timer fires
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.getReadiness().status).toBe("ready"); // not expired yet
    expect(listener.mock.calls.length).toBe(calls);
    expect(vi.getTimerCount()).toBe(1); // re-armed

    await vi.advanceTimersByTimeAsync(600);
    expect(client.getReadiness().status).toBe("unknown");
  });

  it("a throwing online source is reported, never an unhandled rejection; the attempt timer ends the attempt", async () => {
    const { fetch } = scripted(res(503));
    const online = createOnline();
    online.source.isOnline = () => {
      throw new Error("navigator exploded");
    };
    const { client, reportError } = setup(
      config({ maxAttempts: 1 }, { health: { url: "https://api.test/h", timeoutMs: 50 } }),
      fetch,
      online,
    );
    const failure = outcome(client.ensureReady());
    await vi.advanceTimersByTimeAsync(50);
    expect(await failure).toMatchObject({ code: "timeout" });
    expect(reportError).toHaveBeenCalledTimes(1);
    expect((reportError.mock.calls[0]?.[0] as Error).message).toBe("navigator exploded");
    noTimers();
  });

  it("a global fetch that disappears mid-run is a network-error for that attempt, not a crash", async () => {
    const platform = vi.fn<FetchLike>().mockResolvedValueOnce(res(503));
    vi.stubGlobal("fetch", platform);
    const client = assembleClient(createEngine(config({ maxAttempts: 2 })));
    const failure = outcome(client.ensureReady());
    await vi.advanceTimersByTimeAsync(0);
    vi.stubGlobal("fetch", undefined);
    await vi.advanceTimersByTimeAsync(100);
    expect(await failure).toMatchObject({ code: "unreachable", attempts: 2 });
    expect(client.getReadiness()).toMatchObject({ status: "unreachable", reason: "network-error" });
  });

  it("ensureReady is a rejection, not a synchronous throw, even before a client has any state", async () => {
    const client = assembleClient(createEngine({}));
    let promise!: Promise<void>;
    expect(() => {
      promise = client.ensureReady({ signal: "nope" } as never);
    }).not.toThrow();
    expect(await outcome(promise)).toBeInstanceOf(WakeItConfigError);
  });

  it("more subscribers while the expiry timer is armed do not create more timers", async () => {
    const { fetch } = scripted(res(200));
    const { client } = setup(config({}, { readyTtlMs: 1000 }), fetch);
    await client.ensureReady();
    const offs = [client.subscribe(() => undefined), client.subscribe(() => undefined)];
    client.subscribe(() => undefined);
    expect(vi.getTimerCount()).toBe(1);
    for (const off of offs) off();
    expect(vi.getTimerCount()).toBe(1); // one subscriber is still left
  });

  it("a controller can be disposed twice safely", async () => {
    const engine = createEngine(config(), { fetch: scripted("hang").fetch });
    const backend = engine.config.backends["default"];
    if (backend === undefined) throw new Error("backend missing");
    const controller = createController({
      id: "default",
      backend,
      store: engine.store,
      fetch: scripted("hang").fetch,
      online: createOnline().source,
      subscriberCount: () => 0,
      reportError: vi.fn(),
    });
    const waiting = outcome(controller.ensureReady(undefined));
    controller.dispose();
    controller.dispose();
    expect(await waiting).toMatchObject({ code: "aborted" });
    noTimers();
  });
});
