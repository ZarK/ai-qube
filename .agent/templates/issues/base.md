Blocked by: #<issue-id>
Sequence: <optional 34.2.15.4000>

## Summary

One paragraph on what this issue delivers, why this slice exists now, and what visible outcome or contract it should land.

**Reference:** `docs/milestones/MNN-name.md` §§<anchors> | `docs/spec.md` §§<anchors>

## Context

- Milestone refs: `docs/milestones/MNN-name.md` §§...
- Spec refs: `docs/spec.md` §§...
- Related surfaces:

## Goal

State the delivery goal in neutral language. Default to feature delivery, greenfield construction, or capability expansion unless this issue is explicitly a fix.

## Background Or Current Gap (Optional)

Use this only when the issue exists to fix something broken, close a gap, migrate an old path, or explain constraints from existing behavior.

## What We're Delivering

Describe the visible or testable end state in concrete terms.

**Success looks like:**

<Short user/tester narrative>

## Scope

### Schema / Data

-

### API / Contracts

-

### UI / Workflow

-

### Integration Points

-

### Data Model / SQL Implementation

Use this when the issue is schema-heavy, aggregation-heavy, or query-heavy.

-

### Update Flow / Core Principle

Use this when the issue depends on a state transition, cascade, or pipeline rule.

- Update flow:
- Core principle:

### Rules / UI States

Use this when the issue is about visibility rules, collapse rules, warning states, or other stateful UI behavior.

- Rules table or bullets:
- UI states / ASCII snippets:

## Queue Metadata

- Direct blockers: encode each real blocker as a top-of-body `Blocked by: #NNN` line. These lines are the machine-readable dependency source.
- Sequence override: omit by default. Add `Sequence:` only when blocker chains and milestone numbering are not enough.
- Sequence format examples: `0.0.0.0`, `34.2.15`, `34.2.15.4000`
- Labels: choose exactly one priority label (`P1-Critical` to `P4-Low`), one status label (`S-Ready`, `S-InProgress`, `S-Blocked`, or `S-Blocking`), and one or more component labels (`C-*`).
- Shared planning: keep transient implementation notes in the GitHub issue body or comments instead of extra repo markdown files.

## Key References

-

## Dev Tasks

- [ ]
- [ ]
- [ ]

## Acceptance Criteria

- [ ]
- [ ]
- [ ]

## Stable Selectors

| Selector | Element |
|----------|---------|
|          |         |

## E2E Tests

### Test: <descriptive_name>

- Fixture:
- Test steps:
- Key assertions:

### Consolidation Rules

- Prefer extending an existing consolidated E2E flow or spec file before creating a new one.
- Reuse shared helpers, startup flows, and fixture sets when they already construct the data needed for this case.
- Create a new E2E spec or fixture set only when the required scenario cannot fit an existing flow without harming clarity.
- If a new fixture set or spec is required, explain why reuse was not sufficient.
- Always use stable selectors such as `data-testid`.

## Additional Verification

### Unit / Integration

- [ ]

### Manual Verification

-

## Edge Cases

-

## Dependency And Follow-up Notes

- Human-readable dependency rationale:
- Follow-up work unlocked:
- Queue steering note if `Sequence:` is used:

## Suggested Labels

- Priority: `P2-High`
- Status: `S-Ready`
- Components: `C-Frontend`

## Definition Of Done

- [ ] Dev tasks are completed
- [ ] Acceptance criteria are implemented
- [ ] Stable selectors exist for the tested UI surface
- [ ] Named E2E coverage exists for the primary path
- [ ] At least one failure, empty-state, or reversal path is covered
- [ ] Existing E2E flows and fixture sets were reused when practical, or a clear reason for a new spec/fixture was recorded
- [ ] Queue metadata and follow-up work are explicit
