# @tjalve/qube

`@tjalve/qube` is the composer CLI for the QUBE package family. It gives users
one command for discovering the installed planning, execution, quality, and
continuation tools while keeping each component package independently usable.

## Install

Prefer project-local installs for automation:

```sh
pnpm add -D --save-exact --ignore-scripts @tjalve/qube@0.1.0
pnpm exec qube components
```

Global installs are acceptable for manual use when the exact version is pinned:

```sh
npm install -g @tjalve/qube@0.1.0 --ignore-scripts
qube components
```

## Components

| Component | Package | Direct command | Purpose |
| --- | --- | --- | --- |
| `aib` | `@tjalve/aib` | `aib` | Planning state, specs, milestones, and work item drafts. |
| `aie` | `@tjalve/aie` | `aie` | GitHub issue execution workflow. |
| `aiq` | `@tjalve/aiq` | `aiq` | Staged quality gates and evidence. |
| `aiu` | `@tjalve/aiu` | `aiu` | Continuation policy from trusted local state. |

## Usage

```sh
qube --help
qube components
qube run aib -- init . --idea "Ship a local notes CLI" --json
qube run aie -- queue --json
qube run aiq -- doctor --format json
qube run aiu -- status --json
```

The direct component commands remain the right entry point when you only need one
tool:

```sh
pnpm exec aiq doctor --format json
pnpm exec aie queue --json
```

## Dispatch Model

QUBE resolves component binaries in this order:

1. Component binaries installed in QUBE's own package scope.
2. Component binaries available in the local workspace.
3. Ambient `PATH` binaries as a diagnosed fallback.

PATH fallback is deliberately conservative. If QUBE can identify that a
same-package PATH binary is stale, it refuses to dispatch rather than silently
running the wrong version.

## Safety Notes

- The package has no install lifecycle scripts.
- It does not install or update component tools at runtime.
- It does not hide missing tools; missing or unverifiable component binaries are
  reported.
- Published releases are selected by package-specific `publish-qube-v<version>`
  tags from the QUBE repository.
