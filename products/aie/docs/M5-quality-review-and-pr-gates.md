# M5 - Quality, Review, And PR Gates

## Strategic Goal

M5 turns the gate obligations captured by M4 into usable Executor guidance, status commands, and host instructions.

M1 created the package and CLI foundation. M2 added GitHub queue, labels, priority, and dependencies. M3 added issue lifecycle and branch commands. M4 installed always-loaded instructions, host projections, the protected todo pattern, and `/make-it-so`. M5 fills the remaining gate machinery that makes autonomous shipping credible: configured verification guidance, manual UI audit helpers, review-agent prompts, optional Quality Control gate guidance, PR review requests, PR review waiting, PR feedback inspection, and PR body/shipping support.

This milestone implements the first complete gate coordination layer. It does not turn Executor into a test runner, CI system, browser automation framework, review-agent runtime, package-manager runner, or static-analysis engine. Executor coordinates repository policy and gives agents reliable plans, prompts, evidence rules, PR review state, and next actions. The agent performs context-sensitive implementation, package work, tests, builds, audits, `aiq`, review interpretation, PR creation, merge judgment, and follow-up fixes under the installed instructions.

After M5, a developer or agent should be able to run:

- `aie gates plan`
- `aie gates plan --stage pre-pr --json`
- `aie gates status`
- `aie audit ui 93`
- `aie audit ui 93 --prepare`
- `aie review gate 93`
- `aie review gate 93 --prompt`
- `aie pr body 93`
- `aie pr gate 12`
- `aie pr gate 12 --dry-run`
- `aie doctor`

M5 delivers six things:

1. **Configured gate guidance** - deterministic rendering of configured build, lint, typecheck, unit, integration, E2E, custom, and optional `aiq` gates for agents to run.
2. **Manual UI audit helper** - agent-browser-first audit planning, local evidence paths, evidence checks, and no-fabrication rules for agent-run UI/UX audits.
3. **Review-agent gate guidance** - host-aware Oracle-style review prompt generation, configured reviewer support, fallback reviewer assets, and evidence/result handling.
4. **PR review gate** - `aie pr gate <pr>` to request configured PR reviewers, wait the configured duration, inspect PR review/comment state, and report required follow-up.
5. **PR body and shipping readiness support** - PR body generation and merge-readiness output that reflects supplied or recorded gate status, reviewers requested, issue closure, and remaining risks.
6. **Diagnostics and metadata** - doctor checks, schema, help metadata, JSON output, and tests for all M5 gate surfaces.

The important success condition is that `/make-it-so` gives agents enough authority, guidance, and deterministic PR review support to move through configured gates and PR review without needing the user to restate permission or workflow details, while still preventing fabricated audits, hidden external uploads, unsafe reviewer defaults, and accidental claims that `aie` did work the agent must actually perform.

---

## Functional Requirements Addressed

M5 is the primary implementation foundation for:

- **FR-09-001 through FR-09-011** - configured agent-run quality gates, manual UI audit policy, agent-browser preference, real evidence, review-agent gates, Oracle support, optional `aiq` guidance, and gate result reporting.
- **FR-10-001 through FR-10-011** - PR review agents, configurable reviewers, configurable wait duration, `aie pr gate`, feedback loop, PR body support, and squash-merge readiness guidance.
- **FR-12-004 through FR-12-007** - secret redaction, explicit external-service reporting, no unconfigured uploads, and no automatic third-party PR reviewer enablement.

M5 also extends:

- **FR-01-001, FR-01-006, and FR-01-007** - issue execution coordination through gate guidance, optional Quality Control gate configuration, and confident shipping permissions.
- **FR-03-006 and FR-03-010** - installed work-cycle instructions can now name actual guidance/status commands where implemented.
- **FR-08-001 through FR-08-011** - gate failure loops, PR review waits, feedback handling, merge readiness, issue completion, base update, and next issue bootstrap.
- **FR-11-001 through FR-11-007** - OpenCode, Codex, and Claude Code host wording for review-agent prompts and gate todos.
- **FR-13-001 through FR-13-006** - concise human output, structured JSON, actionable errors, doctor, debug logs, and asset/config path visibility.
- **FR-15-001 through FR-15-020** - CLI explorability, help forms, schema, help metadata, stdout/stderr separation, mutation labels, dry-run behavior, and shared command metadata for all M5 commands.

