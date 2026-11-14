# WakeIt — Architecture Decisions (v1.0)

Status: Phase 1 — review revision. Record format: **Decision · Why · Alternatives · Trade-offs · Consequences**. Most expensive-to-reverse first. **[E]** = engineering judgment; owner decisions are logged in §5.

## 1. Decision records

### AD-1 Interface tiers: public-API-first layering plus one narrow internal channel [E, revised]
- **Decision:** Four tiers (ARCHITECTURE §2.1): (1) package public API (semver); (2) internal core interfaces (`ReadinessPort`, store reader/writer, `EngineDeps`, machine types, internal channel — never exported); (3) adapters get only `Pick<WakeIt,"execute">`; (4) React integration — public props/hooks plus an internal `ExperienceController`. Everything above the core uses the public client, with one exception: a **versioned internal channel** attached to the client instance under a registry symbol, carrying `operation-settled` events for the experience controller.
- **Why:** The initial "no private channels at all" rule forced either a public failure-tracking field or fragile snapshot inference. A single internal channel gives the experience precise outcome information without enlarging the npm API, and keeps subsystems decoupled through defined interfaces.
- **Alternatives:** (a) module-level registry — breaks under ESM/CJS or bundler duplication; (b) public event emitter — no developer use case today, permanent API surface; (c) `failedWaits`-style counter on `ReadinessSnapshot` — pollutes a public type and cannot say *which* operation failed (rejected by owner direction O-1); (d) retaining settled operations — contradicts API §4.1.8, leaks memory.
- **Trade-offs:** A reachable-but-unsupported symbol property exists on the client. Mitigations: not in any `.d.ts`, version tag, explicit "unsupported" docs, single event type, no sensitive payload.
- **Consequences:** Lint-enforced boundaries; the React entry degrades gracefully without the channel (no `failed` phase); **promotion rule:** the channel becomes public only after a concrete developer use case and an approved API design.

### AD-2 Experience controller outside the core; failure shown via operation events [E, revised]
- **Why:** Dismissal, visibility, minimum-visible time and copy are presentation concerns; the core must run without UI.
- **Alternatives:** Experience state in the engine; snapshot-diff inference of failures (heuristic, ambiguous with concurrent operations — dropped).
- **Trade-offs:** The controller needs the internal channel (AD-1) for exact readiness-failure outcomes. Failure notices are created only for slow, undismissed operations rejected by readiness (not aborts, not `proceed`, not quiet ones).
- **Consequences:** Pure reducer, table-testable (TR-X1); one controller per provider; nested providers share the outer host.

### AD-3 One external immutable store; `useSyncExternalStore`; microtask-coalesced notification [E]
- **Why:** Exact fit for React 18/19; hydration safe via a constant `getServerSnapshot` (AD-10); slice identity prevents needless re-renders.
- **Alternatives:** Store libraries (dependency); per-subsystem stores (torn reads); synchronous notification (render storms).
- **Trade-offs:** Subscribers may see newer state than the event that woke them (consumers read snapshots, not events). Own implementation needs re-entrancy tests.
- **Consequences:** Read-your-writes getters; flush order = internal events, then subscribers; listener exceptions contained.

### AD-4 Readiness: one controller per backend, shared demand-driven run, run-level policy [E]
- **Why:** No duplicate loops by construction; no timers when nobody waits.
- **Alternatives:** Per-call loops (probe storms); background polling (idle cost); per-waiter budgets (timer multiplication).
- **Trade-offs:** Late joiners share the remaining run budget; after exhaustion a new call starts a fresh run immediately.
- **Consequences:** Backend-keyed Map from day one (D9); `checking` only for a run's first attempt; evidence only from the current run.

