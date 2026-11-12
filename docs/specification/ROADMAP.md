# WakeIt — Roadmap (v1.0)

Status: Phase 0 — approval-ready draft. Scope and priorities are defined in [REQUIREMENTS §1](REQUIREMENTS.md). No dates are committed; phases are gated by exit criteria.

## Phases

| Phase | Goal | Scope | Depends on | Exit criteria |
|---|---|---|---|---|
| **0. Specification** | Agree on what v1 is. | These four documents. | — | Owner answers [PRODUCT_SPEC §10](PRODUCT_SPEC.md); documents consistent. |
| **0.5 Validation** (parallel, short) | Test hypotheses before the API freezes. | Survey existing solutions by category; 3–5 target-developer conversations; validate the 1.5 s threshold and default copy; browser/React compatibility matrix (incl. signal linking support in last-two-version browsers); re-check npm name and reserve it. | 0 | PRODUCT_SPEC §7 hypotheses marked verified/rejected; threshold and name confirmed or changed. |
| **1. Architecture & System Design** | Internal design that satisfies the spec. | Module boundaries, state model, lifecycle/cleanup, build/packaging, test strategy, size-budget method. Must fix the named-backend API shape (D9). | 0 | Design traced against every FR/NFR/AC; no contradictions. |
| **2. Core (headless)** | Reliable readiness + `execute`. | FR-R1–R7, FR-M1–M9, errors, config validation, groups, cancellation contract. No React. | 1 | AC-R\*, AC-M\*, AC-B\*, AC-K\*, AC-N\* pass; leak and concurrency tests pass. |
| **3. React & default experience** | Out-of-the-box UX and replaceability. | Provider, hooks, default overlay, readiness-failed state, theming/messages/actions, custom replacement, error boundary, accessibility, SSR/Next.js. | 2 | AC-X\*, AC-C\*, AC-E\*, AC-A\*, AC-S\* pass. |
| **4. P1 integrations** | Convenience layers, each cut if guarantees can't be met. | Axios, `wrapFetch`, named backends, banner, debug logging. | 3 | Per-item go/no-go recorded; AC-F\* pass for shipped items. |
| **5. Hardening & release** | Production confidence. | Docs completion (incl. game recipe), usability check, size budgets enforced, browser/React matrix run, packaging verification, release notes. | 4 | AC-D\*, AC-P\* pass; **v1.0.0** published. |

## Dependencies

- Phases 4 items depend only on stable Phase 2/3 contracts, so any P1 item can be dropped without affecting v1.0 GA.
- Size budgets need Phase 2 measurements before enforcement.
- The cancellation (API §4.1) and combined-execution (API §4.2) contracts are frozen at the end of Phase 1; changes afterward require re-approval.

## Naming

| Item | Status |
|---|---|
| `wakeit` on npm | **Provisional.** On 2026-11-12 the npm registry endpoint (`registry.npmjs.org/wakeit`) returned HTTP 404 (not found), as did `wake-it` and `wakeit-react`, i.e. no published package under those names at that moment. This does **not** reserve the name, does not rule out registry similarity/policy rejections, and may change before publish. Re-verify and claim in Phase 0.5; check again at publish (AC-P5). |

## Deferred (P2, not committed)

Game slot, bundled mini-game, layout/animation slots, per-operation timeout, persisted/cross-tab readiness, opt-in global fetch instrumentation, other framework bindings. Each needs demand evidence and a design that preserves the contracts above.

## Out of scope

Backend SDKs, hosted service/analytics, application-request replay/retry, HTTP client replacement, plugin system, game editor/marketplace.
