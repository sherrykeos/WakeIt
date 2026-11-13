# WakeIt — Public API Direction (v1.0)

Status: Phase 0 — approval-ready draft. These are **product-level contracts**, not implementation design. Names may be refined in Phase 1; the behavior may not. Priorities and requirement IDs live in [REQUIREMENTS](REQUIREMENTS.md).

Package name: **`wakeit` (provisional)** — see [ROADMAP §Naming](ROADMAP.md).

## 1. Package surface

| Entry | Contents | P |
|---|---|---|
| `wakeit` | Framework-agnostic client: readiness, `execute`, errors. No React import. | P0 |
| `wakeit/react` | Provider, hooks, default experience. | P0 |
| `wakeit/axios` | Axios attach helper (optional peer). | P1 |

`wrapFetch` (P1) lives in the core entry. No other entry points in v1.

## 2. The whole v1 API in one view

```ts
// core
createWakeIt(config): WakeIt

interface WakeIt {
  ensureReady(opts?: { backend?: string; signal?: AbortSignal }): Promise<void>;
  execute<T>(fn: (ctx: { signal: AbortSignal }) => Promise<T>, opts?: ExecuteOptions): Promise<T>;
  getReadiness(backend?: string): ReadinessSnapshot;
  subscribe(listener: () => void): () => void;
  dispose(): void;
  wrapFetch(...): typeof fetch;          // P1
}

interface ExecuteOptions {
  group?: string;                         // label for thresholds / UI filtering
  thresholdMs?: number;                   // overrides group/global threshold
  readiness?: boolean | { backend?: string; onFailure?: "reject" | "proceed" };
  cancellable?: boolean;                  // default false — see §4.1
  signal?: AbortSignal;                   // caller-owned; see §4.1
  experience?: false;                     // monitor without showing UI
}
```

```tsx
// react
<WakeItProvider client experience? theme? messages? actions? />
useWakeIt()               // { execute, ensureReady } bound to the client
useReadiness(backend?)    // ReadinessSnapshot, reactive
useWakeItOperations()     // reactive list of tracked operations (for custom UI)
```

**API review notes (what changed from the first draft):**

| Item | Decision | Reason |
|---|---|---|
| `runWhenReady` | Dropped (D2). | Composition of two primitives; invites replay expectations. |
| `onReadinessFailure` as a top-level option | Folded into `readiness: { onFailure }`. | Option only has meaning with readiness; avoids a dangling option. |
| `cancellable` | Added, default `false`. | A Cancel button on a function that ignores its signal would lie (§4.1). |
| `experience: false` | Added. | Lets code monitor/await readiness without UI; replaces the earlier per-call `ExperienceOptions` object. |
| `wakeit.fetch(input, init & { wakeit })` | Replaced by `wrapFetch` (P1), native signature. | Custom key inside `RequestInit` pollutes native typing; see §6. |
| Game slot, `wakeit/games`, layout/animation slots | Removed from v1 (P2). | See [REQUIREMENTS §1](REQUIREMENTS.md). |
| `ensureReady` / `execute` result | `Promise<void>` / `Promise<T>`; no wrapper object. | Return values stay exactly the app's. |

## 3. Configuration

```ts
createWakeIt({
  backend?: BackendConfig,                 // or `backends: Record<string, BackendConfig>` (P1); both optional (O-7)
  thresholdMs?: number,                    // provisional default: 1500
})
```

| `BackendConfig` option | Meaning |
|---|---|
| `health` | URL or `{ url, method?, headers?, timeoutMs? }`. |
| `isReady` | `(res: Response) => boolean \| Promise<boolean>`. Default: HTTP 2xx. Any format is the developer's call. |
| `poll` | `{ intervalMs?, maxAttempts?, maxDurationMs?, backoff? }` — **probe** retry policy only. `backoff`: `true` or `{ multiplier?, maxDelayMs?, jitter? }` (exponential from `intervalMs`, jitter only shortens delays); details and defaults in [DECISIONS AD-19](../architecture/DECISIONS.md). Always bounded by `maxDurationMs`. |
| `mayColdStart` | Developer's declaration that this backend may sleep; gates cold-start wording ([REQUIREMENTS §5.2](REQUIREMENTS.md)). |
| `readyTtlMs` | In-memory validity of a "ready" result. |

**No backend configured (owner decision O-7).** `backend` and `backends` are both optional (at most one). A client without a backend supports plain `execute(fn)` (monitoring only). `ensureReady()` and `execute(fn, { readiness })` reject with `WakeItConfigError` **before** `fn` is invoked or any operation is created; they never fall back to "no readiness". `poll.backoff` is not part of the configuration yet; its shape is an unresolved Phase 4 decision.

