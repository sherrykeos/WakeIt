import type { ReadinessErrorCode, ReadinessReason, ReadinessStatus } from "../core/types";
import type { ProbeFailure } from "./probe";

// The probe run as a pure transition function (STATE_MACHINES section 2.1, AD-17):
// `(state, event, policy) -> { state, effects }`. No timers, no I/O: the controller interprets
// the effects. Events invalid in a state, or carrying a stale token, are ignored by returning
// the very same state object with no effects.

export type RunPhase = "idle" | "attempting" | "waiting" | "paused";

export interface RunState {
  readonly phase: RunPhase;
  /** Generation token: bumped on every attempt start and on every exit, so stale callbacks no-op. */
  readonly token: number;
  /** Attempts that finished `ready` or failed for a counted reason (offline excluded). */
  readonly attempts: number;
  /** Evidence from this run only; `undefined` until the first attempt resolves. */
  readonly lastReason: ReadinessReason | undefined;
}

export const IDLE_RUN: RunState = Object.freeze({
  phase: "idle",
  token: 0,
  attempts: 0,
  lastReason: undefined,
});

export type FailureReason = ProbeFailure | "timeout";

export type RunEvent =
  | { readonly type: "JOIN" }
  | { readonly type: "ATTEMPT_READY"; readonly token: number }
  | {
      readonly type: "ATTEMPT_FAILED";
      readonly token: number;
      readonly reason: FailureReason;
      /** What the online source reported when the attempt failed. */
      readonly online: boolean;
    }
  | { readonly type: "RETRY_DUE"; readonly token: number }
  | { readonly type: "ONLINE" }
  | { readonly type: "DEADLINE" }
  | { readonly type: "STOP" };

export type RunEffect =
  | { readonly type: "begin" }
  | { readonly type: "attempt"; readonly token: number }
  | {
      readonly type: "status";
      readonly status: ReadinessStatus;
      readonly reason: ReadinessReason;
      readonly attempts: number;
    }
  | { readonly type: "wait"; readonly ms: number; readonly token: number }
  | { readonly type: "ready"; readonly attempts: number }
  | { readonly type: "exhausted"; readonly code: ReadinessErrorCode }
  | { readonly type: "stop" };

export interface RunPolicy {
  readonly maxAttempts: number | undefined;
  /** Delay before the next attempt, given the failed attempts so far (>= 1). */
  readonly retryDelayMs: (failedAttempts: number) => number;
}

export interface Transition {
  readonly state: RunState;
  readonly effects: readonly RunEffect[];
}

/** Error code of a run that ended with this evidence (STATE_MACHINES section 2.3). */
export function codeOf(reason: ReadinessReason | undefined): ReadinessErrorCode {
  switch (reason) {
    case "rejected":
      return "not-ready";
    case "invalid-response":
      return "invalid-response";
    case "network-error":
      return "unreachable";
    case "offline":
      return "offline";
    default:
      // `timeout`, and a run that ended without evidence (the deadline hit the first attempt).
      return "timeout";
  }
}

function statusOf(reason: FailureReason): ReadinessStatus {
  return reason === "rejected" || reason === "invalid-response" ? "not-ready" : "unreachable";
}

const NOTHING = (state: RunState): Transition => ({ state, effects: [] });

export function step(state: RunState, event: RunEvent, policy: RunPolicy): Transition {
  const { phase } = state;

  switch (event.type) {
    case "JOIN": {
      if (phase !== "idle") return NOTHING(state);
      const token = state.token + 1;
      return {
        state: { phase: "attempting", token, attempts: 0, lastReason: undefined },
        effects: [{ type: "begin" }, { type: "attempt", token }],
      };
    }

    case "ATTEMPT_READY": {
      if (phase !== "attempting" || event.token !== state.token) return NOTHING(state);
      const attempts = state.attempts + 1;
      return {
        state: { phase: "idle", token: state.token + 1, attempts, lastReason: undefined },
        effects: [{ type: "ready", attempts }],
      };
    }

    case "ATTEMPT_FAILED": {
      if (phase !== "attempting" || event.token !== state.token) return NOTHING(state);

      // A network failure while offline is connectivity, not evidence about the backend:
      // no attempt is consumed and the run pauses until the connection returns.
      if (event.reason === "network-error" && !event.online) {
        return {
          state: { ...state, phase: "paused", token: state.token + 1, lastReason: "offline" },
          effects: [
            { type: "status", status: "offline", reason: "offline", attempts: state.attempts },
          ],
        };
      }

      const attempts = state.attempts + 1;
      const status: RunEffect = {
        type: "status",
        status: statusOf(event.reason),
        reason: event.reason,
        attempts,
      };
      if (policy.maxAttempts !== undefined && attempts >= policy.maxAttempts) {
        return {
          state: { phase: "idle", token: state.token + 1, attempts, lastReason: event.reason },
          effects: [status, { type: "exhausted", code: codeOf(event.reason) }],
        };
      }
      const token = state.token + 1;
      return {
        state: { phase: "waiting", token, attempts, lastReason: event.reason },
        effects: [status, { type: "wait", ms: policy.retryDelayMs(attempts), token }],
      };
    }

    case "RETRY_DUE": {
      if (phase !== "waiting" || event.token !== state.token) return NOTHING(state);
      const token = state.token + 1;
      return {
        state: { ...state, phase: "attempting", token },
        effects: [{ type: "attempt", token }],
      };
    }

    case "ONLINE": {
      if (phase !== "paused") return NOTHING(state);
      const token = state.token + 1;
      return {
        state: { ...state, phase: "attempting", token },
        effects: [{ type: "attempt", token }],
      };
    }

    case "DEADLINE": {
      if (phase === "idle") return NOTHING(state);
      const next: RunState = {
        phase: "idle",
        token: state.token + 1,
        attempts: state.attempts,
        lastReason: state.lastReason ?? "timeout",
      };
      return {
        state: next,
        effects: [
          // With no evidence yet, the abandoned first attempt becomes the evidence: no usable
          // response within the limit.
          ...(state.lastReason === undefined
            ? [
                {
                  type: "status",
                  status: "unreachable",
                  reason: "timeout",
                  attempts: state.attempts,
                } as const,
              ]
            : []),
          { type: "exhausted", code: codeOf(next.lastReason) },
        ],
      };
    }

    case "STOP": {
      if (phase === "idle") return NOTHING(state);
      return {
        state: { ...state, phase: "idle", token: state.token + 1 },
        effects: [{ type: "stop" }],
      };
    }
  }
}
