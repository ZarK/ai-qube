# Feature Specification System

A repeatable process for creating comprehensive, implementation-ready feature specifications that guide developers (human or AI) through building features end-to-end.

---

## 1. Philosophy

A feature spec is a contract between the person who knows what to build and the developer who builds it. It must be detailed enough that a developer with no prior context can implement the feature correctly, yet it must avoid dictating implementation code. The spec describes the *what* and *why* exhaustively while leaving the *how* to the developer.

Specs are guidance documents. They describe requirements, acceptance criteria, and architectural decisions. Where algorithms or data structures need precision, pseudocode and schema descriptions are used. Full production code is never included — that is the developer's domain.

This level of specification detail pays for itself many times over. It eliminates ambiguity, catches design conflicts early, and provides the acceptance criteria that define "done." The investment is especially critical when working with AI coding agents, where the spec serves as the primary communication channel. Every ambiguity in the spec is a decision the agent will make on its own — sometimes correctly, sometimes not.

---

## 2. The Specification Process

The process has four distinct stages. Each produces specific outputs that feed into the next.

### 2.1 Context Gathering (Phase 1)

Before writing a single line of the spec, build a deep understanding of how this feature fits into the system. This is the most important phase and should not be rushed.

#### 2.1.1 Audit existing architecture

Search the codebase and existing specifications for anything this feature touches:

- **Database tables and columns** that already exist or are anticipated by earlier specs. Master specifications often foreshadow fields or structures before they are implemented.
- **UI patterns** established by implemented features (navigation sections, inspector panels, grid overlays, filter chips, modal workflows).
- **API patterns** already in use (naming conventions, communication protocols, event naming, streaming patterns).
- **Job/pipeline patterns** if this feature involves background processing.
- **Query engine capabilities** if this feature introduces new filterable dimensions.
- **Settings/configuration patterns** if this feature has configurable thresholds or defaults.

> **Why this matters:** Before writing the favorites feature spec for one project, the context audit discovered that the master spec already anticipated "flags (e.g. marked as favorite, hidden)" on the core data model, and a separate feature had already defined sidebar structure for these flags. This shaped the entire spec and prevented rework.

#### 2.1.2 Map dependencies in both directions

Determine what this feature depends on (hard dependencies that must exist, soft dependencies that enhance it) and what it enables downstream. This shapes both scope and schema design.

When a feature is designed as a lightweight predecessor to a more complex future feature, the dependency analysis must drive schema compatibility decisions. For example, a manual tagging feature can be designed to use the same database schemas as a future automated detection feature, so that the manual version serves as a cheap alternative while the automated version is developed — and no migration is needed when it arrives.

#### 2.1.3 Check architecture gates

Most mature projects have architecture constraints or gates — cross-cutting documents that define rules for database scalability, RPC protocol design, UI performance, settings management, or design system compliance. Every new feature spec must identify which gates apply and embed those constraints directly.

Common gates include:

| Gate Type | Trigger Condition | Typical Requirements |
|-----------|-------------------|---------------------|
| Database Scalability | Adds per-record tables or aggregation pressure | Storage format optimization, index audits, cache strategy, benchmark harness |
| RPC / API Scalability | Has bulk payloads or high-rate events | Streaming responses, backpressure, event coalescing, correlation IDs |
| UI Performance | Touches grids, maps, or virtualized lists | Containment boundaries, no per-item layer promotion, lazy loading |
| Settings / Configuration | Introduces any configurable value | Define keys under unified settings schema |
| Design System | Adds any new UI components | Follow established interaction patterns, stable test selectors |

If the project doesn't yet have formal gate documents, the spec author should still consider these dimensions and document any constraints inline.

#### 2.1.4 Clarify ambiguities with the stakeholder

Before writing the spec, ask 2–3 targeted questions about scope, priority, or design direction. Good clarifying questions are those that would materially change the spec if answered differently. Bad questions are those that can be inferred from context or merely confirm obvious requirements.

Examples of good clarifying questions:

