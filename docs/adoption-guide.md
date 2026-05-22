# Adoption Guide

## Purpose

This guide shows how a TypeScript command-line package can adopt `@tjalve/cube-cli` for command metadata, registry-backed help, deterministic schema output, JSON trigger metadata, structured JSON output, human output, structured errors, dry-run disclosure, and contract tests.

The toolkit remains infrastructure. Consuming packages own command behavior, validation rules, product logic, state management, service integrations, policy decisions, and side effects.

## Prerequisites

- Node.js 24 or newer.
- pnpm 11 or newer.
- ESM-first TypeScript source.
- A checked-in package lockfile.
- Exact dependency versions and lifecycle scripts disabled during dependency installation where supported.

Install with an exact version and disabled lifecycle scripts:

```sh
pnpm add @tjalve/cube-cli@0.1.1 --save-exact --ignore-scripts
pnpm install --frozen-lockfile --ignore-scripts
```

Commit the resulting manifest and lockfile changes after reviewing dependency identity, integrity, lockfile impact, and package policy.

## Package Boundary

`@tjalve/cube-cli` provides reusable CLI infrastructure only. It does not:

- import, execute, bundle, or depend on consuming packages;
- mutate user projects, external services, user configuration, dependency state, release state, shell profiles, or background processes by itself;
- install shell completions as an installation side effect;
- provide a terminal dashboard, rich TUI, arbitrary third-party command plugin system, or product policy engine.

Command handlers in consuming packages decide what to read, validate, write, upload, call, approve, block, or roll back.

## Add A First Read-Only Command

Define metadata first. Metadata drives help, schema, validation, and tests, so keep command names, flags, examples, output formats, JSON triggers, errors, and exit codes explicit.

```ts
// src/metadata.ts
import {
  createCommandRegistry,
  defineArgument,
  defineCommand,
  defineExample,
  defineFlag
} from "@tjalve/cube-cli";

export const inspectCommand = defineCommand({
  kind: "command",
  name: "item inspect",
  description: "Inspect an item without changing local or remote state.",
  arguments: [
    defineArgument({
      name: "id",
      description: "Item identifier to inspect.",
      required: false
    })
  ],
  flags: [
    defineFlag({
      name: "json",
      description: "Render machine-readable JSON output.",
      type: "boolean"
    }),
    defineFlag({
      name: "output",
      description: "Select the output format.",
      type: "option",
      options: ["human", "json"],
      defaultValue: "human"
    })
  ],
  examples: [
    defineExample({
      description: "Inspect all items.",
      command: "example item inspect"
    })
  ],
  output: {
    formats: ["human", "json"],
    defaultFormat: "human"
  },
  interactions: {
    json: true,
    noColor: true,
    nonInteractive: true,
    ttyPrompt: false
  },
  errors: [
    {
      kind: "item-not-readable",
      description: "The item could not be read.",
      exitCode: 3
    }
  ],
  exitCodes: [
    {
      code: 0,
      category: "success",
      description: "The command completed successfully."
    },
    {
      code: 3,
      category: "validation",
      description: "The item identifier or item state was invalid."
    }
  ]
});

export const registry = createCommandRegistry({
  commands: [inspectCommand]
});
```

Bind the metadata to a handler. The handler owns real behavior; the toolkit only normalizes parsing, output, help, schema, and errors.

