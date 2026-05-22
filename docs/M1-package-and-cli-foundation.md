# M1 - Package And CLI Foundation

## Strategic Goal

M1 creates the safe, serious foundation for AI Executor as the `@tjalve/aie` npm package and `aie` CLI.

This milestone does not implement the full GitHub issue workflow yet. It establishes the package shape, runtime policy, CLI conventions, repository config model, diagnostics framework, and supply-chain-safe install posture that every later milestone depends on.

After M1, a developer or agent should be able to install or run the package deliberately, invoke `aie --help`, inspect command help, validate the local environment with `aie doctor`, read and validate Executor config, and trust that installing the package does not mutate the repository or run hidden setup code.

M1 delivers five things:

1. **Package foundation** - TypeScript package scaffold for `@tjalve/aie`, compiled output, npm executable, tests, lint/typecheck, and release-safe package metadata.
2. **CLI UX foundation** - consistent command structure, help text, human output, JSON output, exit codes, dry-run conventions, non-interactive behavior, and no-color handling.
3. **Config foundation** - versioned repository config discovery, parsing, validation, defaults, and stable schema for later workflow commands.
4. **Diagnostics foundation** - `aie doctor` infrastructure for local runtime, git, GitHub CLI, and config checks.
5. **Supply-chain-safe posture** - no install lifecycle scripts, minimal justified dependencies, pinned-version documentation, and safe execution expectations.

The important success condition is not feature breadth. The important success condition is that later milestones can add GitHub queue, lifecycle, init, PR gate, and migration behavior without reworking the package, CLI, config, or safety model.

---

## Functional Requirements Addressed

M1 is the primary implementation foundation for:

- **FR-02 - Package, Runtime, And CLI Surface**
- **FR-13 - Observability And Diagnostics**
- **FR-15 - CLI UX Standards**

M1 provides foundational support for:

- **FR-04-001 through FR-04-009 and FR-04-016 through FR-04-018** - config storage, validation, git/PR pre-start policy defaults, `doctor`, and dry-run conventions. Label setup and repository priming are implemented in M2.
- **FR-12-004 through FR-12-006** - log redaction and external-service reporting foundations. Agent instruction prompt hygiene is implemented in M4.
- **FR-02-016 through FR-02-017 and FR-12-012 through FR-12-013** - source/build separation, real checks, product-only implementation wording, and no fake runtime surfaces.
- **FR-02-012 through FR-02-015** - supply-chain-safe package behavior, safe install documentation, no preferred floating `latest` installs, and minimal justified runtime dependencies.

M1 intentionally does not complete:

- `aie init` and installed agent instructions. Those are M4.
- `aie labels setup`, `aie repo prime`, `aie queue`, and `aie next`. Those are M2.
- `aie start`, `aie switch`, `aie view`, `aie complete`, and dependency commands. Those are M3.
- PR review gates, Oracle prompts, manual UI audit guidance, and optional `aiq` quality gate guidance. Those are M5.
- Legacy migration and cleanup. Those are M6.

---

## Specification Inputs

Use [docs/spec.md](spec.md) as the public source of truth for exact functional requirement text and boundaries. M1 implementation language must describe Executor package behavior, CLI semantics, and requirement IDs only.

---

## CLI UX Research Direction

M1 must create a CLI that is genuinely explorable by humans and deterministic for agents. A feature-complete CLI that requires users to memorize exact long commands is not good enough.

Research sources for this direction:

