# AIQ

AIQ is the TypeScript monorepo for the `@tjalve/aiq` code quality runner.

## Repository Workflow

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
pnpm run lint
pnpm test
pnpm run bench:ci
pnpm run test:publish-readiness
pnpm run test:smoke
```

Use `pnpm run build` before packaging so the published CLI package contains fresh internal module output. Use `pnpm test` for the full Vitest suite, `pnpm run bench:ci` for the CI benchmark subset, and `pnpm run test:publish-readiness` for the packed npm UX gate.

## Workspace Packages

| Workspace | Purpose |
|---|---|
| `@tjalve/aiq` | Published CLI and API package |
| `aiq-internal-engine` | Stage planning and runner execution |
| `aiq-internal-config-schema` | Config, progress, and surface resolution |
| `aiq-internal-model` | Shared contracts and IDs |
| `aiq-internal-reporters` | Text and JSON output formatting |
| `aiq-internal-benchmark` | Benchmark scenarios |
| `aiq-internal-hook` | Hook adapter |
| `aiq-internal-github-action` | GitHub Action adapter |
| `aiq-internal-lsp` | LSP adapter |
| `aiq-internal-mcp` | MCP adapter |
| `aiq-internal-opencode-plugin` | OpenCode adapter |

## Package Checks

```bash
npm pack --workspace @tjalve/aiq --dry-run
node scripts/run-smoke-tests.mjs
```

`packages/cli/README.md` is the published npm README for `@tjalve/aiq`. Keep user-facing CLI onboarding there and keep this root README focused on contributor workflow. `pnpm run test:publish-readiness` packs and installs `@tjalve/aiq` before checking the npm-facing CLI and public API contract.

## Publishing

Push a `publish-*` tag from a commit reachable from `main` to start the npm staging workflow. The publish job uses npm Trusted Publishing with the `npm-publish` environment and stages packages for npm approval; it does not use an npm token.
