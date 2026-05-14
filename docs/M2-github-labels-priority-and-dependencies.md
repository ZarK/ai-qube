# M2 - GitHub Labels, Priority, And Dependencies

## Strategic Goal

M2 turns Executor from a safe CLI shell into a GitHub-aware issue queue reader and repository primer.

This milestone does not start, switch, complete, branch, PR, or merge work yet. It establishes the GitHub label system, live issue loading, dependency graph, priority ordering, status drift detection, label synchronization, and repository priming needed before lifecycle commands can safely operate.

After M2, a developer or agent should be able to run `aie labels setup`, `aie repo prime`, `aie queue`, `aie next --json`, and `aie deps ...` to understand what work is ready, what is blocked, why it is blocked, and whether the repository labels match Executor's live dependency graph.

M2 delivers six things:

1. **GitHub issue model** - a tested Node implementation for loading open issues, labels, milestones, body metadata, and repository state through `gh`.
2. **Executor label setup** - idempotent creation/update of priority, status, and component labels from config.
3. **Dependency graph** - parsing `Blocked by: #123` body metadata, computing open blockers, reverse blocking relationships, dependency chains, and graph output.
4. **Priority queue** - deterministic queue ordering that resumes in-progress issues first, then orders ready work by priority, sequence metadata, milestone task numbering, and issue number.
5. **Status sync** - detection and optional repair of stale `S-Ready`, `S-Blocked`, and `S-Blocking` labels from the live blocker graph.
6. **Repository priming** - a safe `aie repo prime` command for repos that have issues but have not yet been prepared by Bootstrap.

The important success condition is that M3 can add `aie start`, `aie view`, `aie switch`, and `aie complete` without reinventing queue semantics or dependency handling.

---

## Functional Requirements Addressed

M2 is the primary implementation foundation for:

- **FR-04-010 through FR-04-014 and FR-04-016 through FR-04-018** - label setup, repository priming, and pre-start git/PR policy visibility.
- **FR-05-001 through FR-05-013** - GitHub issue queue semantics.
- **FR-06-011 through FR-06-013 and FR-06-015** - dependency inspection helpers, dependency graph output, ready/blocked sync, and actionable dependency output.

M2 also extends:

- **FR-04-007 through FR-04-009** - config validation, `doctor`, and dry-run coverage for label and issue-related commands.
- **FR-13-001 through FR-13-004** - concise human output, structured agent output, actionable errors, and non-mutating diagnostics.
- **FR-15-001 through FR-15-020** - CLI explorability, schema, completion, stdout/stderr separation, mutation labeling, and shared command metadata for all M2 commands.

M2 intentionally does not complete:

- `aie start`, `aie view`, `aie switch`, and `aie complete`. Those are M3.
- branch creation or branch verification. That is M3.
- installed agent instructions and `/make-it-so`. Those are M4.
- PR review gates and shipping. Those are M5.
- legacy script cleanup. That is M6.
- Bootstrap-owned spec, milestone, or issue generation.

---

## Source References

Use these local references only when drafting, reviewing, or decomposing this milestone:

| Reference | Local Path | Use |
|-----------|------------|-----|
| GitHub workflow documentation | `references/workflows/memex.photos/docs/gh-workflow.md` | Queue semantics, label categories, dependency metadata, command expectations |
| Label bootstrap script | `references/workflows/memex.photos/scripts/gh-bootstrap-labels.sh` | Idempotent create-or-update label behavior and default label color/description style |
| Queue ordering scripts | `references/workflows/memex.photos/scripts/gh-priority-order.sh`, `references/workflows/memex/scripts/gh-priority-order.sh`, `references/workflows/ai-code-quality/scripts/gh-priority-order.sh` | Queue ordering behavior and human/JSON output expectations |
| Dependency helpers | `references/workflows/memex.photos/scripts/gh-issue-deps.sh`, `references/workflows/memex.photos/scripts/lib/gh-issue-helpers.sh`, `references/workflows/memex/scripts/gh-issue-deps.sh` | Blocker parsing, dependency graph, ready/blocked lists, status sync |
| Label update helper | `references/workflows/memex.photos/scripts/gh-update-labels.sh` | Status label replacement, sequence metadata handling, blocker metadata handling for future desired commands |
| CLI UX research from M1 | `docs/M1-package-and-cli-foundation.md` | Shared command metadata, incomplete-command help, schema, completion, JSON, and mutation warnings |
| Functional requirements | `docs/spec.md` | Exact FR text and boundaries |

