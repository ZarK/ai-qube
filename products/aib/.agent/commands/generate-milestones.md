---
description: Generate deep milestone docs from an accepted spec
---

Generate milestone documents from the accepted dry spec.

Required inputs:
- `docs/spec.md`
- `.qube/aib/session.json`
- `.qube/aib/assumptions.md`

Preconditions:
- require an accepted spec state in `.qube/aib/session.json`; run `/accept-spec` first when acceptance is not recorded yet
- refuse to generate milestones from a shallow or obviously unaccepted spec

Milestone design rules:
- use `.agent/templates/milestones/milestone.md` as the canonical structure
- design milestones as vertical slices with visible, testable, or demoable outcomes
- the first milestone may be harness, shell, or contract plumbing if that unlocks reliable delivery
- each milestone must trace back to exact spec anchors
- each milestone must explain why that slice exists now and what risk it burns down
- each milestone must include issue-ready task breakdowns, likely blockers, integration points, stable selectors, and at least one named E2E scenario
- keep milestone scope implementation-sized: large enough to matter, small enough to ship
- prefer milestone narratives and rationale tables over bare bullet lists

Ordering rules:
- order milestones so early slices validate infrastructure, contracts, and delivery paths
- each milestone should make the next milestone easier and safer
- keep filenames sortable, for example `M01-app-shell.md`
- expose hard dependencies, soft dependencies, and downstream unlocks explicitly

Quality bar:
- do not produce thin milestone shells
- do not copy huge chunks of the spec verbatim; compress the spec into milestone-specific intent, scope, tasks, and proof
- do not leave issue decomposition implicit

Output:
- write milestone files under `docs/milestones/`
- each milestone should be detailed enough that `/generate-issues` can create high-quality issue drafts without re-inventing missing structure
