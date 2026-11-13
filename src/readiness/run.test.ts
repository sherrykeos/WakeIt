import { describe, expect, it } from "vitest";
import { codeOf, IDLE_RUN, step, type RunEvent, type RunPolicy, type RunState } from "./run";

const policy: RunPolicy = { maxAttempts: 3, retryDelayMs: (n) => n * 100 };
const unlimited: RunPolicy = { maxAttempts: undefined, retryDelayMs: () => 100 };

function run(events: readonly RunEvent[], p: RunPolicy = policy) {
  let state: RunState = IDLE_RUN;
  const all = [];
  for (const event of events) {
    const t = step(state, event, p);
    state = t.state;
    all.push(...t.effects);
  }
  return { state, effects: all };
}

const joined = step(IDLE_RUN, { type: "JOIN" }, policy);

describe("run machine: starting", () => {
  it("JOIN from idle begins a run and starts attempt 1", () => {
    expect(joined.state).toMatchObject({ phase: "attempting", attempts: 0, token: 1 });
    expect(joined.effects).toEqual([{ type: "begin" }, { type: "attempt", token: 1 }]);
  });

  it("JOIN while running is ignored: the waiter shares the run", () => {
    expect(step(joined.state, { type: "JOIN" }, policy).state).toBe(joined.state);
  });
});

describe("run machine: attempt outcomes", () => {
  it("ready: goes idle, counts the attempt and bumps the token", () => {
    const t = step(joined.state, { type: "ATTEMPT_READY", token: 1 }, policy);
    expect(t.state.phase).toBe("idle");
    expect(t.state.token).toBe(2);
    expect(t.effects).toEqual([{ type: "ready", attempts: 1 }]);
  });

  it.each([
    ["rejected", "not-ready", "not-ready"],
    ["invalid-response", "not-ready", "invalid-response"],
    ["network-error", "unreachable", "unreachable"],
    ["timeout", "unreachable", "timeout"],
  ] as const)("%s: status %s, error code %s when the run ends", (reason, status, code) => {
    const { effects } = run(
      [
        { type: "JOIN" },
        { type: "ATTEMPT_FAILED", token: 1, reason, online: true },
        { type: "RETRY_DUE", token: 2 },
        { type: "ATTEMPT_FAILED", token: 3, reason, online: true },
        { type: "RETRY_DUE", token: 4 },
        { type: "ATTEMPT_FAILED", token: 5, reason, online: true },
      ],
      policy,
    );
    expect(effects).toContainEqual({ type: "status", status, reason, attempts: 1 });
    expect(effects.at(-1)).toEqual({ type: "exhausted", code });
  });

  it("failure with budget left waits the policy delay for that attempt count", () => {
    const t = step(
      joined.state,
      { type: "ATTEMPT_FAILED", token: 1, reason: "rejected", online: true },
      policy,
    );
    expect(t.state).toMatchObject({ phase: "waiting", attempts: 1, token: 2 });
    expect(t.effects.at(-1)).toEqual({ type: "wait", ms: 100, token: 2 });
  });

  it("the delay grows with the failed-attempt count", () => {
    const { effects } = run([
      { type: "JOIN" },
      { type: "ATTEMPT_FAILED", token: 1, reason: "rejected", online: true },
      { type: "RETRY_DUE", token: 2 },
      { type: "ATTEMPT_FAILED", token: 3, reason: "rejected", online: true },
    ]);
    expect(effects.filter((e) => e.type === "wait").map((e) => (e as { ms: number }).ms)).toEqual([
      100, 200,
    ]);
  });

  it("with no maxAttempts it keeps waiting (the deadline is what bounds the run)", () => {
    let state: RunState = step(IDLE_RUN, { type: "JOIN" }, unlimited).state;
    for (let i = 0; i < 50; i++) {
      state = step(
        state,
        { type: "ATTEMPT_FAILED", token: state.token, reason: "rejected", online: true },
        unlimited,
      ).state;
      expect(state.phase).toBe("waiting");
      state = step(state, { type: "RETRY_DUE", token: state.token }, unlimited).state;
    }
    expect(state.attempts).toBe(50);
  });

  it("a stale token is ignored for every attempt event", () => {
    for (const event of [
      { type: "ATTEMPT_READY", token: 99 },
      { type: "ATTEMPT_FAILED", token: 99, reason: "rejected", online: true },
    ] as const) {
      expect(step(joined.state, event, policy).state).toBe(joined.state);
    }
  });

  it("attempt results are ignored outside the attempting phase", () => {
    const idle = step(IDLE_RUN, { type: "ATTEMPT_READY", token: 0 }, policy);
    expect(idle.state).toBe(IDLE_RUN);
    expect(idle.effects).toEqual([]);
  });
});

