# Compatibility Checklist

## Purpose

Use this checklist when migrating an existing command to `ai-qube-cli` metadata, registry, runtime, help, schema, output, mutation, prompt, terminal, redaction, and testing helpers.

Apply the checklist command by command. Existing command-line behavior may be used by people and automation, so gradual migration with contract tests is safer than broad rewrites.

## Scope Boundary

The toolkit provides reusable infrastructure. The consuming package remains responsible for command behavior, validation rules, product logic, state management, service integrations, policy decisions, external command execution, and side effects.

Do not move consumer-specific policy or side effects into this package while adopting the toolkit.

## Command Metadata

For each command or topic:

- [ ] The command name is stable, explicit, and not accepted through arbitrary prefix abbreviation.
- [ ] Topic metadata is separate from executable command metadata.
- [ ] Aliases are explicit, documented, stable, and tested.
- [ ] Arguments list names, descriptions, required state, and order.
- [ ] Flags list names, descriptions, value types, options, defaults, and aliases.
- [ ] Examples are real command lines that match the final binary name and command shape.
- [ ] Output formats declare whether human and JSON output are supported.
- [ ] Interaction metadata records JSON triggers such as `--json`, `--output json`, and `--output=json`, plus `--help`, `--no-color`, non-interactive mode, TTY prompts, and `--dry-run` where relevant.
- [ ] Stable error kinds and exit codes are listed for known failures.
- [ ] Consumer-defined extension sections contain only data the consuming package owns.

## Help Compatibility

Verify all standard help forms:

- [ ] `<bin> --help`
- [ ] `<bin> help`
- [ ] `<bin> help <command-or-topic...>`
- [ ] `<bin> <command-or-topic...> --help`
- [ ] `<bin> <command-or-topic...> help`

For each help output:

- [ ] Help does not execute command handlers or mutate state.
- [ ] Root help explains the package purpose and common next commands.
- [ ] Topic help lists child commands and aliases clearly.
- [ ] Command help includes purpose, usage, arguments, flags, examples, mutation behavior, dry-run support, JSON trigger support, and supply-chain sensitivity when present.
- [ ] Help text remains concise and deterministic enough for contract tests.

## JSON Output Compatibility

For every command that supports JSON:

- [ ] JSON-triggered output writes only valid JSON to stdout.
- [ ] Warnings, progress, hints, prompts, and diagnostics do not pollute stdout.
- [ ] Success envelopes include `ok: true`, `command`, and command-owned result fields.
- [ ] Error envelopes include `ok: false`, `command`, stable error kind, operation, likely cause, suggested next action, category, and exit code.
- [ ] Token-like values and sensitive structured keys are redacted before rendering output.
- [ ] Tests parse stdout as JSON instead of matching JSON with regular expressions.

## Human Output Compatibility

For every human-facing command:

- [ ] Successful output makes the result obvious in the first screenful.
- [ ] Error output identifies what failed, why it likely failed, and what to do next.
- [ ] Color, icons, spinners, symbols, and progress degrade cleanly in non-TTY, CI, JSON, and no-color environments.
- [ ] Human output does not become the source of truth for automation when schema or JSON output is available.

## Schema Compatibility

For the schema command:

- [ ] The schema includes package name, package version, binary name, topics, commands, arguments, flags, defaults, options, examples, mutation behavior, dry-run support, structured output support, stable error kinds, exit codes, and extension sections.
- [ ] Repeated schema runs produce byte-for-byte identical JSON for unchanged metadata.
- [ ] The schema includes migrated commands and intentionally excludes unsupported internals.
- [ ] Automation can use schema output instead of scraping human help text.

## Exit Codes And Errors

For known failures:

- [ ] Usage errors return category `usage` and exit code `2`.
- [ ] Validation or configuration errors return category `validation` and exit code `3`.
- [ ] External tool or service errors return category `external` and exit code `4`.
- [ ] Safety blocks return category `safety` and exit code `5`.
- [ ] Unexpected internal failures return category `unexpected` and exit code `70`.
- [ ] Unexpected internal failures remain failures and do not render success envelopes.
- [ ] Contract tests cover both human and JSON rendering for representative errors.

## Mutation, Dry-Run, And Safety

For commands that mutate state:

- [ ] Mutation categories are declared in metadata.
- [ ] `--dry-run` is supported unless impossible for a documented reason.
- [ ] Dry-run plans list actions, targets, categories, descriptions, and rerun guidance.
- [ ] Mutation warnings are rendered before side-effecting behavior where useful.
- [ ] Supply-chain-sensitive commands declare dependency, package-manager, generator, CI workflow, release, IDE tooling, MCP server, or AI-agent-tool risk where applicable.
- [ ] Approval policy, external command execution, and real side effects stay inside the consuming package.
- [ ] Tests prove dry-run output does not perform the mutation.

## Prompt And Non-Interactive Behavior

For commands that prompt:

- [ ] Prompts have flag, config, or default equivalents.
- [ ] Prompts are blocked in JSON output, CI, non-TTY execution, and explicit non-interactive flows.
- [ ] Prompt-blocked failures include an actionable next step.
- [ ] Tests cover JSON, CI, non-TTY, and explicit non-interactive prompt paths.

## Contract Tests

Use `ai-qube-cli/testing` helpers or equivalent assertions to verify:

- [ ] CLI execution status, stdout, and stderr.
- [ ] Help output and non-execution of handlers during help.
- [ ] JSON success envelopes.
- [ ] JSON error envelopes.
- [ ] Schema determinism and required schema fields.
- [ ] Prompt blocking.
- [ ] Dry-run disclosure and non-mutation.
- [ ] Pack contents when publishing an npm package.

Recommended command-level test matrix:

| Area | Read-only command | Mutating command |
| --- | --- | --- |
| Help forms | Required | Required |
| Human success | Required | Required when supported |
| JSON success | Required when supported | Required when supported |
| Known error | Required | Required |
| Schema fields | Required | Required |
| Dry-run | Not applicable unless declared | Required |
| Mutation warning | Not applicable | Required when command can mutate |
| Prompt blocking | Required when prompts exist | Required when prompts exist |

## Package And Supply-Chain Checks

- [ ] Install uses exact versions and a checked-in lockfile.
- [ ] Dependency installation keeps lifecycle scripts disabled where supported: `pnpm install --frozen-lockfile --ignore-scripts`.
- [ ] Normal package installation has no `preinstall`, `install`, or `postinstall` lifecycle scripts.
- [ ] Release checks include build, typecheck, tests, package dry-run, publish file assertions, and dependency policy assertions.
- [ ] Pack-safety tests assert that the npm tarball contains only intended runtime files, type declarations, README, license, and package metadata.

## Behavior Change Record

For each migrated command, record behavior changes as intended CLI consistency improvements when they affect:

- help wording or supported help forms;
- command names, aliases, arguments, flags, defaults, or examples;
- JSON stdout shape;
- error kind, message, category, or exit code;
- schema fields;
- dry-run output or mutation warnings;
- prompt blocking or non-interactive behavior.

Do not record product-specific implementation notes in this toolkit. Keep consumer-specific migration notes in the consuming package.

## Public API And Module Format

- [ ] Imports use the root export or intentionally supported subpaths.
- [ ] Unsupported internals are not imported.
- [ ] ESM import paths are used.
- [ ] Named exports are preferred and each package export lists the `types` condition first for TypeScript resolution.
- [ ] CommonJS entrypoints are not assumed unless a concrete consumer need has been addressed.
- [ ] The public API is declared precisely and comprehensively: supported exports, CLI flag contracts, and structured JSON output schemas.
- [ ] Breaking public API changes that require consumer code or scripts to change are treated as major-version changes once the package reaches stable release.
