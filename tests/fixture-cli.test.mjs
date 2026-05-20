import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

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
    assert.match(flagHelp.stdout, /schema\s+Render fixture command metadata/);
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

  it("renders schema JSON that matches the runtime registry", () => {
    const result = runFixture("schema", "--json");

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    const schema = JSON.parse(result.stdout);
    assert.equal(schema.bin, "fixture");
    assert.deepEqual(schema.topics.map((topic) => topic.name), ["cache"]);
    assert.deepEqual(schema.commands.map((command) => command.name), ["cache clear", "cache inspect", "schema"]);
    assert.equal(schema.commands.find((command) => command.name === "cache clear")?.mutation.categories[0], "local-files");
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
    const clear = runFixture("cc", "--dry-run");

    assert.equal(inspect.status, 0);
    assert.equal(inspect.stderr, "");
    assert.deepEqual(JSON.parse(inspect.stdout), { ok: true, command: "cache inspect", key: "alpha" });
    assert.equal(clear.status, 0);
    assert.match(clear.stdout, /EXECUTED cache clear/);
    assert.match(clear.stdout, /Would remove fixture cache entries/);
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