M5 intentionally does not complete:

- Bootstrap-owned spec, milestone, or issue generation.
- Quality Control's static-analysis engine. Executor may render and track an `aiq` gate when enabled; the agent runs `aiq`.
- Umpire-owned long-running scheduling, wakeups, or stop hooks.
- Fully automated generic browser interaction. Executor provides audit helpers and evidence rules; the agent drives the app.
- Automatic screenshot uploads. Future `gh-image` or equivalent support remains future and must be opt-in.
- Legacy cleanup, compatibility wrappers, and migration. Those are M6.
- QUBE wrapper command aliases.

---

## Specification Inputs

Use [docs/spec.md](spec.md) for exact functional requirement text and earlier milestone docs for implemented CLI, config, queue, lifecycle, branch, init, instruction, and todo contracts. M5 implementation language must describe Executor gate, audit, review, PR, and shipping-readiness behavior only.

---

## Dependencies

M5 depends on:

- **M1 - Package And CLI Foundation**
- **M2 - GitHub Labels, Priority, And Dependencies**
- **M3 - Issue Lifecycle, Branch Policy, And Completion**
- **M4 - Init, Agent Instructions, And Make-It-So**

M5 assumes:

- `aie.config.json` exists and validates.
- `gh` wrapper, redaction, and JSON output foundations exist.
- lifecycle commands can identify active issues and completion state.
- installed instructions can be updated to name M5 commands honestly.
- host projections can render OpenCode, Codex, and Claude Code wording.

M5 must not require:

- live GitHub access in normal unit tests
- installed third-party review services for normal tests
- browser automation binaries for normal unit tests
- `aiq` unless it is explicitly enabled
- screenshot upload tools
- install lifecycle scripts

---

## Shared CLI UX Contract For M5

The CLI research added in M1 applies directly to M5.

Every M5 command must be explorable by a human and deterministic for an agent:

- `aie gates` shows `plan`, `status`, configured stages, examples, and side-effect warnings.
- `aie audit` shows `ui`, evidence rules, local evidence path conventions, and no-upload defaults.
- `aie review` shows review-agent gate commands and configured reviewer behavior.
- `aie pr` shows `body` and `gate`, including reviewer request, wait, and feedback inspection behavior.
- `aie help pr gate`, `aie pr gate help`, and `aie pr gate --help` all show PR gate help without mutation.
- `aie help audit ui`, `aie audit ui help`, and `aie audit ui --help` all show manual audit help without mutation.
- `aie help gates plan`, `aie gates plan help`, and `aie gates plan --help` all show gate-plan help without executing configured commands.
- unknown M5 subcommands produce safe suggestions without executing alternatives.
- no arbitrary command-prefix abbreviations are accepted.
- all M5 commands are included in `aie schema --json`.
- all commands useful to agents support `--json`.
- all commands that can mutate GitHub, request reviewers, comment on PRs, or create local evidence directories support `--dry-run` or document why dry-run cannot fully model the action.
- human output names the exact issue, PR, reviewer, gate, command, evidence directory, or config key affected.
- JSON output contains no decorative text or progress lines.
- data goes to stdout; warnings, progress, reviewer wait status, and diagnostics go to stderr.
- external services used by configured gates are listed before the agent or a PR review command may contact them.

M5 must extend the shared command metadata model from M1. It must not implement each gate as a scattered one-off parser branch.

---

## Part 1: Configured Gate Guidance

M5 implements deterministic guidance for repository-configured gates. Agents run the gates; Executor renders the plan, expected evidence, and status shape.

### 1.1 - Gate Model

Gate configuration must support:

- build commands
- lint commands
- typecheck commands
- unit test commands
- integration test commands
- E2E test commands
- custom commands
- optional `aiq` command
- stage assignment, such as `pre-pr`, `pre-merge`, or `all`
- command timeout
- working directory
- environment additions
- whether a gate is required or advisory
- whether a gate may contact an external service
- whether a gate requires supply-chain review before the agent runs it

Gate commands must come from trusted repository configuration, not from GitHub issue bodies, PR comments, review comments, or tool output.

