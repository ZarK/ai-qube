# Quality

Quality is a staged code quality runner for AI-assisted repositories. The published package is `@tjalve/aiq`. It
gives humans and agents one stage ladder, one persisted current stage, and one
command surface for running the checks that matter now.

Quality uses repository-native tool configs by default. Existing Biome config, `tsconfig.json`, Vitest/Jest config, Playwright config or package test scripts, Ruff/Radon-compatible Python config, and metrics config files remain authoritative unless Quality stage or tool selection explicitly narrows what runs.

For the full QUBE package family and command deck, see
https://zark.github.io/ai-qube/ or the repository landing-page artifact at
https://github.com/ZarK/ai-qube/blob/HEAD/docs/index.html.

## Install

```sh
pnpm add -D --save-exact --ignore-scripts @tjalve/aiq@0.2.3
pnpm exec aiq --help
```

For a one-off pinned run:

```sh
npx @tjalve/aiq@0.2.3 doctor
```

## Quick Start

```sh
pnpm exec aiq setup
pnpm exec aiq doctor
pnpm exec aiq config --set-stage 3
pnpm exec aiq
pnpm exec aiq evidence --format json
```

`aiq` is the configured project gate. It looks for a supported project in the
current directory, initializes `.qube/aiq/config.json` and `.qube/aiq/progress.json`
when it can safely infer inputs, and runs every stage from `0` through the
persisted `current_stage`. At a multi-package workspace root, it selects all declared
workspace members, even when there are no changed paths.

## Commands

```sh
aiq
aiq run src
aiq check src
aiq plan src
aiq run src --dry-run
aiq run src --format json
aiq evidence --format json
aiq schema --format json
```

Use `aiq` for the full configured project gate. Use `run <paths...>` for
explicit files and subtrees. Use `plan <paths...>` to see what would run for
explicit targets. `--dry-run` prints the resolved run plan without executing
tools or writing artifacts.

`evidence` reads the latest Quality report and emits structured JSON that
orchestration tools can store as gate evidence or parse as trusted quality
state.

Default text output shows each selected stage with its start time and duration:

```text
[00m00s/00m02s] Stage 5 (sloc): PASSED
[00m02s/00m01s] Stage 6 (complexity): FAILED

Total execution time: 00m03s

To debug failed stages:
  aiq run src --only 6 --verbose  # Debug stage 6 (complexity)
```

Times use `MMmSSs`. Status colors appear only on a terminal when `NO_COLOR` is
unset. `--verbose` adds diagnostics and tool details after the summary.
Debug hints use PowerShell quoting on Windows and POSIX shell quoting elsewhere.
If a target cannot be quoted safely, Quality omits the command. After an implicit
`aiq` run, hints use `aiq --only N --verbose` to select the failed stage.
`--format json` emits the structured report. A stage without measurable files
reports `WARNING` with a reason. An explicit target that selects no files fails.
Directory targets expand recursively. `inputs.ignore` applies to directories,
explicit files, and file lists. A pattern such as `dist/**` also excludes nested
`dist` directories.

## Package Surface

`@tjalve/aiq` ships the `aiq` and `quality` binaries from the top-level export.
`@tjalve/aiq/api` exposes the model, config, engine, reporter, and benchmark
APIs used by the hook, MCP, LSP, GitHub Action, and OpenCode packages.

QUBE orchestration can discover the implemented Quality command surface with
`aiq schema --format json` or by importing `@tjalve/aiq/schema`. Executor and Umpire
integrations should consume `aiq evidence --format json` instead of agent
narration.

QUBE-facing Quality commands are `run`, `check`, `plan`, `doctor`, `setup`,
`status`, `config`, `evidence`, and `schema`. Standalone-only Quality commands are
`bench`, `watch`, `serve`, `hook install`, `hook run`, `ci setup`, and `ignore write`.

## Stage Ladder

| # | Stage | Scope |
| --- | --- | --- |
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

```sh
aiq config --set-stage 6
aiq
aiq run src
aiq run src --up-to 3
aiq run src --only 1
aiq run src --stage typecheck
```

- Default `aiq`, `run`, `plan`, and `doctor`: use cumulative stages
  `0..current_stage` when `.qube/aiq/progress.json` exists.
- `--up-to N`: ignore persisted progress and run every stage from `0` through
  `N`.
- `--only N`: run one numeric stage.
- `--stage <name>`: advanced named-stage selection for scripts or focused
  diagnostics.
- `--diff-only`: scopes diff-safe stages to supplied changed files.

