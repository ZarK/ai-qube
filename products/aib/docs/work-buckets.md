# Work Buckets

These buckets are regular planning buckets for `ai-bootstrap` itself. They are not generated milestones. They align to the existing GitHub issue milestones while adding the missing conceptual work from the current product direction.

## Bucket 1: Package And CLI Foundation

Existing issue: `#1 M1: Package and CLI foundation using @tjalve/qube-cli`

Purpose:

- turn the scaffold into a real `@tjalve/aib` package
- use `@tjalve/qube-cli`
- expose safe CLI help/schema/init behavior
- preserve current scripts until the CLI replacement is ready

Key clarification:

The package foundation must not expose placeholder runtime commands. Commands should either work, clearly dry-run, or be absent.

The CLI is agent-operated. Human-readable help is required for transparency, but command design should prioritize agent-facing JSON contracts over a human terminal wizard.

## Bucket 2: Durable Planning State

Existing issue: `#2 M2: Bootstrap state machine and agent JSON protocol`

Purpose:

- create versioned planning state
- expose `init`, `status`, `next`, and answer-recording commands
- make the process resumable across agent contexts

Key clarification:

The state machine should model phases, but it should not force deep technical questions during initial project clarification.

The state machine should return next actions for the agent to perform with the human, not attempt to own the whole conversation itself.

## Bucket 3: Progressive Discovery

Existing issue: `#3 M3: Repository-aware discovery planner`

Purpose:

- inspect useful context when available
- ask small batches of human-scale questions
- support defaults and rough answers
- avoid leaking private reference material into generated product artifacts

Missing refinement:

Discovery needs a staged question model:

1. project clarification
2. spec completion
3. milestone boundary detail
4. work item execution detail

It should not ask phase 3 or phase 4 questions during phase 1.

## Bucket 4: Spec Engine

Existing issue: `#4 M4: Spec drafting, revision, and acceptance engine`

Purpose:

- draft and revise `docs/spec.md`
- validate spec completeness
- record section-level acceptance
- block milestone generation until accepted

Missing refinement:

The spec should have a known general structure plus dynamic chapters. It should be high-level enough for early collaboration and complete enough to generate milestones, but it should not prematurely require APIs, schemas, selectors, or edge-case catalogs.

## Bucket 5: Milestone Planning

Existing issue: part of `#5 M5: Milestone and work-item draft generation`

Purpose:

- generate milestone docs after spec acceptance
- model milestones as meaningful deliveries
- define milestone boundaries, dependencies, and proof of completion

Missing refinement:

Milestone planning should be its own conceptual layer before work item generation. Users do not need all milestones up front, but the system should recommend at least the first three milestones before breaking any one milestone into issues.

## Bucket 6: Work Item Drafting

Existing issue: part of `#5 M5: Milestone and work-item draft generation`

Purpose:

- turn a milestone into executable work item drafts
- include blockers, acceptance criteria, test expectations, and definition of done
- keep drafts provider-neutral first

Key clarification:

Actual project work should not start from raw specs or milestones. Work items are required.

## Bucket 7: Provider Rendering

Existing issue: `#6 M6: Provider-neutral work item rendering with GitHub first`

Purpose:

- render canonical work item drafts to GitHub or markdown export
- preserve provider-neutral core state
- keep provider IDs and URLs out of product specs

Key clarification:

GitHub is the first renderer, not the product ontology.

## Bucket 8: Agent Host Surfaces

Existing issue: `#7 M7: Agent surfaces and projected command assets`

Purpose:

- render Codex, OpenCode, Claude, Gemini, and other host assets
- teach agents to drive `aib` through structured commands
- support local assets before optional global installation

Key clarification:

The human talks to the agent. The agent asks and reads. `aib` tracks state and phase. Execution belongs to `aie`.

## Bucket 9: Release Readiness

Existing issue: `#8 M8: Release readiness, QA, and end-to-end bootstrap proof`

Purpose:

- prove idea -> spec -> milestones -> work items
- document stable and future surfaces honestly
- package safely
- test deterministic flows

Key clarification:

The first release should prove a narrow GitHub/markdown and Codex/OpenCode path while preserving the provider/tool-agnostic architecture.