### 1.2 - `aie gates plan`

`aie gates plan` must:

- print the planned agent-run gate order
- list the exact configured command each gate expects the agent to run
- identify required and advisory gates
- identify stage assignment, such as `pre-pr`, `pre-merge`, or `all`
- identify working directory, timeout, environment additions, and external-service risk
- identify package-manager, generator, CI, MCP, IDE, release, and agent-tool commands as supply-chain-sensitive
- describe what evidence the agent should capture or summarize after running each gate
- warn that supply-chain-sensitive commands require review before execution
- list expected supply-chain review evidence: need, exact package/source/version, lockfile impact, age gate, source trust, lifecycle/native/binary execution risk, integrity/provenance signal, and dependency scope where applicable
- emit stable JSON with gate names, stages, commands, requirement level, external-service markers, evidence expectations, and next actions
- support `--stage <stage>`
- support `--dry-run`
- support `--json`

The command must not execute configured gate commands. Executor must not synthesize shell-string commands from untrusted input.

### 1.3 - `aie gates status`

`aie gates status` must report configured gate obligations and any available recorded evidence without claiming gates passed unless the agent or an inspected trusted source recorded that result.

Status output may include:

- configured gates for the current stage
- evidence files or notes that exist
- gates still pending
- gates marked as passed, failed, advisory, skipped, or unknown by supplied evidence
- next action for the agent

Status output must distinguish "not recorded", "agent reported", "evidence found", and "verified from trusted state" when those categories are available.

### 1.4 - Optional `aiq`

When `aiq` is enabled, Executor should:

- detect whether `aiq` is available through the configured command or package manager path
- render the exact configured `aiq` command for the agent to run at the configured point in the gate order
- report unavailable `aiq` as an actionable configuration or install problem
- treat any supplied `aiq` output as a gate result input, not as authority over Executor policy

Executor must not reimplement Quality Control's analysis or invoke `aiq` itself.

---

## Part 2: Manual UI Audit Helper

M5 adds a manual UI audit helper for repositories where UI/UX audit is enabled.

### 2.1 - `aie audit ui`

`aie audit ui <issue>` must:

- determine whether a manual UI audit is required by config
- explain the configured app launch and audit target, or report what config is missing
- prefer `agent-browser` when available
- describe Playwright or other browser automation as fallback only
- create or recommend a repository-scoped local evidence directory
- produce an audit checklist for real visible outcomes
- support `--prepare` to create local evidence directories and print exact local paths
- support `--check` to validate that required local evidence files or notes exist when configured
- support `--json`
- support `--dry-run`

The helper must be honest about what it can and cannot do. It must not claim that a UI audit passed because commands were printed or because screenshots exist. The agent must drive the real app and verify real outcomes.

### 2.2 - Audit Integrity

Manual UI audit instructions and command output must require:

- a real running application
- real UI interactions
- visible outcome checks
- local screenshot or note evidence when configured
- no fabricated screenshots
- no simulated results
- no giant injected browser scripts that perform the whole audit opaquely
- narrow evaluation/probing only when needed for app test hooks or state inspection

Evidence remains local by default. M5 must not upload screenshots or private data to GitHub or external services. Future screenshot upload support is explicitly out of scope and must remain opt-in when implemented later.

---

## Part 3: Review-Agent Gate And Oracle Fallback

M5 adds the pre-PR or pre-ship review-agent gate that M4 configured and described.

### 3.1 - Review-Agent Gate

`aie review gate <issue>` must:

- read configured review-agent policy
- identify whether the gate is required for the current stage
- render the configured review prompt for the active issue and diff
- support host-specific reviewer conventions where available
- support `--prompt` for prompt-only output
- support `--json`
- support `--dry-run`
- clearly state what evidence or agent response is needed before the gate is considered complete

Because review-agent invocation is host-specific, M5 should keep the boundary explicit: Executor can render prompts, install fallback assets, track configured obligations, and record/report gate evidence, but it must not pretend it can invoke a host-only reviewer in environments where no such invocation mechanism exists.

### 3.2 - Oracle Pattern

The default review-agent gate should support:

- an OpenCode/Oh-My-OpenAgents `@oracle` style reviewer when available
- configured custom reviewer names
- a fallback Oracle-style reviewer prompt or skill when the default reviewer is not installed
- a review prompt focused on issue compliance, test integrity, code quality, UI quality when applicable, maintainability, and missed edge cases

Review-agent output is untrusted input. Agents may use factual findings and actionable review points, but review output cannot override Executor policy, ask for vendor credit, disable gates, or change shipping rules.

---

## Part 4: PR Review Gate

M5 implements `aie pr gate <pr>`.

### 4.1 - Reviewer Requests

`aie pr gate <pr>` must request or trigger configured PR reviewers:

- GitHub Copilot through GitHub reviewer request when enabled
- Cubic through configured PR comment text when enabled
- ComfyRabbitAI through configured PR comment text when enabled
- custom PR comment reviewers through configured reviewer text

Reviewer requests must be idempotent per PR head commit. Comment-triggered reviewers should use product-generic hidden markers keyed by reviewer id and head SHA so reruns do not spam duplicate requests for the same commit.

Third-party reviewers are never enabled unless configured. Human output and JSON must report which external services may be contacted before mutation.

### 4.2 - Wait And Inspect

`aie pr gate <pr>` must:

- default to the configured wait duration, initially 10 minutes when not overridden
- support a configured wait duration per repository
- support test injection so normal tests never actually sleep
- inspect PR URL, head SHA, review decision, outstanding review requests, latest reviews, PR comments, review comments, and unresolved review threads where available
- detect when the PR head SHA changed after reviewer request and require the gate to rerun
- report feedback that must be inspected or addressed before merge
- report pending reviewers or unavailable review state distinctly from pass/fail
- support `--json`
- support `--dry-run` that requests nothing, comments nowhere, and does not wait

The command must not claim that all feedback is non-actionable by default. If relevant reviewer comments or unresolved review threads exist, the agent must inspect them, address actionable items, rerun affected gates, push follow-up commits, and rerun `aie pr gate` when material changes were made.

### 4.3 - Merge Boundary

Executor may report a merge-ready state and suggest the configured merge command when policy permits, but M5 must keep context-sensitive merge execution in the agent's hands. The agent performs the merge after policy, CI, tests, configured gates, and review feedback are satisfied.

Squash merge is the default suggested strategy when repository policy permits it.

---

## Part 5: PR Body And Shipping Readiness

M5 adds PR body and shipping-readiness support so agents do not have to invent the shipping summary.

### 5.1 - `aie pr body`

`aie pr body <issue>` must generate a PR body draft that includes:

- issue closure reference
- short implementation summary slots or detected summary input
- configured gates the agent has recorded or supplied as run
- configured gates still pending
- review agents requested or pending
- manual UI audit status when applicable
- optional `aiq` gate status when enabled
- known remaining risks or follow-up notes when supplied

The command should support `--json` and should not mutate GitHub unless a future explicit update flag is added.

### 5.2 - Shipping Readiness

M5 should provide merge-readiness output through `aie pr gate` and/or `aie pr body` that tells the agent:

- whether configured local gates are recorded as passed, failed, unknown, or still pending
- whether manual audit is required, recorded, or still pending
- whether review-agent QA is required, recorded, or still pending
- whether PR review gate is complete, pending, failed, or must be rerun
- whether the PR head changed after review requests
- what command the agent should run next

This output supports the installed work cycle; it does not replace the agent's code review, CI inspection, or final judgment.

---

## Part 6: Doctor, Schema, Help Metadata, And Tests

M5 extends the diagnostic and metadata surfaces.

### 6.1 - Doctor

`aie doctor` must report:

- configured gates and invalid gate commands
- configured supply-chain policy and gates marked supply-chain-sensitive
- missing `gh` authentication for PR review gates
- configured PR review agents
- configured review wait duration
- external services that configured gates may contact
- `agent-browser` availability when manual UI audit is enabled
- fallback browser automation availability when configured
- `aiq` availability when enabled
- installed review-agent assets or fallback prompts where applicable
- whether screenshot upload support is disabled or unavailable
- recommended next command

`doctor` remains non-mutating.

### 6.2 - Schema And Help Metadata

`aie schema --json` and help metadata must include:

- `aie gates plan`
- `aie gates status`
- gate stage values
- `aie audit ui`
- audit flags
- `aie review gate`
- review-agent flags
- `aie pr body`
- `aie pr gate`
- PR review-agent values
- dry-run support
- structured output support
- stable error kinds
- mutation behavior and external-service markers

### 6.3 - Tests

M5 tests must cover:

- configured gate ordering
- gate plan rendering without command execution
- gate status rendering from supplied evidence fixtures
- gate JSON output
- token redaction in command, config, PR, and evidence-related output
- optional `aiq` unavailable and available paths
- manual UI audit required/disabled behavior
- local evidence path generation
- no-upload default behavior
- review-agent prompt rendering
- Oracle-style default and custom reviewer names
- fallback reviewer asset availability
- PR reviewer request planning
- idempotent PR comment marker logic
- configurable wait duration without real sleeping
- PR head changed after reviewer request
- PR review/comment/thread fixture parsing
- dry-run behavior for mutating PR gate actions
- PR body generation
- doctor, schema, help metadata, and help output

Normal tests must not require live GitHub, live PR reviewers, real browser automation, `agent-browser`, Playwright, or `aiq`.

---

## Proposed GitHub Issues

M5 should become **6 GitHub issues**, not one issue per gate or review service.

### M5.1 - Implement Configured Gate Guidance

Create the gate model plus `aie gates plan` and `aie gates status` commands for configured agent-run build, lint, typecheck, unit, integration, E2E, custom, and optional `aiq` gates.

Primary FRs: FR-09-001, FR-09-002, FR-09-010, FR-09-011, FR-12-004 through FR-12-006, FR-13-001 through FR-13-003, FR-15-001 through FR-15-020, FR-16-001 through FR-16-016.

CLI UX acceptance:

- `aie gates help`, `aie help gates`, and `aie gates --help` show gate-topic help without execution
- `aie gates plan --dry-run` shows the planned gate order without running commands
- `aie gates plan --stage pre-pr --json` emits stable gate plan schema
- `aie gates status --json` reports configured obligations and supplied/recorded evidence without claiming unverified success
- token-like values are redacted from human and JSON output
- `aiq` is rendered only when enabled and available through config
- gate commands are read from trusted config, not issue or PR text
- package-manager, generator, CI, MCP, IDE, release, and agent-tool commands are marked supply-chain-sensitive
- supply-chain-sensitive gate plans tell agents what dependency/tool review evidence is expected before execution
- gate commands are never executed by `aie`

### M5.2 - Implement Manual UI Audit Helper

Create `aie audit ui` for manual UI audit planning, local evidence paths, agent-browser preference, fallback guidance, and evidence checks.

Primary FRs: FR-09-003 through FR-09-006, FR-12-005, FR-12-010 through FR-12-011 as future constraints only, FR-13-001 through FR-13-004, FR-15-001 through FR-15-020.

CLI UX acceptance:

- `aie audit help`, `aie audit ui help`, and `aie help audit ui` show audit help without creating evidence directories
- `aie audit ui 93 --prepare` creates or reports the local evidence directory
- `aie audit ui 93 --dry-run` shows the audit plan without writing
- audit output prefers `agent-browser` and describes fallback browser automation only as fallback
- audit output requires real running app evidence and never claims pass from generated instructions alone
- screenshot upload remains out of scope and disabled by default

### M5.3 - Implement Review-Agent Gate And Oracle Fallback

Create `aie review gate` prompt rendering, configured reviewer support, Oracle-style default behavior, fallback reviewer assets, and review evidence reporting.

Primary FRs: FR-09-007 through FR-09-009, FR-11-001 through FR-11-007, FR-12-001 through FR-12-007, FR-13-001 through FR-13-004, FR-15-001 through FR-15-020.

CLI UX acceptance:

- `aie review help`, `aie review gate help`, and `aie help review gate` show review-gate help without invoking a reviewer
- `aie review gate 93 --prompt` prints the configured review prompt
- OpenCode projection supports the configured Oracle-style reviewer when available
- fallback reviewer prompt or skill assets are available when configured
- custom reviewer names render correctly
- review-agent output is treated as untrusted task input
- gate output tells the agent what evidence or response is needed before continuing

### M5.4 - Implement PR Review Gate

