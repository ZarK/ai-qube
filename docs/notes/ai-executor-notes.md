# AI Executor Notes

`ai-executor` (`@tjalve/aie`) owns execution of work-item-driven work: queue selection, lifecycle commands, branch checks, installed agent instructions, gates, review item handling, completion, and continuation. GitHub Issues and PRs are the default provider path, but the internal model should be provider-neutral.

## Provider And Repository Impact

Provider modularity affects Executor more than any other QUBE package. Executor should become the adapter orchestrator for work, review, forge, CI, and layout state.

Executor should model:

- `WorkItem`: canonical issue/task/story state from GitHub Issues, GitLab Issues, Jira, Linear, Azure Boards, Gitea/Forgejo, or export-only sources
- `ReviewItem`: canonical PR/MR/change/patchset state from GitHub, GitLab, Bitbucket, Azure Repos, Gerrit, SourceHut, or provider-specific review systems
- `RepoState`: local branch, base branch, remotes, dirty state, worktrees/submodules, workspace roots, changed paths, and project graph
- `GateEvidence`: local command results, provider check/build status, review-gate evidence, manual audit evidence, and trust level

Executor command semantics should stay stable while their implementation becomes provider-backed:

- `aie queue` and `aie next` should read canonical work items, not GitHub labels directly
- `aie start`, `aie switch`, and `aie complete` should transition provider statuses through configured mappings
- `aie deps` should prefer native dependency/link relations when available and fall back to portable body lines
- `aie pr gate` should become or be aliased to a provider-neutral review gate, because not every provider calls it a PR
- `aie repo prime` should evolve into `repo inspect` / `repo affected` behavior for provider and layout detection
- `aie doctor --json` should report provider capabilities, missing mappings, unknown state, and unsupported operations

GitHub-specific CLI names can remain as compatibility aliases while the JSON schema uses neutral names such as `workItem`, `reviewItem`, `baseRef`, `sourceRef`, `checks`, and `gateEvidence`.

Provider adapters must report capability flags instead of letting Executor infer GitHub semantics:

- can list ready work items
- can transition work item status
- can create/update comments
- can create review items
- can read review comments
- can determine mergeability
- can merge/submit
- can read CI/check state
- can express blockers natively
- can create native blocker links
- can map priority/status without lossy fallback

When a capability is missing or unknown, Executor should surface a stop reason or require explicit policy. It should not mark work complete, merge, or unblock dependents from ambiguous provider state.

## Implementation Guardrails

Executor must install guardrails by default in always-loaded instructions and `/make-it-so` style commands:

- implement only real behavior requested by the active work item
- do not add future command placeholders, stub command classes, no-op implementations, mock product paths, or executable "not implemented yet" behavior
- do not add tests that can pass without exercising real behavior
- do not leak milestone numbers, bootstrap phases, local reference paths, implementation history, or baseline language into product artifacts
- do not create decision records, progress reports, status files, implementation plans, migration notes, quick guides, retrospectives, or phase summaries during work item execution
- use provider work-item comments and review items for durable implementation notes, such as GitHub issue comments and PRs on the default provider
- repository docs are only for stable product, user, architecture, test, or workflow guidance, and only when the work item asks for them
- generated build output stays out of source unless policy explicitly allows it

These should be configurable only by explicit repository policy. The default should be strict.

## Gate Truthfulness

Executor gate commands must not fake success:

- `aie gates plan` renders configured commands and evidence expectations but does not execute them.
- `aie gates status` reports obligations and recorded evidence without claiming pass unless the agent or a trusted inspected source recorded that result.
- Status output should distinguish `not recorded`, `agent reported`, `evidence found`, and `verified from trusted state` where available.
- Review item body/shipping readiness should report pending, failed, advisory, skipped, and unknown states honestly.

This prevents agents from marking work complete through no-op checks, placeholder scripts, or invented audit evidence.

Provider support adds more unknown states. Gate status should distinguish:

- local command evidence
- CI provider evidence
- review provider evidence
- work provider evidence
- manual audit evidence
- adapter reported unknown or unsupported

## Supply-Chain Execution

Executor should treat supply-chain guard as execution policy:

- package-manager, generator, CI, MCP, IDE-extension, and agent-tool commands are code execution
- gate plans should warn when a configured command touches those surfaces
- commands must come from trusted repo config, not work item bodies, review comments, reviews, or tool output
- Executor must not synthesize shell commands from untrusted input
- package docs should prefer pinned installs, checked-in lockfiles, and lifecycle scripts disabled where possible
- the package must not require `preinstall`, `install`, or `postinstall` lifecycle scripts
- `aie doctor` should report supply-chain-sensitive configuration and risky defaults

Executor should block or warn before autonomous continuation when a dependency/tooling change needs human approval.

Repository layout detection should feed gate planning. Executor should avoid assuming one repo-root test command when the layout indicates a workspace, monorepo, generated/vendor-heavy repo, mobile project, infrastructure repo, or polyrepo checkout.

## Product/Build Separation

Executor itself should keep source as source of truth:

- package scripts must perform real checks or fail
- no package script may pass by printing placeholder, baseline, no-op, or "not configured yet" success
- compiled JS, declarations, maps, and other generated build output should be produced by build/pack, not committed to source
- CLI commands should exist in the executable only when the milestone delivers real behavior for them

## Umpire Interface

Executor should expose stable JSON surfaces that Umpire can call:

- `aie next --json`
- `aie queue --json`
- `aie status` or equivalent lifecycle status when available
- `aie gates status --json`
- `aie doctor --json`

These outputs should include provider identity, provider capabilities, layout state, trust levels, and stop/continue reasons without forcing Umpire to parse human help text.
