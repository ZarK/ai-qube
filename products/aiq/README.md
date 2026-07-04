# AIQ

AIQ is the quality package inside QUBE. The published package is
`@tjalve/aiq`, and its npm-facing README lives at
`products/aiq/packages/cli/README.md`.

## Public Package

`@tjalve/aiq` provides:

- the `aiq` and `quality` binaries
- staged quality gates from `0` through `9`
- setup and doctor commands for repository readiness
- structured evidence for orchestration tools
- a public API surface for adapters through `@tjalve/aiq/api`

Use the package README for install and command documentation:

- https://github.com/ZarK/ai-qube/tree/main/products/aiq/packages/cli#readme

## Workspace Packages

| Workspace | Status | Purpose |
| --- | --- | --- |
| `@tjalve/aiq` | Published | CLI and API package. |
| `@tjalve/aiq-internal-engine` | Private | Stage planning and runner execution. |
| `@tjalve/aiq-internal-config-schema` | Private | Config, progress, and surface resolution. |
| `@tjalve/aiq-internal-model` | Private | Shared contracts and IDs. |
| `@tjalve/aiq-internal-reporters` | Private | Text and JSON output formatting. |
| `@tjalve/aiq-internal-benchmark` | Private | Benchmark scenarios. |
| `@tjalve/aiq-internal-hook` | Private | Hook adapter. |
| `@tjalve/aiq-internal-github-action` | Private | GitHub Action adapter. |
| `@tjalve/aiq-internal-lsp` | Private | LSP adapter. |
| `@tjalve/aiq-internal-opencode-plugin` | Private | OpenCode adapter. |

## Development

```sh
corepack enable
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @tjalve/aiq-workspace run build
pnpm --filter @tjalve/aiq-workspace test
pnpm --filter @tjalve/aiq-workspace run test:publish-readiness
```

Build before packing so the published CLI package contains fresh internal module
output. `test:publish-readiness` packs and installs `@tjalve/aiq` before checking
the npm-facing CLI and public API contract.

## Publishing

Push a package-specific publish tag from a commit reachable from `main`:

```text
publish-aiq-v<version>
```

The repository publish workflow verifies the selected package and publishes it
through npm trusted publishing with the `npm-publish` GitHub environment.
