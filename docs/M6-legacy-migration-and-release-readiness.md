# M6 - Legacy Migration And Release Readiness

## Strategic Goal

M6 helps existing repositories move from copied helper scripts and hand-maintained agent instructions to package-backed Executor commands.

M1 created the package and CLI foundation. M2 added GitHub queue, labels, priority, dependencies, and repository priming. M3 added lifecycle and branch commands. M4 installed agent instructions and host command projections. M5 added gate guidance, evidence helpers, PR review coordination, and shipping readiness support. M6 finishes the v1 adoption path: legacy detection, migration planning, optional compatibility wrappers, safe cleanup, migration diagnostics, user-facing docs, and release-readiness checks.

Executor still does not execute context-sensitive engineering work. M6 mutates deterministic local migration state only when explicitly requested: config files, managed instruction sections, host command files, compatibility wrapper files, and fingerprinted legacy helper files. Agents remain responsible for reviewing diffs, committing, opening PRs, and applying repository-specific judgment.

After M6, a developer or agent should be able to run:

- `aie migrate legacy`
- `aie migrate legacy --dry-run`
- `aie migrate legacy --apply`
- `aie migrate legacy --install-wrappers --dry-run`
- `aie migrate legacy --cleanup --dry-run`
- `aie migrate map`
- `aie doctor`

M6 delivers six things:

1. **Legacy inventory** - product-generic detection of copied helper scripts, old instruction blocks, old host command files, old queue docs, config-like files, and legacy command references.
2. **Migration planner** - one dry-runnable plan object for local file updates, compatibility wrappers, cleanup candidates, conflicts, warnings, and required confirmations.
3. **Instruction and reference migration** - safe replacement of legacy helper references with `aie` command references in managed or explicitly selected instruction files.
4. **Optional compatibility wrappers** - explicitly installed wrappers for repositories that need a transition period while old instructions still call legacy helper paths.
5. **Safe cleanup** - removal or replacement of only fingerprinted legacy helper files or user-confirmed paths, preserving project-specific scripts and docs.
6. **Release readiness** - migration docs, doctor/schema/help metadata updates, fixture-heavy tests, package safety checks, and final adoption guidance.

The important success condition is that a legacy repository can move to Executor without losing queue state, blocker metadata, sequence metadata, GitHub milestone assignments, active issue state, branch state, or project-specific scripts.

---

## Functional Requirements Addressed

M6 is the primary implementation foundation for:

- **FR-14-001 through FR-14-010** - legacy initialization, command mappings, optional compatibility wrappers, state preservation, cleanup, migration audit, dry-run, init migration choices, safe deletion, and instruction reference updates.

M6 also extends:

- **FR-02-008 through FR-02-010** - low repo noise, explicit compatibility wrappers, and normal npm/Node command compatibility.
- **FR-03-014 through FR-03-015** - safe managed instruction updates and legacy detection surfaced by init.
- **FR-04-008 through FR-04-009** - doctor and dry-run coverage for migration.
- **FR-12-004 through FR-12-006** - safe logs, redaction, and external-service clarity.
- **FR-13-001 through FR-13-006** - concise human output, stable JSON, actionable errors, doctor, debug logs, and asset/config path visibility.
- **FR-15-001 through FR-15-020** - CLI explorability, help forms, schema, help metadata, stdout/stderr separation, mutation labels, dry-run behavior, and shared command metadata for migration commands.

M6 intentionally does not complete:

- Bootstrap-owned spec, milestone, or issue generation.
- Umpire-owned long-running scheduling, wakeups, or stop hooks.
- QUBE wrapper package aliases.
- Automatic migration commits, branches, pull requests, or merges.
- Deleting project-specific files that are not fingerprinted legacy helpers unless the user explicitly passes those paths.
- Screenshot upload or external evidence upload.

---

## Source References

Use these local references only when drafting, reviewing, or decomposing this milestone:

| Reference | Local Path | Use |
|-----------|------------|-----|
| Legacy helper scripts | `references/workflows/memex.photos/scripts/*.sh`, `references/workflows/memex/scripts/*.sh`, `references/workflows/ai-code-quality/scripts/*.sh` | Legacy helper categories, command behavior, migration mappings, and fingerprint inspiration |
| Legacy instruction files | `references/workflows/memex.photos/AGENTS.md`, `references/workflows/ai-code-quality/AGENTS.md`, `references/workflows/ai-bootstrap/resources/agents.md` | Old instruction categories and helper-command references that should become product-generic Executor instructions |
| Host command files | `references/workflows/memex.photos/.opencode/commands/memex.md`, `references/workflows/ai-bootstrap/resources/opencode/commands/memex.md` | Legacy project command shape and migration targets |
| GitHub workflow documentation | `references/workflows/memex.photos/docs/gh-workflow.md` | Legacy user documentation categories and command mappings |
| Umpire installer pattern | `references/workflows/ai-umpire/src/installer.ts`, `references/workflows/ai-umpire/src/assets.ts`, `references/workflows/ai-umpire/README.md` | Safe file planning, install targets, and idempotent asset writing |
| Prior milestones | `docs/M1-package-and-cli-foundation.md`, `docs/M2-github-labels-priority-and-dependencies.md`, `docs/M3-issue-lifecycle-branch-and-completion.md`, `docs/M4-init-agent-instructions-and-make-it-so.md`, `docs/M5-quality-review-and-pr-gates.md` | Existing package, CLI, queue, lifecycle, instruction, and gate surfaces |
| Functional requirements | `docs/spec.md` | Exact FR text and boundaries |

The reference files are source material for milestone authoring. Executor must not ship or depend on this reference corpus.

Reference material stops at this milestone document. Generated GitHub issues, implementation code, code comments, tests, documentation, commit messages, branch names, PR titles, and PR bodies must not cite local reference paths, source repository names, source script filenames, or explain work as copied from or avoiding a reference project. From issue generation onward, use only Executor product behavior, requirement IDs, and user-facing command semantics.

Do not generate issue or implementation wording such as "reference-project style", "copied from the old script", "avoid the old workflow", or similar source-derived explanations. If behavior was derived from the references, express it as a normal Executor requirement.

---

## Dependencies

M6 depends on:

- **M1 - Package And CLI Foundation**
- **M2 - GitHub Labels, Priority, And Dependencies**
- **M3 - Issue Lifecycle, Branch Policy, And Completion**
- **M4 - Init, Agent Instructions, And Make-It-So**
- **M5 - Quality, Review, And PR Gates**

Required from earlier milestones:

- package, config, command metadata, schema, help metadata, dry-run, JSON, and redaction foundations
- `gh` wrapper and GitHub issue/label state helpers
- queue, dependency, lifecycle, and branch commands
- init planner and managed instruction writer
- host projections and `/make-it-so`
- gate guidance, PR body, and PR review coordination surfaces
- doctor diagnostics

M6 must not require:

- copied helper scripts
- install lifecycle scripts
- live GitHub access in normal unit tests
- browser automation
- third-party review services
- QUBE wrapper commands
- automatic git commits, PRs, or merges

---

## Shared CLI UX Contract For M6

The CLI research added in M1 applies directly to M6.

Migration commands are high-risk local-file mutation commands and must be especially explorable:

- `aie migrate` with no subcommand shows valid migration topics and examples.
- `aie migrate legacy help`, `aie help migrate legacy`, and `aie migrate legacy --help` show migration help without mutation.
- `aie migrate legacy` defaults to an audit/plan mode and does not write files.
- `aie migrate legacy --dry-run` shows the full planned file changes, wrapper installs, cleanup candidates, skipped files, and required confirmations.
- `aie migrate legacy --apply` is required for local file mutation.
- `aie migrate legacy --cleanup` is required before deleting or replacing fingerprinted legacy helper files.
- `aie migrate legacy --install-wrappers` is required before creating compatibility wrappers.
- `aie migrate legacy --json` emits a stable plan/result object with no decorative output.
- `aie migrate map` shows old helper categories and their corresponding `aie` commands without requiring a legacy repository.
- `aie schema --json` includes migration commands, mutation markers, dry-run support, wrapper behavior, cleanup behavior, and stable error kinds.
- shell help metadata includes migration flags and known migration modes.
- unknown migration flags produce safe suggestions without executing alternatives.

M6 must extend the shared command metadata model. It must not implement migration UX as scattered one-off parser branches.

---

## Part 1: Legacy Inventory

M6 implements product-generic legacy detection.

### 1.1 - Inventory Scope

`aie migrate legacy` must inspect the repository for:

- copied queue/next helper files
- copied label setup/update helper files
- copied issue start/view/switch/complete helper files
- copied dependency helper files
- copied PR review gate helper files
- old project command files that invoke legacy helpers
- old always-loaded instruction blocks that invoke legacy helpers
- old queue or GitHub execution documentation
- existing Executor config
- host-specific command files that may conflict with generated Executor commands

Detection output must describe categories and paths, not source repository names or reference provenance.

### 1.2 - Fingerprints

