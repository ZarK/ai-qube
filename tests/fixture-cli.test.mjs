import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { assertCliDryRun, assertCliHelp, assertCliJsonError, assertCliJsonSuccess, assertCliPromptBlocked, assertCliResult, assertCliSuccess, parseCliJsonRecord, runNodeCliCommand } from "../dist/testing/index.js";

const packageMetadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const projectRoot = new URL("..", import.meta.url);
const fixtureCliPath = new URL("../dist/fixtures/cli.js", import.meta.url);

function runFixture(...args) {
  return runNodeCliCommand(fixtureCliPath, args, { cwd: projectRoot });
}

describe("fixture CLI runtime", () => {
  it("renders stable root help without executing handlers", () => {
    const flagHelp = runFixture("--help");
    const commandHelp = runFixture("help");

    assertCliHelp(flagHelp, { contains: [/fixture\nProduct-neutral fixture CLI/, /fixture --version/, /cache clear\s+Clear cache entries/, /schema\s+Render deterministic command schema/] });
    assertCliHelp(commandHelp, { contains: [/fixture\nProduct-neutral fixture CLI/] });
    assert.equal(flagHelp.stdout, commandHelp.stdout);
  });

  it("normalizes command help forms without executing handlers", () => {
    const helpCommand = runFixture("help", "cache", "inspect");
    const helpFlag = runFixture("cache", "inspect", "--help");
    const helpToken = runFixture("cache", "inspect", "help");

    assertCliHelp(helpCommand, { contains: ["Usage:\n  fixture cache inspect [key] [--json] [--output <value>]", /JSON output: supported/] });
    assertCliHelp(helpFlag);
    assertCliHelp(helpToken);
    assert.equal(helpCommand.stdout, helpFlag.stdout);
    assert.equal(helpFlag.stdout, helpToken.stdout);
  });

  it("renders configured global version without executing handlers", () => {
    const longFlag = runFixture("--version");
    const shortFlag = runFixture("-v");

    assertCliSuccess(longFlag, { stdout: `${packageMetadata.version}\n`, stdoutExcludes: /EXECUTED/ });
    assertCliSuccess(shortFlag, { stdout: `${packageMetadata.version}\n`, stdoutExcludes: /EXECUTED/ });
    assert.equal(longFlag.stdout, shortFlag.stdout);
  });

  it("renders configured global version as JSON without dispatching commands", () => {
    const result = runFixture("--version", "--json");
    const repeated = runFixture("--json", "-v");

    assertCliJsonSuccess(result, {
      ok: true,
      command: "version",
      package: {
        name: packageMetadata.name,
        version: packageMetadata.version
      },
      version: packageMetadata.version
    });
    assert.equal(result.stdout, repeated.stdout);
    assert.doesNotMatch(result.stdout, /EXECUTED/);
  });

  it("renders mutating command help without treating final help as an argument", () => {
    const result = runFixture("cache", "clear", "help");

    assertCliHelp(result, { contains: [/Dry run: supported/, /Mutation: local-files/] });
  });

  it("renders topic help from metadata without executing handlers", () => {
    const result = runFixture("help", "cache");

    assertCliHelp(result, { contains: [/cache\nCommands for inspecting and maintaining a local cache/, /fixture cache <command> \[flags\]/, /cache inspect\s+Inspect cache entries/, /cache clear: args=0, flags=2, examples=1, json=supported, dry-run=supported, mutation=local-files, supply-chain=standard/, /cache install: args=0, flags=2, examples=1, json=supported, dry-run=supported, mutation=dependency, local-files, supply-chain=sensitive \(dependency, package-manager\)/, /cache inspect: args=1, flags=2, examples=1, json=supported, dry-run=not declared, mutation=none/] });
  });

  it("renders deterministic schema JSON that matches the runtime registry", () => {
    const defaultResult = runFixture("schema");
    const result = runFixture("schema", "--json");
    const repeated = runFixture("schema", "--json");

    assertCliSuccess(defaultResult);
    assertCliSuccess(result);
    assertCliSuccess(repeated);
    assert.equal(defaultResult.stdout, result.stdout);
    assert.equal(result.stdout, repeated.stdout);
    const schema = parseCliJsonRecord(result);
    assert.equal(schema.schemaVersion, 1);
    assert.deepEqual(schema.package, { name: packageMetadata.name, version: packageMetadata.version });
    assert.equal(schema.bin, "fixture");
    assert.deepEqual(schema.extensions, { fixture: true, purpose: "schema-integration" });
    assert.deepEqual(schema.topics.map((topic) => topic.name), ["cache"]);
    assert.deepEqual(schema.commands.map((command) => command.name), ["cache clear", "cache explode", "cache inspect", "cache install", "cache prompt", "cache validate", "schema"]);
    const clearCommand = schema.commands.find((command) => command.name === "cache clear");
    const inspectCommand = schema.commands.find((command) => command.name === "cache inspect");
    const installCommand = schema.commands.find((command) => command.name === "cache install");
    assert.deepEqual(clearCommand?.mutation, {
      mutates: true,
      categories: ["local-files"],
      extensions: { fixtureMutation: "cache-cleanup" }
    });
    assert.deepEqual(clearCommand?.dryRun, { supported: true });
    assert.deepEqual(clearCommand?.supplyChain, { sensitive: false, kinds: [] });
    assert.deepEqual(installCommand?.mutation, {
      mutates: true,
      categories: ["dependency", "local-files"],
      extensions: { fixtureMutation: "dependency-cache" }
    });
    assert.deepEqual(installCommand?.supplyChain, {
      sensitive: true,
      kinds: ["dependency", "package-manager"],
      reason: "Dependency cache preparation depends on package-manager metadata supplied by the consuming package.",
      extensions: { fixtureSupplyChain: "dependency-cache" }
    });
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

  it("resolves fixture prompts from equivalents and blocks interactive prompts in automation", () => {
    const value = runFixture("cache", "prompt", "--value", "alpha", "--json");
    const defaults = runFixture("cache", "prompt", "--defaults");
    const blocked = runFixture("cache", "prompt", "--json");

    assertCliJsonSuccess(value, { ok: true, command: "cache prompt", promptValue: "alpha" });
    assertCliSuccess(defaults);
    assert.equal(defaults.stdout, "Resolved prompt value: fixture-default\n");
    assertCliPromptBlocked(blocked, { envelope: {
      ok: false,
      command: "cache prompt",
      error: {
        kind: "prompt-blocked",
        operation: "prompt cache value",
        likelyCause: "Prompts are disabled in JSON output mode.",
        suggestedNextAction: "Provide the value with flags or config, or rerun in an interactive terminal.",
        category: "usage",
        exitCode: 2
      }
    } });
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
    const install = runFixture("cache", "install", "--dry-run", "--json");

    assertCliJsonSuccess(inspect, { ok: true, command: "cache inspect", key: "alpha" });
    assertCliJsonSuccess(outputJson, { ok: true, command: "cache inspect", key: "alpha" });
    assertCliDryRun(clear, { contains: /Rerun without --dry-run to apply: fixture cache clear --yes/, excludes: /Removed fixture cache entries/ });
    assert.deepEqual(assertCliJsonSuccess(install).dryRunPlan.mutationCategories, ["dependency", "local-files"]);
  });

  it("renders supply-chain-sensitive help and block output without external execution", () => {
    const help = runFixture("cache", "install", "--help");
    const blocked = runFixture("cache", "install");
    const blockedJson = runFixture("cache", "install", "--json");

    assertCliHelp(help, { contains: /Supply chain: sensitive \(dependency, package-manager\)/, excludes: /No external commands executed/ });
    assertCliResult(blocked, { status: 5, stderr: "", stdout: [/Supply-chain block/, /No external commands executed/], stdoutExcludes: /pnpm|npm|yarn|bun/ });
    assertCliJsonError(blockedJson, { status: 5, envelope: {
      ok: false,
      command: "cache install",
      error: {
        kind: "supply-chain-blocked",
        operation: "prepare dependency cache",
        likelyCause: "Dependency cache preparation requires consuming-package supply-chain approval.",
        suggestedNextAction: "Run --dry-run and apply the consuming package approval policy before retrying.",
        category: "safety",
        exitCode: 5
      }
    } });
  });

  it("renders known errors as stable human output", () => {
    const result = runFixture("cache", "validate");

    assertCliResult(result, { status: 3, stdout: "", stderr: [/Error: cache-config-invalid/, /Operation: validate cache configuration/, /Likely cause: The fixture cache configuration is missing a required directory\./, /Suggested next action: Create the cache directory or update the cache configuration path\./, /Exit code category: validation/] });
  });

  it("renders known errors as stable JSON output", () => {
    const result = runFixture("cache", "validate", "--json");

    assertCliJsonError(result, { status: 3, envelope: {
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
    } });
  });

  it("keeps unexpected failures as non-success JSON failures", () => {
    const result = runFixture("cache", "explode", "--json");

    assertCliJsonError(result, { status: 70, envelope: {
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
    } });
  });

  it("renders usage errors as JSON without stderr noise when JSON is requested", () => {
    const result = runFixture("cache", "inspect", "--jso", "--json");

    assertCliJsonError(result, { status: 2, envelope: {
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
    } });
  });

  it("renders parser failures as usage JSON instead of unexpected failures", () => {
    const result = runFixture("cache", "inspect", "--output", "xml", "--json");

    const output = assertCliJsonError(result, { status: 2, command: "cache inspect", kind: "invalid-command-usage", operation: "parse command arguments", category: "usage", exitCode: 2 });
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

    assertCliSuccess(result);
    assert.match(result.stdout, /Inspected cache key: --json/);
    assert.throws(() => parseCliJsonRecord(result), SyntaxError);
  });

  it("suggests likely command misses without executing handlers", () => {
    const result = runFixture("cache", "cleer");

    assertCliResult(result, { status: 2, stdout: "", stderr: [/Unknown command: cache cleer/, /Did you mean "cache clear"/], stderrExcludes: /EXECUTED/ });
  });

  it("suggests likely flag misses without executing handlers", () => {
    const result = runFixture("cache", "inspect", "--jso");

    assertCliResult(result, { status: 2, stdout: "", stderr: [/Unknown flag: --jso/, /Did you mean "--json"/], stderrExcludes: /EXECUTED/ });
  });

  it("does not execute arbitrary command-prefix abbreviations", () => {
    const result = runFixture("cache", "cl", "--dry-run");

    assertCliResult(result, { status: 2, stdout: "", stderr: /Unknown command: cache cl/, stderrExcludes: [/EXECUTED/, /Removed fixture cache entries/] });
  });
});
