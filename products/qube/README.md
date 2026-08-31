# @tjalve/qube

`@tjalve/qube` is the composer CLI for the QUBE package family. It gives users
one command for discovering the installed planning, execution, quality, and
continuation tools while keeping each component package independently usable.

QUBE's public landing page is designed for GitHub Pages at
https://zark.github.io/ai-qube/ and lives in the repository at
https://github.com/ZarK/ai-qube/blob/HEAD/docs/index.html.

## Install

Use npm or pnpm to install an exact version. Prefer project installation for
reproducible automation:

```sh
npm install --save-dev --save-exact --ignore-scripts @tjalve/qube@0.2.12
pnpm add --save-dev --save-exact --ignore-scripts @tjalve/qube@0.2.12
```

Use a global installation for manual shell use:

```sh
npm install --global --ignore-scripts @tjalve/qube@0.2.12
pnpm add --global --ignore-scripts @tjalve/qube@0.2.12
```

Package placement and QUBE configuration scope are independent. After the
`qube` command is available, use one setup entry point:

```sh
qube init --global
qube init
qube init <target>
qube init <target> --git-init
```

`qube init --global` never invokes Git. Repository setup reports staged Git
readiness and can complete safe local setup before an initial commit or remote
exists. See [Git prerequisites](../../docs/qube-init.md#git-prerequisites).
When a repository selects GitHub, init and doctor share the role-aware
[GitHub provider readiness contract](../../docs/qube-github-provider-support.md).

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
qube init --global
qube init
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
qube continue --json
```

The direct command surface covers the regular path from idea, planning, issue
work, review gates, local audit helpers, quality evidence, and continuation
status. Use product routing when a command is intentionally product-specific or
ambiguous, such as config:

```sh
qube aiq config --print-config --format json
qube aiu config --json
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
`.qube/aiq/out/`. Configuration commands resolve explicit, machine-local,
repository, user-global, detected, default, and derived sources consistently.
Repository config stores only meaningful differences from explicit user-global
settings. Use `qube init --inherit <field>` or `qube init --inherit-all` to
remove repository overrides without editing JSON.

Codex host setup and limitations are documented in the repository guide:
[Codex host support](https://github.com/ZarK/ai-qube/blob/HEAD/docs/qube-codex-host-support.md).

Claude Code host setup and limitations are documented in the repository guide:
[Claude Code host support](https://github.com/ZarK/ai-qube/blob/HEAD/docs/qube-claude-code-host-support.md).

Linear provider setup and limitations are documented in the repository guide:
[Linear provider support](https://github.com/ZarK/ai-qube/blob/HEAD/docs/qube-linear-provider-support.md).

GitLab provider setup and limitations are documented in the repository guide:
[GitLab provider support](https://github.com/ZarK/ai-qube/blob/HEAD/docs/qube-gitlab-provider-support.md).

Jira provider setup and live-suite bootstrap are documented in the repository guide:
[Jira provider support](https://github.com/ZarK/ai-qube/blob/HEAD/docs/qube-jira-provider-support.md).

Jenkins provider setup and live-suite bootstrap are documented in the repository guide:
[Jenkins provider support](https://github.com/ZarK/ai-qube/blob/HEAD/docs/qube-jenkins-provider-support.md).

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

QUBE does not load component binaries from the ambient `PATH`. Install each
component with QUBE or in the current workspace so QUBE can verify the package
and version before dispatch.

## Safety Notes

- The package has no install lifecycle scripts.
- It does not install or update component tools at runtime.
- It does not hide missing tools; missing or unverifiable component binaries are
  reported.
- Published releases are selected by package-specific `publish-qube-v<version>`
  tags from the QUBE repository.
