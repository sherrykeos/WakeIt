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
