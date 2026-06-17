---
description: Generate detailed issue drafts from a milestone and accepted spec
---

Generate issue drafts from an accepted spec and a selected milestone.

Required inputs:
- `docs/spec.md`
- one file from `docs/milestones/`
- selected profile from `.bootstrap/session.yaml`
- `.agent/templates/issues/base.md`
- the active profile issue template

Issue generation rules:
- create one primary intent per issue
- prefer vertical slices over layer-only tasks
- use the milestone task breakdown as the source material, then sharpen each issue into an executable delivery unit
- include explicit `Blocked by:` lines whenever dependencies exist
- include `Sequence:` only when ordering needs extra steering beyond blockers and milestone order
- every issue must have a concise summary, explicit context references, a concrete success narrative, dev-task checklist, acceptance criteria, stable selectors, named E2E tests, manual verification guidance, and explicit definition of done
- every issue must map back to milestone and spec anchors so it is obvious why the issue exists
- use profile-aware additions for desktop UI, CLI, backend, or other selected project shapes
- keep each issue small enough for a focused PR, but large enough to land a meaningful proof point
- choose the closest general issue shape instead of flattening everything into one generic body:
  - broad milestone slice: `Summary -> Context -> Scope -> Selectors -> Acceptance Criteria -> E2E Tests -> Queue metadata`
  - umbrella milestone issue: `Reference -> Strategic Goal -> Goal -> Dev Tasks -> E2E Tests -> Acceptance Criteria -> Performance Targets`
  - data-heavy issue: `Goal -> Data Model -> Strategy -> SQL / storage notes -> Dev Tasks -> Stable Selectors -> E2E Test -> Acceptance Criteria`
  - state/cascade issue: `Goal -> Update Flow -> Implementation notes -> Core Principle -> Dev Tasks -> Stable Selectors -> E2E Test -> Acceptance Criteria -> Performance Targets`
  - rules/visibility issue: `Goal -> Rules -> UI States -> Dev Tasks -> Stable Selectors -> repeated E2E Test sections -> Acceptance Criteria`
  - compatibility/follow-up issue: `Summary -> Reference -> Goal -> What We're Delivering -> Key References -> Dev Tasks -> Acceptance Criteria -> Selectors -> Queue metadata`
- default to neutral feature-delivery language. Use a `Background Or Current Gap` or `Problem Statement` section only when the issue is actually a fix, migration, or diagnosis.
- context must reference both the milestone doc and the relevant sections of `docs/spec.md`
- align queue metadata to `resources/gh-workflow.md`: `Blocked by:` lines are the only machine-readable dependency source, `Sequence:` is optional and exceptional, and label suggestions should include exactly one priority label, one status label, and one or more component labels
- keep transient implementation planning in the GitHub issue body or comments instead of inventing extra planning markdown files
- for UI work, prefer extending an existing consolidated E2E flow and reusing an existing fixture set before creating a new spec or dataset
- if a new E2E spec or fixture set is required, state why existing flows or fixtures could not carry the scenario cleanly

Quality bar:
- do not produce thin issue placeholders
- do not restate the milestone title and stop
- do not leave tests, selectors, blockers, or visible outcomes implicit
- separate the problem from the scoped implementation so the implementer understands both the gap and the intended delivery unit
- when an issue has multiple distinct flows, emit multiple named `E2E Test` sections instead of collapsing them into one generic list
- do not reference private example repos, private issues, or learning-source project names in generated output

Output options:
- save drafts under `docs/issues/`
- or create GitHub issues directly with `gh issue create`, but only after showing or saving the drafts first

When creating GitHub issues:
- preserve the generated structure from the templates
- include labels consistent with the milestone scope and active profile
- keep blocker metadata machine-readable with dedicated `Blocked by:` lines
- do not add extra dependency syntax that the queue scripts do not parse
