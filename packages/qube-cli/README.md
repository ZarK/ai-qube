# @tjalve/qube-cli

`@tjalve/qube-cli` is the shared TypeScript CLI library used by the QUBE package
family. It provides command metadata, registry wiring, help text, schema output,
structured output helpers, mutation safety metadata, prompt helpers, redaction,
and test utilities for package-backed CLIs.

It is a library, not a product CLI. Consuming packages own their command
behavior, validation rules, state, service integrations, and side effects.

## Install

```sh
pnpm add @tjalve/qube-cli@0.1.2 --save-exact --ignore-scripts
```

## What It Provides

- command metadata and registry helpers
- consistent human help and JSON schema output
- structured text and JSON output helpers
- typed mutation and safety metadata for agent-facing commands
- terminal, prompt, and redaction utilities
- installer choice primitives for guided setup flows
- package-content and CLI-contract test helpers

## Package Boundary

This package does not mutate user projects, configure shells, install hooks,
contact external services, start background processes, or define product policy
during installation. Runtime behavior belongs to the consuming package.

## Exports

```ts
import { defineCommand, createCommandRegistry } from "@tjalve/qube-cli";
import { renderHelp } from "@tjalve/qube-cli/help";
import { createJsonOutput } from "@tjalve/qube-cli/output";
```

Public subpath exports include:

- `@tjalve/qube-cli/metadata`
- `@tjalve/qube-cli/registry`
- `@tjalve/qube-cli/help`
- `@tjalve/qube-cli/runtime`
- `@tjalve/qube-cli/schema`
- `@tjalve/qube-cli/errors`
- `@tjalve/qube-cli/output`
- `@tjalve/qube-cli/mutation`
- `@tjalve/qube-cli/terminal`
- `@tjalve/qube-cli/prompts`
- `@tjalve/qube-cli/installer`
- `@tjalve/qube-cli/redaction`
- `@tjalve/qube-cli/testing`

## Installer UX Primitives

Package authors can build safe setup flows without inventing prompt, choice, and
non-interactive behavior from scratch:

```ts
import {
  defineInstallerChoiceGroup,
  promptInstallerChoice,
  renderInstallerChoices
} from "@tjalve/qube-cli/installer";

const scope = defineInstallerChoiceGroup({
  name: "install scope",
  message: "Where should this package be installed?",
  defaultValue: "local",
  choices: [
    { value: "local", label: "Project-local", recommended: true },
    { value: "global", label: "Global manual" }
  ]
});
```

Use explicit flag values or safe defaults for `--json`, `--yes`, and CI paths.
Consuming packages still own command generation, validation rules, install
policy, and side effects.

## Adoption

The repository includes an adoption guide and compatibility checklist:

- https://github.com/ZarK/ai-qube/tree/main/packages/qube-cli/docs/adoption-guide.md
- https://github.com/ZarK/ai-qube/tree/main/packages/qube-cli/docs/compatibility-checklist.md

Use those docs when migrating an existing CLI command-by-command while preserving
help, JSON, schema, exit-code, dry-run, and ownership boundaries.

## Development

```sh
corepack enable
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @tjalve/qube-cli run verify
```

The package publishes compiled JavaScript, declaration files, `package.json`,
license metadata, and this README.
