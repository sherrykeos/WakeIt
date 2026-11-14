# WakeIt — Requirements (v1.0)

Status: Phase 0 — approval-ready draft. Priority key: **P0** required for v1 · **P1** planned for v1, individually go/no-go · **P2** deferred · **OOS** out of scope. Numeric values are **proposed targets requiring validation** unless stated otherwise. API shapes are in [API_DESIGN](API_DESIGN.md); contracts referenced here (§4.1 cancellation, §4.2 combined execution) are defined there once.

## 1. Feature inventory

V = user value, C = complexity, M = maintenance cost, R = reliability risk (L/M/H).

| Feature | V | C | M | R | P | Rationale |
|---|---|---|---|---|---|---|
| Readiness probe: URL, method, headers, timeout | H | L | L | L | **P0** | Problem A. |
| Custom `isReady` validator | H | L | L | L | **P0** | HTTP 200 ≠ ready; formats vary. |
| Probe polling/retry policy (bounded) | H | M | M | M | **P0** | Needed to wait safely. |
| Status taxonomy: not-ready / unreachable / offline | H | M | L | M | **P0** | Honest messaging. |
| Shared probe loop across callers | H | M | M | M | **P0** | Prevents probe storms. |
| `execute`: threshold, lifecycle, groups, filtering by group/`experience:false` | H | M | M | M | **P0** | Problem B; universal integration (works with fetch, Axios, anything). |
| Combined behavior via `execute({ readiness })` | H | L | L | M | **P0** | Composition of two P0s. |
| `onFailure: "proceed"` opt-in | M | L | L | M | **P0** | Justified: flaky/misconfigured health endpoints must not hard-block apps that prefer best-effort. Explicit, narrow semantics (API §4.2). |
| Cancellation contract (request-only, `cancellable`) | H | M | M | M | **P0** | Safety and honesty. |
| Concurrency (one experience, shared state) | H | M | M | M | **P0** | Dashboard init. |
| Client usable outside React | H | L | L | L | **P0** | Login code lives in modules. |
| React provider + hooks | H | M | M | L | **P0** | |
| Default overlay experience, readiness-failed state, Dismiss/Cancel/Check-again | H | M | M | L | **P0** | Out-of-the-box value. |
| Theme (light/dark/auto), CSS variables, messages, custom actions | H | L | L | L | **P0** | Customization baseline. |
| Full experience replacement | H | L | L | L | **P0** | Core principle; also the v1 path for custom content and games. |
| Experience error boundary | H | L | L | L | **P0** | Reliability. |
| Accessibility of default experience | H | M | M | L | **P0** | |
| SSR safety, Next.js (client components) | H | M | M | M | **P0** | |
| Axios integration | M | M | M | M | **P1** | Owner decision. Cut rather than weaken guarantees. |
| `wrapFetch` (native-signature fetch wrapper) | M | M | M | M | **P1** | Demoted from P0: `execute(({signal}) => fetch(...))` already covers it with no compatibility promise (API §6). |
| Named multiple backends | M | M | M | M | **P1** | API shape reserved in v1 (D9). |
| Non-blocking banner presentation | M | L | L | L | **P1** | Passive cold-start hint (U4). |
| Opt-in redacted debug logging | M | L | L | L | **P1** | |
| **Game slot** (`game` prop, pause/resume contract, lazy loading) | L–M | L | M | L | **P2** *(recommendation — needs approval)* | A custom experience can already render any interactive content, and unmount on settle is the "stop". The slot would add API surface and a contract to maintain for little v1 value. v1 ships a docs recipe instead. |
| Bundled mini-game / `wakeit/games` | L | M | M | L | **P2** | Owner decision. |
| Layout and animation slots | L | M | M | L | **P2** | Redundant with CSS variables + full replacement. |
| Per-operation timeout | M | L | L | M | **P2** | Apps/clients own timeouts; would add a second cancellation path. |
| Persisted/cross-tab readiness | L | M | M | **H** | **P2** | Stale-evidence risk. |
| Opt-in global fetch/XHR patching | M | H | H | **H** | **P2** | Invasive. |
| Other framework bindings | M | H | H | M | **P2** | |
| Application-request replay/retry | — | — | — | **H** | **OOS** | Unsafe; developer's responsibility. |
| Hosted service, analytics, backend SDK, HTTP client, plugin system, game editor/marketplace | — | — | — | — | **OOS** | PRODUCT_SPEC §6. |

