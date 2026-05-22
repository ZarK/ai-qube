# CLI Toolkit - Functional Requirements Specification

## Purpose

This document defines a reusable TypeScript toolkit for building command-line interfaces that are pleasant for humans and reliable for automation.

The package is a library. It provides command metadata, registry helpers, runtime adapters, help rendering, structured output, schema introspection, dry-run and mutation metadata, prompt gating, terminal formatting, redaction, and reusable CLI test helpers. Consuming packages provide their own commands, product logic, and service integrations.

Requirements use stable identifiers (`FR-XX-NNN` and `NFR-XX-NNN`) so implementation work can reference scope precisely.

## Design Principles

- A CLI should be discoverable from the terminal without reading external docs.
- Agents should use schema and JSON output rather than scraping human help text.
- Mutating commands should make risk visible and support dry-run unless impossible.
- Interactive prompts should improve human workflows without blocking non-interactive use.
- Safe defaults should be built into the package, especially around dependencies, output, prompts, and secrets.

## FR-01 - Toolkit Surface

| ID | Requirement | Status |
|----|-------------|--------|
| FR-01-001 | The package provides shared CLI infrastructure for TypeScript npm packages. | Required |
| FR-01-002 | The package publishes compiled JavaScript, type declarations, and a documented public TypeScript API. | Required |
| FR-01-003 | The root export supports the common path: define commands, create a registry, create a CLI runtime, render help, render schema, return structured results, raise structured errors, detect terminal capability, gate prompts, redact sensitive values, and test CLI behavior. | Required |
| FR-01-004 | The package may expose stable subpaths for larger surfaces: `metadata`, `registry`, `runtime`, `help`, `schema`, `output`, `errors`, `mutation`, `prompts`, `terminal`, `redaction`, and `testing`. | Required |
| FR-01-005 | The package provides command-definition helpers such as `defineCommand`, `defineTopic`, `defineFlag`, `defineArgument`, and `defineExample`, or equivalent documented APIs with the same responsibilities. | Required |
| FR-01-006 | The package provides registry helpers such as `createCommandRegistry`, `validateCommandRegistry`, `findCommand`, `listTopics`, and `listCommands`, or equivalent documented APIs. | Required |
| FR-01-007 | The package provides runtime helpers such as `createCli`, `createCommand`, `createTopicCommand`, `createSchemaCommand`, and `runCli`, or equivalent documented APIs that bind metadata to parser behavior and command execution. | Required |
| FR-01-008 | The package provides help, schema, output, error, mutation, prompt, terminal, redaction, and test helpers sufficient to build a multi-command CLI without hand-rolled parser glue, help normalization, JSON envelopes, schema rendering, or prompt gating. | Required |
| FR-01-009 | The package includes a small fixture CLI used by tests and examples. The fixture demonstrates the reusable APIs without embedding product-specific behavior. | Required |

## FR-02 - Metadata And Registry

| ID | Requirement | Status |
|----|-------------|--------|
| FR-02-001 | Command metadata models command names, topics, arguments, flags, examples, supported output formats, mutation categories, external services, stable error kinds, and exit codes. | Required |
| FR-02-002 | Command metadata supports space-separated command names such as `cache clear` while distinguishing executable commands from non-executable topics. | Required |
| FR-02-003 | Command metadata records support for `--dry-run`, JSON triggers such as `--json` and `--output json`, `--help`, `--no-color`, non-interactive mode, and TTY prompts. | Required |
| FR-02-004 | Command metadata can include consumer-defined extension fields without the package knowing product-specific schemas. | Required |
| FR-02-005 | Registry validation catches missing descriptions, duplicate command names, duplicate aliases, undocumented flags, malformed flag names, missing examples, inconsistent mutation metadata, and unsupported flag types. | Required |
| FR-02-006 | Framework command statics can be derived from metadata where practical so help, schema, validation, and executable behavior do not drift. | Required |
| FR-02-007 | Flag metadata stores canonical flag names without leading dashes, such as `json` or `dry-run`; help and schema rendering are responsible for user-facing tokens such as `--json` or `--dry-run`. | Required |

## FR-03 - Runtime And CLI Behavior