Cleanup candidates must be based on conservative fingerprints.

Fingerprints may include:

- stable helper filenames
- stable command signatures
- stable marker comments
- stable option names
- stable output labels
- checksum-like fixture snapshots maintained inside Executor tests

Fingerprints must not require shipping the local reference corpus. Executor may ship product-generic fingerprints and test fixtures, but not reference paths or source project names.

When a file is not confidently identified as a legacy helper, migration must mark it as `review-required` and preserve it unless the user explicitly passes that path for cleanup.

### 1.3 - State Preservation

Migration must preserve:

- priority labels
- status labels
- component labels
- `Blocked by:` metadata
- `Sequence:` metadata
- GitHub milestone assignments
- issue open/closed state
- `S-InProgress` state
- current branch state
- configured base branch and remote
- existing user-authored instruction content outside managed sections

M6 must not reset labels, reorder issues, close issues, switch branches, or run git history operations as part of migration.

---

## Part 2: Migration Planner

M6 implements one migration plan object that drives human output, JSON output, dry-run, and apply.

### 2.1 - Plan Contents

The migration plan must include:

- repository root
- detected config path
- detected legacy categories
- legacy paths found
- confidence for each detected path
- files that would be created
- files that would be updated
- files that would be removed
- compatibility wrappers that would be installed
- instruction references that would be updated
- files skipped
- conflicts
- warnings
- external services that could be contacted by migrated policy
- required confirmations
- recommended next command

### 2.2 - Plan Modes

`aie migrate legacy` supports:

- audit-only default mode
- `--dry-run`
- `--apply`
- `--cleanup`
- `--install-wrappers`
- `--force` only for documented conflict cases
- `--json`
- `--yes` for non-interactive approved defaults
- explicit path selection for cleanup or wrapper targets

`--apply` without `--cleanup` must not delete legacy files. It may update managed instructions, config, and selected host command files according to the plan.

`--cleanup` without `--apply` must show a cleanup plan without deleting files.

### 2.3 - Safety Behavior

Migration must:

- preserve user-authored file content outside managed sections
- never silently overwrite unmanaged conflicts
- avoid broad glob deletion
- refuse to clean unrecognized files unless explicitly selected
- report every file mutation
- support dry-run for every mutation
- keep data on stdout and warnings/progress on stderr
- redact token-like values from output

If a migration cannot prove a file is safe to remove or update, it must stop or ask for explicit confirmation.

---

## Part 3: Command Mapping And Instruction Migration

M6 maps legacy helper usage to `aie` commands and updates instructions.

### 3.1 - Command Mapping

`aie migrate map` must show product-generic mappings such as:

| Legacy Category | Executor Command |
|-----------------|------------------|
| queue/next issue selection | `aie queue`, `aie next`, `aie start next` |
| label setup/update | `aie labels setup`, `aie deps fix` |
| issue start | `aie start <issue>`, `aie start next` |
| issue view | `aie view <issue>` |
| issue switch | `aie switch <issue>` |
| issue completion | `aie complete <issue>` |
| dependency inspection | `aie deps blockers`, `aie deps blocking`, `aie deps chain`, `aie deps ready`, `aie deps blocked`, `aie deps graph` |
| PR review gate | `aie pr gate <pr>` |
| PR body draft | `aie pr body <issue>` |
| gate guidance | `aie gates plan`, `aie gates status` |
| manual UI audit guidance | `aie audit ui <issue>` |
| review-agent prompt | `aie review gate <issue>` |

Mapping output must not mention source helper filenames unless they are paths found in the target repository.

### 3.2 - Instruction Updates

Migration may update:

- managed Executor instruction sections
- known legacy instruction sections with high-confidence fingerprints
- host command files selected by init policy
- explicit user-selected instruction files

Instruction updates must:

- replace legacy helper commands with equivalent `aie` commands
- preserve repository-specific project guidance
- preserve user-authored content outside managed sections or selected legacy blocks
- keep autonomous shipping language from M4
- keep gate boundaries from M5: agents run tests, builds, audits, `aiq`, and review interpretation
- keep supply-chain safety rules when configured
- keep optional naming rules when enabled

Unmanaged instruction conflicts require clear output and `--force` only when force behavior is safe and documented.

---

## Part 4: Optional Compatibility Wrappers

M6 can install compatibility wrappers only when explicitly requested.

### 4.1 - Wrapper Scope

Compatibility wrappers are for transition periods where existing instructions still call old helper paths.

Wrappers must:

- be opt-in through `--install-wrappers`
- delegate to the corresponding `aie` command
- be clearly marked as generated compatibility shims
- avoid install lifecycle scripts
- avoid shell profile changes
- avoid hidden network calls
- support dry-run
- be listed in `doctor`

Wrappers must not be installed by default because they add repo noise.

### 4.2 - Wrapper Targets

Wrappers may be created only for:

- high-confidence legacy helper paths found in the repository
- explicit user-selected paths
- paths that do not conflict with project-specific files

If a wrapper would replace an existing non-fingerprinted file, migration must refuse unless the user explicitly confirms the exact path and `--force` semantics allow it.

### 4.3 - Wrapper Behavior

Wrapper behavior should be intentionally thin:

- translate legacy arguments where the mapping is deterministic
- call the equivalent `aie` command
- print a short deprecation notice to stderr
- preserve the wrapped command exit code

Wrappers must not reimplement legacy helper logic.

---

## Part 5: Cleanup Apply

M6 supports safe cleanup of legacy files.

### 5.1 - Cleanup Candidates

Cleanup may remove or replace only:

- high-confidence fingerprinted legacy helper files
- high-confidence legacy generated instruction blocks
- high-confidence legacy host command files
- explicit user-selected paths

Cleanup must preserve:

- project-specific scripts
- project documentation
- user-authored instruction text
- unknown helper-like files
- checked-in evidence
- package manifests and lockfiles unless explicitly selected for unrelated reasons outside migration

### 5.2 - Cleanup Output

Cleanup output must show:

- removed files
- updated files
- preserved files
- skipped files
- explicit reasons
- remaining legacy references
- recommended next commands

If cleanup leaves compatibility wrappers behind, output must make that clear and recommend when to remove them.

### 5.3 - Git Boundary

Migration must not:

- stage files
- commit files
- push branches
- create pull requests
- merge pull requests
- run destructive git commands

The agent reviews the diff and performs git/GitHub shipping actions under installed repository policy.

---

## Part 6: Doctor, Schema, Help Metadata, Docs, And Tests

M6 extends diagnostics, metadata, docs, and release checks.

### 6.1 - Doctor

`aie doctor` must report:

- legacy state summary
- managed instruction state
- compatibility wrapper state
- stale compatibility wrappers
- remaining legacy command references
- migration plan availability
- milestone-ordering and milestone-assignment preservation warnings
- whether cleanup is safe, blocked, or review-required
- recommended next command

`doctor` remains non-mutating.

### 6.2 - Schema And Help Metadata

`aie schema --json` and help metadata must include:

- `aie migrate`
- `aie migrate legacy`
- `aie migrate map`
- migration flags
- cleanup flags
- wrapper flags
- mutation markers
- dry-run support
- structured output support
- stable error kinds

### 6.3 - Documentation

M6 must add user-facing docs for:

- installing Executor safely
- initializing a new repository
- migrating a repository with legacy helpers
- interpreting `aie migrate legacy --dry-run`
- choosing cleanup versus compatibility wrappers
- reviewing migration diffs
- running the autonomous issue cycle after migration
- supply-chain-safe package usage

Docs must not include local reference paths, source repository names, or source-provenance explanations.

### 6.4 - Tests

M6 tests must cover:

- legacy inventory fixture detection
- non-legacy file preservation
- conservative fingerprint matching
- migration plan JSON
- dry-run output
- managed instruction migration
- conflict detection
- wrapper planning and writing
- wrapper refusal on unsafe conflicts
- cleanup planning
- cleanup apply against temporary fixtures
- command mapping output
- doctor legacy state output
- schema and help metadata updates
- product-generic generated output

Normal tests must not require live GitHub, real legacy repositories, browser automation, third-party reviewers, `aiq`, or package-manager execution.

---

## Proposed GitHub Issues

M6 should become **5 GitHub issues**, not one issue per helper category.

### M6.1 - Implement Legacy Inventory And Migration Planner

Create `aie migrate legacy` audit/default behavior with legacy inventory, conservative fingerprints, migration plan object, dry-run, JSON output, and safe conflict reporting.

Primary FRs: FR-14-001, FR-14-004, FR-14-006 through FR-14-009, FR-13-001 through FR-13-004, FR-15-001 through FR-15-020.

CLI UX acceptance:

- `aie migrate`, `aie migrate legacy help`, `aie help migrate legacy`, and `aie migrate legacy --help` are non-mutating and useful
- `aie migrate legacy` defaults to audit/plan mode
- `aie migrate legacy --dry-run --json` emits a stable plan object
- legacy detection reports product-generic categories and target repository paths
- unrecognized helper-like files are preserved and marked `review-required`
- migration does not mutate GitHub, git history, branches, or issue state
- normal tests use fixtures, not live repositories