describe("run machine: offline", () => {
  const offline = step(
    joined.state,
    { type: "ATTEMPT_FAILED", token: 1, reason: "network-error", online: false },
    policy,
  );

  it("a network error while offline pauses without consuming an attempt", () => {
    expect(offline.state).toMatchObject({ phase: "paused", attempts: 0, lastReason: "offline" });
    expect(offline.effects).toEqual([
      { type: "status", status: "offline", reason: "offline", attempts: 0 },
    ]);
  });

  it("offline waits never exhaust the attempt budget", () => {
    let state: RunState = joined.state;
    for (let i = 0; i < 20; i++) {
      state = step(
        state,
        { type: "ATTEMPT_FAILED", token: state.token, reason: "network-error", online: false },
        policy,
      ).state;
      expect(state.phase).toBe("paused");
      state = step(state, { type: "ONLINE" }, policy).state;
      expect(state.phase).toBe("attempting");
    }
    expect(state.attempts).toBe(0);
  });

  it("ONLINE resumes immediately with a fresh attempt", () => {
    const t = step(offline.state, { type: "ONLINE" }, policy);
    expect(t.state.phase).toBe("attempting");
    expect(t.effects).toEqual([{ type: "attempt", token: t.state.token }]);
  });

  it("ONLINE outside paused is ignored", () => {
    expect(step(joined.state, { type: "ONLINE" }, policy).state).toBe(joined.state);
    expect(step(IDLE_RUN, { type: "ONLINE" }, policy).state).toBe(IDLE_RUN);
  });

  it("only a network error is treated as offline; a timeout while offline still counts", () => {
    const t = step(
      joined.state,
      { type: "ATTEMPT_FAILED", token: 1, reason: "timeout", online: false },
      policy,
    );
    expect(t.state).toMatchObject({ phase: "waiting", attempts: 1 });
  });

  it("the deadline ends a paused run with the offline code", () => {
    const t = step(offline.state, { type: "DEADLINE" }, policy);
    expect(t.effects).toEqual([{ type: "exhausted", code: "offline" }]);
  });
});

describe("run machine: retry timer, deadline, stop", () => {
  const waiting = step(
    joined.state,
    { type: "ATTEMPT_FAILED", token: 1, reason: "rejected", online: true },
    policy,
  );

  it("RETRY_DUE starts the next attempt; a stale one is ignored", () => {
    const t = step(waiting.state, { type: "RETRY_DUE", token: waiting.state.token }, policy);
    expect(t.state.phase).toBe("attempting");
    expect(step(waiting.state, { type: "RETRY_DUE", token: 1 }, policy).state).toBe(waiting.state);
    expect(step(joined.state, { type: "RETRY_DUE", token: 1 }, policy).state).toBe(joined.state);
  });

  it("DEADLINE ends the run with the last evidence", () => {
    const t = step(waiting.state, { type: "DEADLINE" }, policy);
    expect(t.state.phase).toBe("idle");
    expect(t.effects).toEqual([{ type: "exhausted", code: "not-ready" }]);
  });

  it("DEADLINE during the first attempt records a timeout as the evidence", () => {
    const t = step(joined.state, { type: "DEADLINE" }, policy);
    expect(t.effects).toEqual([
      { type: "status", status: "unreachable", reason: "timeout", attempts: 0 },
      { type: "exhausted", code: "timeout" },
    ]);
  });

  it("DEADLINE and STOP are ignored when idle", () => {
    expect(step(IDLE_RUN, { type: "DEADLINE" }, policy).state).toBe(IDLE_RUN);
    expect(step(IDLE_RUN, { type: "STOP" }, policy).state).toBe(IDLE_RUN);
  });

  it("STOP from any running phase goes idle and invalidates pending callbacks", () => {
    for (const state of [joined.state, waiting.state]) {
      const t = step(state, { type: "STOP" }, policy);
      expect(t.state.phase).toBe("idle");
      expect(t.state.token).toBeGreaterThan(state.token);
      expect(t.effects).toEqual([{ type: "stop" }]);
      // a result from the abandoned attempt can no longer be applied
      expect(step(t.state, { type: "ATTEMPT_READY", token: state.token }, policy).state).toBe(
        t.state,
      );
    }
  });

  it("maps evidence to error codes", () => {
    expect(codeOf("rejected")).toBe("not-ready");
    expect(codeOf("invalid-response")).toBe("invalid-response");
    expect(codeOf("network-error")).toBe("unreachable");
    expect(codeOf("timeout")).toBe("timeout");
    expect(codeOf("offline")).toBe("offline");
    expect(codeOf(undefined)).toBe("timeout");
  });
});