- "Should the inference distinguish between specific modes (drove vs flew vs train) or is a simpler categorization sufficient?" — This materially changes algorithm complexity.
- "Is this a separate dedicated view or rich metadata on existing collections?" — This changes UI architecture.
- "Is there anything else in the same lines? Hidden?" — This expanded one project's scope from favorites-only to favorites + ratings + hidden, tripling the feature's value.

---

### 2.2 Strategic Framing (Phase 2)

Every spec opens with sections that establish *why* this feature exists and how it relates to the system. This is not boilerplate — it is the section developers read to understand the purpose behind every subsequent technical decision.

#### 2.2.1 Strategic Goal with "Success Looks Like"

Write a concise paragraph stating what problem this solves. The best strategic goals include a "success looks like" sentence that traces the user's complete journey through the feature:

> "**Success looks like:** User hovers over photo → heart icon appears → clicks → item marked as favorite → keyboard 1-5 sets star rating → ratings appear as overlay → H key hides item → all views respect these flags → facets filter by any combination → bulk operations work on selections → all actions create audit trail and are reversible."

This narrative forces you to think through the complete user experience before diving into technical details. It also serves as a quick-reference acceptance test: if the final implementation doesn't match this narrative, something was missed.

#### 2.2.2 Spec Requirements Traceability

If the project has a master spec or PRD, create a table linking this feature's requirements back to specific sections in that document:

| Requirement | Spec Section | Notes |
|-------------|--------------|-------|
| User selects source folders | §2.1 | One or more folders, recursive scanning |
| Results show immediately | §2.1 | Streaming, not batch |
| 60fps scrolling in large grids | §3.1 | Virtualization required |

This prevents scope creep and ensures nothing from the original vision is missed. It also provides a paper trail for why specific decisions were made.

#### 2.2.3 "Why This Feature Matters"

Explain the pain point or gap. The most effective approach is comparing your system's approach against common alternatives:

> "Most apps in this category either ignore duplicates (bloated library), delete duplicates automatically (data loss risk), or require manual review of every group (tedious). Our system takes a better approach: automatically select the best version, keep all versions accessible, allow manual override, and never delete anything."

For strategic features where the choice between approaches isn't obvious, use a comparison table:

| Factor | Approach A (Automated) | Approach B (Manual) |
|--------|----------------------|---------------------|
| Complexity | High (ML pipeline, embeddings) | Low (UI for drawing boxes) |
| Setup burden | Model downloads, GPU detection | None |
| Time to value | Weeks | Days |
| Accuracy | Variable (requires tuning) | Perfect (user-defined) |

#### 2.2.4 Relationship to Other Features

Create an explicit table mapping every feature this one touches, with a column explaining *what* the relationship is (settings contributed, schema shared, data consumed, UI pattern reused, query dimension added). This is the single most valuable reference for the developer when they encounter integration points during implementation.

#### 2.2.5 Design Principles

List 3–5 principles that guide decisions throughout the spec. These act as tie-breakers when the developer faces ambiguous situations:

Examples: "Instantly Accessible," "Non-Destructive," "Offline-First," "Content Is Hero," "Batch-First," "Privacy by Default."

---

### 2.3 Technical Specification (Phase 3)

This is the bulk of the document. Each section below should be present when applicable.

#### 2.3.1 Strategic Decisions

Document non-obvious architectural choices with rationale. Use comparison tables when the choice isn't self-evident.

Include compatibility strategies if this feature is designed to be extended later. Define exactly which fields are nullable, which tables are shared, and how the source/provenance of data is distinguished (e.g., `source = 'manual'` vs `'detected'`).

> **Naming convention note:** Some projects use "Decisions Made" tables with Decision/Rationale columns. Others use dedicated "Strategic Decisions" sections with richer prose and named subsections like "Why Approach B Before Approach A?" The richer format is generally preferred as it communicates reasoning more effectively.

#### 2.3.2 Database Schema

For every new or modified table:

- Column name, type, constraints, and purpose
- Indexes with rationale (which queries they accelerate)
- Foreign key relationships
- Migration strategy for existing data
- Scalability notes if the table will grow large

Use table format for schema definitions. Include full CREATE TABLE pseudo-SQL only if the schema is complex enough to warrant it.

Document entity relationships with ASCII diagrams when multiple tables are involved:

```
┌─────────────────────────────────────────────┐
│ ITEM                                         │
│  ┌──────────┐   ┌──────────┐                │
│  │ instance │   │ instance │  ← per-item     │
│  └────┬─────┘   └────┬─────┘                │
└───────┼───────────────┼─────────────────────┘
        │               │
        └───────┬───────┘
         ┌──────▼──────┐
         │   cluster   │  ← groups instances
         └──────┬──────┘
         ┌──────▼──────┐
         │   entity    │  ← named identity
         └─────────────┘
```

#### 2.3.3 API / RPC Methods

For each new backend method:

- Method name following existing naming conventions
- Parameters with types and validation rules
- Return shape
- Error cases and error codes
- Whether it's a query (synchronous) or command (may trigger background work)
- Streaming, backpressure, and correlation ID requirements if applicable

Group methods by domain (CRUD operations, queries, batch operations, lifecycle management).

#### 2.3.4 Events / Notifications

If the feature emits events for the frontend:

- Event name and payload shape
- Emission trigger
- Coalescing rules (how rapid-fire events are batched)
- Which UI components subscribe

#### 2.3.5 UI Specification

Describe every new or modified UI component:

- **ASCII mockups** showing layout, spacing, and content hierarchy. These don't need to be pixel-perfect but must convey structure, nesting, and information density.
- **Interaction model:** What happens on click, hover, keyboard shortcut, drag, right-click.
- **State transitions:** Empty state, loading, populated, error, disabled.
- **Animation intent:** Describe purpose ("subtle fade-in on toggle, ~150ms") not implementation. Never specify CSS values or easing curves in a spec.

> **Critical learning:** LLMs fundamentally struggle with animation code because they cannot visualize timing or easing curves. Describe animation *intent* and let the developer choose implementation. This applies to any spec consumed by AI agents.

#### 2.3.6 Keyboard Shortcuts and Accessibility

Define all keyboard shortcuts with conflict avoidance against existing shortcuts. Specify focus management, screen reader announcements, and ARIA roles where applicable.

#### 2.3.7 Settings Integration

For every configurable value:

- Settings key path (e.g., `faces.minSize`, `export.defaultFormat`)
- Type and validation (range, enum, pattern)
- Default value with rationale
- Where the setting appears in the settings UI
- Runtime behavior when changed (immediate vs next operation)

#### 2.3.8 Algorithms and Processing Logic

When the feature involves non-trivial computation (scoring, detection, inference, clustering):

- Describe the algorithm in prose first
- Provide pseudocode for the core logic
- Define confidence scores, thresholds, and fallback behavior
- Specify determinism requirements (same input must produce same output for scoring)
- Include worked examples with realistic data

Do NOT write production code. Pseudocode gives the developer enough to implement correctly while allowing them to choose the right abstractions for the codebase.

#### 2.3.9 Integration Points

Explicitly describe how this feature integrates with every existing system surface. This is the most frequently missed section in feature specs. Every feature should consider:

| Integration Surface | What to Specify |
|---------------------|----------------|
| Navigation / Sidebar | Which section, navigation item, count display |
| Detail / Inspector Panel | New tabs, new fields in existing tabs |
| Grid / List Views | Overlays, badges, selection behavior changes |
| Facets / Query / Search | New dimensions, filter operators |
| Map | New layers, markers, interactions |
| Export | New tokens, new output sections |
| External API | New query parameters or endpoints |
| Auto-generated Views | New browsable dimensions or grouping options |

If a feature should appear somewhere, say so explicitly. Integration points that are "obvious" to the spec author are frequently missed by the implementer.

---

### 2.4 Implementation Planning (Phase 4)

#### 2.4.1 Dev Task Breakdown

Break the feature into numbered implementation tasks, ordered for vertical-slice development. Each task gets a unique ID following the pattern `{feature}.{task}` (e.g., 12.1, 12.2). Complex tasks can have sub-tasks numbered as `{feature}.{task}.{subtask}`.

Each task includes:

- **"What We're Building"** — One paragraph describing the deliverable
- **Schema changes** (if any)
- **API methods** (if any)
- **UI components** (if any)
- **Acceptance criteria** — Checkbox list of verifiable outcomes

