# AI Executor - Functional Requirements Specification

## Document Purpose

This document defines the functional requirements for AI Executor, distributed as the `@tjalve/aie` npm package and exposed through the `aie` CLI.

AI Executor is the QUBE package responsible for executing issue-driven development work from GitHub issues through implementation, verification, pull request review, merge, issue completion, and selection of the next issue. It is intentionally opinionated: the package exists to make autonomous agents confident enough to keep shipping overnight while still following explicit queue, quality, review, and safety rules.

Requirements use stable identifiers (`FR-XX-NNN`) so milestone specs and GitHub issues can reference them without redefining scope.

## Source Reference Material

This specification is intended to be sufficient input for generating milestones and implementation issues in a fresh context. The functional requirements define the Executor product; the files below are local source material for deriving milestone scope and expected behavior. Executor itself must not ship or depend on these source references as runtime concepts.

Reference material stops at milestone authoring. Generated GitHub issues, implementation code, code comments, tests, documentation, commit messages, branch names, PR titles, and PR bodies must not cite local reference paths, source repository names, source script filenames, or explain work as copied from or avoiding a reference project. From issues onward, all wording must describe Executor product behavior, requirement IDs, and user-facing command semantics only.

Do not write phrases such as "Memex-style labels", "copied from the reference script", "unlike the old repo", or similar reference-derived explanations in generated issues or implementation artifacts. If behavior was derived from the references, express it as a normal Executor requirement.

When generating milestones, use these references where available:

| Reference | Local Path | Relevant Requirements |
|-----------|------------|-----------------------|
| Proven OpenCode command pattern | `references/workflows/memex.photos/.opencode/commands/memex.md` | FR-03, FR-08, FR-11 |
| Full autonomous agent instruction source | `references/workflows/ai-bootstrap/resources/agents.md` | FR-03, FR-08, FR-09, FR-12 |
| GitHub issue workflow documentation | `references/workflows/memex.photos/docs/gh-workflow.md` | FR-04, FR-05, FR-06, FR-10, FR-14 |
| Label bootstrap script | `references/workflows/memex.photos/scripts/gh-bootstrap-labels.sh` | FR-04 |
| Queue ordering scripts | `references/workflows/memex.photos/scripts/gh-priority-order.sh`, `references/workflows/memex/scripts/gh-priority-order.sh`, `references/workflows/ai-code-quality/scripts/gh-priority-order.sh` | FR-05 |
| Issue lifecycle scripts | `references/workflows/memex.photos/scripts/gh-issue-start.sh`, `gh-issue-view.sh`, `gh-issue-switch.sh`, `gh-issue-complete.sh` | FR-06 |
| Dependency helper scripts | `references/workflows/memex.photos/scripts/gh-issue-deps.sh`, `references/workflows/memex/scripts/gh-issue-deps.sh`, `references/workflows/memex.photos/scripts/lib/gh-issue-helpers.sh` | FR-05, FR-06 |
| PR review gate script | `references/workflows/memex.photos/scripts/gh-pr-review-gate.sh` | FR-10 |
| Manual UI audit guide and agent-browser examples | `references/workflows/memex/docs/manual-ui-audit.md`, `references/workflows/memex/e2e/scripts/agent-browser-*.mjs` | FR-09, FR-12 |
| Umpire package installer pattern | `references/workflows/ai-umpire/src/installer.ts`, `references/workflows/ai-umpire/src/bin/aiu.ts`, `references/workflows/ai-umpire/README.md` | FR-02, FR-03, FR-11, FR-14 |

**Requirement status values:**

- **Required** - Must be implemented for the feature domain to be considered complete.
- **Desired** - Should be implemented but can be deferred to a later phase.
- **Future** - Documented for completeness; not in current scope.

---

## FR-01 - Product Role And Boundaries

These requirements define what Executor owns inside the QUBE package family.

Executor coordinates deterministic workflow state and renders guidance for agents. Agents execute context-sensitive engineering work: implementation, tests, builds, audits, `aiq`, code review interpretation, package-manager actions, PR creation content decisions, merge judgment, and follow-up fixes. Executor commands may mutate deterministic GitHub or local workflow state, inspect repository and PR state, render prompts/checklists/commands, and report what the agent should do next.

| ID | Requirement | Status |
|----|-------------|--------|
| FR-01-001 | Executor provides the issue execution coordination system for agentic coding: find or resume the correct GitHub issue, start it, guide implementation, define and track quality/review gate obligations, support pull-request shipping, complete the issue, unblock dependents, update queue state, and continue to the next issue. | Required |
| FR-01-002 | Executor is usable as a standalone package in any GitHub repository that follows the required label and issue metadata conventions. | Required |
| FR-01-003 | Executor works especially well with the other QUBE packages: Bootstrap (`@tjalve/aib`) creates specs, milestones, and issues; Executor (`@tjalve/aie`) guides agents executing those issues; Quality Control (`@tjalve/aiq`) provides deeper quality gates for agents to run; Umpire (`@tjalve/aiu`) keeps the agent loop alive. | Required |
| FR-01-004 | Executor does not own spec generation, milestone generation, or initial GitHub issue generation from specs. Those belong to Bootstrap. | Required |
| FR-01-005 | Executor does not own long-running stop hooks or continuation scheduling. Those belong to Umpire, but Umpire may call Executor commands to choose and resume work. | Required |
| FR-01-006 | Executor does not own static code analysis or AI code-quality engines. Those belong to Quality Control, but Executor may configure, render, and report an optional `aiq` gate for agents to run when installed and enabled. | Required |
| FR-01-007 | Executor is opinionated about the development cycle and shipping permissions. The installed agent instructions explicitly authorize commit, push, PR creation, review-gate waits, merge, issue completion, and continuation when repository policy enables autonomous mode. | Required |
| FR-01-008 | Executor does not replace the human developer's repository-specific requirements. It installs a default execution policy that can be configured per repository during initialization. | Required |
| FR-01-009 | A future QUBE wrapper package may expose shorthand commands for all QUBE packages, but QUBE wrapper behavior is outside this specification. | Future |