The reference files are source material for milestone authoring. Executor must not ship or depend on this reference corpus.

Reference material stops at this milestone document. Generated GitHub issues, implementation code, code comments, tests, documentation, commit messages, branch names, PR titles, and PR bodies must not cite local reference paths, source repository names, source script filenames, or explain work as copied from or avoiding a reference project. From issue generation onward, use only Executor product behavior, requirement IDs, and user-facing command semantics.

Do not generate issue or implementation wording such as "reference-project style", "copied from the old script", "avoid the old labels", or similar source-derived explanations. If behavior was derived from the references, express it as a normal Executor requirement.

---

## Dependencies

M2 depends on **M1 - Package And CLI Foundation**.

Required from M1:

- `aie` package and CLI exist.
- command metadata model exists.
- config discovery and validation exist.
- `aie schema --json` exists.
- `aie doctor` exists.
- dry-run, JSON output, exit-code, and stdout/stderr conventions exist.
- package safety checks exist.

External runtime expectations:

- `git`
- GitHub CLI `gh`
- authenticated GitHub CLI session for commands that inspect or mutate repository labels/issues
- network access only when actually calling GitHub through `gh`

M2 must not require:

- `jq`
- Python
- copied shell scripts
- Bootstrap-generated specs or milestone docs
- repository mutation without explicit command invocation

---

## Shared CLI UX Contract For M2

The CLI research added in M1 applies directly to M2.

Every M2 command must be explorable by a human and deterministic for an agent:

- `aie labels` shows label subcommands, examples, whether they mutate GitHub, and the dry-run path.
- `aie repo` shows `prime`, what it checks, and what it may write or mutate.
- `aie deps` shows `ready`, `blocked`, `blockers`, `blocking`, `chain`, `graph`, and `fix`.
- `aie help labels`, `aie labels help`, and `aie labels --help` all show label-topic help without mutation.
- `aie help deps`, `aie deps help`, and `aie deps --help` all show dependency-topic help without mutation.
- `aie help repo`, `aie repo help`, and `aie repo --help` all show repo-topic help without mutation.
- `aie queue` with no flags shows a readable queue and summary.
- `aie next` with no flags shows the selected issue and why it was selected.
- unknown M2 subcommands produce safe suggestions without executing alternatives.
- no arbitrary command-prefix abbreviations are accepted.
- all M2 commands are included in `aie schema --json`.
- all mutating commands declare mutation behavior in help, schema, and human output.
- all M2 commands useful to agents support `--json`.
- all mutating M2 commands support `--dry-run`.
- human-readable output may use color only as decoration; text labels must carry the meaning.
- JSON output contains no decorative text or progress lines.
- data goes to stdout; warnings, progress, and hints go to stderr.

M2 must not add one-off parser branches for each of these behaviors. It should extend the M1 command metadata model so help, schema, completion, mutation labels, dry-run labels, and tests stay in sync.

---

## Part 1: GitHub Issue And Label Model

M2 needs a reusable GitHub data layer that later lifecycle commands can share.

### 1.1 - `gh` Execution Wrapper

Implement a small wrapper for `gh` calls that:

- executes `gh` with explicit arguments, not shell-string interpolation
- captures stdout, stderr, exit code, and command metadata
- redacts token-like values from errors and debug logs
- distinguishes auth failure, missing `gh`, non-GitHub repo, network/API failure, and malformed output
- supports test injection/mocking without calling GitHub in normal unit tests

