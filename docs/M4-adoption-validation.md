# M4 - Adoption Validation

## Goal

Prove that the toolkit is reusable by adopting it in real TypeScript command-line packages without changing ownership boundaries.

The toolkit must remain infrastructure. Consuming packages continue to own the behavior and side effects of their commands.

## Scope

| ID | Requirement | Source |
| --- | --- | --- |
| M4-001 | Add an adoption guide showing how a consuming package defines command metadata, creates a registry, binds handlers, emits schema, renders JSON/human output, and tests CLI behavior. | FR-07-004, FR-07-005 |
| M4-002 | Create a compatibility checklist for existing consumers: help text, help forms, command names, flags, examples, JSON stdout, error shape, exit codes, schema fields, dry-run behavior, and mutation warnings. | FR-07-001, FR-07-002 |
| M4-003 | Validate migration of at least one read-only command to toolkit-backed metadata/runtime behavior. | FR-01-008, FR-07-002 |
| M4-004 | Validate migration of at least one mutating or dry-run-capable command to toolkit-backed metadata/runtime behavior. | FR-05-001, FR-05-002, FR-07-002 |
| M4-005 | Keep command behavior, side effects, policy decisions, and external command execution inside consuming packages. | NFR-02-001, NFR-02-002, NFR-02-003 |
| M4-006 | Add consumer contract tests that compare migrated command help, schema, JSON stdout, structured errors, exit codes, and dry-run disclosure against expected behavior. | FR-07-001, FR-07-002 |
| M4-007 | Validate that a small CLI can adopt registry-backed help and schema without pulling in unrelated toolkit surfaces. | FR-01-003, FR-01-004, FR-07-007 |
| M4-008 | Document adoption findings as generic package guidance. | NFR-02-001, NFR-02-002 |
| M4-009 | Document semantic-versioning expectations for public API changes after consumer adoption begins. | FR-07-006 |

## Out Of Scope

- Migrating every command in any consuming package.
- Adding product behavior to this package.
- Adding new toolkit surfaces beyond adoption fixes.
- Executing external commands from the toolkit itself.
- Creating a third-party plugin ecosystem.

## Acceptance Criteria

- At least one read-only command runs through toolkit-backed metadata/runtime helpers.
- At least one mutating or dry-run-capable command runs through toolkit-backed metadata/runtime helpers.
- Consuming packages still own command behavior and side effects.
- A small CLI can expose registry-backed help and schema with only the needed toolkit imports.
- Contract tests pass in each migrated consuming package.
- Any behavior changes are explicitly documented as intended CLI consistency improvements.
- The adoption guide is sufficient for a later consuming package to add a first command without reading toolkit internals.

## Rollout Notes

Prefer gradual adoption. Existing CLIs may already have behavior that users or automation rely on, so command-by-command migration with contract tests is safer than broad rewrites.