Task ordering follows vertical-slice principles:

1. Database schema and migration first — everything else depends on data
2. Backend API methods second — UI needs something to call
3. Core UI third — the primary interaction surface
4. Integration points fourth — navigation, facets, inspector, grid
5. Batch operations and edge cases fifth
6. Settings integration last (or alongside relevant tasks)

Each task should be independently implementable and testable. A developer should be able to complete task N, write its test, verify it passes, and then move to task N+1.

#### 2.4.2 E2E Test Scenarios

Write test scenarios in Gherkin-style Given/When/Then format. Each test should:

- Have a descriptive name following the pattern `{feature_under_test}` (e.g., `tag_item_and_filter_by_entity`, `merge_duplicate_records`)
- Specify fixture requirements
- Describe the complete user journey, not individual assertions
- Cover the happy path first, then edge cases
- Be independently runnable (no ordering dependencies between tests)

Example:

```gherkin
Test: merge_duplicate_records

Given "Emma" exists with 10 items
And "Emmy" exists with 5 items (same person, duplicate entry)
When I go to Emma's profile
And I click "Merge with another record"
And I select "Emmy"
And I confirm the merge
Then Emma has 15 items
And Emma's aliases include "Emmy"
And "Emmy" record no longer exists
```

Cover: primary happy path, each major feature path, important error conditions, batch operations, keyboard shortcuts, and integration with other features.

#### 2.4.3 Edge Cases and Error Handling

Catalog edge cases with the condition, expected behavior, and rationale. Common categories:

- **Empty states:** No data, no results, no selection
- **Boundary values:** Minimum, maximum, zero, negative
- **Concurrent operations:** User acts while background processing runs
- **Data integrity:** Missing fields, corrupted data, orphaned records
- **Permission / privacy:** Hidden items, private data exposure
- **Scale:** What happens at 10K, 100K, 1M records
- **Undo / revert:** Reversibility of all user actions
- **Migration:** Existing data that lacks the new fields

#### 2.4.4 Stable Test Selectors

Define all test selectors (e.g., `data-testid` attributes) in a table. These serve double duty: tests use them for reliable element targeting, and they document the complete UI surface area.

Group selectors by component or area. Follow a consistent naming convention like `{component}-{element}-{qualifier}`.

#### 2.4.5 Performance Targets

Define measurable performance targets:

| Operation | Target | Measurement |
|-----------|--------|-------------|
| Query response | <200ms | Time from request to response |
| UI interaction | 60fps | No dropped frames |
| Bulk operation | >N items/sec | Throughput |
| Background job | <Nms per item | Processing rate |

These become part of the acceptance criteria and should be validated in tests or benchmarks.

#### 2.4.6 Closing Sections

Every spec ends with:

- **Dependencies Summary:** Clean table splitting hard dependencies (must complete first) from soft dependencies (enhance but not required).
- **What This Feature Enables:** Bullet list of downstream capabilities unlocked.
- **Out of Scope:** Explicitly list what is NOT covered, referencing which future feature or spec will handle it.
- **Future Considerations:** Brief notes on known future enhancements the current design should accommodate without implementing. These influence schema design (nullable fields for future use) and API design (extensible parameter objects).

---

## 3. The Canonical Section Order

```
# Feature N — {Name}

## Strategic Goal
## Why This Feature Matters
## Spec Requirements (traceability to master spec / PRD)
## Relationship to Other Features
## Design Principles
## Strategic Decisions (with rationale tables)
## Dependencies and Gates

--- TECHNICAL SPECIFICATION ---

## Core Concepts (domain model, entity relationships)
## Database Schema
## API / RPC Methods
## Events / Notifications
## UI Specification (with ASCII mockups)
## Keyboard Shortcuts
## Settings Integration
## Algorithms (pseudocode where needed)
## Integration Points

--- IMPLEMENTATION ---

## Dev Task Breakdown (numbered, ordered for vertical slices)
  ### Task N.1: {Name}
    #### What We're Building
    #### Schema Changes
    #### API Methods
    #### UI Components
    #### Acceptance Criteria

## Stable Test Selectors
## E2E Test Scenarios (Gherkin-style)
## Edge Cases and Error Handling
## Performance Targets
## Acceptance Criteria (global)

--- CLOSING ---

## Dependencies Summary (hard / soft table)
## What This Feature Enables
## Out of Scope
## Future Considerations
```

