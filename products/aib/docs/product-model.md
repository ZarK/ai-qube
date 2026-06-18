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

`aib` is also not primarily a CLI for humans to drive directly. It is a CLI for AI agents working with humans. The normal interaction is:

```text
Human describes intent -> Agent calls aib -> aib returns next action/questions -> Agent asks the human -> Agent records answers in aib -> aib advances the planning state
```

Human-readable help and diagnostics still matter, but they support setup, debugging, and transparency. The main product contract is the agent-facing state machine and JSON protocol.

## QUBE Boundary

| Package | Responsibility |
|---------|----------------|
| `aib` | Idea intake, project clarification, spec drafting, milestone planning, work item generation, planning state. |
| `aie` | Work item execution, lifecycle, branch/review/gate orchestration, completion. |
| `aiq` | Quality checks, evidence checks, fake-progress detection, layout-aware verification. |
| `aiu` | Continuation policy, stalled-loop recovery, automatic resume. |
| `qube` | Future top-level composition over product packages, providers, and agent-tool adapters. |

## Product Principles

### Agent-Mediated UX

The human should not have to learn `aib` commands, phases, schemas, or state files. The agent is the operator of the CLI. `aib` guides the agent so the agent can guide the human.

CLI commands should therefore optimize for deterministic JSON, explicit next actions, durable state updates, and clear handoff instructions. Human-facing output should explain what happened, not become the primary workflow.

### Progressive Clarification

`aib` starts with human-scale questions about intent, scope, audience, non-goals, and project shape. It does not begin by asking about APIs, schemas, selectors, IPC, package managers, or edge cases.

Technical detail appears only when the current phase requires it.

### Tool And Provider Agnostic Core

GitHub and OpenCode are useful first renderers, not core assumptions. Core planning state should speak in neutral terms such as `WorkItemDraft`, `PlanningState`, `Provider`, `AgentHost`, and `CapabilityReport`.

### Project Profile Before Project Machinery

`aib` should identify the project shape before applying coding-project assumptions. A documentation set, research brief, design exercise, process workflow, or markdown-only export should not receive default requirements for APIs, schemas, selectors, package commands, builds, or automated tests.

Profiles begin as candidate classifications that the agent can confirm or refine with the human. They influence spec chapters, milestone deliverables, work item validation, and whether provider or repository mutation is appropriate.

### User Language First

Questions should be concrete and phrased in the user's product language. `aib` may recommend defaults and tradeoffs, but it should not ask the user to understand internal abstractions before the product shape is clear.

### Durable State Over Transcript Memory

The planning process must survive context loss. Decisions, assumptions, open questions, generated artifacts, and provider-created IDs belong in planning state.

### No Recursive Planning Trap

For `aib` itself, this repository uses regular planning documents. The product may later generate specs and milestones for other projects, but its own development plan should stay readable and direct.

## Non-Goals

- `aib` is not designed as a wizard that a human is expected to operate directly from the terminal.
- `aib` does not execute generated work items.
- `aib` does not run quality gates.
- `aib` does not decide that GitHub Issues are the only work item system.
- `aib` does not require a coding project. It must also support documentation, research, process, content, design, or operations projects.
- `aib` does not ask deep technical questions during initial idea clarification unless the user volunteers that detail.
- `aib` does not install global agent commands, tools, or skills without explicit user action.
- `aib init --agent <host>` may project local repository assets for supported hosts. Those assets teach the host to operate `aib`; they do not replace the CLI state machine or install global commands.

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

## Project Profiles

Project profiles are lightweight planning templates, not permanent labels. They keep early planning useful without forcing every project through a software-delivery shape.

| Profile | Default posture | Validation examples |
|---------|-----------------|---------------------|
| Coding project | Repository mutation is allowed when configured. | Tests, build, review, acceptance. |
| CLI or package project | Coding project with command, configuration, packaging, and release constraints. | Tests, build, review, package contract acceptance. |
| Local AI project | Coding project with model behavior, privacy, local runtime, and hardware constraints. | Tests, build, privacy evidence, review. |
| Documentation or content project | Non-code project focused on structure, audience, review, and publication. | Review, acceptance, publication checklist. |
| Research project | Non-code project focused on evidence, methods, sources, and recommendations. | Evidence table, review, acceptance. |
| Design project | Non-code project focused on workflows, concepts, artifacts, and critique. | Review, acceptance evidence, stakeholder signoff. |
| Operations or process project | Non-code project focused on roles, handoffs, checklists, and operating model. | Evidence, review, stakeholder signoff. |
| Export-only project | Non-code project that produces markdown or handoff artifacts without provider mutation. | Review and acceptance. |
| Unclassified / fallback | Conservative non-code posture until the agent and human clarify the shape. | Continue discovery, record assumptions, review before acceptance. |

Non-code profiles can still produce milestones and work items. Their work items describe reviewable deliverables and acceptance evidence instead of implementation instructions.
