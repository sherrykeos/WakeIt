# WakeIt — Product Specification (v1.0)

Status: Phase 0 — approval-ready draft · Source of truth for Phase 1 (Architecture). Companion docs: [API_DESIGN](API_DESIGN.md) · [REQUIREMENTS](REQUIREMENTS.md) · [ROADMAP](ROADMAP.md).

## 1. Definition

**WakeIt is a backend-agnostic React SDK that detects backend readiness, monitors application requests, and replaces boring waiting with a customizable experience.** It works over plain HTTP with any backend; no WakeIt-specific server code is required.

Promise: **easy to adopt, powerful to customize, reliable in production.**

Principles (binding on every later decision):

1. Three independent subsystems: **Readiness**, **Monitoring**, **Experience**. Each is usable without the others.
2. The built-in experience is a convenience; it is fully replaceable by the developer's own React components.
3. WakeIt observes the application's operations; it never alters their semantics.
4. WakeIt only states what it has evidence for.
5. Production reliability over feature count. Small package, no mandatory runtime dependencies beyond the React peer.
6. Interactive content (including games) is something developers may place in the experience; WakeIt bundles no game in v1 and is never a game engine.

## 2. Problems

| | Problem | WakeIt's role |
|---|---|---|
| A | **Backend cold starts.** Some platforms sleep idle services; the first request can take a long time. | Detect readiness with a developer-defined probe; communicate honestly while waiting. |
| B | **Boring waiting.** Spinners and blank screens when an important operation exceeds expectations. | Show a customizable experience once an operation exceeds a threshold (provisional default 1.5 s), and close it when the operation settles — without implying the operation is done. |

A and B are related but not identical: a slow request is **not** proof of a sleeping backend (it may be a slow query, a large upload, or a degraded service). This distinction drives the safety model.

## 3. Target users

| Segment | Why they care |
|---|---|
| React developers | Typed hooks/components, minimal setup. |
| Indie hackers / small teams on free or hobby tiers | Cold starts are routine on their hosting. |
| SaaS developers | Branded, controlled waiting UX; safe around auth and payments. |
| Full-stack developers (any backend language) | HTTP-only contract; no server SDK. |

Primary persona: a React developer shipping an app against a backend that is sometimes slow to respond and who wants control without writing infrastructure code.

## 4. Use cases

| # | Scenario | Benefit | Notes |
|---|---|---|---|
| U1 | **Login after idle** — user clicks Login; backend is cold. | High | Combined mode: wait for readiness, then run login once. If readiness fails, login is not run and the app handles the readiness error. No replay. |
| U2 | **Dashboard initialization** — several requests on mount. | High | One shared experience for a request *group*, not one per request. |
| U3 | **Slow API request** — a report endpoint occasionally takes seconds. | Medium | Monitoring only; neutral copy ("taking longer than usual"). |
| U4 | **Backend cold start, passive** — show a non-blocking hint when app loads. | High | Readiness only; developer declares the backend may cold-start. |
| U5 | **Multiple backend services** — auth service and API service wake independently. | Medium | Named backends; readiness tracked per backend. |
| U6 | **File upload** — long transfer. | Low–Medium | Upload progress UI is the app's job; WakeIt must not touch the body or stream. Use `execute` (optionally `experience:false`) around the app's own upload call. |
| U7 | **Long-running operation** (export, report). | Low | Better served by app-level job/progress UX. WakeIt may show a waiting experience but does not model progress. |
| U8 | **Branded waiting screen** — custom component and copy, including any interactive content the developer builds. | High | Core customization promise; full replacement is the mechanism. |

**Poor fit (documented, not solved):** sub-second spinners for ordinary UI loading, skeleton screens, background polling, server-driven job progress, offline-first sync.

## 5. Operating modes — evaluation and recommendation

| Mode | What it really is | Assessment |
|---|---|---|
| 1. Readiness (`ensureReady`) | Probe the backend until ready or failure. Starts WakeIt's *own* requests (probes). | Distinct, needed (U4). Safe: no application request is involved. |
| 2. Monitoring (`execute`) | Observe one app operation; show experience past a threshold. | Distinct, needed (U1–U3, U6). Observation only. |
| 3. Combined (`runWhenReady`) | `ensureReady` then `execute`. | **Not a third primitive.** Pure composition. A separate verb adds API surface, and the name implies WakeIt "runs when ready" in a retrying sense, inviting a replay expectation. Folded into `execute(fn, { readiness })`. |

Findings:

- **Overlap:** Mode 3 = Mode 1 + Mode 2. Presenting three peers suggests three concepts when there are two.
- **Confusion risk:** `runWhenReady` hides a behavioral difference: the app function starts *later* than the call. That is a legitimate, visible semantic change and must be opt-in and explicit.
- **Safety:** the only mode that delays an application operation is the combined one. It must never start the operation twice or after an abort, and rejects without running it when readiness fails (exact contract: [API_DESIGN §4.2](API_DESIGN.md); failure classes: [REQUIREMENTS §5.4](REQUIREMENTS.md)).
- **Lifecycle difference:** readiness is *shared and long-lived* (one probe loop serves many callers, state persists in memory); monitoring is *per-operation and short-lived*.

**Recommendation:** expose **two primitives** — `ensureReady()` and `execute()` — and express combined behavior as an option: `execute(fn, { readiness: true })`. `runWhenReady` is not a public API in v1. Details in [API_DESIGN](API_DESIGN.md).

## 6. Product boundaries — WakeIt v1 is NOT