## 2. Functional requirements

### Readiness (FR-R)

| ID | Requirement | P |
|---|---|---|
| FR-R1 | Probe a configurable URL with configurable method, headers, per-attempt timeout. | P0 |
| FR-R2 | Readiness decided by developer `isReady`; default is HTTP 2xx. Works for any JSON shape and empty (204) bodies. | P0 |
| FR-R3 | Probe retry policy: interval, max attempts, max duration, optional backoff (AD-19); **bounded by default** (run deadline always applies). | P0 |
| FR-R4 | Status: `unknown, checking, ready, not-ready, unreachable, offline`, each with a machine-readable reason. | P0 |
| FR-R5 | Concurrent `ensureReady` callers share one probe loop; one caller aborting does not stop the others. | P0 |
| FR-R6 | "Ready" is in-memory and time-limited; never persisted. | P0 |
| FR-R7 | Only the developer's `isReady` reads health responses; WakeIt never reads application responses. | P0 |
| FR-R8 | Named backends with independent state. | P1 |

### Monitoring and execution (FR-M)

| ID | Requirement | P |
|---|---|---|
| FR-M1 | `execute` invokes `fn` **at most once** (zero times if readiness fails or is aborted first) and returns its value unchanged. | P0 |
| FR-M2 | `fn`'s rejection is rethrown as the **same object**. After `fn` starts, WakeIt never throws its own errors. | P0 |
| FR-M3 | Operation state: `stage` (`awaiting-readiness` \| `running`), `slowness` (`quiet` \| `slow`, past threshold) and `cancelRequested`; settling removes the operation and queues an internal `operation-settled` event with the outcome (`fulfilled \| rejected`). **No `cancelled`, `succeeded` or `failed` state** (D-5.1). | P0 |
| FR-M4 | Threshold configurable globally, per group, per call. Provisional default 1500 ms. | P0 |
| FR-M5 | Cancellation follows API §4.1 exactly (dismiss ≠ request ≠ actual cancellation; no fabricated results). | P0 |
| FR-M6 | Combined execution follows API §4.2 (readiness then single invocation; reject by default; explicit `proceed`). | P0 |
| FR-M7 | Concurrent operations tracked independently; one experience shows all visible slow operations. | P0 |
| FR-M8 | No automatic retries or replays of application operations, ever. | P0 |
| FR-M9 | Groups provide thresholds and filtering for custom UI; `experience:false` monitors without UI. | P0 |
| FR-M10 | `wrapFetch` meets the compatibility contract in API §6. | P1 |
| FR-M11 | Axios interceptor integration with equivalent guarantees (API §7). | P1 |
| FR-M12 | `getOperations()` returns frozen, identity-stable snapshots of live operations; `cancel(id)` is an idempotent request that is a no-op for unknown, settled and non-`cancellable` operations (A-1). | P0 |

### Experience (FR-X)

| ID | Requirement | P |
|---|---|---|
| FR-X1 | Experience opens only after the threshold; closes when the last visible operation settles; configurable minimum visible time prevents flashing (value proposed, to validate). | P0 |
| FR-X2 | Copy follows the evidence rule (§5.2) and **never implies the business operation succeeded or completed**. | P0 |
| FR-X3 | Phases: `readiness-pending`, `request-slow`, `readiness-failed` (API §4.3). WakeIt never displays application errors. | P0 |
| FR-X4 | Default actions: Dismiss always; Cancel only for `cancellable` operations; Check again (re-probe only) in `readiness-failed`. | P0 |
| FR-X5 | Complete replacement by a custom component receiving `ExperienceProps`. | P0 |
| FR-X6 | Built-in customization: messages, theme, CSS variables, stable class hooks, custom actions. | P0 |
| FR-X7 | Throwing custom experience is contained by an error boundary; fallback to default UI (or none if configured); never affects operations. | P0 |
| FR-X8 | Banner presentation. | P1 |

### Developer experience (FR-D)

