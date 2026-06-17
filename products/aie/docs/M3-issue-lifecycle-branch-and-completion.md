# M3 - Issue Lifecycle, Branch Policy, And Completion

## Strategic Goal

M3 turns the GitHub queue from M2 into safe issue lifecycle commands.

This milestone adds the commands an agent or developer needs to move an issue through execution state: inspect it, verify the repository is ready for new work, start or resume it, prepare the correct branch, intentionally switch away from it, and complete it after the PR has merged so dependent issues can unblock.

M3 does not install agent instructions, perform implementation work, run quality gates, create pull requests, wait for PR reviews, or merge PRs. Those are handled by later milestones and by the agent following installed repository policy. M3 provides the deterministic lifecycle commands those later stages rely on.

After M3, a developer or agent should be able to run:

- `aie view 93`
- `aie start next`
- `aie start 93`
- `aie branch suggest 93`
- `aie branch check 93`
- `aie branch create 93`
- `aie switch 94`
- `aie complete 93 --check-only`
- `aie complete 93`

M3 delivers seven things:

1. **Lifecycle mutation planner** - shared planning and dry-run behavior for issue labels, comments, assignment, closure, dependent unblocking, and branch actions.
2. **Issue context view** - a readable and structured issue view with blockers, dependents, acceptance checklist summary, current lifecycle state, and recommended next action.
3. **Start/resume commands** - `aie start next` and `aie start <issue>` with blocker checks, one-in-progress enforcement, optional assignment/comment, and optional branch guidance.
4. **Pre-start git/PR policy** - no linked worktrees, no blocking open pull requests, and a current local base branch before new issue work starts.
5. **Branch policy helpers** - issue-coupled branch naming, branch suggestion, branch verification, and explicit branch creation without destructive git behavior.
6. **Switch command** - intentional movement from one in-progress issue to another while returning the paused issue to its correct ready or blocked state.
7. **Completion command** - post-merge issue completion, checklist checks, status cleanup, issue close handling, and dependent issue unblocking.

The important success condition is that M4 can install agent instructions telling agents to call these commands confidently during the work cycle, and M5 can rely on `aie complete` after PR merge.

---

## Functional Requirements Addressed

M3 is the primary implementation foundation for:

- **FR-06-001 through FR-06-010 and FR-06-016 through FR-06-018** - start, view, switch, complete, pre-start git/PR policy, dry-run/check-only, and structured lifecycle output.
- **FR-07-001 through FR-07-010** - branch naming policy, branch suggestion/creation, context-sensitive git boundaries, no-worktree policy, open-PR blocker policy, no destructive git operations, and branch verification.

M3 also extends:

- **FR-01-001** - issue execution from selection through completion and dependent unblocking.
- **FR-01-007** - shipping permissions are supported by deterministic lifecycle commands, while installed instructions arrive in M4.
- **FR-05-005 through FR-05-006** - resume active issue first and enforce one active in-progress issue.
- **FR-05-012 through FR-05-013** - lifecycle commands keep dependency-derived status correct.
- **FR-13-001 through FR-13-004** - concise human output, structured agent output, actionable errors, and non-mutating diagnostics.
- **FR-15-001 through FR-15-020** - CLI explorability, schema, help metadata, stdout/stderr separation, mutation labeling, and shared command metadata for all M3 commands.

M3 intentionally does not complete:

- blocker metadata edit helpers from **FR-06-014** unless explicitly pulled into M3 as a small follow-on. M2 already provides dependency inspection and sync.
- installed `AGENTS.md`, `CLAUDE.md`, and `/make-it-so` instructions. Those are M4.
- manual UI audit guidance, Oracle/review prompts, test gate guidance, PR review gates, PR creation, and merge policy. Those are M5 and the installed work cycle.
- legacy cleanup. That is M6.

---

## Specification Inputs

Use [docs/spec.md](spec.md) for exact functional requirement text, [docs/M1-package-and-cli-foundation.md](M1-package-and-cli-foundation.md) for shared CLI contracts, and [docs/M2-github-labels-priority-and-dependencies.md](M2-github-labels-priority-and-dependencies.md) for queue and dependency behavior that M3 builds on. M3 implementation language must describe Executor lifecycle, branch, and completion behavior only.