| ID | Requirement | Status |
|----|-------------|--------|
| FR-03-001 | The package uses `@oclif/core` as the command-tree framework and `@clack/prompts` as the TTY prompt library. | Required |
| FR-03-002 | The package builds on oclif command parsing, flag parsing, command loading, help primitives, and test support instead of reimplementing parallel parser or command-dispatch behavior. | Required |
| FR-03-003 | The package builds on Clack prompt primitives instead of reimplementing prompt rendering, terminal input handling, or prompt cancellation behavior. | Required |
| FR-03-004 | Framework-specific details are wrapped behind exported helpers where this removes repeated consumer boilerplate, while keeping command names, stack traces, and command tests understandable. | Required |
| FR-03-005 | The package must not enable framework plugin auto-installation, remote plugin loading, telemetry, auto-updating behavior, or hidden remote execution. | Required |
| FR-03-006 | Standard help forms are supported: `<bin> --help`, `<bin> help`, `<bin> help <command-or-topic...>`, `<bin> <command-or-topic...> --help`, and `<bin> <command-or-topic...> help`. | Required |
| FR-03-007 | Help invocations are always non-mutating. The final token `help` is reserved for help lookup and must not be treated as a positional argument to a mutating command. | Required |
| FR-03-008 | Root help shows a concise landing page with purpose, common next commands, exploration paths, and mutation expectations instead of a raw parser dump. | Required |
| FR-03-009 | Command and topic help includes purpose, usage, arguments, flags, examples, mutation behavior, dry-run support, and JSON trigger support. | Required |
| FR-03-010 | Unknown commands and misspelled flags may suggest alternatives when confidence is high. Suggestions must never execute automatically. | Required |
| FR-03-011 | Arbitrary command-prefix abbreviations are not accepted. Short aliases are allowed only when explicit, documented, stable, and tested. | Required |
| FR-03-012 | Prompt helpers never prompt in JSON output, CI, non-TTY execution, or explicit non-interactive flows such as `--yes` or `--defaults`. | Required |
| FR-03-013 | Prompt helpers always have flag or config equivalents in consuming commands. | Required |

## FR-04 - Output, Schema, And Errors

| ID | Requirement | Status |
|----|-------------|--------|
| FR-04-001 | The package provides a deterministic schema renderer for command-line packages. | Required |
| FR-04-002 | Schema output includes package name, package version, binary name, command metadata, topics, arguments, canonical flag names, rendered flag tokens, defaults, options, examples, mutation behavior, dry-run support, structured output support, stable error kinds, and exit codes. | Required |
| FR-04-003 | Schema output can include consumer-defined extension sections without requiring product-specific code in the toolkit. | Required |
| FR-04-004 | The package provides standard JSON success and error envelopes. Success output includes at least `ok`, `command`, and consumer-defined result fields. Error output includes `ok: false`, `command`, stable error kind, failed operation, likely cause, suggested next action, and exit code category. | Required |
| FR-04-005 | JSON-triggered output writes only valid JSON to stdout. Warnings, progress, hints, prompts, and diagnostics go to stderr unless the command's primary result is itself a diagnostic report. | Required |
| FR-04-006 | Output helpers support both command-specific human renderers and command-specific JSON result shapes from the consuming package. | Required |
| FR-04-007 | Known command errors render stable JSON and human output. Unexpected failures remain real failures and must not be converted into success. | Required |
| FR-04-008 | Exit codes distinguish success (`0`), usage error (`2`), validation/config error (`3`), external tool or service error (`4`), safety block (`5`), and unexpected internal error (`70`). | Required |

## FR-05 - Mutation, Dry-Run, And Safety

| ID | Requirement | Status |
|----|-------------|--------|
| FR-05-001 | Command metadata supports mutation categories including `local-files`, `local-config`, `external-service`, `dependency`, `release`, and consumer-defined categories. | Required |
| FR-05-002 | Commands that mutate state declare mutation categories in metadata and support `--dry-run` unless dry-run is impossible for a documented reason. | Required |
| FR-05-003 | The package renders dry-run plans, mutation warnings, and "rerun without --dry-run" guidance consistently. | Required |
| FR-05-004 | Schema output marks mutating commands and mutation categories so automation can decide whether approval or extra checks are required. | Required |
| FR-05-005 | Commands can be marked as supply-chain-sensitive when they involve dependencies, package-manager commands, generators, CI/release workflow changes, IDE tooling, MCP servers, or AI-agent tools. | Required |
| FR-05-006 | The package provides metadata fields and output helpers for supply-chain blocks, but consuming packages own approval policy and external command execution. | Required |
| FR-05-007 | The package treats command arguments, flags, external service output, logs, comments, user-authored prose, and tool stdout/stderr as untrusted input. | Required |
| FR-05-008 | Redaction helpers protect common token-like values in errors, debug logs, diagnostics, and rendered summaries. | Required |
| FR-05-009 | The package must not upload source code, private data, logs, command payloads, or diagnostics to external services. | Required |
| FR-05-010 | The package must not execute shell commands synthesized from untrusted text. | Required |

## FR-06 - Package And Supply Chain