---

## FR-02 - Package, Runtime, And CLI Surface

| ID | Requirement | Status |
|----|-------------|--------|
| FR-02-001 | Executor is distributed as the public npm package `@tjalve/aie`. | Required |
| FR-02-002 | The package exposes the executable CLI command `aie`. | Required |
| FR-02-003 | The package requires a currently supported Node.js runtime at release time. As of May 14, 2026, the baseline target is Node.js 24 LTS or newer; Node.js 20 is not an acceptable baseline because it reached end of life on April 30, 2026. | Required |
| FR-02-004 | The package may require `git` and the GitHub CLI (`gh`) for repository operation. | Required |
| FR-02-005 | The package does not require `jq`; JSON parsing and command orchestration are implemented in Node. | Required |
| FR-02-006 | The package is implemented primarily in TypeScript and publishes compiled JavaScript plus type declarations. | Required |
| FR-02-007 | The package exposes `aie` through npm's normal explicit CLI entrypoint only after the repository owner installs the package or invokes it deliberately. Installing the package must not run Executor, mutate a repository, or configure hooks by side effect. | Required |
| FR-02-008 | The package keeps installed repo noise low by preferring package commands over copied shell scripts. | Required |
| FR-02-009 | Compatibility shell wrappers may be installed only when explicitly requested, and those wrappers delegate to `aie` commands. | Desired |
| FR-02-010 | Windows support is limited to normal npm/Node command compatibility in v1; no PowerShell-specific duplicate implementation is required. | Required |
| FR-02-011 | The CLI accepts issue numbers with or without a leading `#` when the shell passes the token through. Documentation examples prefer bare numbers because unquoted `#93` can be interpreted as a shell comment. | Required |
| FR-02-012 | Executor is compatible with strict supply-chain safety policies: no `preinstall`, `install`, or `postinstall` lifecycle scripts are required for normal package use. | Required |
| FR-02-013 | Executor documentation shows supply-chain-safe installation patterns that use exact versions, checked-in lockfiles, and lifecycle scripts disabled where the package manager supports it. | Required |
| FR-02-014 | Executor does not document floating `latest` installs as the preferred path. Examples use pinned package versions or repository lockfile workflows. | Required |
| FR-02-015 | Executor minimizes runtime dependencies and justifies any dependency added for CLI UX, GitHub integration, formatting, prompts, or config parsing. | Required |
| FR-02-016 | Generated build output such as compiled JavaScript, declaration files, declaration maps, and source maps is not committed to the source repository. Source files are the source of truth; build output is produced by the build or pack step. | Required |
| FR-02-017 | Package scripts must perform real checks or fail. No script may pass by printing a placeholder, baseline, no-op, or "not configured yet" success message. | Required |

---

## FR-03 - Initialization And Installed Instructions

| ID | Requirement | Status |
|----|-------------|--------|
| FR-03-001 | `aie init .` initializes the current repository for the Executor issue workflow. | Required |
| FR-03-002 | Initialization supports `--tool opencode`, `--tool codex`, `--tool claude-code`, and `--tool all`. | Required |
| FR-03-003 | OpenCode is the first-class and most-tested install target. | Required |
| FR-03-004 | Initialization appends a full Executor section to `AGENTS.md` unless configured otherwise. | Required |
| FR-03-005 | Initialization appends a full Executor section to `CLAUDE.md` when Claude Code support is requested. | Required |
| FR-03-006 | Installed always-loaded instructions include the complete autonomous issue work cycle, todo-list expectations for hosts that support todos, quality gates, review gates, PR shipping authority, and continuation rules. | Required |
| FR-03-007 | Initialization installs `.opencode/commands/make-it-so.md` for OpenCode. | Required |
| FR-03-008 | Initialization may also install `.opencode/commands/makeitso.md` as a convenience alias. | Desired |
| FR-03-009 | The `/make-it-so` command tells the agent to continue the autonomous GitHub issue workflow until the queue is empty or blocked, using concise imperative wording that grants trust, autonomy, and authority within configured repository policy. | Required |
| FR-03-010 | The `/make-it-so` command continues the issue workflow, uses the configured `aie` queue and lifecycle commands, follows installed repository instructions, executes without unnecessary pauses, explicitly authorizes normal git and GitHub shipping actions when autonomous mode is enabled, and ships when gates pass. | Required |
| FR-03-011 | For tools that support project commands, initialization installs equivalent "make it so" commands. For tools without project command support, initialization relies on always-loaded instruction files. | Required |
| FR-03-012 | Initialization gathers or accepts repository policy settings for branch naming, base branch/remote, no-worktree enforcement, open-PR blocking behavior, ignored automation PR authors, component labels, optional GitHub milestone ordering, enabled review agents, manual UI audit behavior, review wait duration, agent-run quality gate commands, and supply-chain safety policy. | Required |
| FR-03-013 | Initialization can run non-interactively using defaults and config flags so agents can bootstrap repositories without a manual prompt when the user requests that mode. | Desired |
| FR-03-014 | Initialization never silently overwrites existing repository instructions or config. It appends managed sections or requires `--force` for replacement. | Required |
| FR-03-015 | Initialization detects legacy copied workflow scripts and old agent instructions, explains what it found, and offers a migration path to the package-backed `aie` commands. | Required |
| FR-03-016 | Installed always-loaded instructions include implementation guardrails: agents must implement only real requested behavior, avoid fake commands/stubs/no-op tests, keep implementation artifacts in product language, avoid milestone/phase/reference leakage, avoid agent-created meta docs, keep generated build output out of commits unless policy allows it, and use issue comments or PRs for durable implementation notes. | Required |
| FR-03-017 | Initialization can make the implementation guardrail instruction block mandatory by default and configurable only through an explicit repository policy choice. | Desired |
| FR-03-018 | Installed always-loaded instructions include supply-chain safety rules for dependency work, package-manager commands, project generators, CI actions/workflows, release automation, IDE tooling, MCP servers, and AI-agent tools. | Required |