---

## Dependencies

M3 depends on:

- **M1 - Package And CLI Foundation**
- **M2 - GitHub Labels, Priority, And Dependencies**

Required from M2:

- normalized issue model
- GitHub CLI execution layer
- dependency graph
- effective status computation
- queue ordering
- status-label drift detection
- dependency status sync
- structured queue and dependency output

External runtime expectations:

- `git`
- GitHub CLI `gh`
- authenticated GitHub CLI session for issue mutation
- repository config with branch naming policy
- repository config with base branch/remote and open-PR blocking policy

M3 must not require:

- `jq`
- Python
- copied shell scripts
- linked git worktrees
- hidden git hooks
- PR review integrations
- destructive git commands

---

## Shared CLI UX Contract For M3

The CLI research added in M1 applies directly to M3.

Every M3 command must be explorable by a human and deterministic for an agent:

- `aie start` explains `next` and issue-number usage, with examples.
- `aie view` explains issue-number usage and available output modes.
- `aie switch` explains how the current in-progress issue is detected and how to pass `--from`.
- `aie complete` explains `--check-only`, `--dry-run`, and why completion should run after merge even when a PR closed the issue.
- `aie branch` shows `suggest`, `check`, and `create`, including which commands mutate git state.
- `aie help start`, `aie start help`, and `aie start --help` all show start help without mutation.
- `aie help complete`, `aie complete help`, and `aie complete --help` all show completion help without mutation.
- `aie help branch`, `aie branch help`, and `aie branch --help` all show branch-topic help without mutation.
- start/switch help explains that new issue work is blocked by linked worktrees, blocking open pull requests, or a stale local base branch.
- unknown M3 subcommands produce safe suggestions without executing alternatives.
- no arbitrary command-prefix abbreviations are accepted.
- all M3 commands are included in `aie schema --json`.
- all mutating commands declare mutation behavior in help, schema, and human output.
- all M3 commands useful to agents support `--json`.
- all mutating M3 commands support `--dry-run`.
- commands that can operate on issue numbers accept bare numbers and shell-safe `#` forms when the shell passes them through.
- JSON output contains no decorative text or progress lines.
- data goes to stdout; warnings, progress, and hints go to stderr.

M3 must extend the shared command metadata model from M1. It must not implement lifecycle UX as scattered one-off parser branches.

---

## Part 1: Lifecycle Mutation Planner

M3 needs one lifecycle planning layer so dry-run output and actual mutation stay consistent.

### 1.1 - Planned Actions

Lifecycle commands must be able to plan and render these action types:

- add issue labels
- remove issue labels
- replace status labels
- assign issue to authenticated GitHub user
- add issue comment
- close issue as completed
- refresh dependent issue status
- suggest branch name
- verify current branch
- create local branch
- check linked worktree status
- check blocking open pull requests
- check local base branch freshness against the configured remote

Every planned action must declare:

- target type
- target identifier
- whether it mutates GitHub, git state, or only local output
- human description
- structured JSON shape
- preconditions
- expected result

### 1.2 - Dry-Run Behavior

Every mutating lifecycle command must support `--dry-run`.

Dry-run output must show exactly what would change without mutating:

- labels removed or added
- comments that would be written
- assignment that would be attempted
- issue close action
- dependent issue sync actions
- branch creation action

Dry-run must still perform read-only validation so it can catch blockers, multiple in-progress issues, linked worktree state, blocking open pull requests, stale base branch state, missing branch policy, and unsafe repository state.

### 1.3 - Partial Failure Reporting

If a command performs multiple mutations and one fails, output must report:

- actions completed
- action that failed
- actions not attempted
- recommended recovery command

JSON output must include the same information so agents can decide whether to retry, stop, or inspect manually.

---

## Part 2: Issue View

M3 implements `aie view <issue>`.

### 2.1 - Displayed Context

`aie view <issue>` must show:

- issue number and title
- URL
- state
- labels
- GitHub milestone title, state, and due date when available
- assignees
- priority
- label status
- effective status
- blockers and their open/closed states
- open issues blocked by this issue
- acceptance checklist summary
- branch suggestion
- current branch match, when running inside a git repository
- recommended next action

