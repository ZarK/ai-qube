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

| Workspace | Purpose |
| --- | --- |
| `@tjalve/aiq` | Published CLI and API package. |
| `aiq-internal-engine` | Stage planning and runner execution. |
| `aiq-internal-config-schema` | Config, progress, and surface resolution. |
| `aiq-internal-model` | Shared contracts and IDs. |
| `aiq-internal-reporters` | Text and JSON output formatting. |
| `aiq-internal-benchmark` | Benchmark scenarios. |
| `aiq-internal-hook` | Hook adapter. |
| `aiq-internal-github-action` | GitHub Action adapter. |
| `aiq-internal-lsp` | LSP adapter. |
| `aiq-internal-mcp` | MCP adapter. |
| `aiq-internal-opencode-plugin` | OpenCode adapter. |

## Development

```sh
corepack enable
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter ai-code-quality run build
pnpm --filter ai-code-quality test
pnpm --filter ai-code-quality run test:publish-readiness
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
