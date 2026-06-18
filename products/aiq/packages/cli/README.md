# @tjalve/aiq

AIQ is a staged code quality runner for AI-assisted repositories. It gives humans and agents one stage ladder, one persisted current stage, and one command to run the checks that matter now.

## Quickstart

```bash
npx @tjalve/aiq
npx @tjalve/aiq setup
npx @tjalve/aiq doctor
npx @tjalve/aiq config --set-stage 3
npx @tjalve/aiq --format json
```

`aiq` is the configured project gate. It looks for a supported project in the current directory, initializes `.aiq/aiq.config.json` and `.aiq/progress.json` when it can safely infer inputs, and runs every stage from `0` through the persisted `current_stage`.

## Commands

```bash
npx @tjalve/aiq
npx @tjalve/aiq run src
npx @tjalve/aiq plan src
npx @tjalve/aiq run src --dry-run
npx @tjalve/aiq run src --format json
npx @tjalve/aiq evidence --format json
```

Use `aiq` for the full configured project gate. Use `run <paths...>` for explicit files and subtrees. Use `plan <paths...>` to see what would run for explicit targets. `--dry-run` prints the resolved run plan without executing tools or writing artifacts.
`evidence` reads the latest AIQ report and emits structured JSON that orchestration tools can store as gate evidence or parse as trusted quality state.

Default text output is compact: status, selected stage results, diagnostics summary, and the next action. Use `--verbose` for run metadata, artifact paths, stage notes, and command/tool details. Use `--format json` for the complete machine-readable report.

## Package Surface

`@tjalve/aiq` is the canonical package for standalone users and adapters. It ships the `aiq` and `quality` binaries from the top-level export, and `@tjalve/aiq/api` exposes the model, config, engine, reporter, and benchmark APIs used by the hook, MCP, LSP, GitHub Action, and OpenCode packages.

QUBE orchestration can discover the implemented AIQ command surface with `npx @tjalve/aiq schema --format json` or by importing `@tjalve/aiq/schema`. AIE and AIU integrations should consume `aiq evidence --format json` instead of agent narration.

## Stage Ladder

| # | Stage | Scope |
|---|---|---|
| 0 | e2e | full run |
| 1 | lint | diff-scoped |
| 2 | format | diff-scoped |
| 3 | typecheck | full run |
| 4 | unit | full run |
| 5 | sloc | diff-scoped |
| 6 | complexity | diff-scoped |
| 7 | maintainability | diff-scoped |
| 8 | coverage | full run |
| 9 | security | full run |

## Stage Selection

```bash
npx @tjalve/aiq config --set-stage 6
npx @tjalve/aiq
npx @tjalve/aiq run src
npx @tjalve/aiq run src --up-to 3
npx @tjalve/aiq run src --only 1
npx @tjalve/aiq run src --stage typecheck
```

- Default `aiq`, `run`, `plan`, and `doctor`: use cumulative stages `0..current_stage` when `.aiq/progress.json` exists.
- `--up-to N`: ignore persisted progress and run every stage from `0` through `N`.
- `--only N`: run one numeric stage.
- `--stage <name>`: advanced named-stage selection for scripts or focused diagnostics.
- `--diff-only`: scopes diff-safe stages to supplied changed files.

Full-run stages stay selected and use workspace context because they cannot be made safe from a changed-file list alone: `e2e`, `typecheck`, `unit`, `coverage`, and `security`.

## Doctor

```bash
npx @tjalve/aiq setup
npx @tjalve/aiq setup --up-to 3
npx @tjalve/aiq setup --only 1
npx @tjalve/aiq setup --format json
npx @tjalve/aiq doctor
npx @tjalve/aiq doctor --up-to 3
npx @tjalve/aiq doctor --only 1
npx @tjalve/aiq doctor --verbose
```

`setup` gives agents the setup actions for the selected stages and detected project technologies. It reports bundled, project-managed, and external host tools, lists missing required prerequisites, and returns structured recommended actions in JSON. AIQ does not install tools or mutate the host environment.

`doctor` checks config/progress state, detects project technologies, reports the stages that would run, and separates npm-bundled tools from external host tools. It exits non-zero when selected stages need missing required setup. Use `--verbose` to show exact binary paths and versions.

AIQ uses repository-native tool configs by default. Existing Biome config, `tsconfig.json`, Vitest/Jest config or package test scripts, Playwright config or e2e/audit scripts, Ruff/Radon-compatible Python config, and metrics config files remain authoritative for their tools unless AIQ stage/tool selection explicitly narrows what runs.

## Common Remediation

```bash
npx @tjalve/aiq setup
npx @tjalve/aiq doctor
npx @tjalve/aiq config --print-config
npx @tjalve/aiq config --set-stage <0-9>
```

If a tool is missing, run `setup` for the exact agent actions, then install the missing prerequisite through the normal toolchain for that language or project.

Metric stages enforce SLOC, complexity, maintainability, and readability defaults for source and test code. Treat metric remediation as behavior-preserving work, not architecture redesign. Allowed changes include splitting oversized files, extracting existing code blocks into named functions, improving local names, and reducing local complexity without changing observable behavior. Preserve public APIs, command behavior, tool selection, execution order, existing pathways, and repository conventions. Do not use metric failures as authorization for feature changes, command semantic changes, stage/language/tool boundary changes, replacing existing pathways with new architecture, or unrelated rename churn. Use direct purpose-revealing names: active verbs for functions, direct nouns for values, plural nouns for collections, short scoped file/module names, and no vague helper/manager/processor names unless local convention requires them.