Recent comments may be included when supported by flags, but human output should stay concise by default.

### 2.2 - Recommended Next Action

The recommended next action should be explicit:

- resume this issue
- start this issue
- do not start because blockers are open
- do not start because another issue is in progress
- switch intentionally if needed
- complete only after merge
- run branch check/create before implementation

### 2.3 - Structured Output

`aie view <issue> --json` must include issue data, dependency data, branch data, checklist summary, warnings, and recommended action in a stable schema.

---

## Part 3: Start And Resume

M3 implements `aie start next` and `aie start <issue>`.

### 3.1 - `aie start next`

`aie start next` must:

1. Use the M2 queue engine.
2. Resume the single open `S-InProgress` issue if one exists.
3. Fail if multiple open issues are `S-InProgress`.
4. Otherwise select the highest-priority effectively ready issue.
5. Run the pre-start git/PR policy before starting new work.
6. Fail cleanly if the queue is empty, blocked, or pre-start policy fails.
7. Apply the same start behavior as `aie start <issue>`.

### 3.2 - `aie start <issue>`

`aie start <issue>` must:

- load the target issue
- reject closed or missing issues
- check open blockers
- check for an existing different `S-InProgress` issue
- run pre-start git/PR policy when the target is not already in progress
- be idempotent when the target issue is already the active issue
- remove ready/blocked status labels as needed
- add `S-InProgress`
- optionally assign the issue to the authenticated GitHub user
- optionally add a standard started-work comment
- report branch suggestion or branch state
- support `--dry-run`
- support `--json`

Policy flags must include:

- `--no-assign`
- `--no-comment`
- a branch behavior flag if start can also create or verify branches

M3 should keep branch creation explicit. If branch creation is supported from `aie start`, it must require an explicit flag or repository policy that was already accepted in config.

### 3.3 - Start Output

Human output must include:

- selected issue
- whether the command started or resumed
- labels changed
- assignment/comment result
- branch suggestion or branch check result
- next recommended command

JSON output must include:

- selected issue
- action: `started`, `resumed`, `blocked`, `empty`, or `invalid`
- mutations planned/completed
- blockers
- active issue state
- pre-start git/PR policy result
- branch recommendation
- warnings/errors

---

## Part 4: Pre-Start Git And PR Policy

M3 enforces the repository state that must be true before new issue work starts.

### 4.1 - No Linked Worktrees

Executor does not use linked git worktrees for issue execution in v1.

Lifecycle and branch commands must:

- detect linked git worktree state
- refuse to start new issue work from a linked worktree
- report the primary repository path when detectable
- avoid creating, deleting, or switching worktrees

This policy applies to `aie start <issue>`, `aie start next` when it would start new work, `aie switch <issue>`, and `aie branch create <issue>`.

### 4.2 - Open Pull Request Blocker

Before starting new issue work, Executor must check open pull requests in the repository.

The check must:

- list open pull requests with number, title, URL, author, head branch, base branch, and draft state
- ignore PRs whose author is configured as automation
- treat all other open PRs as blockers
- fail before mutating issue labels, comments, assignment, or branches when blockers exist
- explain that existing pull requests should be merged, closed, or intentionally handled before starting new issue work

Automation authors are configured in repository policy. The default list should include common dependency-update automation accounts and remain editable.

### 4.3 - Base Branch Freshness

Before starting new issue work, Executor must verify the local base branch is current with the configured remote base branch.

The default remote/base pair is `origin` and `main` unless detected or configured otherwise.

The check must:

- verify the local base branch exists
- verify the configured remote tracking branch exists
- verify the local base branch commit equals the configured remote base branch commit
- fail before mutation if the local base branch is stale, missing, or diverged
- report the command the agent should run, such as checking out the base branch and pulling from the configured remote

`aie start next` may skip this check only when it is resuming the single existing in-progress issue.

### 4.4 - Preflight Output

Human output must name:

- linked worktree status
- blocking open PRs, if any
- configured remote/base pair
- local and remote base branch commits when helpful
- next command or manual action needed