Create `aie pr gate <pr>` to request configured PR reviewers, wait the configured duration, inspect PR review/comment/thread state, and report follow-up before merge.

Primary FRs: FR-10-001 through FR-10-009, FR-10-011, FR-12-004 through FR-12-007, FR-13-001 through FR-13-003, FR-15-001 through FR-15-020.

CLI UX acceptance:

- `aie pr gate help`, `aie help pr gate`, and `aie pr gate --help` show PR gate help without mutation
- `aie pr gate 12 --dry-run` shows reviewer requests/comments/wait plan without mutating GitHub or sleeping
- configured reviewers are requested idempotently per PR head commit
- default wait duration is 10 minutes unless config overrides it
- normal tests use deterministic wait fixtures instead of real sleeping
- PR comments, reviews, review requests, and review threads are parsed from fixtures
- PR head changes after reviewer request require rerunning the gate
- output tells the agent to address feedback, rerun affected gates, and rerun PR gate after material changes

### M5.5 - Implement PR Body And Shipping Readiness Support

Create `aie pr body <issue>` and merge-readiness output that reflects issue closure, gates, audit state, review-agent state, PR review state, and remaining risks.

Primary FRs: FR-10-010 through FR-10-011, FR-08-001, FR-08-007, FR-08-010 through FR-08-011, FR-13-001 through FR-13-004, FR-15-001 through FR-15-020.

CLI UX acceptance:

- `aie pr body help`, `aie help pr body`, and `aie pr body --help` show body help without mutation
- `aie pr body 93` emits a PR body draft with `Closes #93`
- PR body output includes configured gates recorded as run and pending
- PR body output includes manual UI audit status when applicable
- PR body output includes review agents requested or pending
- merge-readiness output recommends the next command rather than silently merging
- squash merge is the default suggested strategy when repository policy permits it

### M5.6 - Implement M5 Doctor, Schema, Help Metadata, And Tests

Extend `aie doctor`, `aie schema --json`, help metadata, fixtures, and tests for all M5 commands and gate states.

Primary FRs: FR-09-001 through FR-09-011, FR-10-001 through FR-10-011, FR-12-004 through FR-12-007, FR-13-001 through FR-13-006, FR-15-001 through FR-15-020, FR-16-011 through FR-16-016.

CLI UX acceptance:

- `aie doctor` reports gate, audit, review-agent, PR review, external-service, `agent-browser`, and `aiq` readiness without mutation
- `aie doctor` reports configured supply-chain policy and supply-chain-sensitive gate readiness without mutation
- `aie schema --json` includes all M5 commands, flags, mutation markers, external-service markers, and stable error kinds
- help metadata includes M5 command groups, flags, stage values, and configured review-agent values
- fixtures cover PR review states without live GitHub
- tests cover help output, dry-run output, JSON schema, redaction, and product-generic generated output
- tests do not require live review services, live browser automation, or real sleeping

---

## Exit Criteria

M5 is complete when:

- `aie gates plan --dry-run`, `aie gates plan --json`, and `aie gates status --json` work against configured gates without executing them.
- optional `aiq` guidance is rendered only when enabled and available.
- `aie audit ui <issue>` produces a real-audit plan, local evidence path, and no-upload default.
- `aie review gate <issue> --prompt` renders configured Oracle-style or custom reviewer prompts.
- fallback reviewer assets are available when configured.
- `aie pr gate <pr> --dry-run` shows reviewer request and wait plans without mutation.
- `aie pr gate <pr>` requests configured reviewers idempotently, waits the configured duration, inspects PR review state, and reports required follow-up.
- `aie pr body <issue>` generates an issue-closing PR body draft with supplied or recorded gate/review/audit status.
- M4 installed instructions can be updated to name the implemented M5 commands honestly.
- `aie doctor` reports M5 gate readiness and external-service exposure without mutating.
- `aie schema --json` and help metadata include M5 command surfaces.
- normal tests pass without live GitHub, browser automation, PR reviewers, `aiq`, executing configured gates, or real sleep.

After M5, Executor has the gate coordination layer needed for autonomous agents to work from issue implementation through review-gated PR shipping. M6 can then focus on legacy cleanup, migration, compatibility wrappers, and any final packaging polish needed before broader adoption.
