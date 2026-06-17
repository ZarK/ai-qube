# AI Umpire Notes

`ai-umpire` (`@tjalve/aiu`) owns continuation: it keeps agent work moving across stop hooks, context limits, stalled sessions, and multi-step planning/execution loops. It should continue from provider-neutral trusted state, not GitHub-specific assumptions.

## Provider And Repository Impact

Provider modularity changes Umpire from "watch GitHub issue/PR state" to "enforce continuation policy over Executor and Bootstrap JSON state."

Umpire should consume:

- `WorkItem` queue state from Executor, including provider id, canonical status, priority, blockers, and trust level
- `ReviewItem` state from Executor, including review provider, approvals, mergeability, open comments, and linked work items
- `GateEvidence` state from Executor and Quality-control, including local gates, CI provider checks, manual audits, and unknown/unsupported states
- `RepoState` from Executor, including base branch/ref freshness, active branch/ref, dirty worktree, workspace layout, and policy boundaries
- Bootstrap planning state, including provider choices, unresolved schema questions, and generated work item status

Umpire should never infer provider semantics itself. For example, it should not parse Jira statuses, GitLab labels, Linear workflow states, or Gerrit votes unless Executor has normalized them into trusted JSON.

Provider-neutral continuation invariants:

- only one normal active work item should be in progress unless repository policy allows parallel work
- only one normal active review item should be open for autonomous shipping unless policy allows more
- the local source ref should be based on the latest configured target ref, except for the current unmerged work
- no required gate evidence should be failed, missing, or unknown before merge/submit/completion
- provider adapters must prove status transitions, blockers, mergeability, and CI state or Umpire should stop
- repository layout uncertainty should stop broad commands when affected-scope detection is required by policy

## Continuation Boundaries

Umpire should keep work moving, but not whip through safety blocks. It should continue only when the next action is clear from trusted state:

- active work item or ready queue item from Executor
- planning next step from Bootstrap
- configured status from trusted JSON output
- known gate/audit/review state

It should stop and ask for human input when a package/tooling change needs explicit supply-chain approval, when planning has unresolved product-scope questions, or when queue state is invalid.

## Execution Loop Enforcement

Umpire should continuously check deterministic state before telling an agent to continue or start new work:

- only one open review item should be active for normal autonomous work, unless repository policy explicitly allows more
- only one work item should be in the canonical `in progress` state, unless repository policy explicitly allows parallel work
- the local branch/ref should be based on the latest configured base branch/ref, except for the agent's current unmerged changes
- local base branch/ref state should be synced with the configured remote before starting a new work item
- no required CI provider checks or local gates should be failing before merge/submit or before starting the next work item
- agents should not sit idle when there is active in-progress or ready work
- agents should continue the full execution loop through shipping: implementation, gates, review item creation, review wait, merge/submit when allowed, work item completion, base update, and next work item bootstrap

Umpire should prefer Executor's structured state commands for these checks, for example queue/next/lifecycle/gate/doctor JSON output, rather than parsing human prose. Umpire should not pretend it can judge broad semantic questions such as whether code is fully aligned with a spec unless another trusted tool or agent has produced a concrete, machine-readable result.

When state is invalid, Umpire should route the agent to the corrective action instead of blindly starting new work:

- finish or reconcile the existing review item before opening another
- resume or complete the current in-progress work item before starting another
- update the base branch/ref before selecting the next work item
- fix failing CI or route back to implementation before merge
- collect missing gate/review/audit evidence before marking work done

## Quality Idle Work

When an agent is idle and `aiq` is available, Umpire should use that idle time to drive concrete quality progress:

- ask the agent to run `aiq` for the current repository or current stage
- inspect `aiq` structured output when available
- whip the agent to fix failing `aiq` stages one by one
- continue until all configured `aiq` stages pass, the queue needs normal work item execution, or a human/safety block is reached

This is a good Umpire responsibility because it is concrete and externally checkable. Umpire does not need to infer product correctness; it only needs to keep the agent working on known failing quality stages.

If `aiq` is unavailable, Umpire may ask the agent to run the repository's configured deterministic gates, but it should avoid vague prompts such as "make sure the code is correct" unless tied to a concrete gate, work item, review item, or failing check.