JSON output must include:

- `worktree`
- `openPullRequests`
- `ignoredPullRequests`
- `blockingPullRequests`
- `baseBranch`
- `remoteBranch`
- `localCommit`
- `remoteCommit`
- `status`
- `errors`

---

## Part 5: Branch Policy Helpers

M3 implements branch suggestion and verification helpers.

### 5.1 - Branch Naming

The default branch naming policy creates issue-coupled branches using:

```text
issue/<number>-<slug>
```

The slug is derived from the issue title, lowercased, hyphenated, and limited to a short readable length.

Repository config may choose another prefix or pattern. M3 must validate the configured pattern before using it.

### 5.2 - Branch Commands

M3 implements:

- `aie branch suggest <issue>`
- `aie branch check <issue>`
- `aie branch create <issue>`

`aie branch suggest <issue>` is read-only and prints the expected branch name.

`aie branch check <issue>` is read-only and verifies whether the current branch matches the configured policy for the issue.

`aie branch create <issue>` mutates local git state and must:

- support `--dry-run`
- refuse to run outside a git repository
- refuse to run from a linked git worktree
- refuse to switch branches with an unsafe dirty checkout state unless a safe policy is explicitly configured
- never run destructive git operations
- never hard reset
- never delete branches
- report whether it created a new branch or checked out an existing branch

M3 may support creating from the configured base branch only when the local repository state is safe and the base branch freshness check passes. Pulling from remote remains an agent-instruction responsibility in M4 because it is context-sensitive.

### 5.3 - Branch Verification In Lifecycle

Lifecycle commands must surface branch guidance:

- `aie start` reports the expected branch.
- `aie view` reports whether the current branch matches the issue when applicable.
- `aie complete --check-only` verifies branch consistency when repository policy requires it.

Branch mismatch should block completion checks only when configured policy says branch matching is required.

---

## Part 6: Switch

M3 implements `aie switch <issue>`.

### 6.1 - Switch Behavior

`aie switch <issue>` intentionally moves work from the current in-progress issue to another issue.

It must:

- detect the current in-progress issue when `--from` is not provided
- reject ambiguous multiple in-progress issues
- allow explicit `--from <issue>`
- verify the target issue exists and is open
- run the pre-start git/PR policy before starting the target issue
- check target blockers unless an explicit force option is supplied
- return the paused issue to its effective ready or blocked state
- optionally comment on the paused issue
- start the target issue using the same start planner
- support `--dry-run`
- support `--json`

### 6.2 - Force Behavior

Force-switching to a blocked issue is dangerous and should be explicit.

If supported, the force flag must:

- be named clearly
- show open blockers in human and JSON output
- be visible in help/schema as risky
- never be used by `aie start next`

### 6.3 - Switch Output

Human output must include:

- from issue
- target issue
- paused issue status after sync
- target issue status after start
- comments/labels/assignment actions
- branch recommendation

JSON output must include the same action plan and result.

---

## Part 7: Complete And Unblock

M3 implements `aie complete <issue>`.

### 7.1 - Completion Checks

`aie complete <issue> --check-only` must verify:

- issue exists
- issue is open or was already closed by a PR
- configured checklist policy
- unchecked issue body checklist items
- active status label state
- branch policy, when configured as required
- dependent issue impact

Unchecked checklist items block completion unless `--force` is explicitly supplied.

### 7.2 - Completion Behavior

`aie complete <issue>` runs after the PR is merged.

It must:

- remove lifecycle status labels from the completed issue
- optionally add a completion comment
- close the issue as completed when it is still open
- still refresh dependents when the issue was already closed by a PR
- synchronize dependent issues from the live blocker graph
- unblock dependents whose remaining blockers are all closed
- leave dependents blocked when other blockers remain open
- support `--dry-run`
- support `--json`

This command is required even when a PR closing keyword already closed the issue, because dependent unblocking and queue maintenance still need to run.

### 7.3 - Completion Output

Human output must include:

- issue completed
- checklist result
- labels removed
- close result or already-closed state
- dependents refreshed
- dependents unblocked
- dependents still blocked
- remaining open issues in the completed issue's GitHub milestone when milestone data is available
- next recommended command, usually `aie next` or `aie queue`

