import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { assertCliHelp, assertCliJsonError, assertCliJsonSuccess, assertCliSuccess, parseCliJsonRecord, runNodeCliCommand } from "../dist/testing/index.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const compiledConsumerDir = join(repoRoot, "examples/read-only-consumer/dist");
let consumerRoot;
let consumerCliPath;

function copyCompiledConsumer() {
  consumerRoot = mkdtempSync(join(tmpdir(), "qube-cli-read-only-consumer-"));
  const nodeModulesDir = join(consumerRoot, "node_modules");
  const packageScopeDir = join(nodeModulesDir, "@tjalve");
  mkdirSync(packageScopeDir, { recursive: true });
  linkPackageRoot(join(packageScopeDir, "qube-cli"));
  writeFileSync(
    join(consumerRoot, "package.json"),
    `${JSON.stringify({ name: "read-only-consumer-contract", private: true, type: "module" }, null, 2)}\n`
  );

  for (const entry of readdirSync(compiledConsumerDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".js")) {
      copyFileSync(join(compiledConsumerDir, entry.name), join(consumerRoot, entry.name));
    }
  }
  consumerCliPath = join(consumerRoot, "cli.js");
}

function runConsumer(...args) {
  return runNodeCliCommand(consumerCliPath, args, { cwd: consumerRoot });
}

function linkPackageRoot(target) {
  symlinkSync(repoRoot, target, platform() === "win32" ? "junction" : "dir");
}

describe("read-only consumer adoption", () => {
  before(() => {
    copyCompiledConsumer();
  });

  after(() => {
    if (consumerRoot !== undefined) {
      rmSync(consumerRoot, { recursive: true, force: true });
    }
  });

  it("runs from an isolated consumer package through public package exports", () => {
    assert.match(consumerRoot, /qube-cli-read-only-consumer-/);
    assert.equal(existsSync(consumerCliPath), true);
    const result = runConsumer("catalog", "inspect", "alpha");

    assertCliSuccess(result, {
      stdout: [/READ-ONLY HANDLER EXECUTED/, /Catalog item alpha: Alpha item \(available\)/, /No state changed\./]
    });
  });

  it("renders standard help forms without executing the consumer handler", () => {
    const rootHelp = runConsumer("--help");
    const commandHelp = runConsumer("help", "catalog", "inspect");
    const flagHelp = runConsumer("catalog", "inspect", "--help");
    const tokenHelp = runConsumer("catalog", "inspect", "help");

    assertCliHelp(rootHelp, {
      contains: [/consumer\nRead-only consumer CLI validating @tjalve\/qube-cli adoption\./, /consumer --version/, /catalog inspect\s+Inspect a catalog item/]
    });
    assertCliHelp(commandHelp, {
      contains: ["Usage:\n  consumer catalog inspect <id> [--json] [--output <value>]", /JSON output: supported/]
    });
    assertCliHelp(flagHelp);
    assertCliHelp(tokenHelp);
    assert.equal(commandHelp.stdout, flagHelp.stdout);
    assert.equal(flagHelp.stdout, tokenHelp.stdout);
  });

  it("inherits global version output from the shared runtime", () => {
    const human = runConsumer("--version");
    const json = runConsumer("--version", "--json");

    assertCliSuccess(human, { stdout: "0.1.0\n", stdoutExcludes: /READ-ONLY HANDLER EXECUTED/ });
    assertCliJsonSuccess(json, {
      ok: true,
      command: "version",
      package: {
        name: "read-only-consumer",
        version: "0.1.0"
      },
      version: "0.1.0"
    });
    assert.doesNotMatch(json.stdout, /READ-ONLY HANDLER EXECUTED/);
  });

  it("emits clean JSON success output for read-only behavior", () => {
    assertCliJsonSuccess(runConsumer("catalog", "inspect", "alpha", "--json"), {
      ok: true,
      command: "catalog inspect",
      id: "alpha",
      name: "Alpha item",
      status: "available",
      mutated: false
    });
    assertCliJsonSuccess(runConsumer("catalog", "inspect", "bravo", "--output", "json"), {
      ok: true,
      command: "catalog inspect",
      id: "bravo",
      name: "Bravo item",
      status: "archived",
      mutated: false
    });
  });

  it("renders deterministic schema metadata for the adopted command", () => {
    const first = runConsumer("schema", "--json");
    const second = runConsumer("schema", "--json");

    assertCliSuccess(first);
    assertCliSuccess(second);
    assert.equal(first.stdout, second.stdout);
    const schema = parseCliJsonRecord(first);
    assert.deepEqual(schema.package, { name: "read-only-consumer", version: "0.1.0" });
    assert.equal(schema.bin, "consumer");
    assert.deepEqual(schema.topics.map((topic) => topic.name), ["catalog"]);

    const command = schema.commands.find((entry) => entry.name === "catalog inspect");
    assert.ok(command, "expected catalog inspect command in schema");
    assert.deepEqual(command.output, { formats: ["human", "json"], defaultFormat: "human" });
    assert.deepEqual(command.interactions, {
      json: true,
      noColor: true,
      nonInteractive: true,
      ttyPrompt: false
    });
    assert.deepEqual(command.mutation, { mutates: false, categories: [] });
    assert.deepEqual(command.errors, [
      { kind: "catalog-item-not-found", description: "The requested catalog item was not found.", exitCode: 3 }
    ]);
    assert.deepEqual(command.exitCodes, [
      { code: 0, category: "success", description: "The command completed successfully." },
      { code: 3, category: "validation", description: "The catalog item identifier was invalid or unknown." }
    ]);
  });

  it("renders structured JSON validation errors with stable exit codes", () => {
    assertCliJsonError(runConsumer("catalog", "inspect", "missing", "--json"), {
      status: 3,
      envelope: {
        ok: false,
        command: "catalog inspect",
        error: {
          kind: "catalog-item-not-found",
          operation: "inspect catalog item",
          likelyCause: "No catalog item matched \"missing\".",
          suggestedNextAction: "Choose an existing catalog item such as alpha or bravo.",
          category: "validation",
          exitCode: 3
        }
      }
    });
  });

  it("renders JSON usage errors for invalid read-only command flags", () => {
    const output = assertCliJsonError(runConsumer("catalog", "inspect", "alpha", "--output", "xml", "--json"), {
      status: 2,
      command: "catalog inspect",
      kind: "invalid-command-usage",
      category: "usage",
      exitCode: 2,
      operation: "parse command arguments"
    });

    assert.match(output.error.likelyCause, /human/);
    assert.match(output.error.likelyCause, /json/);
  });
});
