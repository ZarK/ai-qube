# M3 - Schema Output And Safety

## Goal

Add the agent-facing and safety-oriented helpers that make CLIs deterministic for automation and safe by default for humans.

This milestone turns the registry/runtime foundation into a reusable surface for TypeScript command-line packages.

## Scope

| ID | Requirement | Source |
| --- | --- | --- |
| M3-001 | Implement deterministic schema rendering for package name, version, binary name, topics, commands, arguments, flags, defaults, options, examples, mutation behavior, dry-run support, structured output support, error kinds, exit codes, and extension sections. | FR-04-001, FR-04-002, FR-04-003 |
| M3-002 | Provide standard JSON success and error envelopes with command name, stable error kind, failed operation, likely cause, suggested next action, and exit-code category. | FR-04-004, FR-04-007, FR-04-008 |
| M3-003 | Ensure JSON mode writes only valid JSON to stdout and sends warnings, progress, hints, prompts, and diagnostics to stderr. | FR-04-005, NFR-01-006 |
| M3-004 | Add output helpers for command-specific human renderers and command-specific JSON result shapes. | FR-04-006 |
| M3-005 | Implement mutation metadata helpers for `local-files`, `local-config`, `external-service`, `dependency`, `release`, and consumer-defined categories. | FR-05-001 |
| M3-006 | Implement dry-run plan and mutation warning renderers with consistent rerun guidance. | FR-05-002, FR-05-003, FR-05-004 |
| M3-007 | Add supply-chain-sensitive command metadata and helper output without owning approval policy or command execution. | FR-05-005, FR-05-006 |
| M3-008 | Implement prompt gating around Clack so prompts are blocked in JSON output, CI, non-TTY execution, and explicit non-interactive flows. | FR-03-003, FR-03-012, FR-03-013 |
| M3-009 | Implement terminal capability detection, no-color behavior, and degradation for non-TTY/CI output. | NFR-01-005 |
| M3-010 | Implement redaction helpers for common token-like values in errors, debug logs, diagnostics, and rendered summaries. | FR-05-007, FR-05-008 |
| M3-011 | Add reusable CLI test helpers for command execution, stdout/stderr assertions, JSON parsing, help snapshots, prompt-blocking, dry-run checks, and pack-safety assertions. | FR-07-001, FR-07-002, FR-07-003 |

## Out Of Scope

- Product-specific policy decisions about whether a mutating command is allowed.
- Running external commands.
- Uploading diagnostics or telemetry.
- Product-specific schemas beyond extension sections supplied by consumers.

## Acceptance Criteria

- Fixture CLI `schema --json` is deterministic across repeated runs.
- Fixture JSON commands produce parseable JSON on stdout with no warning/progress text mixed in.
- Known fixture errors render stable human output and stable JSON output.
- Dry-run fixture commands render mutation targets and rerun guidance without mutating fixture state.
- Prompt tests prove prompts are skipped or blocked in JSON, CI, non-TTY, and explicit non-interactive modes.
- Redaction tests cover token-like values in direct strings and structured diagnostics.
- Test helpers are used by the fixture CLI tests rather than only unit-tested in isolation.

## Adoption Constraint

M3 must remain product-agnostic. Schema extension sections, JSON result fields, human renderers, mutation policies, and approval decisions are supplied by consuming packages.
