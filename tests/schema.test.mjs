import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("schema renderer", () => {
  it("renders stable JSON independent of nested metadata order", async () => {
    const { createCommandRegistry, renderSchemaJson } = await import("../dist/index.js");
    const commandWithUnsortedNestedFields = {
      kind: "command",
      name: "cache inspect",
      description: "Inspect cache entries without changing local state.",
      aliases: ["z", "a"],
      arguments: [
        { name: "source", description: "Source cache entry.", extensions: { zeta: true, alpha: true } },
        { name: "destination", description: "Destination cache entry." }
      ],
      flags: [
        { name: "output", short: "o", description: "Select output format.", type: "option", aliases: ["format"], options: ["json", "human"], defaultValue: "human" },
        { name: "tag", short: "t", description: "Attach labels to the cache query.", type: "string", aliases: ["label"], multiple: true },
        { name: "verbose", description: "Render verbose diagnostics.", type: "boolean", aliases: ["v"] },
        { name: "worktree", description: "Allow linked git worktrees.", type: "boolean", aliases: ["linked-worktree"], negatable: true },
        { name: "json", short: "j", description: "Render JSON.", type: "boolean" }
      ],
      examples: [
        { description: "Inspect target.", command: "fixture cache inspect target" },
        { description: "Inspect all.", command: "fixture cache inspect" }
      ],
      output: { formats: ["json", "human"], defaultFormat: "human" },
      interactions: { json: true, nonInteractive: true, noColor: true, ttyPrompt: false },
      errors: [{ kind: "z-error", description: "Z error." }, { kind: "a-error", description: "A error." }],
      exitCodes: [
        { code: 2, category: "validation", description: "Validation failed." },
        { code: 0, category: "success", description: "Completed." }
      ],
      extensions: { zeta: 2, alpha: 1 }
    };
    const commandWithSortedNestedFields = {
      ...commandWithUnsortedNestedFields,
      aliases: ["a", "z"],
      arguments: commandWithUnsortedNestedFields.arguments,
      flags: [...commandWithUnsortedNestedFields.flags].reverse(),
      examples: [...commandWithUnsortedNestedFields.examples].reverse(),
      output: { formats: ["human", "json"], defaultFormat: "human" },
      errors: [...commandWithUnsortedNestedFields.errors].reverse(),
      exitCodes: [...commandWithUnsortedNestedFields.exitCodes].reverse(),
      extensions: { alpha: 1, zeta: 2 }
    };
    const options = { packageName: "pkg", packageVersion: "1.2.3", bin: "fixture" };

    const left = renderSchemaJson(createCommandRegistry({ commands: [commandWithUnsortedNestedFields] }), options);
    const right = renderSchemaJson(createCommandRegistry({ commands: [commandWithSortedNestedFields] }), options);

    assert.equal(left, right);
    const schema = JSON.parse(left);
    const command = schema.commands[0];
    assert.deepEqual(command.aliases, ["a", "z"]);
    assert.deepEqual(command.arguments.map((argument) => argument.name), ["source", "destination"]);
    assert.deepEqual(command.flags.map((flag) => flag.name), ["json", "output", "tag", "verbose", "worktree"]);
    assert.deepEqual(command.flags.find((flag) => flag.name === "json")?.tokens, ["--json", "-j"]);
    assert.equal(command.flags.find((flag) => flag.name === "json")?.short, "j");
    assert.equal(command.flags.find((flag) => flag.name === "json")?.negatable, false);
    assert.deepEqual(command.flags.find((flag) => flag.name === "output")?.tokens, ["--output", "-o", "--format"]);
    assert.deepEqual(command.flags.find((flag) => flag.name === "output")?.options, ["human", "json"]);
    assert.deepEqual(command.flags.find((flag) => flag.name === "tag")?.tokens, ["--tag", "-t", "--label"]);
    assert.equal(command.flags.find((flag) => flag.name === "tag")?.multiple, true);
    assert.deepEqual(command.flags.find((flag) => flag.name === "verbose")?.tokens, ["--verbose", "--v"]);
    assert.deepEqual(command.flags.find((flag) => flag.name === "worktree")?.tokens, ["--worktree", "--no-worktree", "--linked-worktree", "--no-linked-worktree"]);
    assert.equal(command.flags.find((flag) => flag.name === "worktree")?.negatable, true);
    assert.deepEqual(command.errors.map((error) => error.kind), ["a-error", "z-error"]);
    assert.deepEqual(command.exitCodes.map((exitCode) => exitCode.code), [0, 2]);
  });

  it("preserves positional argument order because it is CLI semantics", async () => {
    const { createCommandRegistry, renderSchema } = await import("../dist/index.js");
    const registry = createCommandRegistry({
      commands: [
        {
          kind: "command",
          name: "copy cache",
          description: "Copy cache entries from source to destination.",
          arguments: [
            { name: "source", description: "Source cache entry." },
            { name: "destination", description: "Destination cache entry." }
          ],
          examples: [{ description: "Copy cache entry.", command: "fixture copy cache source destination" }]
        }
      ]
    });

    const schema = renderSchema(registry, { packageName: "pkg", packageVersion: "1.2.3", bin: "fixture" });

    assert.deepEqual(schema.commands[0]?.arguments.map((argument) => argument.name), ["source", "destination"]);
  });

  it("marks mutating commands, dry-run support, and extension sections", async () => {
    const { createCommandRegistry, renderSchema } = await import("../dist/index.js");
    const registry = createCommandRegistry({
      commands: [
        {
          kind: "command",
          name: "deploy release",
          description: "Deploy a release after policy checks.",
          examples: [{ description: "Deploy.", command: "fixture deploy release" }],
          interactions: { dryRun: { supported: false, reason: "Deployment requires external approval." }, json: true },
          mutation: { categories: ["release", "external-service"], extensions: { owner: "consumer" } },
          supplyChain: {
            sensitive: true,
            kinds: ["release", "ci-workflow"],
            reason: "Release automation changes require supply-chain review.",
            extensions: { policy: "consumer-owned" }
          },
          extensions: { consumerSection: { enabled: true } }
        }
      ]
    });

    const schema = renderSchema(registry, {
      packageName: "pkg",
      packageVersion: "1.2.3",
      bin: "fixture",
      extensions: { consumerRoot: true }
    });

    assert.deepEqual(schema.extensions, { consumerRoot: true });
    assert.equal(schema.commands[0]?.mutation.mutates, true);
    assert.deepEqual(schema.commands[0]?.mutation.categories, ["external-service", "release"]);
    assert.deepEqual(schema.commands[0]?.mutation.extensions, { owner: "consumer" });
    assert.deepEqual(schema.commands[0]?.supplyChain, {
      sensitive: true,
      kinds: ["ci-workflow", "release"],
      reason: "Release automation changes require supply-chain review.",
      extensions: { policy: "consumer-owned" }
    });
    assert.deepEqual(schema.commands[0]?.dryRun, {
      supported: false,
      reason: "Deployment requires external approval."
    });
    assert.deepEqual(schema.commands[0]?.extensions, { consumerSection: { enabled: true } });
  });

  it("marks non-sensitive commands with default supply-chain metadata", async () => {
    const { createCommandRegistry, renderSchema } = await import("../dist/index.js");
    const registry = createCommandRegistry({
      commands: [
        {
          kind: "command",
          name: "cache inspect",
          description: "Inspect cache entries without changing local state.",
          examples: [{ description: "Inspect.", command: "fixture cache inspect" }]
        }
      ]
    });

    const schema = renderSchema(registry, { packageName: "pkg", packageVersion: "1.2.3", bin: "fixture" });

    assert.deepEqual(schema.commands[0]?.supplyChain, { sensitive: false, kinds: [] });
  });

  it("renders named consumer sections deterministically with redaction", async () => {
    const { createCommandRegistry, renderSchemaJson } = await import("../dist/index.js");
    const registry = createCommandRegistry({
      commands: [
        {
          kind: "command",
          name: "cache inspect",
          description: "Inspect cache entries without changing local state.",
          examples: [{ description: "Inspect.", command: "fixture cache inspect" }]
        }
      ]
    });

    const rendered = renderSchemaJson(registry, {
      packageName: "pkg",
      packageVersion: "1.2.3",
      bin: "fixture",
      sections: {
        providers: {
          token: "ghp_1234567890abcdefghijklmnopqrstuvwxyz",
          zeta: true
        },
        config: {
          beta: 2,
          alpha: 1
        }
      }
    });
    const schema = JSON.parse(rendered);

    assert.deepEqual(Object.keys(schema.sections), ["config", "providers"]);
    assert.deepEqual(schema.sections.config, { alpha: 1, beta: 2 });
    assert.equal(schema.sections.providers.token, "[REDACTED]");
    assert.equal(schema.sections.providers.zeta, true);
  });
});