---

## FR-04 - Repository Configuration

| ID | Requirement | Status |
|----|-------------|--------|
| FR-04-001 | Executor stores repository-specific workflow policy in a versioned config file, defaulting to `aie.config.json` or an equivalent documented path. | Required |
| FR-04-002 | Configuration includes priority labels, status labels, component labels, optional GitHub milestone ordering policy, branch naming policy, base branch/remote, no-worktree enforcement, open-PR blocking behavior, ignored automation PR authors, enabled review agents, review wait duration, manual UI audit policy, agent-run quality gate commands, and supply-chain safety policy. | Required |
| FR-04-003 | Priority labels are fixed by default to `P1-Critical`, `P2-High`, `P3-Medium`, and `P4-Low`. | Required |
| FR-04-004 | Status labels are fixed by default to `S-Ready`, `S-InProgress`, `S-Blocked`, and `S-Blocking`. | Required |
| FR-04-005 | Component labels include broad defaults: `C-Architecture`, `C-Backend`, `C-Frontend`, `C-Testing`, `C-Tooling`, `C-Docs`, `C-DevEx`, `C-CI`, `C-Security`, and `C-Data`. | Required |
| FR-04-006 | Component labels can be extended per repository during initialization and later config edits. | Required |
| FR-04-007 | Executor validates configuration and reports unknown labels, missing status labels, unsupported review agents, invalid wait durations, and unsafe branch patterns. | Required |
| FR-04-008 | Executor provides `aie doctor` to verify runtime tools, GitHub authentication, repository remote state, labels, config, installed commands, and instruction sections. | Required |
| FR-04-009 | Executor supports a dry-run mode for commands that mutate GitHub labels, issues, PRs, branches, or local files. | Required |
| FR-04-010 | Executor provides `aie labels setup` to create or update the required priority, status, and component labels in GitHub. | Required |
| FR-04-011 | `aie labels setup` is idempotent: existing labels are updated to the configured color and description, missing labels are created, and unrelated labels are left alone. | Required |
| FR-04-012 | Executor provides `aie repo prime` or an equivalent command that prepares a repository for issue execution when Bootstrap has not been run yet. | Required |
| FR-04-013 | Repository priming verifies GitHub CLI auth, creates required labels, checks whether issues exist, checks whether installed instructions exist, writes minimal Executor config, and reports missing planning artifacts without generating specs or milestones. | Required |
| FR-04-014 | Repository priming can create only the Executor-owned scaffolding needed to work existing issues; it must not take over Bootstrap responsibilities such as creating the functional spec, milestone docs, or issue batches from a spec. | Required |
| FR-04-015 | Repository priming can optionally create a small seed issue only when explicitly requested by the user or a non-interactive flag. | Desired |
| FR-04-016 | Default git policy disables linked git worktrees for Executor issue execution. Executor commands must not create, enter, or rely on git worktrees in v1. | Required |
| FR-04-017 | Default pre-start policy blocks starting a new issue when open pull requests exist, except PRs authored by configured automation accounts such as dependency-update bots. | Required |
| FR-04-018 | Default base-branch policy requires the local base branch to match the configured remote base branch before starting a new issue. The default remote/base pair is `origin` and `main` unless repository detection or config says otherwise. | Required |
| FR-04-019 | When GitHub milestone ordering is enabled, configuration can define the milestone title order or title-number parsing policy used as an ordering hint. Milestones are optional organization metadata and never replace status labels or blocker metadata. | Desired |

## FR-05 - GitHub Queue Semantics

