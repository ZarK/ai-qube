import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("output and error helpers", () => {
  it("creates stable JSON success envelopes with consumer fields", async () => {
    const { createJsonSuccessEnvelope, renderJsonSuccess } = await import("../dist/index.js");

    assert.deepEqual(createJsonSuccessEnvelope("cache inspect", { zeta: 2, alpha: 1 }), {
      ok: true,
      command: "cache inspect",
      alpha: 1,
      zeta: 2
    });
    assert.equal(renderJsonSuccess("cache inspect", { key: "alpha" }), '{"ok":true,"command":"cache inspect","key":"alpha"}\n');
    assert.throws(() => createJsonSuccessEnvelope("cache inspect", { ok: true }), /reserved field "ok"/);
  });

  it("redacts token-like values in JSON success envelopes", async () => {
    const { renderJsonSuccess } = await import("../dist/index.js");

    assert.deepEqual(JSON.parse(renderJsonSuccess("cache inspect", {
      authorization: "Bearer abcdefghijklmnopqrstuvwxyz123456",
      nested: { apiKey: "abcdefghijklmnopqrstuvwxyz123456", password: 123456789, privateKey: "fixture-key", safe: "alpha" }
    })), {
      ok: true,
      command: "cache inspect",
      authorization: "[REDACTED]",
      nested: { apiKey: "[REDACTED]", password: "[REDACTED]", privateKey: "[REDACTED]", safe: "alpha" }
    });
  });

  it("preserves non-plain objects for normal JSON serialization", async () => {
    const { renderJsonSuccess } = await import("../dist/index.js");

    assert.deepEqual(JSON.parse(renderJsonSuccess("cache inspect", { at: new Date("2026-05-20T00:00:00.000Z") })), {
      ok: true,
      command: "cache inspect",
      at: "2026-05-20T00:00:00.000Z"
    });
  });

  it("rejects values that cannot render as valid JSON", async () => {
    const { renderJsonLine } = await import("../dist/index.js");

    assert.throws(() => renderJsonLine(undefined), /must be serializable as valid JSON/);
    assert.throws(() => renderJsonLine(() => undefined), /must be serializable as valid JSON/);
    assert.throws(() => renderJsonLine(Symbol("fixture")), /must be serializable as valid JSON/);
  });

  it("renders structured CLI errors for JSON and human output", async () => {
    const { createCliError, exitCodeForCategory, renderCliErrorText, renderJsonError } = await import("../dist/index.js");
    const error = createCliError({
      command: "cache validate",
      kind: "cache-config-invalid",
      operation: "validate cache configuration",
      likelyCause: "The cache configuration is missing.",
      suggestedNextAction: "Create the cache configuration.",
      category: "validation"
    });

    assert.equal(error.exitCode, 3);
    assert.equal(exitCodeForCategory("success"), 0);
    assert.equal(exitCodeForCategory("usage"), 2);
    assert.equal(exitCodeForCategory("validation"), 3);
    assert.equal(exitCodeForCategory("external"), 4);
    assert.equal(exitCodeForCategory("safety"), 5);
    assert.equal(exitCodeForCategory("unexpected"), 70);
    assert.deepEqual(JSON.parse(renderJsonError(error)), {
      ok: false,
      command: "cache validate",
      error: {
        kind: "cache-config-invalid",
        operation: "validate cache configuration",
        likelyCause: "The cache configuration is missing.",
        suggestedNextAction: "Create the cache configuration.",
        category: "validation",
        exitCode: 3
      }
    });
    assert.match(renderCliErrorText(error), /Suggested next action: Create the cache configuration\./);
  });

  it("redacts token-like values in human and JSON errors", async () => {
    const { createCliError, renderCliErrorText, renderJsonError } = await import("../dist/index.js");
    const secret = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
    const error = createCliError({
      command: "cache validate",
      kind: "cache-config-invalid",
      operation: `validate token ${secret}`,
      likelyCause: `Authorization failed for Bearer abcdefghijklmnopqrstuvwxyz123456`,
      suggestedNextAction: `Remove api_key=abcdefghijklmnopqrstuvwxyz123456 from config.`,
      category: "validation"
    });

    assert.doesNotMatch(renderCliErrorText(error), new RegExp(secret));
    const json = JSON.parse(renderJsonError(error));
    assert.equal(json.error.operation, "validate token [REDACTED]");
    assert.equal(json.error.likelyCause, "Authorization failed for Bearer [REDACTED]");
    assert.equal(json.error.suggestedNextAction, "Remove api_key=[REDACTED] from config.");
  });

  it("wraps raw runtime output in JSON mode", async () => {
    const { createCli, createCommand, createCommandRegistry, runCli } = await import("../dist/index.js");
    const rawCommand = {
      kind: "command",
      name: "raw output",
      description: "Return raw output for fallback JSON rendering.",
      flags: [{ name: "json", description: "Render JSON output.", type: "boolean" }],
      examples: [{ description: "Run raw output.", command: "fixture raw output --json" }],
      interactions: { json: true }
    };
    const cli = createCli({
      bin: "fixture",
      registry: createCommandRegistry({ commands: [rawCommand] }),
      commands: [createCommand(rawCommand, () => ({ stdout: "raw text\n" }))]
    });

    const result = await runCli(cli, ["raw", "output", "--json"]);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), { ok: true, command: "raw output", output: "raw text\n" });
  });

  it("handles global version before command dispatch", async () => {
    const { createCli, createCommand, createCommandRegistry, runCli } = await import("../dist/index.js");
    let invoked = false;
    const command = {
      kind: "command",
      name: "raw output",
      description: "Return raw output for fallback JSON rendering.",
      flags: [{ name: "json", description: "Render JSON output.", type: "boolean" }],
      examples: [{ description: "Run raw output.", command: "fixture raw output --json" }],
      interactions: { json: true }
    };
    const cli = createCli({
      bin: "fixture",
      packageName: "fixture-package",
      packageVersion: "1.2.3",
      registry: createCommandRegistry({ commands: [command] }),
      commands: [createCommand(command, () => {
        invoked = true;
        return { stdout: "raw text\n" };
      })]
    });

    const human = await runCli(cli, ["--version"]);
    const json = await runCli(cli, ["-v", "--json"]);

    assert.equal(invoked, false);
    assert.deepEqual(human, {
      exitCode: 0,
      stdout: "1.2.3\n",
      stderr: "",
      executedCommand: "version"
    });
    assert.deepEqual(JSON.parse(json.stdout), {
      ok: true,
      command: "version",
      package: {
        name: "fixture-package",
        version: "1.2.3"
      },
      version: "1.2.3"
    });
    assert.equal(json.exitCode, 0);
    assert.equal(json.stderr, "");
    assert.equal(json.executedCommand, "version");
  });

  it("parses rendered flag tokens into canonical flag keys", async () => {
    const { createCli, createCommand, createCommandRegistry, runCli } = await import("../dist/index.js");
    const command = {
      kind: "command",
      name: "flag demo",
      description: "Return parsed flags for runtime verification.",
      flags: [
        { name: "json", short: "j", description: "Render JSON output.", type: "boolean" },
        { name: "format", short: "f", description: "Select output format.", type: "option", aliases: ["output"], options: ["human", "json"] },
        { name: "tag", short: "t", description: "Attach repeated tag values.", type: "string", aliases: ["label"], multiple: true }
      ],
      examples: [{ description: "Run flag demo.", command: "fixture flag demo --json" }],
      interactions: { json: true }
    };
    const cli = createCli({
      bin: "fixture",
      registry: createCommandRegistry({ commands: [command] }),
      commands: [createCommand(command, ({ flags }) => ({ json: { flags } }))]
    });

    const result = await runCli(cli, ["flag", "demo", "-j", "-f", "json", "--label", "alpha", "-t", "beta"]);
    const help = await runCli(cli, ["help", "flag", "demo"]);
    const unknownShort = await runCli(cli, ["flag", "demo", "-x"]);

    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      command: "flag demo",
      flags: {
        format: "json",
        json: true,
        tag: ["alpha", "beta"]
      }
    });
    assert.equal(help.exitCode, 0);
    assert.match(help.stdout, /-j, --json\s+Render JSON output/);
    assert.match(help.stdout, /-f, --format <value>\s+Select output format/);
    assert.equal(unknownShort.exitCode, 2);
    assert.match(unknownShort.stderr, /Unknown flag: -x/);
    assert.doesNotMatch(unknownShort.stderr, /raw text/);
  });

  it("does not treat negative positional values as unknown short flags", async () => {
    const { createCli, createCommand, createCommandRegistry, runCli } = await import("../dist/index.js");
    const command = {
      kind: "command",
      name: "number inspect",
      description: "Inspect a numeric positional value.",
      arguments: [{ name: "value", description: "Numeric value to inspect." }],
      flags: [{ name: "json", short: "j", description: "Render JSON output.", type: "boolean" }],
      examples: [{ description: "Inspect a negative value.", command: "fixture number inspect -1 --json" }],
      interactions: { json: true }
    };
    const cli = createCli({
      bin: "fixture",
      registry: createCommandRegistry({ commands: [command] }),
      commands: [createCommand(command, ({ args }) => ({ json: { value: args.value } }))]
    });

    const result = await runCli(cli, ["number", "inspect", "-1", "-j"]);

    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      command: "number inspect",
      value: "-1"
    });
  });

  it("renders non-zero runtime results as JSON failures", async () => {
    const { createCli, createCommand, createCommandRegistry, runCli } = await import("../dist/index.js");
    const failingCommand = {
      kind: "command",
      name: "raw fail",
      description: "Return a non-zero runtime result for JSON failure rendering.",
      flags: [{ name: "json", description: "Render JSON output.", type: "boolean" }],
      examples: [{ description: "Run raw failure.", command: "fixture raw fail --json" }],
      interactions: { json: true }
    };
    const cli = createCli({
      bin: "fixture",
      registry: createCommandRegistry({ commands: [failingCommand] }),
      commands: [createCommand(failingCommand, () => ({ exitCode: 5, json: { detail: "blocked" }, stderr: "blocked by policy\n" }))]
    });

    const result = await runCli(cli, ["raw", "fail", "--json"]);

    assert.equal(result.exitCode, 5);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: false,
      command: "raw fail",
      error: {
        kind: "command-failed",
        operation: "run raw fail",
        likelyCause: "blocked by policy\n",
        suggestedNextAction: "Inspect the command failure and retry after the underlying issue is fixed.",
        category: "unexpected",
        exitCode: 5
      }
    });
  });
});