JSON output must include:

- issue
- completion state
- checklist result
- mutations planned/completed
- dependent issue results
- next recommended command
- warnings/errors

---

## Part 8: Doctor, Schema, And Help Metadata Updates

M3 must keep the M1 CLI metadata surfaces current.

### 8.1 - Schema

`aie schema --json` must include all M3 commands with:

- arguments
- flags
- examples
- mutation markers
- dry-run/check-only support
- structured output support
- stable error kinds
- stable result object names

Agents should be able to discover that `aie view`, `aie branch suggest`, and `aie branch check` are read-only, while `aie start`, `aie switch`, `aie complete`, and `aie branch create` can mutate GitHub or git state.

### 8.2 - Help Metadata

Help metadata should include M3 command names, flags, examples, mutation markers, JSON support, dry-run support, and check-only support.

### 8.3 - Doctor

M3 extends `aie doctor` with checks for:

- valid branch naming policy
- current in-progress issue count
- current branch matching the active issue, when applicable
- linked worktree state
- open pull requests that would block new issue work
- configured base branch freshness against the configured remote
- lifecycle command readiness
- missing GitHub labels needed for lifecycle commands
- dependent status drift after recently closed issues, where cheaply detectable

`doctor` remains non-mutating. It should suggest `aie view`, `aie branch check`, resolving blocking pull requests, updating the local base branch from the configured remote, leaving a linked worktree, `aie deps fix --dry-run`, or `aie complete --check-only` when relevant.

---

## Proposed GitHub Issues

M3 should become **6 GitHub issues**, not one issue per command or FR.

### M3.1 - Implement Lifecycle Mutation Planner

Create a shared planner for lifecycle mutations so dry-run output, JSON output, human output, and actual execution use the same action model.

Primary FRs: FR-06-009, FR-06-010, FR-06-016 through FR-06-018, FR-07-006, FR-07-008 through FR-07-010, FR-13-001 through FR-13-004, FR-15-001 through FR-15-020.

CLI UX acceptance:

- every planned action declares whether it mutates GitHub, git state, or neither
- standardized help forms work for lifecycle commands and never consume `help` as an issue number, branch name, or other mutating positional argument
- dry-run output and execution output use the same action model
- partial failures report completed, failed, and skipped actions
- pre-start policy failures block mutation and report linked worktree, open PR, or base branch freshness details
- JSON output is stable and contains no human decoration
- command metadata drives help, schema, help metadata, and tests

### M3.2 - Implement `aie view` Issue Context

Create the read-only issue view that combines issue metadata, dependency state, checklist summary, branch suggestion, and recommended next action.

Primary FRs: FR-05-014 through FR-05-017, FR-06-005, FR-06-010, FR-13-001, FR-15-001 through FR-15-020.

CLI UX acceptance:

- `aie view` without an issue explains the expected argument and examples
- `aie view 93` is concise but complete enough to start work safely
- `aie view 93 --json` exposes issue, dependency, checklist, branch, and recommendation data
- `aie view 93` shows GitHub milestone context when available without requiring milestones for execution
- output names blockers and dependents with titles and states
- recommended next action is explicit

### M3.3 - Implement `aie start next` And `aie start <issue>`

Implement start/resume behavior using the M2 queue and lifecycle planner.

Primary FRs: FR-05-005, FR-05-006, FR-05-015 through FR-05-016, FR-06-001 through FR-06-004, FR-06-009, FR-06-010, FR-06-016 through FR-06-018, FR-07-008 through FR-07-010.

CLI UX acceptance:

- `aie start` explains `next` and issue-number usage
- `aie start next` resumes the single active issue before starting new work
- `aie start next` respects configured GitHub milestone ordering only through the M2 queue engine
- missing milestones do not block start unless repository policy explicitly requires milestone assignment
- multiple active issues fail with an actionable error
- open blockers prevent start unless a future explicit force path exists
- starting new issue work is blocked by linked worktrees, blocking open PRs, or stale local base branch state
- resuming the single active issue does not require base-branch freshness preflight
- assignment/comment behavior follows config and flags
- `--dry-run` and `--json` are supported
- output reports labels, assignment, comment, branch recommendation, and next command

