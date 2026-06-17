---
description: Continue discovery or produce the next deep dry spec draft
---

Continue the spec workflow from the current project state.

Required inputs to read first:
- `.bootstrap/session.yaml`
- `.bootstrap/discovery-log.md`
- `.bootstrap/assumptions.md`
- `docs/spec.md` if it exists
- relevant plan, naming, and resource files if they exist

Before drafting or revising:
- audit the existing context for related data models, workflows, APIs, UI patterns, architecture gates, and already-decided terminology
- preserve stable headings and accepted sections when revising later sections
- surface assumptions explicitly instead of burying them inside requirements
- ask only the smallest next batch of high-impact questions if discovery gaps would materially change the spec

Writing rules:
- use `.agent/templates/spec/dry-spec.md` as the canonical section order
- write a large, implementation-ready dry spec, not a thin outline
- keep the spec contract-oriented, invariants-first, acceptance-hooked, and implementation-agnostic
- prefer traceability tables, rationale tables, integration tables, ASCII layouts, event envelopes, and pseudocode over vague prose
- include explicit integration points so future implementers do not miss sidebar, inspector, query, export, tasks, or settings impacts
- define stable test selectors and named E2E scenarios before milestone generation
- separate what must be true from how code will eventually be written

Revision rules:
- do not silently remove accepted constraints
- patch sections in place when possible instead of reshuffling the document
- call out what changed, what stayed stable, and what remains unresolved
- leave milestone and issue generation for later commands once the spec is explicitly accepted

Acceptance flow:
- get section-by-section acceptance in this order:
  1. strategic framing
  2. invariants and dependencies
  3. functional requirements
  4. contracts and technical model
  5. UI, settings, algorithms, and integration points
  6. implementation planning and test plan

Output expectation:
- `docs/spec.md` should be detailed enough that a developer or agent with no prior context can plan milestones from it without inventing missing product behavior.