| ID | Requirement | Status |
|----|-------------|--------|
| FR-05-001 | Executor uses GitHub issues as the executable work queue. | Required |
| FR-05-002 | `aie queue` displays the live ordered queue in human-readable form. | Required |
| FR-05-003 | `aie queue --json` emits machine-readable queue data for agents and for Umpire integration. | Required |
| FR-05-004 | `aie next --json` or an equivalent command returns the issue Executor would resume or start next. | Required |
| FR-05-005 | Queue selection always resumes an open `S-InProgress` issue before selecting a new `S-Ready` issue. | Required |
| FR-05-006 | Executor enforces that only one open issue is `S-InProgress` at a time unless a force option is explicitly used. | Required |
| FR-05-007 | Executor treats issue body lines matching `Blocked by: #123` as blocker metadata. | Required |
| FR-05-008 | Executor computes effective blocked state from live GitHub issue status, not only from stale labels. | Required |
| FR-05-009 | Queue ordering supports explicit `Sequence:` metadata in issue bodies. | Required |
| FR-05-010 | Queue ordering supports task numbering in issue titles, such as `M34.2.15: ...`, `AM7.3.2: ...`, or equivalent project prefixes. | Required |
| FR-05-011 | Queue ordering sorts by effective status, priority, explicit sequence metadata, configured GitHub milestone order when enabled, title-derived task numbering, and issue number as the final tie-breaker. | Required |
| FR-05-012 | Executor provides a label sync command that reconciles `S-Ready`, `S-Blocked`, and `S-Blocking` labels from the live blocker graph. | Required |
| FR-05-013 | Executor can explain why an issue is blocked and list the open blockers that must close before it can start. | Required |
| FR-05-014 | Executor reads the GitHub milestone field for issues and includes milestone title, milestone state, due date when available, and milestone progress counts in queue data when returned by GitHub. | Desired |
| FR-05-015 | GitHub milestones are an optional organization and progress dimension. Executor must not require milestones for issue execution, and missing milestones must not block `aie next`, `aie start`, or `aie complete` unless repository policy explicitly requires milestone assignment. | Required |
| FR-05-016 | When configured milestone ordering is enabled, `aie queue` and `aie next` use milestone order as a batch-level ordering hint after priority and explicit `Sequence:` metadata, while still respecting effective status and open blockers first. | Desired |
| FR-05-017 | `aie queue` can group or summarize issues by GitHub milestone in human output, and `aie queue --json` exposes milestone grouping/progress without requiring agents to scrape human text. | Desired |
| FR-05-018 | `aie doctor` can report milestone-ordering configuration problems such as unknown configured milestone names, issues missing milestones when policy requires them, duplicate milestone order keys, and milestone assignment drift. | Desired |
| FR-05-019 | Repository priming may report existing GitHub milestones and missing milestone assignments, but must not create milestones or generate milestone plans. Bootstrap owns milestone creation and planning. | Required |

---

## FR-06 - Issue Lifecycle Commands

| ID | Requirement | Status |
|----|-------------|--------|
| FR-06-001 | `aie start next` resumes the existing in-progress issue if one exists; otherwise it starts the highest-priority eligible issue. | Required |
| FR-06-002 | `aie start <issue>` starts a specific issue only after checking open blockers and existing in-progress issues. | Required |
| FR-06-003 | Starting an issue removes ready/blocked status labels as needed, adds `S-InProgress`, and optionally assigns the issue to the authenticated GitHub user. | Required |
| FR-06-004 | Starting an issue can add a standard "started work" issue comment when enabled by repository policy. | Required |
| FR-06-005 | `aie view <issue>` displays issue title, body, labels, milestone, blockers, blocking issues, acceptance criteria, and recommended next action. | Required |
| FR-06-006 | `aie switch <issue>` intentionally moves work from one issue to another while preserving correct ready/blocked state on the paused issue. | Required |
| FR-06-007 | `aie complete <issue>` runs after the PR is merged, closes or marks the issue complete as needed, updates status labels, and unblocks dependent issues whose remaining blockers are all closed. | Required |
| FR-06-008 | `aie complete <issue>` is required even when the PR body includes `Closes #<issue>`, because Executor must perform unblocking and queue maintenance. | Required |
| FR-06-009 | Lifecycle commands support `--check-only` or `--dry-run` modes where mutation would be risky. | Required |
| FR-06-010 | Lifecycle commands emit structured JSON when requested so agents and Umpire can make deterministic decisions. | Required |
| FR-06-011 | Executor provides dependency inspection helpers equivalent to the mature script workflows: direct blockers, issues blocked by a given issue, dependency chains, all blocked open issues, ready issues in queue order, and dependency graph output. | Required |
| FR-06-012 | Executor provides `aie deps blockers <issue>`, `aie deps blocking <issue>`, `aie deps chain <issue>`, `aie deps ready`, `aie deps blocked`, `aie deps graph`, and `aie deps fix --dry-run`. | Required |
| FR-06-013 | `aie deps fix` synchronizes stale `S-Ready` and `S-Blocked` labels from the live blocker graph without changing `S-InProgress` issues. | Required |
| FR-06-014 | Executor provides helper commands to add and remove blocker metadata from issue bodies while preserving unrelated issue text. | Desired |
| FR-06-015 | Dependency helper output references the source issue titles and open/closed states so agents can decide whether to start, unblock, switch, or stop. | Required |
| FR-06-016 | Before transitioning any not-yet-in-progress issue to `S-InProgress`, Executor verifies the pre-start git/PR policy: no linked worktree, no blocking open PRs, and local base branch matches the configured remote base branch. | Required |
| FR-06-017 | Pre-start git/PR policy is not required when `aie start next` resumes the single existing `S-InProgress` issue, because resuming active work may occur on that issue branch. | Required |
| FR-06-018 | If pre-start git/PR policy fails, lifecycle commands do not mutate issue labels, assignment, comments, or branches; they report blocking PRs, branch freshness details, or worktree state with actionable next commands. | Required |
| FR-06-019 | `aie complete <issue>` reports remaining open issues in the completed issue's GitHub milestone and recommends the next queue command or next milestone context when milestone ordering is enabled. | Desired |

