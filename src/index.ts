// `wakeit` core entry. Explicit allow-list: internal modules are never re-exported.
export { createWakeIt } from "./core/client";
export { WakeItConfigError, WakeItReadinessError } from "./core/errors";
export type {
  BackendConfig,
  BackoffConfig,
  EnsureReadyOptions,
  ExecuteContext,
  ExecuteOptions,
  GroupConfig,
  HealthRequestConfig,
  OperationSnapshot,
  PollConfig,
  ReadinessErrorCode,
  ReadinessReason,
  ReadinessSnapshot,
  ReadinessStatus,
  WakeIt,
  WakeItConfig,
} from "./core/types";