---

## 4. Calibrating Spec Depth by Feature Type

Not every feature needs the same level of detail. The right depth depends on what the feature is establishing.

### Foundation features (early in a project)

These establish the core patterns that everything else builds on. They should be **more prescriptive** about code structure, naming conventions, and communication contracts because they are defining patterns for the first time.

- Include specific file paths and environment variable names when establishing infrastructure conventions.
- Include typed interface definitions when defining a contract that other features build on.
- Include the full query model or data structure when it becomes the shared language of the system.

**Principle:** When you're defining a pattern others will follow, be specific. When you're following an established pattern, reference it rather than redefining it.

### Enrichment / domain features (mid-project)

These follow established patterns but introduce domain-specific complexity. They should shift from code-level specificity toward algorithmic descriptions.

- Introduce offline data setup scripts as reusable patterns (e.g., geographic data, classification databases).
- Pioneer algorithmic pseudocode for processing logic (clustering, scoring, inference).
- Spawn addendums for future iteration when the initial implementation reveals a richer design space.

### Complex technical features (AI, ML, pipelines)

These are the most technically demanding specs. They include model management, worker process lifecycle, multi-stage pipelines, and storage optimization strategies.

- Include CLI specifications for model management and setup.
- Detail long-running worker lifecycle (startup, request handling, shutdown).
- Heavily reference scalability gate requirements because they typically create the largest data stores.

### Integration / system features (mid-to-late project)

These integrate earlier features into coherent UI surfaces. They tend to be structurally complex with hierarchical state machines, dependency resolution, and multi-tab UIs.

- Include state machine diagrams for lifecycle management.
- Define dependency graphs between sub-tasks.
- Provide the most detailed ASCII mockups because the UI is the primary deliverable.

### Late-stage features (mature project)

These benefit from all earlier learnings. They are the most polished specs and often the longest.

- Open with strategic comparison tables and explicit compatibility strategies.
- Include the most refined "success looks like" narratives.
- Contain exhaustive cross-feature integration tables.
- Map configurable values across the entire system into a unified schema.

---

## 5. Patterns and Anti-Patterns

### 5.1 Patterns That Work

**Comparison tables for strategic decisions.** Lay alternatives side by side with evaluation factors as rows. This makes reasoning transparent and auditable.

**"Success looks like" narratives.** A single sentence tracing the complete user journey forces you to think through every interaction point before specifying them individually.

**ASCII mockups over prose descriptions.** A 20-line ASCII box diagram communicates layout faster and more precisely than three paragraphs of text. Every UI section should have one.

**Explicit compatibility strategies.** When a feature is designed to be extended, document exactly how future data coexists with current data. Define discrimination fields, nullable columns, and migration-free evolution paths.

**Cross-feature integration tables.** Tables mapping every feature to its contributed export tokens, settings keys, or query dimensions are the gold standard for documenting integration surfaces.

**Pseudocode for non-trivial algorithms.** Precise enough to implement from but doesn't constrain the developer's choice of abstractions. Include: scoring functions, detection algorithms, clustering heuristics, and inference engines.

**Descriptive test scenario names.** `tag_item_and_filter_by_entity` tells the developer what the test proves. `test_3` does not.

**Addendums for extending reviewed specs.** Once a spec has been reviewed and implementation has started, extend it via addendums rather than silently modifying the original. This preserves the review history and makes changes explicit.

### 5.2 Anti-Patterns to Avoid

**Writing implementation code in specs.** The moment you write a complete interface definition or a full migration script, you've crossed from specification into implementation. Use pseudo-SQL, pseudocode, and type-like descriptions instead.

**Specifying animation curves or exact style values.** Describe intent ("subtle fade, ~150ms") and let the developer choose the implementation. LLMs particularly struggle with getting timing and easing right.