| ID | Requirement | P |
|---|---|---|
| FR-D1 | TypeScript-first; exported types; `execute` preserves `fn`'s return type. | P0 |
| FR-D2 | Config validated at creation with actionable messages. | P0 |
| FR-D3 | SSR-safe; Next.js via client components; no globals touched at import. | P0 |
| FR-D4 | Docs: quick start, readiness recipes (JSON variants, 204), custom experience (including a game recipe), Next.js, safety guarantees, non-goals. | P0 |

## 3. Non-functional requirements

| Area | Requirement |
|---|---|
| Reliability | WakeIt failures (probe, UI) never cause an application operation to fail, hang, or run twice. All loops bounded by default. Timers/listeners cleaned on settle, unmount, and `dispose()`. |
| Performance | No timers or network activity when idle. Tracking overhead **proposed target:** not measurable above noise with 1,000 concurrent tracked operations (validate in Phase 2). |
| Memory | No retained references to settled operations, responses, or unmounted components; verified by leak tests (mount/unmount; 1,000-operation churn). |
| Security & privacy | No logging of request/response bodies, headers, or full URLs by default; debug logging opt-in and redacted; no telemetry; no outbound calls other than configured probes; health URLs are developer configuration. |
| Accessibility | Default experience targets WCAG 2.2 AA: roles/labels, live-region status, focus trap and restore for the blocking overlay, keyboard Dismiss/Cancel, `prefers-reduced-motion`, contrast in both themes. |
| Browser compat | Last two versions of evergreen browsers (Chrome, Edge, Firefox, Safari) — **subject to compatibility validation** (e.g., signal linking) in Phase 0.5/1. |
| React compat | React 18 and 19; StrictMode and concurrent rendering safe. |
| SSR | Import and render on server without errors; no `window`/`document` use outside effects/handlers; no hydration mismatch. |
| Type safety | Strict-TS friendly; no `any` in public types; types shipped. |
| Package size | **Proposed:** core ≤ ~4 KB, React bindings + default UI ≤ ~10 KB (min+gzip); enforced in CI after Phase 2 measurement. |
| Dependencies | No runtime dependencies; `react` peer; Axios optional peer. |
| Maintainability | Small public surface; semver; every documented contract has a test; deprecation policy. |
| DX | First working integration from the README alone in minutes (usability-checked). |

## 4. Boundaries

See [PRODUCT_SPEC §6](PRODUCT_SPEC.md); the OOS and P2 rows above are binding for v1.

## 5. Error and failure model

### 5.1 Domains and terms

| Term | Meaning |
|---|---|
| **Readiness failure** | A WakeIt probe outcome. Surfaces only as `WakeItReadinessError` *before* `fn` starts. |
| **Application failure** | Anything produced by `fn`, fetch, or Axios. Passed through untouched. |
| **Probe retry** | WakeIt re-sending its own health request per `poll`. |
| **Operation retry** | Re-running business logic. **Never done by WakeIt.** |
| **Bypass** | `readiness: { onFailure: "proceed" }`: start `fn` despite a bypassable readiness failure. |

### 5.2 Evidence rule

| UI claim | Allowed only when |
|---|---|
| "This is taking longer than usual." | Operation exceeded the threshold. |
| "Can't reach the backend yet." | A probe observed `unreachable` or `timeout`. |
| "Backend is starting up." | `mayColdStart: true` **and** a probe observed `not-ready`, `unreachable` or `timeout`. |
| "Backend is responding. Still waiting for your request…" | Probe ready while the operation is still pending. |
| Never | Sleeping/cold-start claims from slowness alone; any wording suggesting the operation finished, succeeded, or was cancelled. |

### 5.3 Lifecycle scenarios