### AD-5 Readiness freshness: read-time normalization + observed-expiry timer [E, revised — review A]
- **Decision:** A public readiness snapshot never reports `ready` at/after `validUntil`. (1) `getReadiness()` derives the expired snapshot (`unknown`, reason `expired`) at read time, identity-cached per store version; (2) a one-shot expiry timer per ready backend exists **only while the store has ≥ 1 subscriber** (and is `unref`'d where supported) to commit the normalization and notify hooks; none otherwise.
- **Why:** Truthfulness without idle cost. Read-time derivation is correct even when timers are throttled (background tabs); the timer only drives re-render latency.
- **Alternatives:** (a) lazy-only normalization at decision points — rejected: a `ready` snapshot could be shown long after expiry; (b) always-on timer — idle cost and keeps Node processes alive; (c) expose `validUntil` and let consumers compare — misleading by default; (d) no TTL — violates FR-R6.
- **Trade-offs:** One timer per ready backend while the UI observes; the Phase 0 NFR "no timers when idle" needs its "idle" defined as no probing, no tracked operations and no subscribers (A-6). Two mechanisms to test (TR-F1…F4).
- **Consequences:** Invariant 10 (never `ready` past expiry); resource table includes the expiry timer.

### AD-6 Cancellation signals: engine-owned controller per operation, manual linking, explicit pre-abort rules [E + O-4]
- **Why:** Clear ownership; no dependency on newer platform APIs (`AbortSignal.any`).
- **Alternatives:** `AbortSignal.any`; passing the caller's signal straight through (cannot support UI cancel).
- **Trade-offs:** WakeIt manages listener removal (balance-tested). `fn` always receives a derived signal.
- **Consequences:** Plain `execute` with a pre-aborted signal invokes `fn` once with an aborted signal; combined execution rejects `aborted` and never invokes `fn` — even with valid readiness; a **final abort check** immediately precedes any post-wait invocation (STATE_MACHINES §3, §5.1). `AbortController` is checked at the first operation, not at import.

### AD-7 Invocation contract: synchronous when no wait; exact throw/thenable/identity semantics [E, revised — review C]
- **Decision:** `fn` is invoked synchronously inside `execute` whenever no readiness wait is needed (including combined calls with currently valid readiness); otherwise after the wait. Exactly once via a single-use stage transition set before the call. Synchronous throws (any value) become rejections with the thrown value itself, before `execute` returns. Native promises get one `then`; thenables and plain values are tolerated at runtime via standard promise resolution (public type stays `Promise<T>`). The returned promise is derived: value/reason identity guaranteed, microtask timing not. Settle order: outcome → cleanup → state commit → event → caller promise. Cleanup and subscriber errors are contained. Call-time config errors reject (never sync-throw) with `fn` uninvoked. Full table: STATE_MACHINES §3.1; tests TR-I1…I7.
- **Why:** Preserves user-gesture-sensitive APIs and ordering; guarantees identity; avoids stray unhandled rejections.
- **Alternatives:** Always defer to a microtask (changes semantics); `Promise.race` with an abort promise (fabricated outcomes); rejecting non-promise returns (breaks JS callers for no benefit).
- **Trade-offs:** Derived-promise timing is not identical to `fn`'s promise; thenable tolerance is behavior to maintain.
- **Consequences:** Immediate-failure cleanup uses the normal settle path; re-entrancy cases are specified.

### AD-8 Errors: two classes, brand-based `instanceof`, no stored errors [E]
- **Why:** The discriminator "WakeIt errors only before `fn` starts" must survive duplicated package copies.
- **Alternatives:** Plain `instanceof`; string-only codes; a wider hierarchy.
- **Trade-offs:** A few bytes for a `Symbol.hasInstance` brand check.
- **Consequences:** `WakeItReadinessError` carries `code`, `backend`, `attempts`, `elapsedMs`, optional `cause`; never responses, queries, or headers. Reason→code mapping in STATE_MACHINES §2.3.

### AD-9 Operation model: parallel regions; settled operations removed from state [E]
- **Why:** Matches the spec (`cancelRequested`, no `cancelled` state, API §4.1.8) without boolean-combination ambiguity.
- **Alternatives:** Retaining settled operations; a flat enum.
- **Trade-offs:** Outcomes reach the UI via the internal event (AD-1).
- **Consequences:** Memory proportional to live operations only.

### AD-10 SSR contract and environment access [E + O-3]
- **Contract:** (1) no globals or side effects at import; (2) `createWakeIt` builds objects only — no network, timers, listeners; (3) React rendering is pure — no probes, timers, listeners, DOM access or style injection; (4) `getServerSnapshot` returns a **constant empty snapshot**, never live client state, so shared server clients cannot leak in-flight operations into HTML and hydration matches; (5) explicit `ensureReady`/`execute` calls do real work in any runtime (including Node) and must not be called during render (undetectable, documented); (6) no user-specific data is stored in a client.
- **Alternatives:** `typeof window` gating in the core (breaks legitimate Node use; cannot detect "inside render").
- **Trade-offs:** E-14 as originally worded is unenforceable (amendment A-3).
- **Consequences:** Environment features (`fetch`, `AbortController`, timers, `online` events) are resolved lazily at call time; AC-S1/S2 verify the contract, including a server-render of a client that is busy.

### AD-11 Entry points: `wakeit`, `wakeit/react`, `wakeit/axios`; no `wakeit/fetch` [E]
- **Why:** `wrapFetch` is dependency-free and tree-shakes out; Axios is split only for type isolation and its optional peer.
- **Alternatives:** Separate `wakeit/fetch`; one all-in-one entry.
- **Trade-offs:** `wrapFetch` bytes count against the core budget when imported.
- **Consequences:** `"use client"` on the React entry only.

### AD-12 Default UI styling: injected scoped `<style>` + CSS variables, optional nonce [E]
- **Why:** Zero-setup, no CSS-framework/icon dependency, SSR-safe (injected only when visible, client-side).
- **Alternatives:** Shipped `.css` (extra step); inline styles (no media queries); CSS-in-JS (dependency).
- **Trade-offs:** Strict CSP needs `style-src` or the nonce prop; custom experiences bypass it.
- **Consequences:** `wakeit-*` classes and `--wakeit-*` variables become public, semver'd surface.

### AD-13 Toolchain: pnpm, strict TypeScript, tsup (verify upkeep) / tsdown alternative, Vitest, RTL, Playwright + axe, ESLint + Prettier, publint + attw, size-limit, GitHub Actions [E]
- **Why:** Each tool has a concrete job (ARCHITECTURE §10); `publint`/`attw` target dual-package risk.
- **Alternatives:** unbuild/Vite lib/plain `tsc`; Jest; msw instead of a real server.
- **Trade-offs:** tsup's upkeep status must be verified at scaffolding; switching is low-cost.
- **Consequences:** Nothing installed in Phase 1.

### AD-14 Test determinism: fake timers + two injected dependencies + pure transitions + real HTTP server [E]
- **Why:** Injection only where a seam materially helps (transport, platform signal).
- **Alternatives:** Injected scheduler/clock everywhere; fetch mocks only.
- **Trade-offs:** Dependence on fake-timer semantics (CI matrix covers Node versions).
- **Consequences:** An internal factory takes deps; public `createWakeIt` does not.

### AD-15 Client ownership and disposal [E]
- **Why:** Business code uses the client outside React; provider unmount must not break it.
- **Alternatives:** Provider-created clients.
- **Trade-offs:** Tests must call `dispose()`.
- **Consequences:** After `dispose()`: plain `execute(fn)` passes through (invokes `fn` once, untracked); readiness operations reject `aborted`; `cancel` no-ops (STATE_MACHINES §1).

### AD-16 Adapters are `execute` clients; Axios uses a settlement bridge [E]
- **Why:** Keeps `execute` the single primitive and the adapter tier minimal (`Pick<WakeIt,"execute">`).
- **Alternatives:** A tracking primitive (second code path); wrapping Axios's `adapter` (version coupling; replaces defaults).
- **Trade-offs:** Bridge promise must be silenced carefully; highest-risk P1.
- **Consequences:** Phase 4 go/no-go verifies AC-F2 on supported Axios versions; cut rather than weaken.

### AD-17 Pure transition functions plus a small effect interpreter [E]
- **Why:** Each transition-table row becomes a unit test; enables exhaustive interleaving tests.
- **Alternatives:** Inline imperative handlers; an FSM library.
- **Trade-offs:** Size/indirection against the ~4 KB core budget (provisional).
- **Consequences:** If Phase 2 measurement shows the budget unreachable, loosen readiness policy only and keep the operation machine pure; revisit the budget with the owner.

## 2. Technical risks

| ID | Risk | Severity | Mitigation |
|---|---|---|---|
| R-1 | Core size budget (~4 KB gz) tight with machines, freshness, `wrapFetch` | Medium | Measure early in Phase 2; AD-17 fallback; budgets stay provisional. |
| R-2 | Axios settlement bridge varies across Axios versions/interceptor order | High (P1) | Version matrix; cut criteria; observation-only scope. |
| R-3 | `navigator.onLine` inaccurate; cross-origin failures opaque (CORS vs unreachable); timeout ≠ down | Medium | Reason-keyed evidence (STATE_MACHINES §2.3); never pre-block on `onLine`; dev hint toward CORS/CSP. |
| R-4 | Dual-package hazard | Medium | Types-only cross-entry imports; brand `instanceof`; instance-borne channel; attw/publint. |
| R-5 | Internal channel mismatch/absent (foreign client copy) or misuse of the unsupported symbol | Low–Med | Version tag + graceful degradation; docs mark unsupported; promotion rule. |
| R-6 | Coalesced notifications + concurrent React produce ordering assumptions | Low–Med | Read-your-writes; flush order fixed; Strict Mode/concurrent tests. |
| R-7 | Focus trap / modal semantics are error-prone | Medium | axe + keyboard Playwright tests; small scoped implementation. |
| R-8 | Hanging `fn` keeps tracked state and signal listener indefinitely | Low | Documented; per-op timeout P2. |
| R-9 | Default probe policy values wrong for real platforms | Medium | Provisional values (§3), validated in Phase 0.5. |
| R-10 | Sibling providers for one client render multiple overlays | Low | Nested case handled; sibling case documented + dev warning. |
| R-11 | Strict CSP blocks injected styles | Low–Med | `nonce`; custom experience path. |
| R-12 | Observed-expiry timer vs "no idle timers" NFR; timer throttling | Low | "Idle" clarified (A-6); `unref`; read-time normalization makes throttling harmless. |
| R-13 | Thenable/plain-value tolerance and synchronous invocation become de-facto API | Low–Med | Contract documented and tested (TR-I\*); public types stay strict. |

## 3. Provisional values (engineering proposals for validation, not product claims)

| Setting | Proposed default | Status |
|---|---|---|
| Slow threshold | 1500 ms | Owner decision (provisional) |
| Per-group thresholds | none by default (fall through to client value) | O-2 |
| Probe attempt timeout | 10 s | Validate in Phase 0.5 |
| Probe interval | 2 s fixed (backoff opt-in) | Validate |
| Run deadline (`maxDurationMs`) | 60 s; attempts bounded by deadline/interval | Validate |
| `readyTtlMs` | 60 s | Validate |
| `minVisibleMs` | 400 ms | Validate (UX) |

## 4. Phase 0 amendments required (owner-approved items and clarifications; **not applied** — Phase 0 documents are unchanged)

| ID | Document / section | Conflict or gap | Recommended amendment |
|---|---|---|---|
| A-1 | API_DESIGN §2 (interface), §4 React table | No public way to read operations or request a cancel; `useWakeItOperations` and `ExperienceProps.actions.cancel` need it (O-1). | Add `getOperations(): readonly OperationSnapshot[]` and `cancel(operationId): void` (idempotent no-op for unknown/settled/non-cancellable; documented as a cancellation *request*). Do **not** add `failedWaits`. |
| A-2 | API_DESIGN §3 | FR-M4/AC-N2 require per-group thresholds; config has only a global value (O-2). | Add `groups: { [name]: { thresholdMs? } }`; precedence call > group > client > default. |
| A-3 | REQUIREMENTS §5.3 E-14 | "`ensureReady` during SSR render … guarded" is unenforceable in a runtime-agnostic core (O-3). | Reword to the SSR contract in AD-10 (no work at import/create/render/mount; server snapshot constant; explicit calls are real work and unsupported during render). Add AC for server-rendering a busy shared client. |
| A-4 | API_DESIGN §4.1 | Pre-aborted caller signal not specified for plain `execute` (O-4). | Add: plain ⇒ `fn` invoked once with an aborted signal; combined ⇒ `WakeItReadinessError("aborted")`, `fn` never invoked (even with valid readiness). Add AC-K rows and the race documentation (STATE_MACHINES §5.1). |
| A-5 | REQUIREMENTS FR-R4, §5.2, §5.4 | Timeout has no status; "Can't reach the backend yet" is permitted for `timeout`, overclaiming (O-5). | Timeout ⇒ status `unreachable`, reason `timeout` (code `timeout`). Split §5.2: `network-error` ⇒ "Can't reach the backend yet"; `timeout` ⇒ "The backend hasn't responded yet"; `offline` ⇒ connectivity wording. Document that `unreachable` means "no usable response", not proof of downtime. |
| A-6 | REQUIREMENTS FR-R6 and §3 Performance | "Time-limited ready" doesn't say what snapshots show after expiry; "no timers when idle" is undefined (review A). | FR-R6: snapshots never report `ready` past validity (reason `expired`). Performance: *idle* = no probing, no tracked operations, no subscribers; an expiry timer may exist while subscribed. |
| A-7 | API_DESIGN §8 (`WakeItConfigError` "thrown"), §4.1/§3.3 | Sync-throw vs rejection unspecified for call-time option errors; invocation timing unspecified (review C). | Config errors are thrown by `createWakeIt` and **rejected** by `execute`/`ensureReady`. Add the invocation contract (STATE_MACHINES §3.1): synchronous invocation when no wait is needed; sync throws become rejections with the same value; runtime tolerance for thenables/plain values with public type unchanged. |
| A-8 | PRODUCT_SPEC §10 (housekeeping) | Questions 1–5 (game slot, `wrapFetch` P1, layout/animation slots P2, per-operation timeout P2, `readiness-failed` display) are open, but the Phase 1 scope statement treats them as decided. | Record as approved/resolved (assumed from the Phase 1 scope list — please confirm). |

## 5. Owner decision log and remaining questions

| ID | Decision | Applied as |
|---|---|---|
| O-1 | Approved `getOperations()` and `cancel(operationId)`; tiered public/internal separation; **no** `failedWaits`; evaluate operation-level failure representation. | Added to public client (A-1). Readiness failure represented as an internal `operation-settled` event on the operation (AD-1/AD-2). |
| O-2 | Approved per-group thresholds. | `groups` config (A-2); `thresholds.ts`. |
| O-3 | Approved revised SSR contract. | AD-10, ARCHITECTURE §8, AC-S\* (A-3). |
| O-4 | Plain: invoke once with the aborted signal. Combined: reject with `WakeItReadinessError`, never invoke. Document races. | AD-6, STATE_MACHINES §3.1 rows 13–14, §5.1, TR-C\* (A-4). |
| O-5 | Approved `unreachable` + reason `timeout`; distinguish timeout from proof of unreachability. | STATE_MACHINES §2.3 evidence table (A-5). |
| O-6 | **Rejected** — no Cancel for non-cancellable operations in any stage. | Option removed; Phase 0 contract preserved (STATE_MACHINES §3, §6). |

**Remaining questions for the owner**
1. **Approve amendments A-1…A-8** to the Phase 0 documents (they are recommended edits; none is applied). A-6 is new from this review (freshness wording); A-7 is a clarification (rejection vs sync throw; invocation timing). A-8 asks you to confirm my assumption that Phase 0 §10 questions 1–5 are resolved.
2. **Informational (engineering decision, no action needed unless you object):** the internal symbol-keyed channel (AD-1). If you prefer *zero* undocumented coupling, the alternative is a public event emitter (larger API) or dropping the exact `readiness-failed` phase detail.

No open item blocks implementation planning.

## 6. Phase 3 review resolutions

| ID | Decision (owner) | Applied as |
|---|---|---|
| O-7 | `backend`/`backends` are **optional** (at most one). A client may have no readiness backend; plain `execute` stays usable. `ensureReady` and `execute({ readiness })` with no backend reject `WakeItConfigError` before `fn` is invoked. | API_DESIGN §3/§8, STATE_MACHINES §3 and §3.1 row 15, ARCHITECTURE §4.3, AC-B5. Phase 3: config, state and types accept no backend. The rejecting calls arrive with Phases 4–5. |
| O-8 | `poll.backoff` is **not invented** in Phase 3. | Rejected as an unknown option until defined. Open decision P4-1 below. |
| O-9 | Error model stays minimal. | Only `WakeItConfigError` exists. `WakeItReadinessError` ships in Phase 4. No lifecycle or invariant error classes (AD-8 unchanged: two classes, brand-based `instanceof`). |
| O-10 | Minimal environment abstraction accepted. | `core/env.ts` holds only the contained-error reporter. Timers, the fetch transport and the online source are **deferred to their first consumer** (readiness, Phase 4). An abstraction written before its consumer would be guessed, unused code, and AD-14 limits injection to those two seams once they exist. |
| O-11 | Internal state types stay unexported. | Only `createWakeIt`, `WakeItConfigError`, `WakeIt`, `WakeItConfig` and its config types are public. `subscribe()` is retained: it is in the approved API (API §2) and is exactly what `useSyncExternalStore` needs. Its TSDoc states that it fires for state readable through the getters added in Phases 4–5. |

### AD-1 clarification: the internal channel (not a violation; attachment deferred)

- **Finding.** AD-1 *as revised* permits exactly one non-public coupling: the versioned, symbol-keyed channel. The "no private channels at all" rule quoted in AD-1's *Why* is the **initial** rule that was rejected. The Phase 3 implementation therefore matched AD-1, but did so ahead of need.
- **Why it exists.** The experience controller needs the exact outcome of a settled operation to create `readiness-failed` notices (FR-X3, TR-X1). Alternatives were already rejected: a readiness `failedWaits` counter (owner direction O-1), snapshot-diff inference (ambiguous with concurrent operations), a public emitter (permanent API surface without a developer use case), a module-level registry (breaks under ESM/CJS or bundler duplication, R-4). An instance-borne symbol is the simplest mechanism that survives duplication.
- **Does React need it?** Only for the `readiness-failed` phase; everything else works from public snapshots (STATE_MACHINES §4 already specifies graceful degradation).
- **Decision.** Keep AD-1 unchanged and **do not attach the channel in Phase 3**. It has no producer (operations) and no consumer (React controller) until Phases 5–6, so attaching it early only added an unsupported property to the public client and froze its shape before its consumer was designed. The internal event queue inside the store stays: its flush order (events before subscribers) is a store contract that Phase 5 depends on and is fully tested. Phase 5 re-adds the attachment with the first emitter.
- **Maintenance risks (unchanged by deferral).** Version skew between package copies (handled by the version tag and degradation), wrapper objects that copy the client and drop a non-enumerable symbol (degrades the same way), and the promotion rule in AD-1.
- **Owner approval.** The question 2 above ("informational, unless you object") was never explicitly confirmed. **Open:** confirm the channel for Phase 5, or choose the alternative there (public emitter, or dropping exact `readiness-failed` detail).

### R-1 update: core size measured in Phase 3

Core entry now: **2.58 kB min+gzip** of the ~4 kB provisional budget, with no readiness or execution code yet. Approximate standalone contributions (min+gzip): config validation ~1.5 kB, store ~0.6 kB, errors 0.25 kB, cleanup scope 0.25 kB, state 0.2 kB, client/engine glue the rest. About 1.4 kB remains for the readiness controller, probe/policy/validity, the operation machine, executor, signals, thresholds, `WakeItReadinessError` and `wrapFetch`. That is **likely insufficient** (engineering estimate, not measured). No correctness or validation code was removed to chase the number. Re-baseline with the owner at the end of Phase 4 (AD-17 fallback: loosen readiness policy, keep the operation machine pure).

### Open decisions for Phase 4

| ID | Question |
|---|---|
| P4-1 | ~~Shape and semantics of `poll.backoff`~~ Resolved by AD-19. |
| P4-2 | Peer dependencies: the default overlay portal implies `react-dom`, but ARCHITECTURE §10 and D7 list only `react`; supported Axios range (provisionally `^1.0.0`). |
| P4-3 | ~~Which backend id `ensureReady()` uses~~ Resolved by AD-18 (explicit id required unless one is named `default`). |

## 7. Phase 4 readiness decisions (resolve P4-1, P4-3; P4-2 stays open)

Status values and codes keep their approved hyphenated spelling (`not-ready`). Provisional numbers are proposals pending Phase 0.5 validation.

### AD-18 Backend identity and selection [E, resolves P4-3]
- **Decision:** A single `backend` is stored under the id `"default"`; named `backends` use their keys. `ensureReady({ backend })` and `getReadiness(backend)` take that id. With no `backend` argument the id is `"default"` **only if a backend with that id exists**; otherwise the call fails with a `WakeItConfigError` that lists the configured ids. A single named backend that is not called `default` is **not** chosen implicitly. No backend configured, an unknown id and a non-string id are all `WakeItConfigError` (rejection for `ensureReady`, synchronous throw for the synchronous getter `getReadiness`).
- **Why:** Never choosing arbitrarily; a later second backend cannot silently change which backend an existing call targets.
- **Trade-off:** One extra argument when using only named backends.

### AD-19 Polling and `poll.backoff` [E, resolves P4-1]
- **Decision:** `poll: { intervalMs, maxAttempts?, maxDurationMs, backoff? }`. First attempt is immediate; **every retry is delayed**. Without `backoff` the delay is the fixed `intervalMs`. `backoff` is `true`, `false` or `{ multiplier?, maxDelayMs?, jitter? }`: delay before retry *n* (n = failed attempts so far, from 1) is `min(maxDelayMs, intervalMs × multiplier^(n−1))`, then multiplied by `1 − jitter × random()`. So `intervalMs` is the initial delay; jitter only **shortens** the delay, so `maxDelayMs` stays a true cap and the result lies in `[delay×(1−jitter), delay]`.
- **Defaults/validation (provisional):** `multiplier` default 2, finite > 1; `maxDelayMs` default `max(30000, intervalMs)`, finite > 0, ≥ `intervalMs`; `jitter` default 0.2, in `[0, 0.5]` (the upper bound prevents near-zero retry delays). All millisecond options are finite and ≤ 2 147 483 647, the largest value a timer accepts (a larger value would fire immediately). `maxAttempts` integer ≥ 1.
- **Bounds:** never unlimited: the run deadline `maxDurationMs` (default 60 s) always applies, and `maxAttempts` is optional on top. The attempt timeout `health.timeoutMs` (default 10 s) bounds one attempt; the deadline bounds the whole run, including an attempt in flight. If the deadline fires during an attempt, that attempt is abandoned and the run fails with the last evidence from this run, or `timeout` if there is none.
- **Attempt accounting:** an attempt counts when it finishes `ready` or failed for a reason other than `offline`. Offline waits consume no attempt.

### AD-20 Readiness semantics [E]
- **Decision:** Transport success is not readiness. The default validator is "HTTP 2xx" (`response.ok`, so 204 is ready). A custom `isReady(response)` fully decides, including for non-2xx. It must return exactly `true` (ready) or `false` (`rejected`); a throw, rejection or any other return value is `invalid-response`. The response body is cancelled best-effort after validation. Statuses/reasons/codes are exactly STATE_MACHINES §2.3: `unknown`, `checking`, `ready`, `not-ready` (`rejected` | `invalid-response`), `unreachable` (`network-error` | `timeout`), `offline`; no status was added.
- **Why strict returns:** a validator returning `undefined` (forgotten `return`) must not silently mean "not ready forever".

### AD-21 Freshness [E, implements AD-5]
- **Decision:** `validUntil = now + readyTtlMs` at the moment readiness is established. Expiration is evaluated at **read time** (`getReadiness`) and when a new `ensureReady` call decides between "resolve" and "start a run" (`now ≥ validUntil` means expired, one clock read). The expired snapshot is `unknown`/`expired` with `checkedAt` kept, identity-cached. While the store has ≥ 1 subscriber, one `unref`'d one-shot timer per ready backend commits the expired snapshot so subscribers re-render. No subscribers means no timer. Concurrent callers never see stale `ready`: they all go through the same check, and a post-expiry caller starts a (shared) new run.
- **Mechanism:** the store reports subscriber-count changes to the engine (internal option), which re-syncs the expiry timers. `readyTtlMs: 0` makes a result expire immediately; the waiters that triggered the run are still released.

### AD-22 Shared runs and cancellation [E]
- **Decision:** One controller per backend id (created lazily), at most one run and one attempt in flight. Callers are *waiters* sharing the run's budget. A caller's `signal` removes **only its waiter** (rejects `aborted`); the run continues while any waiter remains. When the last waiter leaves, the in-flight attempt is aborted, timers and listeners are released, and a status still at `checking` (no evidence from this run) is restored to its pre-run snapshot; failure evidence is kept. A pre-aborted signal rejects `aborted` before any work, even when readiness is fresh. After `dispose()`, `ensureReady` rejects `aborted`, `getReadiness` keeps working on the last snapshot, and nothing commits or notifies.
- **Not in Phase 4:** operation tracking of `ensureReady` (kind `readiness`, threshold, experience) and `onFailure: "proceed"` release belong to Phase 5.

### AD-23 Offline and injection [E, refines AD-14]
- **Decision:** Two injected seams (internal factory only): `fetch` and an *online source* `{ isOnline(), onOnline(listener) }`. Timers, `Date.now` and `Math.random` are global and resolved at call time (tests use fake timers). The default online source reads `navigator.onLine` and the global `online` event **lazily**; where they do not exist (Node, SSR) it reports online and registers nothing. A network failure while the source reports offline is `offline`: it consumes no attempt and the run pauses (no timer except the deadline) until the source reports online, then probes immediately. WakeIt never pre-blocks on `onLine === false`. Only the `online` event is listened to, and only while a run exists.

### AD-24 Errors [E, implements AD-8]
- **Decision:** `WakeItReadinessError` (brand-based `instanceof`) with `code` ∈ `not-ready` | `unreachable` | `offline` | `timeout` | `invalid-response` | `aborted`, plus `backend`, `attempts`, `elapsedMs`. Mapping: `rejected`→`not-ready`, `invalid-response`→`invalid-response`, `network-error`→`unreachable`, `timeout`→`timeout`, `offline`→`offline`; disposal and caller abort→`aborted`. Messages are fixed text plus the backend id; they never include URLs, headers or bodies. **No `cause` is attached** (validator and network error messages can embed response content or hostnames); the field stays optional in the contract. `timeout` means "no usable response within the limit", never "unreachable" or "sleeping". Missing backend, unknown id, invalid options and missing `fetch`/`AbortController` are `WakeItConfigError`.

### R-1 update after Phase 4 (core size re-baselined)

Core entry: **5.86 kB min+gzip** (2.52 kB after Phase 3, +3.3 kB for readiness). Approximate standalone contributions: config validation 2.4 kB (backoff and timer-range checks added 0.6 kB), readiness subsystem about 3.3 kB (run reducer 0.7, controller about 1.0, service and its fixed error messages about 0.8, probe/validity/policy about 0.7, env and the second error class the rest), store 0.6 kB. No code was removed to meet the old figure. The `size-limit` core limit is changed from 4 kB to **6.5 kB** as a *ratchet* just above the measured size: it still catches regressions but does **not** pre-approve Phase 5, whose execution engine, operation machine and `wrapFetch` will exceed it. **Open owner decision:** set the real v1 budget at the end of Phase 5 (the original "about 4 kB core" no longer fits; AD-17's fallback of loosening the pure-machine style is not attractive because it would trade away the tested transition tables).

## 8. Phase 5 decisions (execution engine)

Approved by the owner on 2026-11-14 in response to three conflicts between the Phase 5 brief and the approved documents (D-5.1 to D-5.3). The rest are engineering decisions.

| ID | Decision | Rationale and consequences |
|---|---|---|
| D-5.1 | **Lifecycle stays the approved model** (AD-9, API 4.1): `stage`, `slowness` and `cancelRequested`; settled operations are removed. **No** `succeeded`, `failed` or `cancelled` state and no retention. | The brief suggested retained terminal states including `cancelled`. WakeIt cannot know an abort caused a rejection, so a `cancelled` claim would be false; retention adds a memory policy with no consumer. Outcomes reach observers through `operation-settled`. |
| D-5.2 | **Internal channel: emit now, attach in Phase 6.** The executor queues `operation-settled` into the store's existing event queue. The symbol-keyed accessor is not attached until the React controller exists. Resolves the open question in "AD-1 clarification". | The event carries information public snapshots cannot (outcome, origin and code of an operation that was removed). Snapshot diffing is ambiguous with concurrent operations; a public emitter is permanent API without a developer use case. Attaching now would freeze a surface with no consumer. When attached it stays versioned, instance-borne and unexported (AD-1, R-5). |
| D-5.3 | **`fn` type widens** to `(ctx) => T \| PromiseLike<T>`; result `Promise<Awaited<T>>`. | Sync functions type-check; behavior matches AD-7. Amends API 2 and 4.2. |
| D-5.4 | **`OperationSnapshot` is public** (returned by `getOperations`) and gains `experience: boolean`. | Without it `experience: false` would be accepted and silently dropped. Additive; documented in API 4.5. Not covered by the three approved answers: please confirm. |
| D-5.5 | **Cancellation without `AbortSignal.any`**: one `AbortController` per operation; the caller's signal is linked by a listener removed once at settlement; `cancel(id)` and caller aborts share one idempotent `request()` that sets `cancelRequested` before aborting. Readiness waits use the operation's signal. | Every cause of a readiness-stage abort travels through the same waiter removal, and the final abort check closes the window between readiness resolving and invocation. |
| D-5.6 | **`proceed` is implemented narrowly**: readiness codes other than `aborted` only; never after an abort or disposal; never for configuration errors; no change to the wait. | Matches API 4.2 and REQUIREMENTS 5.4. No new fallback semantics. |
| D-5.7 | **`ensureReady` tracking stays deferred.** | It needs `group` / `thresholdMs` options that do not exist on `EnsureReadyOptions`, changes Phase 4 behavior and has no consumer before the experience layer. **Open:** decide in Phase 6 with the experience controller. |
| D-5.8 | **No separate pure operation reducer.** | The executor encodes the transitions as single-use guarded steps. Behavior and invariants are covered through the real engine and through a fake `ReadinessPort` for exact race windows. Revisit if Phase 6 needs the table. |
| D-5.9 | **Store `equals` option.** | Prevents a notification for a no-op frame (add and remove in one synchronous run) without changing the default `Object.is` contract. |
| D-5.10 | **Size ratchet raised from 6.5 kB to 7.5 kB.** Measured 7.28 kB. | Same ratchet policy as R-1 (just above measured, still catches regressions). No correctness code was removed. **Open owner decision:** the real v1 budget, and whether `wrapFetch` (P1) fits. |

### Error types and codes after Phase 5

No new classes (AD-8, O-9). Before `fn` starts, `execute` can reject only with `WakeItConfigError` (invalid usage, no/unknown/ambiguous backend, missing `fetch` or `AbortController`) or `WakeItReadinessError` with `code` in `not-ready`, `unreachable`, `offline`, `timeout`, `invalid-response` or `aborted` (caller abort, `cancel(id)`, disposal). After `fn` starts, every rejection is the application's own value.

### Remaining risks

- A function that never settles keeps its operation tracked until it does (a per-operation timeout is P2).
- A thenable's `then` is invoked once by standard promise resolution, one microtask later than for a native promise: identity of value and reason is guaranteed, timing is not (AD-7).
- Notifications are coalesced per microtask; a synchronous add and remove is invisible to subscribers by design.
