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
- `@tjalve/qube`: future composer package

## Monorepo Policy

Use pnpm workspaces as the baseline. Do not introduce Nx or Turbo until the
package graph and CI cost justify it.

Each product package must remain independently usable and publishable. The
future `@tjalve/qube` package should compose the tools, not replace direct use
of `aib`, `aie`, `aiu`, or `aiq`.

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

## Planning

Migration tracking starts at
[#1](https://github.com/ZarK/ai-qube/issues/1).