---

## FR-07 - Branch And Git Policy

| ID | Requirement | Status |
|----|-------------|--------|
| FR-07-001 | Executor initialization asks for or accepts a default branch naming policy. | Required |
| FR-07-002 | The default branch naming policy creates issue-coupled branches using the issue number and a short slug, for example `issue/93-short-title`. | Required |
| FR-07-003 | Executor can suggest or create the branch for an issue according to repository policy. | Required |
| FR-07-004 | Context-sensitive git actions during implementation, such as staging exact files, writing commit messages, pushing, creating PRs, merging, and pulling the configured base branch, are performed by the agent following installed instructions rather than hidden automation that cannot inspect the code state. | Required |
| FR-07-005 | Executor instructions explicitly authorize agents to commit, push, create PRs, wait for configured review gates, merge, complete issues, pull the configured base branch, and continue to the next issue when repository policy enables autonomous mode. | Required |
| FR-07-006 | Executor commands never run destructive git operations such as hard reset unless the user or repository policy explicitly permits them. | Required |
| FR-07-007 | Executor can verify that the current branch matches the active issue before shipping. | Required |
| FR-07-008 | Executor issue execution does not use linked git worktrees in v1. Lifecycle and branch commands detect linked worktrees and refuse to start new issue work from them. | Required |
| FR-07-009 | Executor can verify that the configured local base branch is checked out where required, has no unsafe uncommitted work, and matches the configured remote base branch before new issue work begins. | Required |
| FR-07-010 | Executor can list open repository pull requests and classify configured automation-authored PRs as ignored for the pre-start blocker check while treating all other open PRs as blockers. | Required |

---

## FR-08 - Autonomous Work Cycle

| ID | Requirement | Status |
|----|-------------|--------|
| FR-08-001 | Executor defines one end-to-end work cycle: queue inspection, issue start or resume, pre-start git/PR policy check for new work, branch check, implementation, manual audit when applicable, review-agent check, test gates, optional Quality Control gate, PR creation, PR review wait, PR feedback handling, merge, issue completion, base branch update, and next issue bootstrap. | Required |
| FR-08-002 | The `/make-it-so` command starts or resumes this work cycle and instructs the agent to keep going until no ready work remains or the queue is blocked. | Required |
| FR-08-003 | The installed instructions tell agents not to ask questions or pause for confirmations at normal decision, implementation, PR, review, merge, issue-completion, or continuation steps when autonomous mode is enabled and repository policy is satisfied. | Required |
| FR-08-004 | The installed instructions require agents to maintain visible local todo state when the host supports todo tools, use those todo tools directly from the main agent instead of delegating todo operations to subagents, and keep at most one local todo item in progress. | Required |
| FR-08-005 | The installed todo pattern includes issue read, implementation, manual UI audit when relevant, review-agent QA, test gates, PR review wait, branch check, ship, and next issue bootstrap; protected workflow todo ids include `branch-check`, `ship`, `pr-review-wait` when configured, and `next`. | Required |
| FR-08-006 | The installed continuation pattern prevents agents from reaching zero pending todos before the next issue is bootstrapped or the queue is confirmed empty; the `next` todo remains pending until new issue todos have been created or the queue is confirmed empty/blocked. | Required |
| FR-08-007 | If a review, audit, test, or PR gate fails, the work cycle loops back to implementation and reruns the relevant gates. | Required |
| FR-08-008 | If the queue is empty or every issue is blocked, the work cycle reports that state and stops cleanly. | Required |
| FR-08-009 | The work cycle is generic across repositories and avoids product-specific names from source reference projects in installed default instructions. | Required |
| FR-08-010 | Before bootstrapping the next new issue after a merge, the work cycle requires the agent to complete the current issue with `aie complete <issue>`, return to the configured base branch, pull the latest remote base branch, verify no blocking open PRs remain, and only then start new work. | Required |
| FR-08-011 | If blocking open PRs remain, the local checkout is a linked worktree, or the base branch is not current with the configured remote, the work cycle stops and reports the exact blocker instead of starting a new issue. | Required |

---

## FR-09 - Quality Gates And Manual Audits

| ID | Requirement | Status |
|----|-------------|--------|
| FR-09-001 | Executor supports storing, validating, and rendering repository-configured agent-run build, unit test, integration test, E2E test, lint, typecheck, and custom verification commands. | Required |
| FR-09-002 | Executor instructions require agents to run all configured gates and confirm they pass before PR creation or merge. | Required |
| FR-09-003 | Manual UI audit is enabled by default for repositories with UI or UX work and can be disabled during initialization or config edits. | Required |
| FR-09-004 | Manual UI audit instructions prefer Vercel `agent-browser` for token-efficient UI inspection when available. | Required |
| FR-09-005 | Playwright or other browser automation may be used as a fallback when `agent-browser` is unavailable or insufficient. | Required |
| FR-09-006 | Manual UI audit evidence must be real and based on a running application, not fabricated or inferred. | Required |
| FR-09-007 | Executor supports a configurable review-agent gate before tests or before shipping. | Required |
| FR-09-008 | The default review-agent gate supports the OpenCode/Oh-My-OpenAgents `@oracle` pattern when available. | Required |
| FR-09-009 | Executor may provide a fallback Oracle-style reviewer prompt or skill for repositories that do not have Oh-My-OpenAgents installed. | Desired |
| FR-09-010 | Executor can configure and render `aiq` as an additional agent-run quality gate when `@tjalve/aiq` is installed and enabled. | Desired |
| FR-09-011 | Executor reports which gates are configured, which gates the agent has recorded or reported as run, and which gates are still pending in command output or PR body templates. | Desired |

