import { createEngine, type Engine } from "./engine";
import { WakeItConfigError } from "./errors";
import type {
  EnsureReadyOptions,
  ExecuteContext,
  ExecuteOptions,
  OperationSnapshot,
  ReadinessSnapshot,
  WakeIt,
  WakeItConfig,
} from "./types";

/**
 * Builds the public facade over an engine: a frozen object of closures (no `this`
 * dependence), so `const { subscribe } = client` works. Internal.
 */
export function assembleClient(engine: Engine): WakeIt {
  const client = {
    subscribe(listener: () => void): () => void {
      if (typeof listener !== "function") {
        throw new WakeItConfigError("Invalid WakeIt argument: `subscribe` expects a function.");
      }
      return engine.store.subscribe(listener);
    },
    ensureReady(options?: EnsureReadyOptions): Promise<void> {
      return engine.readiness.ensureReady(options);
    },
    getReadiness(backend?: string): ReadinessSnapshot {
      return engine.readiness.getReadiness(backend);
    },
    execute<T>(
      fn: (context: ExecuteContext) => T | PromiseLike<T>,
      options?: ExecuteOptions,
    ): Promise<Awaited<T>> {
      return engine.executor.execute(fn, options);
    },
    getOperations(): readonly OperationSnapshot[] {
      return engine.executor.getOperations();
    },
    cancel(operationId: string): void {
      engine.executor.cancel(operationId);
    },
    dispose(): void {
      engine.dispose();
    },
  };
  return Object.freeze(client);
}

/**
 * Creates an independent WakeIt client. Validates `config` and throws `WakeItConfigError`
 * when invalid. Performs no network requests and starts no timers or listeners.
 */
export function createWakeIt(config: WakeItConfig): WakeIt {
  return assembleClient(createEngine(config));
}