M2 should prefer GitHub's JSON output from `gh` and parse it in Node. It must not depend on `jq`.

### 1.2 - Issue Model

Implement a normalized internal issue model containing:

- issue number
- title
- body
- state
- labels
- milestone
- URL
- priority label
- status label
- component labels
- declared blockers
- open blockers
- issues blocked by this issue
- sequence key
- sequence source
- effective status
- status-label mismatch flag

The model must preserve enough raw data to explain queue decisions without requiring additional GitHub calls for every human output line.

### 1.3 - Test Fixtures

Add fixture-based tests for:

- no issues
- ready issues
- in-progress issue
- blocked issue with open blocker
- blocked issue whose blocker is closed
- stale `S-Ready` / `S-Blocked` labels
- multiple priorities
- missing priority/status labels
- explicit `Sequence:` metadata
- milestone title numbering such as `M2.3.4: ...`, `AM7.3.2: ...`, and project-specific prefixes
- more than one open `S-InProgress` issue

Normal tests must not require live GitHub access.

---

## Part 2: Label Setup

M2 implements `aie labels setup`.

### 2.1 - Default Labels

Executor-owned default labels come from `docs/spec.md` and repository config.

Priority labels:

- `P1-Critical`
- `P2-High`
- `P3-Medium`
- `P4-Low`

Status labels:

- `S-Ready`
- `S-InProgress`
- `S-Blocked`
- `S-Blocking`

Default component labels:

- `C-Architecture`
- `C-Backend`
- `C-Frontend`
- `C-Testing`
- `C-Tooling`
- `C-Docs`
- `C-DevEx`
- `C-CI`
- `C-Security`
- `C-Data`

Project-specific component labels can be configured, but labels outside the Executor defaults must not become universal Executor defaults.

M2 should not create milestone labels by default. Milestone naming belongs to project planning and Bootstrap.

### 2.2 - Idempotent Setup

`aie labels setup` must:

- create missing configured labels
- update color and description for configured labels that already exist
- leave unrelated labels alone
- report every planned or completed change
- support `--dry-run`
- support `--json`
- avoid duplicate labels across configured label families

Human output should group changes into created, updated, unchanged, and skipped labels. JSON output should include the same categories in stable arrays.

### 2.3 - Label Validation

M2 extends `aie doctor` to check:

- missing Executor labels
- configured labels that do not exist in GitHub
- duplicate labels in config
- unknown configured label families
- multiple status labels on the same issue when issue scanning is enabled

`aie doctor` must not mutate labels. It can recommend `aie labels setup --dry-run` and then `aie labels setup`.

---

## Part 3: Dependency Graph

M2 implements the dependency graph behind `aie deps`.

### 3.1 - Blocker Metadata Parser

Executor treats only body lines matching `Blocked by:` as dependency metadata.

Accepted examples:

```text
Blocked by: #123
- Blocked by: #123
Blocked by: #123 #456
```

Matching is case-insensitive and line-based. Other issue links in issue bodies, comments, PRs, or acceptance criteria do not affect dependency ordering.

The parser must:

- deduplicate blocker references
- sort blocker numbers
- ignore malformed references without crashing
- report malformed dependency lines as warnings where useful
- ignore closed blockers when computing effective blocked state

### 3.2 - Dependency Commands

M2 implements:

- `aie deps ready`
- `aie deps blocked`
- `aie deps blockers <issue>`
- `aie deps blocking <issue>`
- `aie deps chain <issue>`
- `aie deps graph`
- `aie deps fix --dry-run`
- `aie deps fix`

All dependency inspection commands support `--json`.

`aie deps fix` is mutating and must:

- support `--dry-run`
- leave `S-InProgress` issues unchanged
- synchronize `S-Ready` and `S-Blocked` from the live blocker graph
- update `S-Blocking` where a ready or blocked issue is currently blocking other open issues, if this is supported by the configured policy
- report every issue whose labels would change or did change

### 3.3 - Dependency Output