```ts
#!/usr/bin/env node
// src/cli.ts
import { pathToFileURL } from "node:url";
import {
  createCli,
  createCliError,
  createCommand,
  createSchemaCommand,
  runCli
} from "@tjalve/cube-cli";
import { inspectCommand, registry } from "./metadata.js";

let runtimeRegistry = registry;

export const cli = createCli({
  bin: "example",
  description: "Example CLI using @tjalve/cube-cli infrastructure.",
  registry,
  commands: [
    createCommand(inspectCommand, ({ args }) => {
      const id = typeof args.id === "string" ? args.id : "all";

      if (id.trim().length === 0) {
        throw createCliError({
          command: "item inspect",
          kind: "item-not-readable",
          operation: "inspect item",
          likelyCause: "The item identifier was empty.",
          suggestedNextAction: "Provide a non-empty item identifier or omit it to inspect all items.",
          category: "validation"
        });
      }

      return {
        json: { id },
        human: `Inspected item: ${id}\n`
      };
    }),
    createSchemaCommand({
      registry: () => runtimeRegistry,
      bin: "example",
      packageName: "example-cli",
      packageVersion: "0.1.0"
    })
  ]
});

runtimeRegistry = cli.registry;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const result = await runCli(cli, argv);
  if (result.stdout.length > 0) process.stdout.write(result.stdout);
  if (result.stderr.length > 0) process.stderr.write(result.stderr);
  return result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
```

The resulting command should support standard help forms without executing handlers:

```sh
example --help
example help
example help item inspect
example item inspect --help
example item inspect help
```

The schema command should emit deterministic JSON:

```sh
example schema --json
```

Commands that support JSON should define a JSON trigger such as a `json` boolean flag or an `output` option that accepts `json`, set `interactions.json: true`, and return structured `json` fields from each successful handler path. `--json`, `--output json`, and `--output=json` are stable machine-readable output contracts for scripts; human output can evolve separately. The runtime wraps handler fields in the standard success envelope:

```sh
example item inspect alpha --json
```

```json
{"ok":true,"command":"item inspect","id":"alpha"}
```

## Add A Dry-Run-Capable Command

Mutating commands should declare mutation categories and support `--dry-run` unless previewing is impossible for a documented reason. The consuming package still owns the actual mutation and approval policy.

```ts
import {
  createDryRunPlan,
  createDryRunPlanFields,
  defineCommand,
  defineExample,
  defineFlag,
  defineMutationMetadata,
  dryRunSupported,
  mutationCategories,
  renderDryRunPlan,
  renderMutationWarning
} from "@tjalve/cube-cli";

export const pruneCommand = defineCommand({
  kind: "command",
  name: "item prune",
  description: "Remove stale local item records after showing the planned changes.",
  flags: [
    defineFlag({
      name: "dry-run",
      description: "Show planned changes without removing records.",
      type: "boolean"
    }),
    defineFlag({
      name: "json",
      description: "Render machine-readable JSON output.",
      type: "boolean"
    }),
    defineFlag({
      name: "yes",
      description: "Run without interactive confirmation.",
      type: "boolean"
    })
  ],
  examples: [
    defineExample({
      description: "Preview stale record cleanup.",
      command: "example item prune --dry-run"
    })
  ],
  output: { formats: ["human", "json"], defaultFormat: "human" },
  interactions: {
    json: true,
    dryRun: dryRunSupported(),
    noColor: true,
    nonInteractive: true,
    ttyPrompt: true
  },
  mutation: defineMutationMetadata({
    categories: mutationCategories("local-files")
  })
});
```

Handler pattern:

```ts
createCommand(pruneCommand, ({ flags }) => {
  const plan = createDryRunPlan({
    command: "item prune",
    summary: "Remove stale local item records.",
    mutationCategories: ["local-files"],
    steps: [
      {
        action: "delete",
        target: "local item records marked stale",
        category: "local-files",
        description: "Remove records after consumer-owned confirmation."
      }
    ],
    rerunCommand: "example item prune --yes"
  });

  if (flags["dry-run"] === true) {
    return {
      json: createDryRunPlanFields(plan),
      human: renderDryRunPlan(plan)
    };
  }

  return {
    json: { removed: true },
    human: `${renderMutationWarning({
      command: "item prune",
      categories: ["local-files"],
      dryRun: pruneCommand.interactions?.dryRun,
      message: "Run --dry-run before removing records."
    })}Removed stale item records.\n`
  };
});
```

## Test The CLI Contract

Use the public testing helpers to assert behavior from the compiled CLI entrypoint. Contract tests should verify help, schema, JSON stdout, structured errors, exit codes, prompt blocking, and dry-run disclosure.