The default threshold of **1500 ms is provisional** pending validation (ROADMAP Phase 0.5). Config errors throw `WakeItConfigError` at `createWakeIt`.

## 4. Behavioral contracts

### 4.1 Execution and cancellation

Four distinct things, never conflated:

| Concept | What it is | Effect on the operation |
|---|---|---|
| **Dismiss** | UI-only: hide the waiting experience. | None. No signal, no state change to the operation. |
| **Cancellation request** | `signal` abort — via experience Cancel, caller's own `signal` option, or custom-UI `cancel()`. | Only the *request*: WakeIt aborts the `AbortSignal` it gave `fn`. |
| **Actual cancellation** | `fn` observing the signal and stopping. | Owned entirely by `fn`. WakeIt can only observe `fn`'s settlement. |
| **Completion after cancellation request** | `fn` settles anyway. | Returned/rethrown **exactly as `fn` produced it**. |

Rules:

1. **Ownership.** WakeIt owns the `AbortController` it passes to `fn`. The caller may pass their own `opts.signal`; if it aborts, WakeIt aborts the signal given to `fn` (and any readiness wait). The caller's signal is never aborted by WakeIt. Whether anything actually stops is `fn`'s responsibility.
2. **No fabrication.** WakeIt never rejects, resolves, or races the promise returned by `execute` once `fn` has been invoked. The returned promise **is** `fn`'s outcome. If `fn` ignores the signal it runs to completion normally.
3. **No cancelled claim.** Operation state exposes `cancelRequested: boolean`, never `cancelled`. UI copy after a request is "Cancellation requested…" until `fn` settles, then the experience closes. WakeIt cannot know whether a rejection was caused by the abort.
4. **`cancellable` honesty.** The default experience shows a **Cancel** action only for operations with `cancellable: true` (the developer attests `fn` honors `signal`). Otherwise it shows **Dismiss** (or nothing). Custom experiences receive `cancellable` per operation.
5. **Before `fn` is invoked** (readiness wait, WakeIt-owned): abort is real. `execute`/`ensureReady` reject with `WakeItReadinessError` code `aborted`; `fn` is never invoked.
6. **Dismissal then completion.** `fn` continues; the promise settles normally; the experience does not reappear for that operation. Operations started later open the experience normally.
7. **Unmount / navigation.** Unmounting the provider or experience dismisses UI and removes subscriptions. It does **not** abort `fn`; wiring `signal` to component lifecycle is the developer's choice.
8. **Cleanup.** On settle: that operation's timers are cleared and it is removed from tracked state. On `dispose()`: probe loops and timers stop and subscribers are dropped; in-flight `fn`s are untouched. No state updates reach unmounted components.

### 4.2 Readiness and combined execution

```ts
await wakeit.ensureReady();                       // (a) readiness only
await wakeit.execute(fn);                         // (b) monitoring only
await wakeit.execute(fn, { readiness: true });    // (c) readiness, then fn exactly once
```

| Aspect | Contract |
|---|---|
| (a) `ensureReady` | Resolves when ready; rejects `WakeItReadinessError`. Concurrent callers share one probe loop. A tracked wait: opens the experience after the threshold like any operation. |
| (b) `execute` | Invokes `fn` immediately, once. No probing. |
| (c) combined | 1) readiness wait → 2) single invocation of `fn`. If readiness is already valid (within `readyTtlMs`), no probe and `fn` starts immediately. |
| Threshold clock | Starts at the `execute` call, so a slow readiness wait can open the experience. |
| Readiness failure (default `onFailure: "reject"`) | `execute` rejects with `WakeItReadinessError`; **`fn` is never invoked**. |
| `onFailure: "proceed"` | After the readiness policy ends in a *bypassable* failure ([REQUIREMENTS §5.4](REQUIREMENTS.md)), `fn` is invoked **once**; the failure is recorded in `getReadiness()` only. It does **not** shorten the wait (bounded by `poll`) and does not retry anything. |
| Error separation | Before `fn` starts: only `WakeItReadinessError`/`WakeItConfigError` can reject. **After `fn` starts: WakeIt never throws its own error; every rejection is the application's, same object.** This is the discriminator developers use. |
| Replay | Never. Probe retries are WakeIt's own requests; `fn` is called at most once per `execute` call. A later `execute` call is a new, developer-initiated operation. |

