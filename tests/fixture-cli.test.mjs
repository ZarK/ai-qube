import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const packageMetadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

function runFixture(...args) {
  return spawnSync(process.execPath, ["dist/fixtures/cli.js", ...args], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8"
  });
}

describe("fixture CLI runtime", () => {
  it("renders stable root help without executing handlers", () => {
    const flagHelp = runFixture("--help");
    const commandHelp = runFixture("help");

    assert.equal(flagHelp.status, 0);
    assert.equal(commandHelp.status, 0);
    assert.equal(flagHelp.stderr, "");
    assert.equal(commandHelp.stderr, "");
    assert.equal(flagHelp.stdout, commandHelp.stdout);
    assert.match(flagHelp.stdout, /fixture\nProduct-neutral fixture CLI/);
    assert.match(flagHelp.stdout, /cache clear\s+Clear cache entries/);
    assert.match(flagHelp.stdout, /schema\s+Render deterministic command schema/);
    assert.doesNotMatch(flagHelp.stdout, /EXECUTED/);
  });

  it("normalizes command help forms without executing handlers", () => {
    const helpCommand = runFixture("help", "cache", "inspect");
    const helpFlag = runFixture("cache", "inspect", "--help");
    const helpToken = runFixture("cache", "inspect", "help");

    assert.equal(helpCommand.status, 0);
    assert.equal(helpFlag.status, 0);
    assert.equal(helpToken.status, 0);
    assert.equal(helpCommand.stdout, helpFlag.stdout);
    assert.equal(helpFlag.stdout, helpToken.stdout);
    assert.match(helpCommand.stdout, /Usage:\n  fixture cache inspect \[key\] \[--json\] \[--output <value>\]/);
    assert.match(helpCommand.stdout, /JSON output: supported/);
    assert.doesNotMatch(helpCommand.stdout, /EXECUTED/);
  });

  it("renders mutating command help without treating final help as an argument", () => {
    const result = runFixture("cache", "clear", "help");

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Dry run: supported/);
    assert.match(result.stdout, /Mutation: local-files/);
    assert.doesNotMatch(result.stdout, /EXECUTED/);
  });

  it("renders topic help from metadata without executing handlers", () => {
    const result = runFixture("help", "cache");

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /cache\nCommands for inspecting and maintaining a local cache/);
    assert.match(result.stdout, /fixture cache <command> \[flags\]/);
    assert.match(result.stdout, /cache inspect\s+Inspect cache entries/);
    assert.match(result.stdout, /cache clear: args=0, flags=2, examples=1, json=supported, dry-run=supported, mutation=local-files/);
    assert.match(result.stdout, /cache inspect: args=1, flags=2, examples=1, json=supported, dry-run=not declared, mutation=none/);
    assert.doesNotMatch(result.stdout, /EXECUTED/);
  });

  it("renders deterministic schema JSON that matches the runtime registry", () => {
    const defaultResult = runFixture("schema");
    const result = runFixture("schema", "--json");
    const repeated = runFixture("schema", "--json");

    assert.equal(defaultResult.status, 0);
    assert.equal(defaultResult.stderr, "");
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.equal(repeated.status, 0);
    assert.equal(repeated.stderr, "");
    assert.equal(defaultResult.stdout, result.stdout);
    assert.equal(result.stdout, repeated.stdout);
    const schema = JSON.parse(result.stdout);
    assert.equal(schema.schemaVersion, 1);
    assert.deepEqual(schema.package, { name: packageMetadata.name, version: packageMetadata.version });
    assert.equal(schema.bin, "fixture");
    assert.deepEqual(schema.extensions, { fixture: true, purpose: "schema-integration" });
    assert.deepEqual(schema.topics.map((topic) => topic.name), ["cache"]);
    assert.deepEqual(schema.commands.map((command) => command.name), ["cache clear", "cache explode", "cache inspect", "cache validate", "schema"]);
    const clearCommand = schema.commands.find((command) => command.name === "cache clear");
    const inspectCommand = schema.commands.find((command) => command.name === "cache inspect");
    assert.deepEqual(clearCommand?.mutation, {
      mutates: true,
      categories: ["local-files"],
      extensions: { fixtureMutation: "cache-cleanup" }
    });
    assert.deepEqual(clearCommand?.dryRun, { supported: true });
    assert.equal(inspectCommand?.mutation.mutates, false);
    assert.deepEqual(inspectCommand?.output, { formats: ["human", "json"], defaultFormat: "human" });
    assert.deepEqual(inspectCommand?.interactions, {
      json: true,
      noColor: true,
      nonInteractive: true,
      ttyPrompt: false
    });
    assert.deepEqual(inspectCommand?.errors, [
      { kind: "cache-read-failed", description: "The cache could not be read.", exitCode: 2 }
    ]);
    assert.deepEqual(inspectCommand?.exitCodes, [
      { code: 0, category: "success", description: "The command completed successfully." },
      { code: 2, category: "validation", description: "The cache key or cache state was invalid." }
    ]);
    assert.deepEqual(inspectCommand?.flags.find((flag) => flag.name === "output")?.defaultValue, "human");
    assert.deepEqual(inspectCommand?.extensions?.nested, { alpha: 1, beta: 2 });
    assert.doesNotMatch(result.stdout, /Usage:/);
    assert.doesNotMatch(result.stdout, /Commands:/);
  });

  it("keeps exact multi-token commands ahead of single-token aliases", async () => {
    const { createCli, createCommand, createCommandRegistry, runCli } = await import("../dist/index.js");
    const alphaBetaCommand = {
      kind: "command",
      name: "alpha beta",
      description: "Run the exact alpha beta command.",
      examples: [{ description: "Run alpha beta.", command: "fixture alpha beta" }]
    };
    const alphaOtherCommand = {
      kind: "command",
      name: "alpha-other",
      aliases: ["alpha"],
      description: "Run the aliased alpha command.",
      examples: [{ description: "Run alpha alias.", command: "fixture alpha" }]
    };
    const aliasShadowCli = createCli({
      bin: "fixture",
      registry: createCommandRegistry({ commands: [alphaBetaCommand, alphaOtherCommand] }),
      commands: [
        createCommand(alphaOtherCommand, () => ({ stdout: "alias-shadow\n" })),
        createCommand(alphaBetaCommand, () => ({ stdout: "exact-command\n" }))
      ]
    });

    const result = await runCli(aliasShadowCli, ["alpha", "beta"]);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "exact-command\n");
    assert.equal(result.executedCommand, "alpha beta");
  });

  it("executes exact commands and explicit aliases", () => {
    const inspect = runFixture("cache", "inspect", "alpha", "--json");
    const outputJson = runFixture("cache", "inspect", "alpha", "--output", "json");
    const clear = runFixture("cc", "--dry-run");

    assert.equal(inspect.status, 0);
    assert.equal(inspect.stderr, "");
    assert.deepEqual(JSON.parse(inspect.stdout), { ok: true, command: "cache inspect", key: "alpha" });
    assert.equal(outputJson.status, 0);
    assert.equal(outputJson.stderr, "");
    assert.deepEqual(JSON.parse(outputJson.stdout), { ok: true, command: "cache inspect", key: "alpha" });
    assert.equal(clear.status, 0);
    assert.match(clear.stdout, /EXECUTED cache clear/);
    assert.match(clear.stdout, /Would remove fixture cache entries/);
  });

  it("renders known errors as stable human output", () => {
    const result = runFixture("cache", "validate");

    assert.equal(result.status, 3);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Error: cache-config-invalid/);
    assert.match(result.stderr, /Operation: validate cache configuration/);
    assert.match(result.stderr, /Likely cause: The fixture cache configuration is missing a required directory\./);
    assert.match(result.stderr, /Suggested next action: Create the cache directory or update the cache configuration path\./);
    assert.match(result.stderr, /Exit code category: validation/);
  });

  it("renders known errors as stable JSON output", () => {
    const result = runFixture("cache", "validate", "--json");

    assert.equal(result.status, 3);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: false,
      command: "cache validate",
      error: {
        kind: "cache-config-invalid",
        operation: "validate cache configuration",
        likelyCause: "The fixture cache configuration is missing a required directory.",
        suggestedNextAction: "Create the cache directory or update the cache configuration path.",
        category: "validation",
        exitCode: 3
      }
    });
  });

  it("keeps unexpected failures as non-success JSON failures", () => {
    const result = runFixture("cache", "explode", "--json");

    assert.equal(result.status, 70);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: false,
      command: "cache explode",
      error: {
        kind: "unexpected-error",
        operation: "run cache explode",
        likelyCause: "Fixture exploded unexpectedly.",
        suggestedNextAction: "Inspect the command failure and retry after the underlying issue is fixed.",
        category: "unexpected",
        exitCode: 70
      }
    });
  });

  it("renders usage errors as JSON without stderr noise when JSON is requested", () => {
    const result = runFixture("cache", "inspect", "--jso", "--json");

    assert.equal(result.status, 2);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: false,
      command: "cache inspect",
      error: {
        kind: "unknown-flag",
        operation: "parse flags",
        likelyCause: "Flag \"--jso\" is not defined for cache inspect.",
        suggestedNextAction: "Use \"--json\" instead.",
        category: "usage",
        exitCode: 2
      }
    });
  });

  it("renders parser failures as usage JSON instead of unexpected failures", () => {
    const result = runFixture("cache", "inspect", "--output", "xml", "--json");

    assert.equal(result.status, 2);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.command, "cache inspect");
    assert.equal(output.error.kind, "invalid-command-usage");
    assert.equal(output.error.operation, "parse command arguments");
    assert.match(output.error.likelyCause, /human/);
    assert.match(output.error.likelyCause, /json/);
    assert.equal(output.error.category, "usage");
    assert.equal(output.error.exitCode, 2);
  });

  it("does not treat positional tokens after -- as JSON mode flags", () => {
    const result = runFixture("cache", "inspect", "--", "--json");

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Inspected cache key: --json/);
    assert.throws(() => JSON.parse(result.stdout), SyntaxError);
  });

  it("suggests likely command misses without executing handlers", () => {
    const result = runFixture("cache", "cleer");

    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Unknown command: cache cleer/);
    assert.match(result.stderr, /Did you mean "cache clear"/);
    assert.doesNotMatch(result.stderr, /EXECUTED/);
  });

  it("suggests likely flag misses without executing handlers", () => {
    const result = runFixture("cache", "inspect", "--jso");

    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Unknown flag: --jso/);
    assert.match(result.stderr, /Did you mean "--json"/);
    assert.doesNotMatch(result.stderr, /EXECUTED/);
  });

  it("does not execute arbitrary command-prefix abbreviations", () => {
    const result = runFixture("cache", "cl", "--dry-run");

    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Unknown command: cache cl/);
    assert.doesNotMatch(result.stderr, /EXECUTED/);
    assert.doesNotMatch(result.stderr, /Removed fixture cache entries/);
  });
});
