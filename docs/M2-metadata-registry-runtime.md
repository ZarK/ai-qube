# M2 - Metadata Registry And Runtime

## Goal

Implement the registry-driven command model and runtime helpers that let TypeScript CLI packages define commands once and reuse the same metadata for parser behavior, help, schema, validation, and tests.

This milestone proves the core model with a small fixture CLI before any real consuming package migrates.

## Scope

| ID | Requirement | Source |
| --- | --- | --- |
| M2-001 | Implement command-definition helpers for commands, topics, flags, arguments, and examples. | FR-01-005 |
| M2-002 | Model command names, topics, arguments, flags, examples, supported output formats, mutation categories, external services, stable error kinds, exit codes, dry-run support, JSON trigger support, help, no-color, non-interactive mode, and TTY prompts. | FR-02-001, FR-02-003 |
| M2-003 | Support command names with space-separated topics such as `cache clear`, while distinguishing executable commands from non-executable topics. | FR-02-002 |
| M2-004 | Support consumer-defined extension metadata without requiring toolkit knowledge of product-specific schemas. | FR-02-004, FR-04-003 |
| M2-005 | Implement registry helpers to create, validate, find, and list commands and topics. | FR-01-006 |
| M2-006 | Validate duplicate command names, duplicate aliases, missing descriptions, undocumented flags, unsupported flag types, missing examples, and inconsistent mutation metadata. | FR-02-005 |
| M2-007 | Derive oclif command statics and parser behavior from metadata where practical. | FR-02-006, FR-03-002, FR-03-004 |
| M2-008 | Implement runtime helpers for creating command classes, topic commands, schema command registration hooks, and CLI runners. | FR-01-007 |
| M2-009 | Normalize standard help forms: `<bin> --help`, `<bin> help`, `<bin> help <command>`, `<bin> <command> --help`, and `<bin> <command> help`. | FR-03-006, FR-03-007 |
| M2-010 | Render root, topic, and command help from metadata with usage, arguments, flags, examples, mutation behavior, dry-run support, and JSON trigger support. | FR-03-008, FR-03-009 |
| M2-011 | Implement safe command and flag suggestions for high-confidence misses without executing suggestions automatically. | FR-03-010, FR-03-011 |
| M2-012 | Add a product-neutral fixture CLI that exercises topics, read-only commands, mutating dry-run commands, aliases, unknown command handling, and help forms. | FR-01-009, FR-07-002 |

## Out Of Scope

- Final JSON schema renderer details beyond data structures needed by M3.
- Consumer migrations.
- Completion generation.
- Product-specific config validation or service-specific behavior.

## Acceptance Criteria

- Fixture CLI root help is concise and stable.
- Fixture CLI command help is generated from metadata and does not execute command handlers.
- `fixture help <command>` and `fixture <command> help` render the same command help as `fixture <command> --help`.
- Registry validation catches intentionally invalid fixture definitions in tests.
- Unknown commands and misspelled flags can suggest likely matches, but tests prove no handler executes as a side effect.
- Tests prove arbitrary command-prefix abbreviations do not execute.
- Public APIs are documented enough for a consuming package to define command metadata and bind a handler.

## Adoption Constraint

M2 must remain product-agnostic. It can support consumer-defined extension metadata, but it must not import, depend on, or encode product-specific models.
