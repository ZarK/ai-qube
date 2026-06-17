# Project Name - Dry Specification

Spec Version: v0.1
Status: draft | accepted
Primary Profile: <desktop-ui | web-ui | cli-tool | backend-service | local-ai-app>

## Strategic Goal

Describe the core user problem, the intended outcome, and why this feature or product deserves to exist now.

**Success looks like:**

Write one dense user-journey sentence that traces the full happy path from first trigger to visible outcome. Use `->` separators if helpful.

- Problem:
- Primary outcomes:
- Non-goals:
- Who this is for:
- Why now:

## Spec Requirements

Map this document back to the originating idea, plan, PRD, or master spec.

| Requirement | Source Section | Notes |
|-------------|----------------|-------|
|             |                |       |

## Why This Matters

Explain the pain point, why common alternatives are worse, and what quality bar this spec is trying to hit.

| Factor | Current / Typical Approach | Proposed Approach |
|--------|----------------------------|-------------------|
|        |                            |                   |

## Relationship To Other Features

List every nearby system surface this work touches so future implementers do not miss obvious integrations.

| Feature / Surface | Relationship | Contract Or Constraint |
|-------------------|--------------|------------------------|
|                   |              |                        |

## Design Principles

List 3-5 principles that break ties during implementation.

- Principle 1:
- Principle 2:
- Principle 3:
- Principle 4:

## Invariants

Write stable truths that should survive refactors.

### MUST

-

### MUST NOT

-

### SHOULD

-

### Test Hooks For Invariants

For each important invariant, name the observable signal, selector, event, or data condition that proves it.

| Invariant | Observable Proof |
|-----------|------------------|
|           |                  |

## Dependencies And Gates

Identify upstream dependencies and architecture gates before writing deep technical sections.

### Hard Dependencies

-

### Soft Dependencies

-

### Downstream Features Enabled

-

### Architecture Gates

| Gate | Trigger | Embedded Constraint |
|------|---------|---------------------|
|      |         |                     |

## Context Audit Summary

Summarize what was discovered in the existing codebase, plan docs, prior specs, and patterns before drafting this spec.

### Existing Data / Schema Patterns

-

### Existing API / RPC / Event Patterns

-

### Existing UI / Workflow Patterns

-

### Open Questions Or Assumptions

-

---

## Functional Requirements

Describe outcomes, not implementation. Every requirement should include acceptance hooks.

### FR-001

- Requirement:
- Acceptance:
  - Given
  - When
  - Then

### FR-002

- Requirement:
- Acceptance:
  - Given
  - When
  - Then

### FR-003

- Requirement:
- Acceptance:
  - Given
  - When
  - Then

## Strategic Decisions

Capture non-obvious choices and why they beat alternatives.

| Decision | Options Considered | Rationale | Consequence |
|----------|--------------------|-----------|-------------|
|          |                    |           |             |

## Core Concepts

Define the durable domain language used across the rest of the document.

- Entity / concept:
- Entity / concept:
- Entity / concept:

## Data And State Model

### Entities

| Entity | Purpose | Key Fields | Notes |
|--------|---------|------------|-------|
|        |         |            |       |

### State Transitions

| Transition | Trigger | Result | Reversibility |
|------------|---------|--------|---------------|
|            |         |        |               |

### Schema / Storage Notes

- New tables or documents:
- Modified tables or documents:
- Index strategy:
- Migration strategy:
- Scale notes:

## API / RPC Methods

Document every boundary method needed to support this feature.

| Method | Kind | Inputs | Returns | Errors / Validation |
|--------|------|--------|---------|---------------------|
|        |      |        |         |                     |

## Events / Notifications

Use stable envelopes and example payloads when events matter.

### Event Envelope

- Required fields:
- Ordering guarantees:
- Correlation rules:
- Backpressure or coalescing rules:

### Event List

| Event | Trigger | Payload Summary | Consumers |
|-------|---------|-----------------|-----------|
|       |         |                 |           |

### Example Payloads

```json
{
  "type": "example.event",
  "ts": "<iso-timestamp>",
  "seq": 0,
  "jobId": "job_example",
  "data": {}
}
```

## UI Specification

Describe structure, interactions, and states. Prefer ASCII mockups over vague prose.

### Primary Layout

```text
+----------------------------------------------------------+
|                                                          |
|                                                          |
+----------------------------------------------------------+
```

### Components And Surfaces

| Surface | Purpose | Key States | Notes |
|---------|---------|------------|-------|
|         |         |            |       |

### Interaction Model

- Primary flow:
- Empty state:
- Loading state:
- Error state:
- Keyboard shortcuts:
- Accessibility requirements:
- Animation intent:

## Settings Integration

For every user-facing knob, define the settings contract now.

| Setting Key | Type | Default | Validation | Runtime Behavior |
|-------------|------|---------|------------|------------------|
|             |      |         |            |                  |

## Algorithms And Processing Logic

If non-trivial scoring, inference, clustering, scheduling, or merging exists, describe it here with prose first and pseudocode second.

### Algorithm Summary

-

### Pseudocode

```text
INPUT:
STEPS:
OUTPUT:
```

### Determinism Requirements

-

### Worked Example

- Input:
- Expected output:

## Integration Points

Explicitly call out every existing surface that should reflect this feature.

| Integration Surface | Required Behavior |
|---------------------|-------------------|
| Navigation / Sidebar |                   |
| Detail / Inspector |                     |
| Grid / List |                             |
| Search / Query / Facets |                 |
| Export / Reports |                        |
| External API / CLI |                      |
| Background jobs / Tasks |                 |

---

## Dev Task Breakdown

Break implementation into numbered vertical slices. Each task should end in something visible, testable, or demoable.

### Task 1.1: <name>

#### What We're Building

Describe the slice and its visible outcome.

#### Spec Anchors

-

#### Schema Changes

-

#### API / Contract Changes

-

#### UI / Workflow Changes

-

#### Acceptance Criteria

- [ ]
- [ ]
- [ ]

### Task 1.2: <name>

#### What We're Building

#### Spec Anchors

-

#### Schema Changes

-

#### API / Contract Changes

-

#### UI / Workflow Changes

-

#### Acceptance Criteria

- [ ]
- [ ]
- [ ]

## Stable Test Selectors

Define selectors before implementation so tests and UI evolve together.

| Selector | Surface | Purpose |
|----------|---------|---------|
|          |         |         |

## E2E Test Scenarios

Write named end-to-end flows in Given/When/Then style.

### Test: <descriptive_name>

- Fixture requirements:
- Given
- When
- Then
- And

### Test: <descriptive_name>

- Fixture requirements:
- Given
- When
- Then
- And

## Edge Cases And Error Handling

| Condition | Expected Behavior | Why It Matters |
|-----------|-------------------|----------------|
|           |                   |                |

## Performance Targets

| Operation | Target | Measurement |
|-----------|--------|-------------|
|           |        |             |

## Global Acceptance Criteria

- [ ] Core flows satisfy the success narrative
- [ ] Invariants have explicit observable proofs
- [ ] Contracts are stable enough for milestone and issue generation
- [ ] Integration points are explicit rather than implied
- [ ] E2E scenarios cover at least the primary happy path and a meaningful failure path

---

## Dependencies Summary

| Dependency Type | Item | Why It Matters |
|-----------------|------|----------------|
| Hard            |      |                |
| Soft            |      |                |

## What This Enables

-

## Out Of Scope

-

## Future Considerations

-
