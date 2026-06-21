# @tjalve/qube

`@tjalve/qube` is the composer CLI for the QUBE package family. It gives users
one command for discovering the installed planning, execution, quality, and
continuation tools while keeping each component package independently usable.

## Install

Prefer project-local installs for automation:

```sh
qube install
qube install --yes --dry-run --json
qube install --scope local --package-manager pnpm --host codex --work-provider github --yes
```

`qube install` is a guided installer planner. It asks about project-local versus
global use, package manager, host surface, work provider, lifecycle-script
posture, docs/config notes, and migration from standalone package globals. In
agent and CI contexts, pass explicit flags or `--yes` for safe defaults. The
command prints a plan and copyable commands; it does not run package managers or
install hidden dependencies.

```sh
pnpm add -D --save-exact --ignore-scripts @tjalve/qube@0.1.1
pnpm exec qube components
```

Global installs are acceptable for manual use when the exact version is pinned:

```sh
npm install -g @tjalve/qube@0.1.1 --ignore-scripts
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
qube install --yes --dry-run --json

# Plan from an idea.
qube idea "Ship a local notes CLI"
qube plan status --json
qube spec draft --json
qube spec validate --json
qube spec accept --section all --json
qube milestones --json
qube work-items --json
qube work-items render --provider github --dry-run --json

# Execute issue work.
qube queue --json
qube start next --json
qube view 84 --json
qube branch create 84 --dry-run --json
qube review gate 84 --prompt
qube pr body 84
qube pr gate 87 --json
qube complete 84 --check-only --json

# Audit local apps and quality state.
qube app start --name ui-audit -- pnpm dev
qube app wait --name ui-audit --url http://127.0.0.1:5173 --timeout 30
qube app status --name ui-audit --json
qube app stop --name ui-audit --json
qube doctor --json
qube check src --json
qube quality status --json
qube evidence --json
qube status --json
```

The direct command surface covers the regular path from idea, planning, issue
work, review gates, local audit helpers, quality evidence, and continuation
status. Use product routing when a command is intentionally product-specific or
ambiguous, such as config and migration:

```sh
qube aiq config --print-config --format json
qube aiu config --json
qube aie migrate legacy --dry-run --json
```

Use `qube run` as the low-level escape hatch when debugging a component command
or forwarding an unusual command shape:

```sh
qube run aib -- status --json
qube run aiq -- doctor --format json
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
