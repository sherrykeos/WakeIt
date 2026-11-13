# Contributing

WakeIt is in early development; the specification and architecture in `docs/` are the source of
truth. Do not change approved behavior in code without updating (and getting approval for) the
documents first.

## Setup

1. Install Node.js 24 LTS (`.nvmrc`) and pnpm 10 (`npm i -g pnpm@10.34.9`, or any way that provides
   the version in `packageManager`).
2. `pnpm install`

## Workflow

Run `pnpm verify` before pushing; it runs the same steps as CI (typecheck, lint, format check,
tests, build, dist check, package validation, size). Use `pnpm format` to fix formatting.

## Project layout

```text
src/index.ts       core entry (`wakeit`)
src/react/         `wakeit/react`
src/axios/         `wakeit/axios`
tests/infra/       tests of the repository tooling itself
```

Further layers (`core/`, `readiness/`, `execution/`, `experience/`, `fetch/`, `shared/`) are added
by the phases that implement them, as specified in `docs/architecture/ARCHITECTURE.md` section 2.

## Architecture boundaries

These are enforced by ESLint (`eslint.config.js`) and verified by `tests/infra/boundaries.test.ts`:

- The core must not import React or Axios, and must not depend on the experience UI.
- `readiness` and `execution` never import each other.
- `react`, `experience` and `axios` may import the core as **types only**.
- Library code must not touch `window`, `document`, `navigator` or storage, except in
  `src/core/env.ts` and `src/react/`.
- No import cycles.

## Dependencies

The package has zero runtime `dependencies`. `react` is a peer; `axios` is an optional peer. Adding a
runtime dependency needs an architecture decision first.

## Git hooks

None are configured: CI runs every check, and hooks would add install-time machinery without a
current need. Revisit when the contributor count grows.