Full-run stages stay selected and use workspace context because they cannot be
made safe from a changed-file list alone: `e2e`, `typecheck`, `unit`,
`coverage`, and `security`.

## Setup And Doctor

```sh
aiq setup
aiq setup --up-to 3
aiq setup --only 1
aiq setup --format json
aiq doctor
aiq doctor --up-to 3
aiq doctor --only 1
aiq doctor --verbose
```

`setup` gives agents the setup actions for the selected stages and detected
project technologies. It reports bundled, project-managed, and external host
tools, lists missing required prerequisites, and returns structured recommended
actions in JSON. Quality does not install tools or mutate the host environment.

`doctor` checks config/progress state, detects project technologies, reports the
stages that would run, and separates npm-bundled tools from external host tools.
It exits non-zero when selected stages need missing required setup. Use
`--verbose` for additional diagnostics. Required host tools always include their
resolved paths and versions. Ruff, ShellCheck, and shfmt must be executables on
`PATH`. The Python type checker, ty, also resolves on `PATH`. Lizard runs through
uvx with an exact version pin shared by all metric runners. `doctor` requires
uvx on `PATH` and reports its path, version, and the pinned Lizard version. Radon must
be installed for the Python interpreter that Quality resolves; `doctor` reports
that interpreter. Python prerequisite probes exclude the working
directory and Python environment variables from the module search path so local
modules cannot shadow installed host tools. User site packages remain available.

Doctor probes the commands needed by the selected stages. Rust lint, format, and
coverage require `cargo clippy`, `cargo fmt`, and `cargo llvm-cov`, respectively.
Cargo alone does not satisfy these requirements. .NET lint and format also require
`dotnet format`. Each subcommand must successfully report its version.

JavaScript and TypeScript test scripts require npm when the resolved runner invokes
`npm test` or `npm run`. Direct test runners do not require npm.
For direct Playwright E2E runs, doctor checks the local Playwright executable and
its version. A missing executable makes doctor fail. PowerShell probes
the runtime and the selected stage's modules: PSScriptAnalyzer or Pester.
HCL-only typecheck does not require Terraform; HCL lint and format do.

Maven and Gradle wrappers must be regular, non-empty files. Doctor reads their
version from valid wrapper distribution properties or a successful `--version`
command. Invalid wrappers require the system Maven or Gradle command instead.
If neither is available, doctor fails. Version probes can execute project wrappers.

## SLOC Limit

Set the repository limit in `.qube/aiq/config.json`:

```json
{
  "version": 1,
  "stages": {
    "sloc": { "limit": 800 }
  }
}
```

`stages.sloc.limit` is a positive integer. A file fails when its source line count
is greater than or equal to the limit. Quality counts non-blank, non-comment
lines in the entire file, including top-level code. The repository setting takes
precedence over environment thresholds. Without this setting, existing defaults
and environment variables apply.

## Commit Hook

```sh
aiq hook install
aiq hook run
```

`hook install` writes `pre-commit` in the effective Git hooks directory. It refuses
an external hooks directory or a different existing hook. The hook invokes Node
with the absolute path of the installing `aiq` entry point. Keep that installation
available, or reinstall the hook after moving it.

The hook checks staged files with the configured stages `0..current_stage` and
blocks the commit if a stage fails. It uses the same text renderer as `aiq run`.
The published `@tjalve/aiq` package contains the complete hook implementation.

## Common Remediation

```sh
aiq setup
aiq doctor
aiq config --print-config
aiq config --set-stage <0-9>
```

Metric stages enforce SLOC, complexity, maintainability, and readability defaults for source and test code. Treat metric remediation as behavior-preserving work, not architecture redesign.

Allowed changes include splitting oversized files, extracting existing code blocks into named functions, improving local names, and reducing local complexity without changing observable behavior. Preserve public APIs, command behavior, tool selection, execution order, existing pathways, and repository conventions. Do not use metric failures as authorization for feature changes, command semantic changes, stage/language/tool boundary changes, replacing existing pathways with new architecture, or unrelated rename churn. Use direct purpose-revealing names for new symbols and extracted blocks.

## Safety Notes

- The package has no install lifecycle scripts.
- `plan`, `doctor`, `setup`, `schema`, and `evidence` are inspection-first
  commands.
- `run`, `check`, `watch`, and benchmark commands may execute repository quality
  tools selected by configuration.
- Quality does not install missing host tools. It reports setup actions for the
  repository owner or agent to apply through the normal project toolchain.