Human output must name issue numbers and titles, not only numbers.

Examples of required explanations:

- "Issue #42 is blocked by #17, which is still open."
- "Issue #42 has declared blockers, but all blockers are closed, so it is effectively ready."
- "Issue #17 blocks #42 and #49."
- "No open blockers found."

JSON output must include issue numbers, titles, states, open/closed blocker status, effective status, and any label drift.

---

## Part 4: Queue Ordering

M2 implements `aie queue` and `aie next`.

### 4.1 - Effective Status

Executor computes effective status from live issue data:

1. If an open issue has `S-InProgress`, effective status is `S-InProgress`.
2. Else if it has at least one declared blocker that is still open, effective status is `S-Blocked`.
3. Else effective status is `S-Ready`.

Configured status labels are still important, but stale labels do not override the live blocker graph. Stale labels are reported as drift.

M2 must detect and report when more than one open issue has `S-InProgress`. M3 will enforce this during `aie start`, but M2 should already make the problem visible in `aie queue`, `aie next`, `aie deps fix --dry-run`, and `aie doctor`.

### 4.2 - Ordering Rules

Queue ordering sorts by:

1. effective status, with `S-InProgress` first
2. priority label
3. explicit `Sequence:` metadata in the issue body
4. milestone task numbering in issue titles
5. GitHub issue number

Priority score defaults:

- `P1-Critical`
- `P2-High`
- `P3-Medium`
- `P4-Low`

Issues without a configured priority use the configured default priority for ordering and are reported as missing-priority warnings.

### 4.3 - Sequence Metadata

`Sequence:` metadata accepts numeric dotted keys:

```text
Sequence: 1
Sequence: 1.2
Sequence: 1.2.3
Sequence: 1.2.3.4000
```

Keys are normalized to four numeric parts for sorting.

Title-based task numbering must support project prefixes such as:

- `M2.3.4: ...`
- `AM7.3.2: ...`
- another configured alphabetic prefix followed by milestone/section/task numbers

Explicit body `Sequence:` metadata wins over title-derived numbering.

### 4.4 - `aie queue`

`aie queue` human output must include:

- in-progress issue section, when present
- next ready issue, when present
- ordered ready/blocked summary
- drift warnings
- blocked count
- ready count
- concise next diagnostic command when drift exists, such as `aie deps fix --dry-run`

`aie queue --json` must emit:

- `version`
- repository identity
- ordered `issues`
- `readyIssues`
- `blockedIssues`
- `inProgress`
- `nextIssue`
- warnings
- label drift count

The issue entries must include:

- number
- title
- URL
- labels
- priority
- label status
- effective status
- components
- milestone
- blockers
- open blockers
- blocked-by count
- sequence key
- sequence source
- status mismatch

### 4.5 - `aie next`

`aie next` selects the issue Executor would resume or start:

1. If exactly one open issue is effectively `S-InProgress`, return that issue.
2. If multiple issues are `S-InProgress`, fail with an actionable error unless a future force option is explicitly supported.
3. Otherwise return the highest-priority effectively ready issue.
4. If all issues are blocked, report that the queue is blocked and list the first blocked issues with their open blockers.
5. If there are no open issues, report that the queue is empty.

`aie next --json` must be stable enough for Umpire to call later. It should include:

- selected issue or `null`
- selection reason
- queue state: `resume`, `ready`, `blocked`, `empty`, or `invalid`
- warnings
- blocking details when blocked

---

## Part 5: Repository Priming

M2 implements `aie repo prime`.

### 5.1 - Prime Scope

`aie repo prime` prepares a repository to execute existing GitHub issues when Bootstrap has not run.

It may:

- verify `gh` auth
- verify git remote/repository identity
- detect linked git worktree state
- verify configured base branch/remote values can be resolved when config exists
- report open pull requests that would block starting new issue work under repository policy
- create or update Executor-owned labels
- write minimal `aie.config.json` when missing and explicitly allowed
- check whether open issues exist
- check whether Executor instructions are installed
- report missing planning artifacts

