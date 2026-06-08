# AI Bootstrap Product Model

## Purpose

`ai-bootstrap` (`aib`) owns the planning side of QUBE. It turns early project intent into durable planning artifacts:

- a high-level project definition
- a dry functional/non-functional spec
- milestone plans
- work item drafts
- provider-rendered work items when configured
- agent/tool setup instructions that teach a coding agent how to continue the planning or execution flow

`aib` is not the execution system. It does not implement the planned project and it does not own review, merge, quality, or continuation loops. Those belong to other QUBE packages.

## QUBE Boundary

| Package | Responsibility |
|---------|----------------|
| `aib` | Idea intake, project clarification, spec drafting, milestone planning, work item generation, planning state. |
| `aie` | Work item execution, lifecycle, branch/review/gate orchestration, completion. |
| `aiq` | Quality checks, evidence checks, fake-progress detection, layout-aware verification. |
| `aiu` | Continuation policy, stalled-loop recovery, automatic resume. |
| `qube` | Future top-level composition over product packages, providers, and agent-tool adapters. |

## Product Principles

### Progressive Clarification

`aib` starts with human-scale questions about intent, scope, audience, non-goals, and project shape. It does not begin by asking about APIs, schemas, selectors, IPC, package managers, or edge cases.

Technical detail appears only when the current phase requires it.

### Tool And Provider Agnostic Core

GitHub and OpenCode are useful first renderers, not core assumptions. Core planning state should speak in neutral terms such as `WorkItemDraft`, `PlanningState`, `Provider`, `AgentHost`, and `CapabilityReport`.

### User Language First

Questions should be concrete and phrased in the user's product language. `aib` may recommend defaults and tradeoffs, but it should not ask the user to understand internal abstractions before the product shape is clear.

### Durable State Over Transcript Memory

The planning process must survive context loss. Decisions, assumptions, open questions, generated artifacts, and provider-created IDs belong in planning state.

### No Recursive Planning Trap

For `aib` itself, this repository uses regular planning documents. The product may later generate specs and milestones for other projects, but its own development plan should stay readable and direct.

## Non-Goals

- `aib` does not execute generated work items.
- `aib` does not run quality gates.
- `aib` does not decide that GitHub Issues are the only work item system.
- `aib` does not require a coding project. It must also support documentation, research, process, content, design, or operations projects.
- `aib` does not ask deep technical questions during initial idea clarification unless the user volunteers that detail.
- `aib` does not install global agent commands, tools, or skills without explicit user action.

## Artifact Model

| Artifact | Phase | Purpose |
|----------|-------|---------|
| Planning state | All phases | Machine-readable source of current decisions, unknowns, status, providers, and artifact paths. |
| Discovery log | Spec phase | Human-readable record of questions, answers, assumptions, and decisions. |
| `docs/spec.md` | Spec phase | Accepted project definition with functional and non-functional requirements. |
| Milestone docs | Milestone phase | Meaningful delivery slices with boundaries, dependencies, and enough detail for work item generation. |
| Work item drafts | Work item phase | Provider-neutral executable units. |
| Provider work items | Work item phase | GitHub Issues, GitLab issues, Jira tickets, Linear issues, markdown exports, or another configured rendering. |
| Agent assets | Finalization | Host-specific prompts, commands, rules, or instructions that teach agents how to drive `aib` or later `aie`. |