---

## FR-10 - Pull Request Review And Shipping

| ID | Requirement | Status |
|----|-------------|--------|
| FR-10-001 | Executor supports optional PR review agents: GitHub Copilot, Cubic, CodeRabbit, and custom PR comment reviewers. | Required |
| FR-10-002 | PR review agents are strongly recommended but not hard dependencies. | Required |
| FR-10-003 | Initialization lets the user choose which PR review agents are enabled for the repository. | Required |
| FR-10-004 | Initialization lets the user configure custom reviewer names and PR comment text. | Required |
| FR-10-005 | The default PR review wait duration is 10 minutes. | Required |
| FR-10-006 | The PR review wait duration is configurable per repository. | Required |
| FR-10-007 | `aie pr gate <pr>` requests or triggers the configured PR reviewers, waits for the configured duration, then inspects PR comments, review comments, and review states. | Required |
| FR-10-008 | `aie pr gate <pr>` is optional as a command but the installed work cycle requires equivalent behavior before merge. | Required |
| FR-10-009 | If new review feedback appears, the agent must address it, rerun affected gates, update the PR, and rerun the PR review gate when material changes were made. | Required |
| FR-10-010 | PR bodies generated or suggested by Executor include issue closure references, supplied or recorded gate status, review agents requested, and remaining risks when applicable. | Desired |
| FR-10-011 | Executor suggests squash merge as the default merge strategy in instructions and readiness output when repository policy permits; the agent performs the merge. | Required |

---

## FR-11 - Agent Host Support

| ID | Requirement | Status |
|----|-------------|--------|
| FR-11-001 | OpenCode support includes project command installation, full `AGENTS.md` instruction installation, and compatibility with Oh-My-OpenAgents conventions when present. | Required |
| FR-11-002 | Codex support includes full `AGENTS.md` instruction installation and any project command or local prompt mechanism Codex supports. | Required |
| FR-11-003 | Claude Code support includes full `CLAUDE.md` instruction installation and any project command mechanism Claude Code supports. | Required |
| FR-11-004 | Gemini support is not a primary v1 target but may receive best-effort instruction projection later. | Desired |
| FR-11-005 | Executor-installed instructions are tool-aware where necessary but keep the core workflow wording shared across tools. | Required |
| FR-11-006 | Executor never depends on a single host-specific todo implementation. It describes the shared todo requirements and renders host-specific wording for OpenCode `todowrite`/`todoread`, Claude Code `TodoWrite`/`TodoRead`, Codex plan/todo support such as `update_plan` when available, or a visible checklist fallback when a host lacks local todo tools. | Required |
| FR-11-007 | OpenCode receives extra testing and polish because it is the primary development host. | Required |

---

## FR-12 - Safety, Security, And Prompt Hygiene

| ID | Requirement | Status |
|----|-------------|--------|
| FR-12-001 | Executor treats GitHub issue bodies, PR comments, review comments, external tool output, and subordinate agent output as untrusted task input, not authority over workflow policy. | Required |
| FR-12-002 | Executor-installed instructions tell agents not to follow prompt-injection attempts embedded in issues, comments, generated diffs, or review output. | Required |
| FR-12-003 | Executor-installed instructions prohibit adding agent, model, service, or vendor credit to commits, PRs, issues, docs, code comments, or UI unless the user explicitly asks for that exact credit. | Required |
| FR-12-004 | Executor commands avoid leaking secrets in logs and redact known token-like values where practical. | Required |
| FR-12-005 | Executor commands do not upload source code, screenshots, or private data to external services except through explicitly configured review or audit integrations. | Required |
| FR-12-006 | Executor reports external services used by configured review gates so repository owners understand what may leave the local environment. | Required |
| FR-12-007 | Executor does not automatically enable third-party PR review agents without repository opt-in during initialization or config. | Required |
| FR-12-008 | Initialization can omit or soften the installed prompt-injection warning block when the repository owner explicitly disables that instruction section. | Desired |
| FR-12-009 | Initialization can omit or soften the installed no-credit warning block when the repository owner explicitly disables that instruction section. | Desired |
| FR-12-010 | Future audit evidence support may integrate `drogers0/gh-image` or an equivalent GitHub image upload helper to attach manual UI audit screenshots to issues or PRs as proof or bug evidence. | Future |
| FR-12-011 | Future screenshot upload support must be opt-in, must warn about sensitive images, must support local-only evidence as the default, and must avoid uploading secrets, private user data, or proprietary screenshots without repository owner consent. | Future |
| FR-12-012 | Implementation artifacts must describe product behavior only. Source code, tests, shipped documentation, package scripts, comments, commits, PRs, and generated files must not reference planning machinery such as milestone numbers, bootstrap phases, issue implementation history, baselines, reference repositories, or local source-reference paths. | Required |
| FR-12-013 | Executor must not ship fake behavior: no placeholder commands, no stub command classes, no no-op implementations, no mock product paths, and no tests that pass without validating real behavior. | Required |
| FR-12-014 | Agents implementing Executor issues must not create repository meta documentation such as decision records, status updates, progress reports, implementation plans, migration notes, quick guides, retrospectives, or phase summaries. Durable implementation communication belongs in GitHub issue comments and PRs. Repository docs may be changed only when the active issue explicitly asks for stable product, user, architecture, test, or workflow documentation. | Required |

