# ai-qube

QUBE is the package family for durable autonomous development work: planning,
execution, quality, and continuation controls that can be used independently or
composed together.

This repository is the monorepo home for:

- `@tjalve/qube-cli`: reusable CLI infrastructure
- `@tjalve/aib`: Bootstrap planning and work-item generation
- `@tjalve/aie`: Executor work-item execution
- `@tjalve/aiu`: Umpire continuation policy
- `@tjalve/aiq`: Quality gates and evidence
- `@tjalve/qube`: composer package for coordinating the standalone tools

## Monorepo Policy

Use pnpm workspaces as the baseline. Do not introduce Nx or Turbo until the
package graph and CI cost justify it.

Each product package must remain independently usable and publishable. The
`@tjalve/qube` package composes the tools, not replace direct use
of `aib`, `aie`, `aiu`, or `aiq`.

## Composer CLI

Use `qube components` to list the standalone tools and `qube run <component>`
to dispatch to the component version installed with QUBE. The composer does not
replace direct use of the product CLIs. Ambient `PATH` lookup is a diagnosed
fallback, not the default dispatch path.

```sh
pnpm --filter @tjalve/qube run build
pnpm --filter @tjalve/qube exec qube components
```

See:

- `docs/qube-command-surfaces.md` for QUBE-facing versus standalone command surfaces
- `docs/qube-host-surfaces.md` for GitHub/OpenCode ownership
- `docs/qube-paths-and-artifacts.md` for config, state, and repo artifact ownership
- `docs/release/install-migration.md` for fresh install and old global binary migration validation
- `docs/release/version-audit.json` for the npm version audit used by release checks

## Package Publishing

Publishing is driven by immutable package-specific tags:

- `publish-qube-cli-v<version>`
- `publish-aib-v<version>`
- `publish-aie-v<version>`
- `publish-aiu-v<version>`
- `publish-aiq-v<version>`
- `publish-qube-v<version>`

The publish workflow verifies the selected package before `npm publish
--provenance --access public`. AIQ uses its full build, test, and publish
readiness path; most non-AIQ product changes skip AIQ's cross-language setup,
while shared CI/workspace files still trigger AIQ checks.

## Target Layout

```text
packages/
  qube-cli/
  qube-core/
products/
  aib/
  aie/
  aiu/
  aiq/
  qube/
adapters/
  github/
  opencode/
plugins/
  ai-umpire-codex/
docs/
  notes/
```

`packages/qube-core` and the `adapters/*` packages are private workspace
packages. They define the first shared QUBE contract boundary without making the
public product CLIs depend on unpublished packages.

## Planning

Migration tracking starts at
[#1](https://github.com/ZarK/ai-qube/issues/1).