### M3.4 - Implement Branch Policy Helpers

Implement branch naming, suggestion, verification, and explicit branch creation.

Primary FRs: FR-07-001 through FR-07-010, FR-06-010, FR-15-001 through FR-15-020.

CLI UX acceptance:

- `aie branch` shows `suggest`, `check`, and `create`
- `aie branch suggest 93` is read-only
- `aie branch check 93` is read-only and gives a clear pass/fail result
- `aie branch create 93 --dry-run` shows the planned git action
- branch creation refuses linked worktrees, unsafe dirty checkout state, and stale base branch state unless policy explicitly permits the action
- no branch command performs destructive git operations
- schema and help metadata mark branch mutation behavior correctly

### M3.5 - Implement `aie switch`

Implement intentional movement from one in-progress issue to another.

Primary FRs: FR-06-006, FR-06-009, FR-06-010, FR-06-016 through FR-06-018, FR-05-006, FR-07-008 through FR-07-010, FR-13-001 through FR-13-004.

CLI UX acceptance:

- `aie switch` explains target issue and optional `--from`
- current active issue is detected when unambiguous
- multiple active issues fail with an actionable error
- paused issue returns to effective ready or blocked state
- target issue uses the same start planner, blocker checks, and pre-start git/PR policy
- `--dry-run` and `--json` are supported
- risky force behavior, if supported, is explicit in help and schema

### M3.6 - Implement `aie complete` And Lifecycle Diagnostics

Implement post-merge issue completion, checklist checks, label cleanup, close behavior, dependent unblocking, and M3 doctor/schema/help metadata updates.

Primary FRs: FR-06-007 through FR-06-010, FR-06-019, FR-05-012 through FR-05-017, FR-07-007 through FR-07-010, FR-13-001 through FR-13-004, FR-15-001 through FR-15-020.

CLI UX acceptance:

- `aie complete` explains issue-number usage, `--check-only`, `--dry-run`, and `--force`
- `aie complete 93 --check-only` verifies completion readiness without mutation
- unchecked checklist items block completion unless `--force` is supplied
- already-closed issues still trigger dependent refresh
- dependents are unblocked only when all open blockers are resolved
- completion output reports remaining work in the completed issue's GitHub milestone when milestone data is available
- output recommends `aie next` or `aie queue` after completion
- `aie doctor`, `aie schema --json`, and help metadata include M3 lifecycle, branch, linked-worktree, open-PR, and base branch freshness checks

---

## Exit Criteria

M3 is complete when:

- `aie view <issue>` gives a complete read-only issue execution context.
- `aie start next` resumes an active issue or starts the correct ready issue.
- `aie start <issue>` starts a specific issue only when blockers and active-issue rules allow it.
- starting new issue work is blocked when the checkout is a linked worktree, blocking open PRs exist, or the local base branch is not current with the configured remote.
- `aie branch suggest`, `aie branch check`, and `aie branch create` follow repository branch policy and avoid destructive git behavior.
- `aie switch <issue>` intentionally moves in-progress state while preserving ready/blocked state on the paused issue.
- `aie complete <issue> --check-only` verifies completion readiness without mutation.
- `aie complete <issue>` closes or finalizes the issue and refreshes dependent issue status even when the issue was already closed by a PR.
- all M3 mutating commands support `--dry-run`.
- all M3 agent-facing commands support stable `--json`.
- incomplete M3 command groups guide users forward with examples and mutation warnings.
- `aie doctor` includes lifecycle, branch, linked-worktree, open-PR, and base branch readiness checks without mutation.
- `aie schema --json` and help metadata include all M3 commands.
- normal tests cover start/resume, blocker rejection, multiple active issue rejection, pre-start linked-worktree/open-PR/base-freshness failures, switch planning, completion checks, dependent unblocking, branch naming/check/create planning, dry-run output, and structured JSON output without live GitHub access.

M3 should leave the repo ready for M4 to install agent instructions that tell agents how to use these commands as part of the autonomous issue work cycle.