### 4.3 Experience and readiness failure

When a waiting call rejects with a readiness error after the user has seen the experience, the experience may show a `readiness-failed` phase (dismissible, with **Check again**, which re-probes the backend only — it never re-runs any operation). Suppress with `experience: false`.

### 4.4 `ensureReady` and `getReadiness` (Phase 4 contract)

```ts
ensureReady(opts?: { backend?: string; signal?: AbortSignal }): Promise<void>
getReadiness(backend?: string): ReadinessSnapshot
```

| Aspect | Contract |
|---|---|
| Backend selection | A single `backend` has the id `"default"`; named `backends` use their keys. Without `backend`, `"default"` is used **only if it exists**; otherwise the call fails with `WakeItConfigError` listing the configured ids. No backend is ever chosen implicitly or arbitrarily (AD-18). |
| Failures | `ensureReady` never throws synchronously. It rejects `WakeItConfigError` for: no backend configured, unknown or non-string backend id, invalid options, no `fetch`/`AbortController` available. `getReadiness` throws `WakeItConfigError` for the first three. |
| Readiness | Transport success is not readiness: the default validator accepts HTTP 2xx (so `204` is ready), a custom `isReady` decides alone and must return exactly `true` or `false` (anything else, or a throw, is `invalid-response`). |
| Shared run | Concurrent callers for one backend share one probe run and its budget. `signal` removes **only that caller's wait** (rejects `aborted`); the run stops when the last waiter leaves. A pre-aborted signal rejects `aborted` immediately, even when readiness is fresh. |
| Freshness | A result is valid for `readyTtlMs` (`validUntil`). `getReadiness` never returns `ready` at or after `validUntil` (it returns `unknown`/`expired`). `ensureReady` at or after `validUntil` starts a new shared run. |
| Offline | A network failure while the environment reports offline is `offline`, consumes no attempt, and pauses probing until connectivity returns; the run deadline still bounds the wait. |
| Timeout | `timeout` means no usable response within the limit; it does not prove the backend is down or asleep. |
| After `dispose()` | `ensureReady` rejects `aborted`; `getReadiness` keeps returning the last snapshot; no further notifications. |
| Not yet | Tracking `ensureReady` as an operation (threshold, experience) and `execute({ readiness })` arrive with the execution phase. |

`ReadinessSnapshot`: `{ backend, status, reason?, attempts, checkedAt?, validUntil? }`, frozen and identity-stable until it changes. `attempts` counts finished probe attempts of the current run (offline waits excluded).

## 5. Usage examples

**Login, readiness first, handling both error domains**

```ts
import { createWakeIt, WakeItReadinessError } from "wakeit";

export const wakeit = createWakeIt({
  backend: {
    health: "https://api.example.com/health",
    isReady: async (r) => r.ok && (await r.json()).status === "ready",
    mayColdStart: true,
  },
});

async function onLogin(credentials: Credentials) {
  try {
    const session = await wakeit.execute(
      ({ signal }) => api.login(credentials, { signal }),
      { readiness: true, cancellable: true, group: "auth" },
    );
    return session;                       // type: Session
  } catch (e) {
    if (e instanceof WakeItReadinessError) return showBackendUnavailable(e.code);
    throw e;                              // the application's own error, unchanged
  }
}
```

**Readiness recipes**

```ts
isReady: (r) => r.status === 204                          // empty body
isReady: async (r) => (await r.json()).healthy === true   // { "healthy": true }
```

**Dashboard: concurrent requests share one experience**

```ts
const [me, stats] = await Promise.all([
  wakeit.execute(({ signal }) => api.me({ signal }), { group: "dashboard" }),
  wakeit.execute(({ signal }) => api.stats({ signal }), { group: "dashboard" }),
]);
```

**Best-effort mode (explicit opt-in)**

```ts
await wakeit.execute(() => api.ping(), { readiness: { onFailure: "proceed" } });
```

**Upload: monitor without UI interference (body untouched)**

```ts
await wakeit.execute(() => uploadFile(file), { group: "upload", experience: false });
```

**Fetch without a wrapper (always available, fully native)**

```ts
const res = await wakeit.execute(({ signal }) => fetch("/api/report", { signal }), { cancellable: true });
```

**React**

```tsx
<WakeItProvider client={wakeit} theme="auto" messages={{ slow: "Still working on it…" }}>
  <App />
</WakeItProvider>

const { execute } = useWakeIt();
const readiness = useReadiness();          // { status, reason?, checkedAt?, attempts }
```