**Leaving integration points implicit.** If a feature should appear in the sidebar, say so. If it should create a new facet dimension, specify the config. "Obvious" integration points are the ones most frequently missed by implementers.

**Conflating dev tasks with acceptance criteria.** A dev task says "what to build." Acceptance criteria say "how to verify it's built correctly." These should be separate and complementary.

**Over-specifying UI layout.** ASCII mockups should show structure and content hierarchy, not pixel measurements. Let the design system handle spacing, colors, and typography.

**Skipping edge cases.** The implementation time spent on edge cases is proportional to how well they're specified. Unspecified edge cases become bugs or inconsistencies.

---

## 6. Non-Negotiable Development Rules

Embed these rules across all specifications:

### Rule 1: "No Feature Without an E2E Test"

A feature is not done until: it is reachable via the real UI, it works end-to-end through the full stack, it has an isolated test that proves it works, and the test uses deterministic fixtures.

### Rule 2: Vertical Slices Only

For every feature, implement in this exact order: UI affordance → bridge/API layer → backend implementation → data layer → test proving it works. Never implement all database changes first, then all API changes, then all UI. Each task should produce a working vertical slice.

### Rule 3: Deterministic Testing

Tests use fixtures and stubs. Never use sleep-based waits. Always disable animations in test mode. Tests must be independently runnable with no ordering dependencies between them.

### Rule 4: Offline-First / Privacy-First

All processing happens locally by default. No sensitive data exposed to external services. Network access is always optional and opt-in.

### Rule 5: Restartable Background Work

Every background job supports pause, resume, cancel, and reset. This is not optional — it is a core contract that users depend on for safety when working with large datasets.

---

## 7. Process Checklist

Use this checklist when creating a new feature specification.

### Before Writing

- [ ] Searched existing specs for related tables, APIs, and UI patterns
- [ ] Mapped hard and soft dependencies in both directions
- [ ] Checked architecture gates for applicable constraints
- [ ] Asked clarifying questions about scope, priority, and design direction
- [ ] Identified which existing feature patterns this one should follow

### During Writing

- [ ] Strategic Goal includes "success looks like" narrative
- [ ] Spec Requirements traceability table links back to master spec / PRD
- [ ] Relationship table covers all touched features
- [ ] Database schema includes indexes and migration strategy
- [ ] API methods include error cases and validation rules
- [ ] UI sections have ASCII mockups for every new component
- [ ] All configurable values have settings keys defined
- [ ] Algorithms described in prose + pseudocode (no production code)
- [ ] Integration points explicitly documented for every existing system surface
- [ ] Dev tasks numbered and ordered for vertical-slice implementation
- [ ] Each dev task has acceptance criteria as checkbox list
- [ ] Stable test selectors defined for every UI element
- [ ] E2E tests cover happy path, edge cases, keyboard shortcuts, batch operations
- [ ] Edge cases cataloged with expected behavior and rationale
- [ ] Performance targets defined with measurement methods
- [ ] Out of scope section explicitly states what is deferred

### After Writing

- [ ] Spec reviewed against architecture gates one final time
- [ ] No production code in the document (pseudocode and schemas only)
- [ ] Cross-references to other features are correct and bidirectional
- [ ] A developer with no prior context could implement from this spec alone
- [ ] Acceptance criteria are verifiable (checkboxes, not vague statements)
- [ ] Settings keys don't conflict with existing configuration namespaces

---

## 8. Final Notes

Specification quality is proportional to implementation quality. A vague spec produces a vague implementation with missing edge cases and integration gaps. A precise spec produces a precise implementation that passes its E2E tests on the first serious attempt.

The investment in specification detail is especially critical when working with AI coding agents, where the spec is the primary communication channel. Every ambiguity in the spec is a decision the agent will make on its own — sometimes correctly, sometimes not. The more decisions are made in the spec, the more predictable the implementation.

Treat specs as living documents during implementation. Addendums are the right mechanism for extending specs after review, rather than silently modifying the original.

**The process in one sentence:** Gather context deeply, frame strategy clearly, specify technically precisely, plan implementation as vertical slices, test everything end-to-end, and document what you defer.