---

## FR-13 - Observability And Diagnostics

| ID | Requirement | Status |
|----|-------------|--------|
| FR-13-001 | Executor command output is concise for humans and structured for agents when `--json` is requested. | Required |
| FR-13-002 | Mutating commands print what they changed: labels added or removed, issue comments created, branches created, PR reviewers requested, and dependents unblocked. | Required |
| FR-13-003 | Commands fail with actionable messages when GitHub authentication is missing, labels do not exist, blockers are open, config is invalid, or repository state is unsafe. | Required |
| FR-13-004 | `aie doctor` reports install health and recommended fixes without mutating state unless explicitly told to fix. | Required |
| FR-13-005 | Executor can emit debug logs for troubleshooting while keeping normal output clean. | Desired |
| FR-13-006 | Executor exposes package asset paths and installed configuration paths for debugging and tests. | Desired |

---

## FR-14 - Migration From Script-Based Repositories

| ID | Requirement | Status |
|----|-------------|--------|
| FR-14-001 | Executor can initialize repositories that previously used copied legacy shell helpers for issue execution. | Required |
| FR-14-002 | Executor provides migration mappings from legacy queue, start, switch, view, dependency, completion, and PR-gate helper commands to the corresponding `aie` commands. | Required |
| FR-14-003 | Executor can optionally install compatibility wrappers for existing agent instructions that still call legacy helper paths. | Desired |
| FR-14-004 | Executor migration preserves existing queue labels, blocker metadata, sequence metadata, GitHub milestone assignments, issue state, and branch state. | Required |
| FR-14-005 | Executor does not require repositories to keep copied script implementations after migration. | Required |
| FR-14-006 | Executor provides `aie migrate legacy` or an equivalent command that audits copied scripts, old workflow docs, old project commands, and old agent instruction blocks before changing anything. | Required |
| FR-14-007 | Legacy migration has a dry-run mode that shows files to remove, files to preserve, instruction blocks to replace, and compatibility wrappers to install. | Required |
| FR-14-008 | `aie init` detects legacy repositories and asks whether to leave legacy files untouched, install compatibility wrappers, or clean up and replace them with package-backed Executor instructions. | Required |
| FR-14-009 | Legacy cleanup never deletes project-specific scripts or docs unless they match known workflow helper fingerprints or the user explicitly confirms the paths. | Required |
| FR-14-010 | Legacy cleanup updates old helper-command references in installed agent instructions to the corresponding `aie` commands. | Required |

---

## FR-15 - CLI UX Standards

These requirements define the user-facing behavior of the Executor CLI. They do not prescribe the implementation library.

| ID | Requirement | Status |
|----|-------------|--------|
| FR-15-001 | Executor uses one consistent CLI UX style across commands: clear help text, predictable subcommands, stable exit codes, concise human output, and JSON output for agents. | Required |
| FR-15-002 | Every command provides `--help`; Executor also supports canonical explicit help as `aie help <command-or-topic...>` and exploratory suffix help as `aie <command-or-topic...> help`, for example `aie help init` and `aie init help`. Command help includes purpose, usage, arguments, options, examples, and whether the command mutates local files, git state, or GitHub state. Help invocations are always non-mutating and must not treat `help` as a positional argument to a mutating command. | Required |
| FR-15-003 | Commands that mutate local files, git state, or GitHub state support `--dry-run` unless dry-run is impossible for a documented reason. | Required |
| FR-15-004 | Commands that are useful to agents support `--json` with a stable schema and no decorative output. | Required |
| FR-15-005 | Human-readable output is concise, action-oriented, and names the exact issue, PR, branch, label, config file, or instruction file affected. | Required |
| FR-15-006 | Interactive initialization questions have equivalent flags or config values so `aie init` can run non-interactively. | Required |
| FR-15-007 | Interactive prompts never appear when `--json`, `--yes`, `--defaults`, or a non-interactive environment is active. | Required |
| FR-15-008 | Color and terminal decoration are disabled automatically when stdout is not a TTY, when `--json` is requested, or when standard no-color environment variables are set. | Required |
| FR-15-009 | Error messages include the failed operation, the likely cause, and the next command or config change the user or agent should try. | Required |
| FR-15-010 | Command names remain short and consistent with the package role, for example `aie start next`, `aie complete 93`, `aie queue`, `aie deps blockers 93`, and `aie pr gate 12`. | Required |
| FR-15-011 | Running `aie` with no arguments shows a concise landing page with the most common next commands and exploration paths instead of a raw parser dump. | Required |
| FR-15-012 | Running an incomplete command group, such as `aie labels`, `aie deps`, `aie start`, or `aie pr`, shows valid next subcommands, examples, mutation warnings where relevant, and the standardized help forms for exploring deeper command help. | Required |
| FR-15-013 | Unknown commands and misspelled flags provide safe "did you mean" suggestions where confidence is high, but Executor never automatically runs a suggested alternative. | Required |
| FR-15-014 | Executor does not accept arbitrary command-prefix abbreviations because they create long-term compatibility traps. Short aliases are allowed only when explicit, documented, tested, and stable. | Required |
| FR-15-015 | Executor provides `aie schema --json` or an equivalent command that emits a machine-readable description of implemented commands, arguments, flags, examples, mutation behavior, dry-run support, structured output support, stable error kinds, and exit codes. | Required |
| FR-15-016 | Agents and automation are expected to use structured output and schema introspection rather than scraping human help text. | Required |
| FR-15-017 | Executor keeps data on stdout and warnings, progress, hints, and diagnostics on stderr, especially in structured output mode. | Required |
| FR-15-018 | Executor does not require shell completion for v1. Package installation and initialization must never modify shell profiles, shell startup files, editor configuration, or terminal completion paths. | Required |
| FR-15-019 | Human help, agent schema output, docs generation, mutation labels, dry-run labels, and CLI tests are derived from shared command metadata so they do not drift. | Required |
| FR-15-020 | Interactive prompts and rich terminal formatting are used only when a TTY is available and always have flag, config, or non-interactive equivalents. | Required |
| FR-15-021 | A command is present in the executable CLI only when the active issue delivers real behavior for that command. Issue bodies must not ask agents to add commands outside their scope, and Executor must not contain executable placeholders, reserved command classes, or "not implemented yet" runtime paths. | Required |

