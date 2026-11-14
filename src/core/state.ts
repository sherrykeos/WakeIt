import type { CoreState, NormalizedConfig, OperationSnapshot, ReadinessSnapshot } from "./types";

/** Shared empty list: identity-stable, so "no operations" never changes slice identity. */
export const EMPTY_OPERATIONS: readonly OperationSnapshot[] = Object.freeze([]);

/** Returns `state` with one backend's snapshot replaced; other slices keep their identity. */
export function withReadiness(state: CoreState, snapshot: ReadinessSnapshot): CoreState {
  const readiness = Object.assign(
    Object.create(null) as Record<string, ReadinessSnapshot>,
    state.readiness,
    { [snapshot.backend]: snapshot },
  );
  return Object.freeze({ ...state, readiness: Object.freeze(readiness) });
}

/**
 * Initial state: every configured backend starts `unknown` with no attempts (no evidence yet).
 * Nothing probes; readiness behavior arrives with the readiness phase.
 */
export function createInitialState(config: NormalizedConfig): CoreState {
  const readiness = Object.create(null) as Record<string, ReadinessSnapshot>;
  for (const backend of Object.keys(config.backends)) {
    readiness[backend] = Object.freeze({ backend, status: "unknown", attempts: 0 });
  }
  return Object.freeze({ readiness: Object.freeze(readiness), operations: EMPTY_OPERATIONS });
}

/** Returns `state` with a new operations list; an empty list is the shared constant. */
export function withOperations(
  state: CoreState,
  operations: readonly OperationSnapshot[],
): CoreState {
  const next = operations.length === 0 ? EMPTY_OPERATIONS : Object.freeze(operations);
  return next === state.operations ? state : Object.freeze({ ...state, operations: next });
}