| Source | Relevant Guidance For Executor |
|--------|--------------------------------|
| [Command Line Interface Guidelines](https://clig.dev/) | Human-first design, ease of discovery, concise help on incomplete commands, examples-first help, typo suggestions, stdout/stderr separation, TTY-aware interactivity, standard flags, no arbitrary command abbreviations |
| [The CLI Spec](https://clispec.dev/) | Agent-facing structured output, schema introspection, stderr/stdout separation, non-interactive behavior, idempotent commands, bounded output |
| [Heroku CLI Style Guide](https://devcenter.heroku.com/articles/cli-style-guide) | Humans before machines, consistent topics/commands, flags when clarity matters, prompts only when bypassable, human output plus JSON/terse output |
| [PatternFly CLI Handbook](https://www.patternfly.org/developer-resources/cli-handbook/) | Accessibility, specific error wording, text labels instead of color-only meaning, keyboard/non-interactive-safe flows |
| [@tjalve/qube-cli](https://www.npmjs.com/package/@tjalve/qube-cli) | Shared command metadata, runtime wiring, help, schema, output, redaction, prompt, and CLI contract helpers |
| [Commander docs](https://www.npmjs.com/package/commander) | Minimal parser, generated help, usage errors, typo suggestions, low dependency surface |
| [Yargs docs](https://yargs.js.org/) | Generated help and command/options structure |
| [Clipanion docs](https://mael.dev/clipanion/docs/) | Type-safe command declarations and predictable option behavior |
| [Ink](https://term.ink/) | Rich terminal UIs; likely too heavy for normal Executor commands unless a future dashboard-style command justifies it |

Executor uses `@tjalve/qube-cli` for command metadata, runtime dispatch, help, schema, structured output, redaction, and prompt helpers. It must be used conservatively: no auto-updating installers, no just-in-time plugin installation, no hidden remote execution, and no install lifecycle scripts. Executor-owned modules keep domain behavior, provider fields, config policy schema, diagnostics, and command side effects.

The library decision belongs to this milestone document and issue comments/PR discussion. Agents must not create a separate decision record, status document, implementation plan, progress document, or other meta documentation for it.

Any chosen CLI dependency must pass the package safety expectations in this milestone: exact version selection, no install lifecycle scripts required for normal use, small justified runtime dependency surface, no hidden auto-update behavior, and no remote execution.

Executor's CLI UX model is:

1. **Progressive disclosure for humans** - `aie`, `aie help`, `aie help <command-or-topic...>`, `aie <command-or-topic...> help`, incomplete commands, and typo mistakes must guide the user toward the next valid command instead of failing with parser jargon.
2. **Machine contract for agents** - agents must use `--json`, `--output json`, and `aie schema` rather than parsing human help text.
3. **One command registry** - command metadata must be declared once and reused for parsing, help, schema output, docs, mutation labels, dry-run support, and tests.
4. **No fuzzy execution** - suggestions are good, but Executor must not silently run a different mutating command than the user typed. Arbitrary command-prefix abbreviations are not allowed because they create future compatibility traps.
5. **TTY-aware interaction** - prompts and rich formatting are allowed only for interactive terminals and must always have flag/config equivalents.

---

## Dependencies

M1 has no project milestone dependencies.

External runtime expectations:

- Node.js 24 LTS or newer.
- npm-compatible package execution.
- `git` available for repository diagnostics.
- GitHub CLI `gh` available for GitHub diagnostics, but M1 must not require GitHub mutation.

M1 must not require:

- `jq`
- copied shell scripts
- install lifecycle scripts
- PowerShell-specific duplicate command implementations
- network access during normal tests

---

## Part 1: Package Foundation

The package must be a normal npm package with an explicit executable entrypoint.

### 1.1 - Package Identity

Implement package metadata for:

- package name: `@tjalve/aie`
- executable command: `aie`
- TypeScript source
- compiled JavaScript output
- type declarations
- explicit files published to npm
- Node.js engine requirement of Node 24 or newer

Installing the package must not execute Executor, write files, configure hooks, mutate GitHub, or modify the current repository.

### 1.2 - Build And Test Baseline

Add the minimal project commands needed to keep the package healthy:

- typecheck
- lint or equivalent static validation
- unit tests
- build
- package dry-run or equivalent publish-surface check

The test suite in M1 should focus on CLI parsing, config validation, output formatting, exit codes, and diagnostics behavior. Full GitHub issue behavior is not part of M1.

### 1.3 - Dependency Policy

Runtime dependencies must be minimal and justified.

Any dependency added for CLI parsing, prompts, colors, config parsing, schema validation, logging, or formatting must have a clear reason in code review or implementation notes. The package must not use install lifecycle scripts for normal operation.

---

## Part 2: CLI UX Foundation

The `aie` CLI must feel stable before it has all subcommands.

### 2.1 - Root Command

`aie --help` must show:

- what Executor does
- global options
- available command groups
- examples
- mutation expectations
- where to run `aie doctor`

The CLI must support:

- `--help`
- `aie help <command-or-topic...>` as the canonical explicit help form
- `aie <command-or-topic...> help` as the exploratory suffix help form
- `--version`
- `--json` where meaningful
- `--dry-run` for mutating command families as they are added
- `--no-color` or automatic no-color behavior
- predictable non-zero exit codes

All help forms must be non-mutating. The final token `help` is reserved for help lookup and must not be interpreted as a positional argument to a mutating command, so a later command such as `aie init help` shows init help rather than initializing a target named `help`.

### 2.2 - Implemented Command Surface

M1 must implement only the commands owned by M1. It must not add executable placeholders, reserved command classes, "not implemented yet" runtime paths, or roadmap commands.

The M1 executable command tree includes:

- `aie doctor`
- `aie schema`

Incomplete command behavior is part of the UX contract:

- `aie` with no arguments shows a concise landing page with the most common next commands, not a raw parser dump.
- `aie help doctor`, `aie doctor help`, and `aie doctor --help` reach the same doctor help.
- `aie help schema`, `aie schema help`, and `aie schema --help` reach the same schema help.
- Commands owned by later milestones are absent until their own issues implement real behavior.

Unknown command behavior must be helpful but safe:

- typos should produce "did you mean" suggestions where confidence is high
- suggestions must not execute automatically
- mutating alternatives must be clearly marked as mutating
- arbitrary command-prefix abbreviations must not be accepted
- explicit aliases are allowed only when documented and stable

### 2.3 - Output Rules

Human output must be concise and action-oriented.

JSON output must be valid JSON with no decorative text. `--json` is the short path for agents, while `--output json` can be added as the more general output selector when the chosen CLI framework supports it cleanly.

Any command that supports structured output must emit a stable top-level shape with at least:

- `ok`
- `command`
- `cwd`
- `configPath` when known
- `diagnostics` or `result` as appropriate
- `errors` when failed

Errors must include:

- failed operation
- likely cause
- suggested next action
- exit code category

Data goes to stdout. Warnings, progress, hints, and diagnostics go to stderr unless the command's primary result is itself a diagnostic report. JSON mode must never mix decorative text, progress spinners, or human hints into stdout.

### 2.4 - Agent Schema And Introspection

M1 must add an agent-facing command schema surface.

`aie schema --json` must describe the implemented CLI in machine-readable form so agents and Umpire integration do not need to scrape `--help` output.

The schema must include:

- command names and aliases
- command descriptions
- arguments, flags, defaults, and required fields
- examples
- whether the command mutates local files, git state, or GitHub state
- whether the command supports `--dry-run`
- whether the command supports structured output
- stable output object names where known
- stable error kinds and exit codes

The schema can follow a small internal shape in M1, but it should be designed so it can later emit or map to OpenCLI or CLI Spec style descriptions without a rewrite.

### 2.5 - Terminal Discovery

M1 must support discovery through `aie`, `--help`, `aie help <topic...>`, suffix `help`, clear examples, safe suggestions, and `aie schema --json`.

Shell completion is not part of v1. The package must not modify shell profiles, shell startup files, editor configuration, or terminal completion paths.

### 2.6 - Clean Implementation Architecture

CLI UX must not be implemented as scattered one-off `if`/`else` blocks.

M1 must establish a small internal command metadata model that can drive:

- parser registration
- root help
- topic help
- incomplete-command help
- typo suggestions
- `aie schema`
- JSON output capability
- mutation and dry-run labels
- docs generation or docs checks
- snapshot tests for help output

Command handlers should return typed result objects. Rendering should be separate from behavior so human output, JSON output, errors, and tests can stay consistent.

---

## Part 3: Config Foundation

Executor needs one repository policy file for workflow behavior.

### 3.1 - Config Discovery

Implement config discovery for the documented default path:

- `aie.config.json`

Additional config paths are out of scope for M1.

### 3.2 - Config Schema

The M1 config schema must include the workflow policy fields defined in the spec:

- config version
- priority label names
- status label names
- component label names
- branch naming policy
- base branch name and remote name
- no-worktree enforcement
- pre-start open-PR blocking policy
- ignored automation PR authors
- review agents
- review wait duration
- manual UI audit policy
- agent-run quality gate commands
- autonomous shipping policy
- prompt-injection instruction toggle
- no-credit instruction toggle

Validation must catch:

- missing config version
- unsupported config version
- invalid label names
- duplicate labels within a label family
- invalid review wait duration
- unsafe or empty branch naming pattern
- unsafe or empty base branch/remote values
- invalid ignored automation PR author values
- invalid command values for quality gates
- unsupported enum values

### 3.3 - Defaults

Default config values must match the spec:

- priorities: `P1-Critical`, `P2-High`, `P3-Medium`, `P4-Low`
- statuses: `S-Ready`, `S-InProgress`, `S-Blocked`, `S-Blocking`
- components: `C-Architecture`, `C-Backend`, `C-Frontend`, `C-Testing`, `C-Tooling`, `C-Docs`, `C-DevEx`, `C-CI`, `C-Security`, `C-Data`
- base branch/remote: detected repository default when available, otherwise `main` and `origin`
- linked git worktrees are disabled for Executor issue execution
- pre-start open-PR blocking is enabled
- ignored automation PR authors include common dependency-update automation accounts and can be extended per repository
- default PR review wait: 10 minutes
- OpenCode as the highest-polish target
- manual UI audit enabled by default for UI/UX projects once init asks for project type in M4

M1 does not need to implement the interactive init prompts that choose these defaults. It needs the default model and validation that init will use later.

---

## Part 4: Diagnostics Foundation

`aie doctor` is the main M1 user-facing command after `aie --help`.

### 4.1 - Doctor Checks

M1 `aie doctor` must check:

- current working directory
- whether the command is running inside a git repository
- detected repository root
- current branch
- default branch when cheaply available
- whether the checkout appears to be a linked git worktree
- configured base branch and remote when config exists
- whether `git` is available
- whether `gh` is available
- whether `gh auth status` appears usable
- whether `aie.config.json` exists
- whether config parses and validates
- whether Node.js runtime satisfies the package requirement

M1 `doctor` may report label, issue, open-PR preflight, base-branch freshness, instruction, and PR-gate checks as "not checked yet" or "implemented in later milestone" only if the output is explicit. M2-M6 will fill those in.

### 4.2 - Doctor Modes

`aie doctor` must support:

- human-readable output
- `--json`
- no mutation by default
- enough structured diagnostic IDs for agents to react deterministically

M1 should not implement `doctor --fix` unless the implementation is trivial and limited to safe local config creation. Mutation-oriented repair can wait until the relevant feature milestones.

---

## Part 5: Safety And Package Trust

M1 must make the package safe to install and safe to inspect.

### 5.1 - Install Safety

The package must not define `preinstall`, `install`, or `postinstall` lifecycle scripts.

Documentation must show safe install and execution patterns using pinned versions or lockfile-controlled workflows. Examples must not recommend floating `latest` installs as the preferred path.

### 5.2 - Runtime Safety

M1 commands must not mutate:

- GitHub labels
- GitHub issues
- GitHub PRs
- local instruction files
- git branches
- git history
- copied legacy scripts

The CLI must not mutate user repositories in M1.

### 5.3 - Logging And Redaction

The logging foundation must avoid printing secrets. M1 should include a basic redaction helper for token-like values and should use it in errors and debug output.

---

## Proposed GitHub Issues

M1 should become **5 GitHub issues**, not one issue per requirement.

### M1.1 - Scaffold `@tjalve/aie` Package

Create the TypeScript npm package, `aie` executable entrypoint, build/test/typecheck commands, package metadata, Node 24 engine requirement, and publish-surface guard.

Primary FRs: FR-02-001, FR-02-002, FR-02-003, FR-02-006, FR-02-007, FR-02-010, FR-02-012, FR-02-016, FR-02-017, FR-12-012, FR-12-013.

Acceptance:

- `aie --version` works from the built package.
- package install has no lifecycle side effects.
- package metadata exposes only intended files.
- compiled output, declarations, source maps, and declaration maps are not committed.
- scripts perform real checks or fail.
- test/typecheck/build commands pass.

### M1.2 - Implement CLI Framework, Explorability, Help, Output, And Exit Codes

Create the root CLI behavior, implemented command structure, help text, command schema, global options, JSON output conventions, color/no-color handling, and error model.

Primary FRs: FR-12-012 through FR-12-014, FR-13-001, FR-13-003, FR-15-001 through FR-15-021.

Acceptance:

- `aie --help` is useful without reading docs.
- `aie` with no arguments shows a concise landing page with common next commands.
- `aie doctor --help` documents whether it mutates state.
- implemented incomplete command groups show valid next steps and examples.
- unknown commands produce safe suggestions without auto-running alternatives.
- arbitrary command-prefix abbreviations are not accepted.
- explicit aliases, if any, are documented and stable.
- `aie schema --json` exposes metadata for implemented commands.
- commands owned by later issues are absent until implemented.
- no executable placeholders, stub command classes, or "not implemented yet" runtime paths exist.
- `--json` emits valid undecorated JSON.
- stdout/stderr separation is tested.
- errors include likely cause and next action.
- no decision record, status document, implementation plan, progress document, or other meta documentation is created.

### M1.3 - Implement Config Discovery, Defaults, And Validation

Create the repository config model around `aie.config.json`, including defaults and validation for labels, branch policy, base branch/remote, no-worktree enforcement, open-PR preflight policy, ignored automation PR authors, review agents, waits, manual UI audit, agent-run quality gates, and instruction toggles.

Primary FRs: FR-04-001, FR-04-002, FR-04-003 through FR-04-009, FR-04-016 through FR-04-018.

Acceptance:

- config can be loaded from the repo root.
- missing config is reported clearly.
- invalid config produces actionable validation errors.
- defaults match the spec, including no-worktree policy and pre-start git/PR policy.
- config validation is unit tested with valid and invalid examples.

### M1.4 - Implement `aie doctor` Diagnostics Foundation

Implement diagnostics for runtime, git, GitHub CLI, repository root, current branch, linked-worktree detection, base branch/remote config presence, and config validity.

Primary FRs: FR-04-008, FR-04-016 through FR-04-018, FR-13-001 through FR-13-004.

Acceptance:

- `aie doctor` prints a concise health report.
- `aie doctor --json` emits stable diagnostic IDs and statuses.
- missing `git`, missing `gh`, missing auth, linked worktree, missing config, and invalid config are distinguishable.
- doctor does not mutate local or remote state.

### M1.5 - Add Supply-Chain-Safe Documentation And Safety Tests

Document safe install/execution patterns and add tests or package checks that prevent lifecycle scripts and unsafe publish metadata from slipping in.

Primary FRs: FR-02-012, FR-02-013, FR-02-014, FR-02-015, FR-12-004, FR-12-005, FR-12-006.

Acceptance:

- docs prefer pinned versions or lockfile-controlled installs.
- docs do not recommend floating `latest` as the preferred path.
- package metadata check fails if install lifecycle scripts are added.
- runtime dependency list is intentionally small and reviewed.
- basic token redaction helper is tested.

---

## Exit Criteria

M1 is complete when:

- `@tjalve/aie` has a working TypeScript package structure.
- `aie` is exposed as the package CLI.
- `aie --help`, `aie --version`, and `aie doctor` work.
- `aie` and incomplete command groups guide exploration with concise next steps.
- unknown commands provide safe suggestions without fuzzy execution.
- `aie schema --json` provides a machine-readable command contract for agents.
- config discovery, defaults, and validation are implemented.
- JSON output conventions and exit-code behavior are established.
- M1 commands do not mutate GitHub, git state, instruction files, or legacy files.
- package install has no lifecycle side effects.
- safe install documentation exists.
- automated tests cover CLI parsing, config validation, diagnostics, JSON output, and package safety checks.

M1 should leave the repo ready for M2 to add the first real GitHub issue queue behavior without revisiting the foundation.
