# WakeIt

> **Status: in development. Not published.**
> Implemented so far: the framework-free core (client, configuration, state store) and backend
> readiness detection (`ensureReady`, `getReadiness`). Operation monitoring, the React bindings and
> the waiting experience are not implemented yet, so there is no usable end-to-end product. The
> `wakeit` name is provisional and not reserved on npm.

WakeIt is planned as a backend-agnostic React SDK that detects when a backend is ready (via
configurable HTTP health probes), monitors slow application operations, and shows a customizable
waiting experience. It is intended to work with any HTTP-based backend.

- Product scope: [docs/specification/](docs/specification/)
- Architecture and decisions: [docs/architecture/](docs/architecture/)

## Planned entry points

| Import         | Purpose                     | State          |
| -------------- | --------------------------- | -------------- |
| `wakeit`       | Framework-free core         | readiness only |
| `wakeit/react` | Provider, hooks, default UI | empty entry    |
| `wakeit/axios` | Optional Axios adapter      | empty entry    |

## Development

Requirements: Node.js 24 LTS (see `.nvmrc`) and pnpm 10 (pinned in `package.json`).

```bash
pnpm install        # install from the lockfile
pnpm dev            # build in watch mode
pnpm build          # production build to dist/
pnpm test           # run tests
pnpm test:coverage  # tests with coverage
pnpm typecheck      # tsc --noEmit
pnpm lint           # ESLint, including architecture boundary rules
pnpm format         # Prettier (write)
pnpm format:check   # Prettier (check)
pnpm check:dist     # verify built exports (after build)
pnpm pack:check     # publint + are-the-types-wrong + npm pack contents (after build)
pnpm size           # bundle size (after build)
pnpm verify         # everything CI runs, in order
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Not yet chosen. A license file will be added once the owner confirms the license.
