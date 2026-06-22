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
qube install --scope local --package-manager pnpm --host claude-code --work-provider github --yes
qube install --scope local --package-manager pnpm --host codex --work-provider linear --yes
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
qube autoresearch init ./scratch "improve notes summary quality" --json
qube oneshot "Ship a local notes CLI" --kind code --json
qube make-it-so "Ship a local notes CLI" --dry-run --json

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
qube aib status --json
qube aiq doctor --format json
```

The direct component packages remain independently installable when you
intentionally only need one package:

```sh
pnpm exec aiq doctor --format json
pnpm exec aie queue --json
```

QUBE remains the preferred entry point for automation, agent instructions, hooks,
and durable examples in this monorepo. Direct package commands share QUBE-owned
repository paths such as `.qube/aie/config.json`, `.qube/aiq/config.json`, and
`.qube/aiq/out/`.

Codex host setup and limitations are documented in the repository guide:
[Codex host support](https://github.com/ZarK/ai-qube/blob/HEAD/docs/qube-codex-host-support.md).

Claude Code host setup and limitations are documented in the repository guide:
[Claude Code host support](https://github.com/ZarK/ai-qube/blob/HEAD/docs/qube-claude-code-host-support.md).

Linear provider setup and limitations are documented in the repository guide:
[Linear provider support](https://github.com/ZarK/ai-qube/blob/HEAD/docs/qube-linear-provider-support.md).

## Make-It-So Contract

`qube make-it-so` is the cardinal work command for turning intent into the
safest real QUBE workflow. It exposes the mapped command and the workflow
boundary instead of hiding provider checks, review gates, or setup gaps.

- `planned` maps free-form intent to `qube aib init <target> --idea <intent>`.
  This creates planning state only; it does not create a GitHub issue, branch,
  pull request, or review request.
- `issue` maps `--flow issue next`, `--flow issue <number>`, or
  `--flow issue #<number>` to `qube aie start`. Executor pre-start checks,
  branch policy, review gates, PR checks, completion, and queue continuation
  stay in force.
- `direct-local` is refused until QUBE has a real oneshot workflow. The command
  reports the missing capability and points users back to planned or issue
  flows instead of running mock local work.

Use `--dry-run --json` to inspect the exact mapped command, flow, boundaries,
and next action without dispatching any component command. Non-interactive JSON
errors use exit code 2 for unsupported or unsafe states.

## Autoresearch Contract

`qube autoresearch` creates a bounded local arena for sustained target/goal
optimization. The first implementation supports local directory targets only
and keeps all working state under `.qube/autoresearch/` until explicit
promotion.

```sh
qube autoresearch init <target-directory> <goal>
qube autoresearch baseline
qube autoresearch run
qube autoresearch status --json
qube autoresearch dashboard
qube autoresearch promote
```

The compact form `qube autoresearch <target-directory> <goal>` is a safe alias
for `init`: it creates the arena and fixed evaluator, but it does not start a
candidate loop or mutate the target.

- `init` writes `arena.json`, `evaluator.json`, `state.json`, `attempts.jsonl`,
  and dashboard files under `.qube/autoresearch/runs/<run-id>/`.
- `baseline` records immutable evidence from the fixed evaluator. Later changes
  to `evaluator.json` stop the run instead of redefining the score.
- `run` creates a sandboxed candidate artifact under the run directory, records
  AIE execution ownership, AIQ evaluation evidence, and AIU continuation state.
- `status` and `dashboard` read structured run state rather than agent prose.
- `promote` is the only command that copies the selected best candidate to the
  target workspace or `--output` path, and it refuses to replace existing output
  unless `--force` is explicit.

## Oneshot Contract

`qube oneshot` is a direct local delivery mode. It creates a concrete scratch
artifact from an idea without entering the normal GitHub issue, branch, pull
request, review-request, merge, or approval workflow.

```sh
qube oneshot "Ship a local notes CLI" --kind code --json
qube oneshot "Create a README draft" --kind doc --dry-run --json
qube oneshot status <run-id> --json
qube oneshot checks <run-id> --json
qube oneshot summary <run-id>
```

The first implementation supports doc and code artifacts. It writes local run
state under `.qube/oneshot/<run-id>/`, including `input.json`, `manifest.json`,
`plan.json`, `assumptions.md`, `mission.md`, `state.json`, `loop.jsonl`,
`actions.jsonl`, `checks.json`, `aiq-evidence.json`, `review.md`, `risk.md`,
`summary.md`, `final.json`, and scratch `workspace/`, `outputs/`, `snapshots/`,
and `logs/` directories.

- `--dry-run --json` reports the inferred assumptions, mutation policy, planned
  checks, and run paths without writing files.
- Default runs mutate only the `.qube/oneshot/<run-id>/` scratch workspace.
- New `--target` paths can receive copied local results; existing targets are
  refused in the first implementation instead of being mutated implicitly.
- `--output` copies the selected artifact to an explicit file and refuses
  overwrites unless `--force-output` is set.
- Summaries state that local checks and local self-review are not PR approval.

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