It must not:

- create specs
- create milestone docs
- generate issue batches from a spec
- silently overwrite existing config
- install agent instructions
- clean up legacy scripts
- create a seed issue unless an explicit future flag requests it

Bootstrap owns spec, milestone, and issue generation. Init/instruction installation is M4. Legacy cleanup is M6.

### 5.2 - Prime Modes

`aie repo prime` must support:

- `--dry-run`
- `--json`
- `--yes` or equivalent non-interactive confirmation bypass
- config path selection if M1 supports it

When run interactively, `repo prime` may ask before writing minimal config or mutating labels. When run non-interactively, all required choices must have flags or defaults.

### 5.3 - Prime Output

Human output must separate:

- checks
- planned changes
- completed changes
- skipped actions
- next recommended commands

JSON output must include:

- repository identity
- checks
- mutations planned/completed
- config path
- label changes
- open issue count
- open pull request preflight summary
- linked worktree status
- base branch/remote detection status
- instruction-file status
- missing planning artifacts
- warnings/errors

---

## Part 6: Completion, Schema, And Doctor Updates

M2 must keep the M1 CLI metadata surfaces current.

### 6.1 - Schema

`aie schema --json` must include all M2 commands with:

- descriptions
- arguments
- flags
- examples
- mutation markers
- dry-run support
- structured output support
- stable error kinds
- stable result object names

Agents should be able to discover that `aie labels setup` and `aie deps fix` mutate GitHub, while `aie queue`, `aie next`, and most `aie deps` commands are read-only.

### 6.2 - Completion

Completion should include M2 commands and flags.

If dynamic completion is practical in M2, it may include:

- configured labels
- issue numbers for dependency commands

Dynamic completion must be best-effort and must not make normal command startup slow or fragile.

### 6.3 - Doctor

M2 extends `aie doctor` with checks for:

- GitHub CLI auth against the detected repository
- configured labels existing in GitHub
- missing labels
- open issue scan availability
- status-label drift summary
- multiple `S-InProgress` issues
- stale blocked/ready labels
- linked worktree state
- open pull requests that would block starting new issue work
- whether configured base branch and remote can be resolved

`doctor` remains non-mutating. It should suggest `aie labels setup --dry-run`, `aie labels setup`, `aie deps fix --dry-run`, `aie deps fix`, resolving blocking pull requests, or updating base branch config when relevant.

---

## Proposed GitHub Issues

M2 should become **6 GitHub issues**, not one issue per command or FR.

### M2.1 - Implement GitHub Issue Model And `gh` Execution Layer

Create the tested Node layer for running `gh`, loading open issues, normalizing labels/body/milestone data, parsing issue metadata, and handling GitHub/auth failures.

Primary FRs: FR-02-004, FR-02-005, FR-05-001, FR-12-004, FR-13-003.

CLI UX acceptance:

- failures distinguish missing `gh`, missing auth, non-GitHub repo, API failure, and malformed JSON
- no command output leaks token-like values
- fixture tests do not require live GitHub
- result types are suitable for human rendering and JSON output

### M2.2 - Implement Idempotent `aie labels setup`

Create/update configured priority, status, and component labels from config while leaving unrelated labels untouched.

Primary FRs: FR-04-003 through FR-04-011.

CLI UX acceptance:

- `aie labels` guides users to `aie labels setup`
- `aie labels setup --help`, `aie labels setup help`, and `aie help labels setup` clearly mark the command as GitHub-mutating without mutating
- `aie labels setup --dry-run` shows planned changes without mutation
- `aie labels setup --json` emits created/updated/unchanged/skipped arrays
- `aie doctor` recommends the dry-run command when labels are missing

### M2.3 - Implement Dependency Graph And `aie deps` Inspection Commands

Implement blocker parsing and read-only dependency inspection commands: `ready`, `blocked`, `blockers`, `blocking`, `chain`, and `graph`.