| Not in v1 | Reason |
|---|---|
| A backend SDK or required server middleware | HTTP-only contract is the core promise. |
| A hosted monitoring service / analytics dashboard | Different product; adds privacy and ops burden. |
| Automatic request replay or retry of application requests | Unsafe for non-idempotent operations (login, payment). Retries stay with the developer. |
| A full HTTP client | WakeIt wraps/observes; it does not replace fetch or Axios. |
| Global monkey-patching of `fetch`/`XMLHttpRequest` | Invasive and hard to reason about; explicit wrappers only. |
| A game engine, game slot, bundled games, visual editor, or marketplace | Games are a developer's own content inside a custom experience; deferred as P2. |
| Vue, Angular, Svelte bindings | React only; core stays framework-agnostic so others are possible later. |
| A plugin system | Premature; the component/hook/option surface is the extension model. |
| Persisted "backend is warm" claims across reloads or tabs | Readiness is evidence with a short lifetime; stale claims are a correctness risk. |
| Request/response body inspection or logging | Privacy and stream-safety. |

## 7. Differentiation

**Verification status: no external market research was performed. Everything below is a hypothesis pending competitive validation.**

| Existing category (by type, not by named product) | What it typically covers (assumption) | Hypothesized gap WakeIt fills |
|---|---|---|
| React loading/spinner libraries | Visual indicators tied to a boolean the developer manages. | No notion of readiness, thresholds, or request lifecycle. |
| HTTP request monitoring/interceptor tools | Observing or retrying requests, often without UI. | No waiting-experience layer; some encourage retry, which WakeIt excludes. |
| Backend health-check utilities | Probing and status reporting, usually server-side or generic. | No React integration or UX coupling. |
| Loading/skeleton UI libraries | Placeholder layouts during data fetch. | Solve layout stability, not long waits or backend state. |

Hypothesis: the distinct value is the **combination** — a safe, evidence-based readiness + monitoring core with a replaceable experience layer — rather than any single capability. To validate: survey existing packages, check cold-start complaints in developer communities, and prototype-test with 3–5 target developers before the v1 API freezes.

## 8. Product decisions

### 8.1 Owner decisions (applied as given)

| Decision | Direction | Where applied |
|---|---|---|
| Readiness failure in combined execution | Reject by default; `fn` not invoked. | API §4.2, REQ FR-M6, AC-B1 |
| Proceed despite failure | Retained as explicit opt-in `readiness: { onFailure: "proceed" }` with narrow semantics. | API §4.2, REQ §5.4 |
| Bundled mini-game | P2. | REQ §1 |
| Axios | P1. | REQ §1, API §7 |
| `fn` ignores `AbortSignal` | Continues unaffected; no fabricated cancellation. | API §4.1 |
| Browser support | Last two evergreen versions, subject to validation. | REQ §3 |
| React support | 18 and 19. | REQ §3 |
| Slow threshold | 1.5 s, **provisional**. | API §3 |
| Package name | `wakeit`, **provisional** (see ROADMAP). | ROADMAP |

### 8.2 Design decisions

| ID | Decision | Reasoning |
|---|---|---|
| D1 | Headless, framework-agnostic client + React bindings. | Login/API code lives outside components. |
| D2 | Two primitives (`ensureReady`, `execute`); combined is an option. | §5. |
| D3 | `execute` is the universal, P0 integration; fetch wrapper and Axios are P1 conveniences; no global patching. | Zero compatibility promises at P0; wrappers add surface and edge cases. |
| D4 | WakeIt never replays/retries application operations; only its own probes retry. | Non-idempotent safety. |
| D5 | Evidence rule (REQ §5.2). | No false claims; never implies completion. |
| D6 | Readiness in memory only, time-limited. | Stale "ready" is worse than a redundant probe. |
| D7 | No runtime dependencies beyond `react` peer; Axios optional peer. | Small, predictable package. |
| D8 | Custom experience replacement is the only extension point for interactive content in v1; game slot deferred (recommendation, pending approval). | Replacement already covers it; avoids a second contract. |
| D9 | API shaped for named backends now (`readiness.backend`, `ensureReady({backend})`); behavior P1. | Avoids later breaking change. |
| D10 | Dismiss ≠ cancellation request ≠ actual cancellation; no `cancelled` state; Cancel UI only for `cancellable` operations. | Honesty about what WakeIt can know. |
| D11 | After `fn` starts, WakeIt throws no errors of its own. | Single, simple discriminator between error domains. |

## 9. Risks and trade-offs

| Risk | Mitigation / trade-off |
|---|---|
| Misconfigured health endpoint blocks combined calls. | Bounded probe policy, clear `WakeItReadinessError` codes, `proceed` opt-in. |
| `cancellable` is a developer attestation WakeIt cannot verify. | Default `false`; docs make the contract explicit. |
| Slow ≠ sleeping makes copy less vivid. | Developer-declared `mayColdStart` unlocks stronger wording. |
| Wrapper tracking ends at response headers, not body. | Documented limitation (API §6); `execute` can wrap whole flows. |
| Value hypothesis unvalidated. | Phase 0.5 before API freeze. |
| Deferring the game slot may disappoint users expecting games. | Docs recipe; revisit as P2 with demand evidence. |

## 10. Open questions for approval

1. **Game slot:** approve deferral to P2 (recommended), or keep a minimal slot in v1?
2. **Fetch wrapper:** approve demotion from P0 to P1 in favor of `execute` + documented native-fetch pattern?
3. **Layout/animation slots → P2** (redundant with CSS variables and full replacement): approve?
4. **Per-operation timeout → P2:** approve?
5. **Readiness failure display:** approve the `readiness-failed` phase with "Check again" (re-probe only) and `experience:false` to suppress?