### M6.2 - Implement Command Mapping And Instruction Migration

Create `aie migrate map` and instruction migration behavior that replaces legacy helper references with equivalent `aie` commands in managed or explicitly selected instruction files.

Primary FRs: FR-14-002, FR-14-004, FR-14-006 through FR-14-010, FR-03-014 through FR-03-015, FR-15-001 through FR-15-020.

CLI UX acceptance:

- `aie migrate map` shows legacy categories and corresponding `aie` commands
- instruction updates preserve user-authored content outside managed sections
- migration updates known legacy instruction sections only when fingerprints are high confidence
- unmanaged conflicts require explicit force behavior
- migrated instructions preserve M4 autonomy wording and M5 agent-execution boundaries
- output contains only Executor product wording and target repository paths

### M6.3 - Implement Optional Compatibility Wrappers And Cleanup Apply

Implement opt-in compatibility wrappers and safe cleanup behavior for fingerprinted legacy helper files.

Primary FRs: FR-02-008 through FR-02-010, FR-14-003 through FR-14-010, FR-13-001 through FR-13-004, FR-15-001 through FR-15-020.

CLI UX acceptance:

- wrappers are never installed unless `--install-wrappers` is set
- wrappers delegate to `aie` commands and do not reimplement legacy logic
- cleanup never deletes non-fingerprinted files unless explicit paths are supplied
- `aie migrate legacy --cleanup --dry-run` shows every file that would be removed or preserved
- `aie migrate legacy --apply --cleanup` reports every mutation
- migration never stages, commits, pushes, opens PRs, merges, or runs destructive git commands

### M6.4 - Implement Migration Doctor, Schema, Help Metadata, And Docs

Extend `aie doctor`, `aie schema --json`, help metadata, and user documentation for migration and release adoption.

Primary FRs: FR-13-001 through FR-13-006, FR-14-001 through FR-14-010, FR-15-001 through FR-15-020.

CLI UX acceptance:

- `aie doctor` reports legacy state, wrapper state, stale wrappers, remaining legacy references, and recommended next commands
- schema includes migration commands, flags, mutation markers, dry-run support, and stable error kinds
- help metadata includes migration commands, flags, and enum values
- docs explain new install, init, migration, wrapper, cleanup, and diff-review flows
- docs are product-generic and do not cite local reference corpus paths or source project names

### M6.5 - Final Release Readiness And Regression Fixtures

Add fixture coverage, package checks, and final release-readiness validation for Executor v1 adoption.

Primary FRs: FR-02-001 through FR-02-015, FR-12-004 through FR-12-007, FR-13-001 through FR-13-006, FR-15-001 through FR-15-020.

CLI UX acceptance:

- fixture tests cover representative clean, mixed, legacy, wrapper, and conflict repositories
- package metadata exposes only intended files
- package contains no install lifecycle scripts
- dependency list remains minimal and justified
- generated output and docs are product-generic
- `npm pack --dry-run` or equivalent package-surface check is covered by scripts/tests
- normal tests pass without live GitHub, package-manager execution, browser automation, PR reviewers, or real sleep

---

## Exit Criteria

M6 is complete when:

- `aie migrate legacy` audits a repository and reports detected legacy state without mutation.
- `aie migrate legacy --dry-run --json` emits a stable migration plan.
- `aie migrate map` shows product-generic legacy category to `aie` command mappings.
- `aie migrate legacy --apply` updates config/instructions/host command files only according to the migration plan.
- compatibility wrappers are installed only when explicitly requested.
- cleanup removes or replaces only high-confidence fingerprinted legacy files or explicit user-selected paths.
- migration preserves labels, blocker metadata, sequence metadata, GitHub milestone assignments, active issue state, branch state, and user-authored instruction content.
- migration never stages, commits, pushes, opens PRs, merges, or runs destructive git commands.
- `aie doctor` reports migration readiness, legacy remnants, wrapper state, and recommended next commands.
- `aie schema --json` and help metadata include migration surfaces.
- user docs cover install, init, migration, cleanup, wrappers, and release-safe adoption.
- normal tests cover migration fixtures, instruction rewrites, wrappers, cleanup, schema, doctor, docs/product-generic output, and package-surface checks without live external services.

After M6, Executor v1 has a complete path for new repositories and existing script-based repositories: initialize, execute GitHub issues through agents, coordinate gates and PR review, migrate away from copied helpers, and keep repo-local noise low.