| ID | Scenario | Expected behavior |
|---|---|---|
| E-1 | Finishes before the threshold | Experience never shown; no flash. |
| E-2 | Exceeds the threshold | Experience opens; `phase` reflects what is known (§5.2). |
| E-3 | Backend ready while request pending | Status updates, copy may change; request not restarted or replayed; experience stays until it settles. |
| E-4 | Multiple operations active | One experience listing all visible operations. |
| E-5 | One finishes, others pending | It leaves the list; experience stays until the last visible operation settles. |
| E-6 | User dismisses | UI hidden; operations untouched; dismissed operations never reopen it; later operations open it normally. |
| E-7 | Cancel requested (cancellable op) | `signal` aborted; `cancelRequested` true; copy "Cancellation requested…"; closes only when `fn` settles; outcome is `fn`'s own. |
| E-8 | Function ignores the signal | Continues normally; promise outcome unchanged. |
| E-9 | Completion after dismissal | Promise settles normally; no UI reappearance; state cleaned. |
| E-10 | User navigates away / unmounts | UI and subscriptions removed; `fn` not aborted by WakeIt; no updates after unmount. |
| E-11 | Custom experience throws | Contained; default UI or none; app and operations unaffected; dev-mode console report. |
| E-12 | Readiness fails in combined call | Default: reject `WakeItReadinessError`, `fn` not invoked. With `proceed` and a bypassable failure: `fn` invoked once. |
| E-13 | Abort during readiness wait | Real cancellation: `WakeItReadinessError("aborted")`, `fn` never invoked, probe loop continues only if other callers wait. |
| E-14 | `ensureReady` during SSR render | No network or timers during render; guarded. |
| E-15 | Browser goes offline mid-wait | Status `offline`; probing pauses (no attempts consumed); resumes on `online`; copy blames connectivity, not the backend. |

### 5.4 Failure classification

| Failure | Domain | WakeIt retries? | Rejects? | Bypassable? |
|---|---|---|---|---|
| Backend not ready (probe answered, `isReady` false / non-2xx) | Readiness | Probe retry per `poll` | After policy ends: code `not-ready` | Yes |
| Backend unreachable (network error/DNS/refused) | Readiness | Probe retry | After policy ends: `unreachable` | Yes |
| Browser offline | Readiness | Waits for `online`; bounded by `maxDurationMs` | After limit: `offline` | Yes (`fn` will likely fail with its own network error) |
| Probe timeout | Readiness | Probe retry | After policy ends: `timeout` | Yes |
| Invalid health response (validator throws/unparseable) | Readiness | Probe retry; flagged as likely misconfiguration | After policy ends: `invalid-response` | Yes |
| Invalid configuration | Config | No | `WakeItConfigError`, immediately | **No** |
| Abort/cancel before `fn` starts | Readiness | No | `WakeItReadinessError("aborted")` | **No** |
| Application request failure (incl. HTTP 4xx/5xx via fetch) | Application | **Never** | Only as `fn`/fetch itself does, same object | n/a |
| Application request timeout | Application | **Never** | Application's own error | n/a |
| User-requested cancellation after `fn` starts | Application | **Never** | Only if `fn` rejects; never fabricated | n/a |

## 6. Acceptance criteria (v1.0)

**Readiness detection**
- AC-R1: Endpoint returns 503 N times then 200 → `ensureReady` resolves after the first 200; probe count = N+1.
- AC-R2: `{"status":"ready"}`, `{"healthy":true}` and 204-without-body are each recognized using configuration only.
- AC-R3: HTTP 200 rejected by `isReady` yields `not-ready`, not `ready`.
- AC-R4: A hanging endpoint is aborted at the configured timeout and recorded as `timeout`.
- AC-R5: 10 simultaneous `ensureReady` calls produce at most one probe in flight.
- AC-R6: After policy limits, polling stops and no timers remain.
- AC-R7: Each row of §5.4 yields the stated code, retry behavior, and bypassability.
- AC-R8: A single `backend` is addressed as `"default"`; with only other named backends, `ensureReady()` without an id rejects `WakeItConfigError` listing the ids; an unknown id and "no backend configured" reject `WakeItConfigError` without any probe.
- AC-R9: Without backoff the retry delay is `intervalMs`; with backoff it follows `min(maxDelayMs, intervalMs × multiplier^(n−1))` shortened by at most `jitter`; never above `maxDelayMs`.
- AC-R10: One caller's `signal` rejects only that caller (`aborted`); the probe continues while others wait; when none remain the attempt is aborted and timers/listeners are released.
- AC-R11: Going offline mid-run consumes no attempt; recovery probes immediately; the run deadline still bounds the wait.
- AC-R12: `getReadiness()` never reports `ready` at or after `validUntil`, with or without subscribers or timers.
- AC-R13: After `dispose()`: `ensureReady` rejects `aborted`, no timers/listeners remain, no state update or notification occurs.

