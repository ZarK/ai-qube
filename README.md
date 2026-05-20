# ai-qube-cli

Reusable TypeScript CLI infrastructure for command-line packages.

This package is a library foundation for CLI metadata, runtime wiring, help, schema, structured output, safety helpers, and tests. It is not a product-specific CLI, and it does not own the behavior or side effects of consuming commands.

## Installation

Use exact versions and keep lifecycle scripts disabled during dependency installation where supported:

```sh
pnpm add ai-qube-cli@0.1.0 --save-exact --ignore-scripts
```

## Development baseline

- Node.js 24 or newer
- pnpm 11 or newer
- ESM-first TypeScript source
- Compiled JavaScript and declaration files in `dist/`

## Package boundary

Consuming packages own their command behavior, validation rules, product logic, state management, service integrations, policy decisions, and side effects. This package provides reusable infrastructure only; it does not mutate user projects, configure shells, install hooks, contact external services, or run background processes during normal installation.

## Verification

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
pnpm run typecheck
pnpm test
pnpm run package-dry-run
```
