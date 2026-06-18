# Issue Alignment

This document maps current GitHub issues to the product direction captured in these docs and identifies missing issue coverage.

## Existing Issues

| Issue | Current Role | Alignment |
|-------|--------------|-----------|
| `#1` Package and CLI foundation | Package baseline | Still correct. It creates the executable base needed for every later bucket. |
| `#2` Bootstrap state machine | Durable planning state | Still correct, but should avoid implying that all phases share the same question depth. |
| `#3` Repository-aware discovery | Progressive discovery | Needs refinement around staged questioning and early high-level user collaboration. |
| `#4` Spec engine | Spec drafting and acceptance | Still correct, but spec structure should be general plus dynamic chapters rather than a fixed deep technical template. |
| `#5` Milestones and work-item drafts | Milestone planning and work item drafting | Too broad conceptually. Milestone planning and work item drafting are separate layers even if implemented in one milestone. |
| `#6` Provider rendering | Provider-neutral rendering | Still correct. GitHub remains first renderer. Markdown export remains important. |
| `#7` Agent surfaces | Agent-host rendering | Still correct. Should keep agent-host assumptions out of core state. |
| `#8` Release readiness | End-to-end proof | Still correct. Must prove the progressive flow, not just template rendering. |

## Added Issue Coverage

### Agent-Mediated CLI Contract

Covered by issues `#2`, `#7`, and `#13`, but this must remain explicit across implementation:

- `aib` is an agent-operated CLI, not a human-operated terminal wizard
- the human talks to the agent
- the agent uses `aib next --json` and related commands to know what to ask, inspect, write, or render
- `aib` owns durable planning state and phase transitions
- the agent owns conversation, context gathering, and natural-language interaction with the human
- human-readable CLI output exists for setup/debugging/transparency, not as the main UX

### Progressive Question Depth

Created issue: `#9 M3: Progressive question depth and phase-aware discovery`

This issue changes discovery from a broad questionnaire into a phase-aware question planner.

Required behavior:

- early questions cover product intent and project shape only
- later questions become deeper only when the phase requires them
- question batches remain small
- answers can be partial, rough, or defaults
- `aib` records assumptions instead of forcing premature detail

### Spec Chapter System

Created issue: `#10 M4: General and dynamic spec chapter system`

This issue covers the spec chapter model:

- required general chapters
- dynamic optional chapters
- shallow-placeholder detection
- spec acceptance criteria
- no premature technical sections unless justified

### Milestone-First Delivery Planning

Created issue: `#11 M5: Milestone-first delivery planning before work item drafting`

This issue covers milestone planning as a distinct phase:

- milestone is a meaningful delivery
- milestones can be generated incrementally
- recommend first three milestones before issue generation
- milestone dependencies are explicit
- milestone docs may include diagrams and pseudo-algorithm notes but not production code

### Executor Queue Ordering

Created issue: `#14 M6: Generate aie-aware queue ordering metadata`

This issue covers queue display metadata for generated work items:

- generated drafts include stable `Sequence:` hints when the target workflow is Executor-compatible
- GitHub and markdown renderers preserve `Blocked by:` dependency lines and `Sequence:` ordering hints
- `Sequence:` is not the dependency model; blockers remain authoritative
- sequence values are validated against generated-draft blockers before provider mutation

### Non-Code Project Support

Created issue: `#12 M3/M4: Non-code project support in planning flows`

This issue covers non-code project handling:

- docs/content project
- research project
- design project
- operations/process project
- export-only work item mode

### QUBE Agnostic Core Contracts

Created issue: `#13 M2/M6: QUBE-agnostic core contracts and vocabulary`

This issue covers naming and contract cleanup:

- `PlanningState`
- `WorkItemDraft`
- `Provider`
- `AgentHost`
- capability reporting
- no GitHub/OpenCode vocabulary in core output except adapter-owned rendering

## Issue Ordering

The added issues are refinements that support existing milestone issues:

1. `#13` QUBE agnostic core contracts, blocked by `#1`, supports `#2`, `#6`, and `#7`.
2. `#9` Progressive question depth, blocked by `#2`, supports `#3`.
3. `#10` Spec chapter system, blocked by `#2`, supports `#4`.
4. `#12` Non-code project support, blocked by `#2`, supports `#3`, `#4`, and `#5`.
5. `#11` Milestone-first delivery planning, blocked by `#4`, supports `#5`.
