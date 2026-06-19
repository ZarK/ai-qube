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
    const secret = "access_token=abcdefghijklmnopqrstuvwxyz123456";
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
    assert.equal(json.error.operation, "validate token access_token=[REDACTED]");
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

  it("parses variadic positional arguments", async () => {
    const { createCli, createCommand, createCommandRegistry, runCli } = await import("../dist/index.js");
    const command = {
      kind: "command",
      name: "files inspect",
      description: "Inspect variadic file arguments.",
      arguments: [{ name: "files", description: "Files to inspect.", multiple: true }],
      flags: [{ name: "json", description: "Render JSON output.", type: "boolean" }],
      examples: [{ description: "Inspect multiple files.", command: "fixture files inspect a.ts b.ts --json" }],
      interactions: { json: true }
    };
    const cli = createCli({
      bin: "fixture",
      registry: createCommandRegistry({ commands: [command] }),
      commands: [createCommand(command, ({ args }) => ({ json: { files: args.files } }))]
    });

    const result = await runCli(cli, ["files", "inspect", "a.ts", "b.ts", "--json"]);

    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      command: "files inspect",
      files: ["a.ts", "b.ts"]
    });
  });

  it("parses negatable boolean flags into the canonical flag key", async () => {
    const { createCli, createCommand, createCommandRegistry, runCli } = await import("../dist/index.js");
    const command = {
      kind: "command",
      name: "policy check",
      description: "Inspect policy flags.",
      flags: [
        { name: "json", description: "Render JSON output.", type: "boolean" },
        { name: "worktree", aliases: ["linked-worktree"], description: "Allow linked git worktrees.", type: "boolean", negatable: true }
      ],
      examples: [{ description: "Disable worktrees.", command: "fixture policy check --no-worktree --json" }],
      interactions: { json: true }
    };
    const cli = createCli({
      bin: "fixture",
      registry: createCommandRegistry({ commands: [command] }),
      commands: [createCommand(command, ({ flags }) => ({
        json: {
          hasWorktree: Object.hasOwn(flags, "worktree"),
          worktree: flags.worktree ?? null
        }
      }))]
    });

    const enabled = await runCli(cli, ["policy", "check", "--worktree", "--json"]);
    const disabled = await runCli(cli, ["policy", "check", "--no-worktree", "--json"]);
    const disabledAlias = await runCli(cli, ["policy", "check", "--no-linked-worktree", "--json"]);
    const omitted = await runCli(cli, ["policy", "check", "--json"]);
    const duplicate = await runCli(cli, ["policy", "check", "--worktree", "--worktree", "--json"]);
    const conflicting = await runCli(cli, ["policy", "check", "--linked-worktree", "--no-worktree", "--json"]);
    const unknownNo = await runCli(cli, ["policy", "check", "--no-autonomous", "--json"]);
    const help = await runCli(cli, ["help", "policy", "check"]);

    assert.deepEqual(JSON.parse(enabled.stdout), { ok: true, command: "policy check", hasWorktree: true, worktree: true });
    assert.deepEqual(JSON.parse(disabled.stdout), { ok: true, command: "policy check", hasWorktree: true, worktree: false });
    assert.deepEqual(JSON.parse(disabledAlias.stdout), { ok: true, command: "policy check", hasWorktree: true, worktree: false });
    assert.deepEqual(JSON.parse(omitted.stdout), { ok: true, command: "policy check", hasWorktree: false, worktree: null });
    assert.equal(duplicate.exitCode, 2);
    assert.match(JSON.parse(duplicate.stdout).error.likelyCause, /worktree/);
    assert.equal(conflicting.exitCode, 2);
    assert.match(JSON.parse(conflicting.stdout).error.likelyCause, /conflicting negated forms/);
    assert.equal(unknownNo.exitCode, 2);
    assert.equal(JSON.parse(unknownNo.stdout).error.likelyCause, "Flag \"--no-autonomous\" is not defined for policy check.");
    assert.equal(help.exitCode, 0);
    assert.match(help.stdout, /--worktree, --no-worktree\s+Allow linked git worktrees/);
    assert.match(help.stdout, /Usage:\n  fixture policy check \[--json\] \[--worktree\|--no-worktree\]/);
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

  it("passes through explicit JSON stdout for non-zero command results", async () => {
    const { createCli, createCommand, createCommandRegistry, runCli } = await import("../dist/index.js");
    const failingCommand = {
      kind: "command",
      name: "raw report",
      description: "Return a non-zero structured report.",
      flags: [{ name: "json", description: "Render JSON output.", type: "boolean" }],
      examples: [{ description: "Run raw report.", command: "fixture raw report --json" }],
      interactions: { json: true }
    };
    const cli = createCli({
      bin: "fixture",
      registry: createCommandRegistry({ commands: [failingCommand] }),
      commands: [
        createCommand(failingCommand, () => ({
          exitCode: 1,
          jsonStdout: '{"status":"failed","diagnosticCount":1}\n'
        }))
      ]
    });

    const result = await runCli(cli, ["raw", "report", "--json"]);

    assert.equal(result.exitCode, 1);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), { status: "failed", diagnosticCount: 1 });
  });
});