**Fully custom experience (any content, including a game of your own)**

```tsx
function MyScreen({ phase, readiness, operations, actions }: ExperienceProps) {
  return (
    <Overlay>
      <p>{phase === "readiness-failed" ? "Can't reach the server." : "One moment…"}</p>
      {/* your own components — including an interactive game — go here */}
      <button onClick={() => actions.dismiss()}>Hide</button>
    </Overlay>
  );
}
<WakeItProvider client={wakeit} experience={MyScreen} />
```

`ExperienceProps`:

| Prop | Meaning |
|---|---|
| `phase` | `"readiness-pending" \| "request-slow" \| "readiness-failed"` — only what WakeIt knows. |
| `readiness` | Relevant backend snapshot (status, reason, attempts). |
| `operations` | Visible tracked operations: `{ id, kind: "readiness" \| "request", group, elapsedMs, cancellable, cancelRequested }`. No URLs/bodies. |
| `actions` | `dismiss()`, `cancel(id?)` (cancellable ops only), `checkBackend()`, plus developer-defined actions. |

Customizing the built-in UI (v1): `messages` (strings or functions of phase/readiness), `theme` (`light \| dark \| auto`), `--wakeit-*` CSS variables, stable class names/data attributes, custom `actions`. Anything beyond that → replace the experience.

## 6. Fetch integration (P1) — critical review

`execute(({ signal }) => fetch(url, { signal }))` already gives monitoring with *zero* compatibility surface and is the P0 recommended pattern. A wrapper adds convenience but also a compatibility promise, so it is P1 and deliberately narrow:

```ts
const apiFetch = wakeit.wrapFetch(globalThis.fetch, { group: "api", filter?: (input, init) => boolean });
const res = await apiFetch("/api/items", { method: "POST", body, credentials: "include" });
```

| Aspect | Contract (what is and is not promised) |
|---|---|
| Signature | Identical to native `fetch`; options are set at wrap time. No custom keys in `RequestInit`. |
| Delegation | Arguments are passed to the supplied fetch unchanged — headers, credentials, method, body, `keepalive`, etc. WakeIt adds/removes none. |
| Response | The original `Response` object is returned; never cloned, read, or wrapped. Status and body semantics untouched. |
| HTTP errors (4xx/5xx) | Resolve as in native fetch. Not WakeIt errors; **not** treated as readiness evidence (only probes are). |
| Network errors | Native `TypeError` rejection passes through unchanged. |
| Retries | None. |
| Tracking window | From call until the fetch promise settles (response headers available). **Body download and streaming are not tracked**; a slow body is invisible to WakeIt. |
| Cancellation | Caller's `init.signal` keeps native behavior. If the call is `cancellable`, the signal handed to native fetch is a *derived* signal linked to the caller's (identity differs; abort reason propagates). **Not supported when `input` is a `Request` object** (replacing its signal would require rebuilding it); such calls are tracked but not cancellable. |
| Compatibility claim | "Transparent delegation" for the rows above — *not* "full compatibility". Edge cases (service workers, framework-patched fetch) are validated in testing, not promised in advance. |

## 7. Axios integration (P1)

```ts
import { attachWakeIt } from "wakeit/axios";
const detach = attachWakeIt(axiosInstance, wakeit, { group: "api", filter });
```

Observes through interceptors; does not alter config, responses, or errors beyond tracking metadata; no retries; returns a detach function. Same tracking window and cancellation caveats as §6 (Axios cancellation is via the caller's own signal/config). Equivalent guarantees are validated in Phase 4; if they cannot be met, the item is cut rather than weakened.

## 8. Errors

| Type | When |
|---|---|
| `WakeItReadinessError` — `code`: `not-ready` · `unreachable` · `offline` · `timeout` · `invalid-response` · `aborted`; plus `backend`, `attempts`, `elapsedMs` | `ensureReady`, or `execute` with `readiness`, **before `fn` is invoked**. `aborted` also covers client disposal. Messages are fixed text; no URL, header, body or `cause` is ever attached (AD-24). |
| `WakeItConfigError` | Invalid configuration/options, thrown before any operation starts; also `ensureReady`/`execute({ readiness })` called when no backend is configured (O-7). |
| *(none)* | Anything after `fn` starts, and all fetch/Axios failures: the application's own errors, untouched. |

## 9. Not in the v1 API

`runWhenReady`, game slot / bundled games, layout and animation slots, per-operation timeout, global fetch/XHR patching, request replay/retry, plugin registration, persisted readiness, analytics hooks.