---

## FR-16 - Supply Chain Safety

Executor does not replace package-manager controls, vulnerability scanners, registry intelligence, repository rules, or human security review. It must, however, make supply-chain-safe behavior part of the installed agent workflow so repositories do not depend on a separate local skill being present.

| ID | Requirement | Status |
|----|-------------|--------|
| FR-16-001 | Executor-installed instructions treat dependency additions, dependency updates, package-manager commands, project generators, CI actions/workflows, release automation, IDE/editor extensions, MCP servers, AI-agent tools, one-line installers, Git URL dependencies, tarballs, and binary downloads as code execution requiring supply-chain review. | Required |
| FR-16-002 | Instructions tell agents to prefer standard library APIs, existing dependencies, or in-repository code before adding a dependency. | Required |
| FR-16-003 | Instructions prohibit `latest`, floating semver ranges for new dependencies, unpinned Git branches, unverified tarballs, and curl-pipe-shell style installers unless the user explicitly approves the exact risk. | Required |
| FR-16-004 | Instructions require exact dependency versions and intentional lockfile preservation or updates when adding or upgrading dependencies. | Required |
| FR-16-005 | Instructions require lifecycle/build scripts from newly introduced packages to be disabled by default with package-manager-supported flags such as `--ignore-scripts`, unless the package is already trusted and the executing scripts have been reviewed. | Required |
| FR-16-006 | Instructions require a conservative package-age gate before adding or upgrading dependencies: at least 7 full days since publication/release by default, and 14 days for high-risk runtime, build, CI/CD, auth, crypto, networking, installer, postinstall, native, binary, or transitive-heavy packages. | Required |
| FR-16-007 | If package age, source identity, provenance, integrity, or execution risk cannot be verified, instructions require the agent to stop and ask for explicit user approval or choose an older verified version. | Required |
| FR-16-008 | Instructions require dependency intake notes in issue comments or PRs when dependencies or dependency-provided tooling change: need, exact package/source/version, lockfile impact, age, source trust, execution risk, integrity signal, and dependency scope. | Required |
| FR-16-009 | Instructions require CI actions and reusable workflows to be treated as dependencies, with third-party actions pinned to immutable full-length commit SHAs where the platform supports it. | Required |
| FR-16-010 | Instructions require existing-project installs to prefer frozen or locked commands with lifecycle scripts disabled where supported, and to avoid broad upgrade commands unless dependency updates are the explicit task. | Required |
| FR-16-011 | Initialization captures supply-chain policy settings, including package-age thresholds, lifecycle-script default, exact-version preference, lockfile behavior, CI action pinning preference, and whether project-level package-manager secure defaults may be written. | Required |
| FR-16-012 | Executor may offer project-level secure default files such as `.npmrc` only during explicit init/migration actions or with explicit flags. It must never write user-level package-manager, shell, editor, or machine configuration. | Required |
| FR-16-013 | `aie gates plan` marks configured package-manager, generator, CI, MCP, IDE, or agent-tool commands as supply-chain-sensitive and tells agents what review evidence is expected before execution. | Required |
| FR-16-014 | `aie doctor` reports supply-chain policy status, detected package managers and lockfiles, package lifecycle-script default visibility where practical, third-party CI action pinning visibility where practical, and recommended next commands without mutating. | Required |
| FR-16-015 | When the user names a suspected supply-chain attack, compromised package, malware campaign, or suspicious dependency, installed instructions tell agents to fetch current advisories, compare manifests and lockfiles against exact package names/versions/tarballs/Git URLs/integrity hashes, stop installs/builds if exposure is possible, preserve evidence, and recommend token/credential rotation before resuming. | Required |
| FR-16-016 | Executor must not maintain a stale embedded advisory list or claim a dependency is safe from package age or provenance alone. Advisory checks must use current external sources when needed. | Required |