| ID | Requirement | Status |
|----|-------------|--------|
| FR-06-001 | The package targets Node.js 24 LTS or newer and uses pnpm for development and release workflows. | Required |
| FR-06-002 | The source tree has an explicit `packageManager` field, a checked-in `pnpm-lock.yaml`, exact dependency versions, and package-manager defaults that disable dependency lifecycle scripts and save exact versions where supported. | Required |
| FR-06-003 | Normal installation has no `preinstall`, `install`, or `postinstall` lifecycle scripts and must not mutate user projects, configure hooks, change shell profiles, contact external services, install other packages, or start background processes. | Required |
| FR-06-004 | Runtime dependencies are minimal and justified. New or upgraded dependencies require identity, exact version, source, publication age, integrity, execution-risk, and scope review before use. | Required |
| FR-06-005 | Newly introduced package versions must be at least 7 full days old; runtime, build-tooling, CLI, prompt, CI/CD, auth, crypto, networking, installer, postinstall, native binary, or transitive-heavy packages should be at least 14 full days old. | Required |
| FR-06-006 | The package avoids Git URL dependencies, branch dependencies, unverified tarballs, curl-pipe-shell installers, binary downloads, and generated-code packages unless explicitly justified and pinned to immutable identity. | Required |
| FR-06-007 | Release checks include install with frozen lockfile and scripts disabled, build, typecheck, tests, package dry-run, publish file assertions, dependency policy assertions, and no generated source artifact assertions. | Required |
| FR-06-008 | Publish workflows use least-privilege permissions, pinned third-party actions, and npm provenance or trusted publishing where available. | Required |

## FR-07 - Testing, Documentation, And Versioning

| ID | Requirement | Status |
|----|-------------|--------|
| FR-07-001 | Unit tests cover metadata validation, help normalization, schema rendering, JSON output helpers, error output helpers, prompt gating, redaction, terminal capability handling, and mutation/dry-run metadata. | Required |
| FR-07-002 | Integration tests use a fixture CLI to verify that help does not execute mutating handlers, JSON stdout is clean, suggestions do not execute, schema matches metadata, and prompts are blocked in non-interactive flows. | Required |
| FR-07-003 | Pack-safety tests assert that the npm tarball contains only intended runtime files, type declarations, README, license, and package metadata. | Required |
| FR-07-004 | Documentation includes a minimal consumer example that defines a command registry, creates a CLI, adds a schema command, renders JSON and human output, and tests help/schema behavior. | Required |
| FR-07-005 | Documentation shows supply-chain-safe install patterns that use exact versions, checked-in lockfiles, and lifecycle scripts disabled where supported. | Required |
| FR-07-006 | Public API changes follow semantic versioning. Breaking API changes require a major version bump once the package reaches stable release. | Required |
| FR-07-007 | The package exports stable subpaths only when intentionally supported. Unsupported internals are not exported accidentally. | Required |
| FR-07-008 | The package is ESM-first. CommonJS entrypoints are optional and only added if there is a concrete consumer need. | Required |

## NFR-01 - Experience Quality

| ID | Requirement | Status |
|----|-------------|--------|
| NFR-01-001 | Human-facing output is concise by default, with clear headings, readable spacing, and no decorative noise that hides the result. | Required |
| NFR-01-002 | Successful commands make the result obvious in the first screenful. Detailed evidence, logs, and secondary data are opt-in or placed after the summary. | Required |
| NFR-01-003 | Errors are specific and actionable. They identify what failed, why it likely failed, what state changed if any, and what the user can do next. | Required |
| NFR-01-004 | Interactive prompts are sparse, respectful, and reversible where practical. Prompts show defaults clearly and avoid asking for information already supplied by flags or config. | Required |
| NFR-01-005 | Color, icons, spinners, symbols, and progress affordances are allowed when they improve scanning in an interactive terminal, but they must degrade cleanly for non-TTY, CI, JSON, and no-color environments. | Required |
| NFR-01-006 | Agent-facing output is deterministic, schema-backed, bounded, and free of terminal decoration, progress text, prompt text, and unrelated diagnostics on stdout. | Required |
| NFR-01-007 | Command names, flags, examples, and error wording use consistent vocabulary across command groups so repeated use builds familiarity. | Required |
| NFR-01-008 | Safe behavior feels natural: dry-run, JSON-triggered output, non-interactive mode, and explicit confirmation paths are first-class command patterns rather than special cases. | Required |

## NFR-02 - Scope Boundaries

| ID | Requirement | Status |
|----|-------------|--------|
| NFR-02-001 | Consuming packages own the behavior of their commands, including validation rules, product logic, state management, service integrations, policy decisions, and side effects. | Required |
| NFR-02-002 | The package must not import, execute, bundle, or depend on consuming packages that use it. | Required |
| NFR-02-003 | The package does not mutate user projects, external services, user configuration, dependency state, release state, shell profiles, or background processes by itself. | Required |
| NFR-02-004 | The package does not install shell completions by side effect. Completion support can be added later as explicit output or an explicit command in consuming packages. | Future |
| NFR-02-005 | The package does not provide a terminal dashboard, rich TUI, or arbitrary third-party command plugin system. Those features require separate dependency and execution-risk design. | Future |