**Execution and monitoring**
- AC-M1: `fn` resolving before the threshold never shows the experience.
- AC-M2: `fn` exceeding the threshold shows the experience once; it closes on settle.
- AC-M3: `fn` call count is exactly 1 on success, failure, cancel request, dismissal, and in StrictMode; 0 on readiness failure/abort.
- AC-M4: A rejection from `fn` is `===` the object at the call site; no WakeIt error ever rejects after `fn` starts.
- AC-M5: The resolved value of `execute` is `===` the value `fn` resolved.
- AC-M6: `experience:false` operations never render UI but appear in `useWakeItOperations`.

**Combined execution**
- AC-B1: Default readiness failure rejects with `WakeItReadinessError` and `fn` is not called.
- AC-B2: With `proceed`, a bypassable failure calls `fn` exactly once; `aborted` and config errors still reject.
- AC-B3: With valid readiness (within TTL), `fn` starts without any probe.
- AC-B4: No code path invokes `fn` a second time (asserted across all failure/cancel permutations).
- AC-B5: With no backend configured, plain `execute(fn)` works; `ensureReady()` and `execute(fn, { readiness })` reject `WakeItConfigError` and `fn` is not invoked.

**Cancellation**
- AC-K1: Cancel/abort request aborts the signal given to `fn` in the same tick; the caller's own signal is never aborted by WakeIt.
- AC-K2: `fn` ignoring the signal runs to completion with its normal outcome; no `cancelled` state or text is ever produced.
- AC-K3: Default Cancel action is absent for non-`cancellable` operations.
- AC-K4: Dismiss does not abort the signal.
- AC-K5: After settle, `dispose()` or unmount: no timers, listeners, or state updates remain.

**React integration**
- AC-X1: Quick start works in a fresh Vite React+TS project with ≤ 10 WakeIt-specific lines.
- AC-X2: Works on React 18 and 19, StrictMode, no warnings.
- AC-X3: Hooks re-render only on relevant changes (render-count tests).

**Custom experiences**
- AC-C1: A custom `experience` renders with documented props; default UI absent from the DOM.
- AC-C2: Theme, messages, CSS variables and custom actions alter the default UI without forking.
- AC-C3: A throwing custom experience does not alter any operation's outcome or crash the app.
- AC-C4: Docs include a working recipe embedding an interactive component in a custom experience.

**Error handling and copy**
- AC-E1: Every scenario E-1…E-15 has an automated test.
- AC-E2: No UI string claims waking/sleeping unless §5.2 holds (tested with and without `mayColdStart`).
- AC-E3: No default string implies completion, success, or cancellation of the business operation.

**Concurrency**
- AC-N1: 50 concurrent slow operations render one experience; it closes after the last settles.
- AC-N2: Groups with different thresholds behave independently.

**SSR**
- AC-S1: `renderToString` succeeds with no network calls and no browser-global errors.
- AC-S2: A Next.js App Router sample builds and hydrates without mismatch warnings.

**Accessibility**
- AC-A1: axe checks pass on all default states in light and dark.
- AC-A2: Keyboard pass: focus enters and is trapped in the overlay; Dismiss/Cancel work via keyboard; focus returns to the trigger.
- AC-A3: Status changes announced via live region (screen-reader smoke test).
- AC-A4: `prefers-reduced-motion` disables non-essential animation.

**P1 items (each only if shipped)**
- AC-F1 (`wrapFetch`): requests observed by a test server are identical to native fetch (method, headers, credentials, body); the returned `Response` is the original object with its body unread; HTTP errors resolve normally; network errors pass through; zero retries; `Request`-object inputs are tracked but not cancellable.
- AC-F2 (Axios): config, responses and errors are unchanged apart from tracking metadata; detach restores pre-attach behavior.

**Documentation**
- AC-D1: Docs cover quick start, readiness recipes, custom experience, Next.js, the §4.1/§4.2 contracts, and "when not to use WakeIt".
- AC-D2: Every public symbol has description + example; examples are type-checked in CI.
- AC-D3: 3 target developers complete the quick start unaided.

**npm distribution**
- AC-P1: ESM + CJS + types; `exports` resolve in Node, Vite and Next.js.
- AC-P2: Package contents limited to built output, README, LICENSE.
- AC-P3: Zero `dependencies`; correct peers; no peer warnings on supported versions.
- AC-P4: Size budgets pass in CI once validated.
- AC-P5: Semver releases with release notes; package name verified available at publish time.