Primary FRs: FR-05-007, FR-05-008, FR-05-013, FR-06-011, FR-06-012, FR-06-015.

CLI UX acceptance:

- `aie deps` shows available subcommands and examples
- `aie deps blockers 93` works with bare issue numbers and, where shell-safe, `#93`
- human output names issue numbers, titles, and open/closed states
- `--json` emits stable graph/blocker data
- malformed blocker lines are reported without crashing

### M2.4 - Implement Queue Ordering With `aie queue` And `aie next`

Implement dependency-aware queue sorting, effective status, sequence/title ordering, drift warnings, `aie queue`, and `aie next`.

Primary FRs: FR-05-002 through FR-05-011, FR-05-013.

CLI UX acceptance:

- `aie queue` is readable for humans and includes a concise summary
- `aie queue --json` emits stable queue data for agents
- `aie next --json` returns the issue to resume/start and the reason
- empty, blocked, and invalid queues produce actionable messages
- multiple `S-InProgress` issues are detected and reported
- output suggests `aie deps fix --dry-run` when status drift exists

### M2.5 - Implement Status Sync With `aie deps fix`

Implement ready/blocked/blocking label synchronization from the live dependency graph.

Primary FRs: FR-05-012, FR-06-012, FR-06-013.

CLI UX acceptance:

- `aie deps fix --help`, `aie deps fix help`, and `aie help deps fix` clearly mark the command as GitHub-mutating without mutating
- `aie deps fix --dry-run` shows exact label changes without mutation
- `S-InProgress` issues are never changed by `deps fix`
- `--json` emits planned/completed label changes
- human output reports each issue changed or skipped

### M2.6 - Implement `aie repo prime` And M2 Doctor/Schema/Completion Updates

Implement repository priming for repos that have issues but no Bootstrap setup, and update `doctor`, `schema`, and completion with all M2 commands.

Primary FRs: FR-04-008, FR-04-012 through FR-04-018, FR-13-001 through FR-13-004, FR-15-001 through FR-15-020. FR-04-015 seed issue creation remains desired and deferred unless explicitly pulled into this issue.

CLI UX acceptance:

- `aie repo` guides users to `aie repo prime`
- `aie repo prime --dry-run` shows checks and planned changes
- `aie repo prime` does not generate specs, milestones, or issue batches
- `aie repo prime` does not install agent instructions
- `aie repo prime` reports linked worktree state, base branch/remote detection, and open PR preflight status without blocking read-only queue commands
- `aie schema --json` includes all M2 commands and mutation markers
- completion includes M2 command names and flags
- `aie doctor` reports label/queue/dependency health and pre-start git/PR preflight visibility without mutating

---

## Exit Criteria

M2 is complete when:

- `aie labels setup` creates/updates configured labels idempotently.
- `aie repo prime` prepares labels/config and pre-start git/PR visibility checks for issue execution without taking over Bootstrap or init responsibilities.
- `aie queue` shows a dependency-aware ordered queue for humans.
- `aie queue --json` emits stable structured queue data.
- `aie next --json` returns the correct issue to resume/start or a clear blocked/empty/invalid state.
- `aie deps ready`, `blocked`, `blockers`, `blocking`, `chain`, `graph`, and `fix` work as specified.
- `aie deps fix --dry-run` and `aie deps fix` synchronize ready/blocked labels without touching `S-InProgress`.
- `aie doctor` includes M2 label, queue, dependency, linked-worktree, open-PR visibility, and base branch/remote checks without mutation.
- `aie schema --json` and completion include all M2 commands.
- incomplete M2 command groups guide users forward with examples and mutation warnings.
- all M2 mutating commands support `--dry-run`.
- all M2 agent-facing commands support stable JSON output.
- normal tests cover queue ordering, blocker parsing, label drift, label setup planning, status sync planning, and GitHub error handling without live GitHub access.

M2 should leave the repo ready for M3 to add lifecycle commands that start, switch, view, complete, branch-check, and unblock issues using the queue/dependency engine built here.