## Legacy AIQ Adoption Whip

Umpire should support a custom whip mode for applying `aiq` to legacy projects where `aiq` was not part of development from the start. In those repositories, asking an agent to "make all `aiq` stages pass" can produce an overwhelming, noisy work surface and weak prioritization.

The mode should use `aiq`'s cumulative stage process:

1. Run only stage 1.
2. Fix all stage 1 findings until stage 1 passes.
3. Move to stage 2.
4. Fix all findings until stages 1 and 2 pass together.
5. Continue stage by stage, always preserving all earlier stage passes.

The continuation prompt should be concrete and repetitive by design:

- inspect `aiq` structured output for the current cumulative stage set
- choose the smallest coherent batch of findings
- implement real fixes, not suppressions, unless policy explicitly allows suppression with justification
- rerun the same cumulative stage set
- continue until the current stage set passes
- advance exactly one stage when the current cumulative set is clean
- stop on supply-chain risk, unclear product behavior, generated/vendor ambiguity, or a stage that needs human policy

Umpire should treat this as a resumable mode with trusted state:

- target repo
- active stage number
- cumulative stage set
- latest `aiq` command and JSON output path
- current failing findings grouped by stage/severity/path
- stages already passing
- stop reason or next whip prompt

This mode is different from normal idle quality work. It is an explicit migration/adoption workflow for bringing a project under `aiq` discipline without forcing the agent to reason about every quality dimension at once.

## Determinism Boundary

Umpire should not own judgments that require open-ended engineering interpretation. Those belong to the active coding agent, reviewer agents, `aiq`, CI, or the human.

Avoid making Umpire responsible for:

- deciding whether implementation fully satisfies a spec from source code alone
- judging broad architecture quality without a configured checker or reviewer output
- proving all acceptance criteria are complete when they are not encoded in structured state
- inferring correctness from agent narrative
- inventing product decisions to unblock planning or implementation

Umpire can still prompt the agent to perform those tasks when needed, but it should phrase the whip around concrete actions: read the work item, run `aiq`, inspect failing CI, address review comments, run configured gates, update provider work item state, or ask the human for the unresolved decision.

## Whip Commands

Umpire should support default whip commands/prompts for common continuation modes:

- continue normal work item execution until the queue is empty or blocked
- continue Bootstrap planning until spec, milestones, and work items are complete or a human decision is needed
- resume an active work item or review item after a stop hook
- recover from idle agent state by asking for the next trusted action

Repositories should be able to override the whip command or prompt. Overrides should supplement trusted repository policy, not bypass safety rules such as one active review item, one in-progress work item, base-ref freshness, failing CI, unknown provider state, or supply-chain approval blocks.

## Anti-Fake Completion

Umpire should not accept fake progress as a stop condition:

- no-op tests or placeholder scripts do not count as passing gates
- generated status files or progress markdown do not prove implementation
- agent narration does not prove audits, tests, or review passed
- `aie gates status --json`, `aiq` output, CI state, review state, and work item state are better continuation inputs than prose

If work appears "done" but required evidence is missing, Umpire should re-prompt the agent to collect or run the real gate rather than start a new work item.

## Planning Continuation With Bootstrap

For `aib` automatic mode, Umpire should drive multi-step planning without assuming one context can hold everything:

- run the next planning action
- verify the artifact exists and is internally consistent
- record phase/status and provider-specific creation state in Bootstrap planning state
- continue to the next phase or stop on a concrete human question

The whip prompt should say to continue spec/milestone/work-item writing until completion or a human-blocking decision, but it should also forbid inventing decisions to avoid asking.

## Supply-Chain Stop Conditions

Umpire should treat supply-chain guard blocks as hard stops unless policy explicitly permits continuation:

- newly introduced package version is too young
- source/provenance cannot be verified
- lifecycle scripts or native binaries need review
- package manager/generator/CI/MCP/agent tool execution is requested from untrusted input
- broad upgrade or floating install is proposed
- possible compromise indicators are found

In these cases Umpire should report the exact blocker and wait for human approval or a safer alternative.