Known error contracts should include the toolkit categories: usage (`2`), validation/configuration (`3`), external tool or service (`4`), safety block (`5`), and unexpected internal failure (`70`).

```js
// tests/cli-contract.test.mjs
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertCliDryRun,
  assertCliHelp,
  assertCliJsonError,
  assertCliJsonSuccess,
  assertCliSuccess,
  parseCliJsonRecord,
  runNodeCliCommand
} from "@tjalve/cube-cli/testing";

const projectRoot = new URL("..", import.meta.url);
const cliPath = new URL("../dist/cli.js", import.meta.url);

function runExample(...args) {
  return runNodeCliCommand(cliPath, args, { cwd: projectRoot });
}

describe("example CLI contract", () => {
  it("renders help without executing handlers", () => {
    assertCliHelp(runExample("item", "inspect", "--help"), {
      contains: ["Usage:", "JSON output: supported"]
    });
  });

  it("emits clean JSON stdout", () => {
    assertCliJsonSuccess(runExample("item", "inspect", "alpha", "--json"), {
      ok: true,
      command: "item inspect",
      id: "alpha"
    });
  });

  it("emits deterministic schema JSON", () => {
    const first = runExample("schema", "--json");
    const second = runExample("schema", "--json");
    assertCliSuccess(first);
    assertCliSuccess(second);
    assert.equal(first.stdout, second.stdout);
    assert.equal(parseCliJsonRecord(first).bin, "example");
  });

  it("renders structured JSON errors", () => {
    assertCliJsonError(runExample("item", "inspect", "", "--json"), {
      status: 3,
      command: "item inspect",
      kind: "item-not-readable",
      category: "validation",
      exitCode: 3
    });
  });

  it("discloses dry-run plans for mutating commands", () => {
    assertCliDryRun(runExample("item", "prune", "--dry-run"), {
      contains: "Rerun without --dry-run to apply: example item prune --yes"
    });
    assert.equal(
      assertCliJsonSuccess(runExample("item", "prune", "--dry-run", "--json")).dryRunPlan.command,
      "item prune"
    );
  });
});
```

## Package And Publish Checks

Release checks in consuming packages should include:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
pnpm run typecheck
pnpm test
```

When publishing npm packages, add pack-safety assertions around `pnpm pack --dry-run --json` so source files, tests, local configuration, and generated build artifacts outside the intended runtime package are not published accidentally. The `@tjalve/cube-cli/testing` helpers provide `runPackDryRun`, `assertPackSafety`, and `assertPackContents` for this pattern.

## Public API And SemVer Expectations

- The package should declare a precise and comprehensive public API for consumers. Public APIs are the root export, intentionally supported subpaths such as `metadata`, `registry`, `runtime`, `help`, `schema`, `output`, `errors`, `mutation`, `prompts`, `terminal`, `redaction`, and `testing`, documented CLI flag contracts, and documented structured JSON output schemas.
- Unsupported internals should not be imported from consuming packages.
- ESM is the supported module format. Prefer named exports and keep the `types` condition first for each exported subpath. CommonJS entrypoints should be added only when there is a concrete consumer need.
- Public API changes follow semantic versioning. Once the package reaches a stable release, breaking changes that require consumer code or scripts to change require a major version bump.
- Behavior changes in help, schema, JSON envelopes, error shape, exit codes, dry-run output, or mutation warnings should be treated as compatibility changes and covered by command contract tests.

## Adoption Checklist

- Define metadata before writing handler code.
- Register every executable command and non-executable topic.
- Add a schema command for automation.
- Return `json` and `human` result shapes from handlers instead of hand-writing mode switches where possible.
- Throw `createCliError` for known actionable failures.
- Declare mutation categories and dry-run support for commands that mutate state.
- Keep external command execution and approval policy in the consuming package.
- Add contract tests before changing existing CLI behavior.
- Run release checks with frozen lockfiles and disabled lifecycle scripts.
