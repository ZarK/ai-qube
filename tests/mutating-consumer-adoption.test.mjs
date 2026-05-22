import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { assertCliDryRun, assertCliHelp, assertCliJsonError, assertCliJsonSuccess, assertCliResult, assertCliSuccess, parseCliJsonRecord, runNodeCliCommand } from "../dist/testing/index.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const compiledConsumerDir = join(repoRoot, "examples/mutating-consumer/dist");
let consumerRoot;
let consumerCliPath;
let stateFilePath;

const initialCatalogState = Object.freeze({
  items: Object.freeze([
    Object.freeze({ id: "alpha", name: "Alpha item", status: "available" }),
    Object.freeze({ id: "bravo", name: "Bravo item", status: "archived" }),
    Object.freeze({ id: "charlie", name: "Charlie item", status: "archived" })
  ])
});

function copyCompiledConsumer() {
  consumerRoot = mkdtempSync(join(tmpdir(), "cube-cli-mutating-consumer-"));
  const nodeModulesDir = join(consumerRoot, "node_modules");
  const packageScopeDir = join(nodeModulesDir, "@tjalve");
  mkdirSync(packageScopeDir, { recursive: true });
  symlinkSync(repoRoot, join(packageScopeDir, "cube-cli"), "dir");
  writeFileSync(
    join(consumerRoot, "package.json"),
    `${JSON.stringify({ name: "mutating-consumer-contract", private: true, type: "module" }, null, 2)}\n`
  );

  for (const entry of readdirSync(compiledConsumerDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".js")) {
      copyFileSync(join(compiledConsumerDir, entry.name), join(consumerRoot, entry.name));
    }
  }
  consumerCliPath = join(consumerRoot, "cli.js");
  stateFilePath = join(consumerRoot, "catalog-state.json");
}

function resetState() {
  writeFileSync(stateFilePath, `${JSON.stringify(initialCatalogState, null, 2)}\n`);
}

function readState() {
  return JSON.parse(readFileSync(stateFilePath, "utf8"));
}

function runConsumer(...args) {
  return runNodeCliCommand(consumerCliPath, args, { cwd: consumerRoot });
}

describe("mutating consumer adoption", () => {
  before(() => {
    copyCompiledConsumer();
  });

  beforeEach(() => {
    resetState();
  });

  after(() => {
    if (consumerRoot !== undefined) {
      rmSync(consumerRoot, { recursive: true, force: true });
    }
  });

  it("runs from an isolated consumer package through public package exports", () => {
    assert.match(consumerRoot, /cube-cli-mutating-consumer-/);
    assert.equal(existsSync(consumerCliPath), true);
    assert.equal(existsSync(stateFilePath), true);
  });

  it("renders standard help forms with dry-run and mutation disclosure", () => {
    const rootHelp = runConsumer("--help");
    const commandHelp = runConsumer("help", "catalog", "prune");
    const flagHelp = runConsumer("catalog", "prune", "--help");
    const tokenHelp = runConsumer("catalog", "prune", "help");

    assertCliHelp(rootHelp, {
      contains: [/mutating-consumer\nMutating consumer CLI validating @tjalve\/cube-cli dry-run adoption\./, /catalog prune\s+Remove archived catalog items/]
    });
    assertCliHelp(commandHelp, {
      contains: ["Usage:\n  mutating-consumer catalog prune [state-file] [--dry-run] [--json] [--yes]", /Dry run: supported/, /Mutation: local-files/]
    });
    assertCliHelp(flagHelp);
    assertCliHelp(tokenHelp);
    assert.equal(commandHelp.stdout, flagHelp.stdout);
    assert.equal(flagHelp.stdout, tokenHelp.stdout);
  });

  it("renders deterministic schema metadata for the adopted mutating command", () => {
    const first = runConsumer("schema", "--json");
    const second = runConsumer("schema", "--json");

    assertCliSuccess(first);
    assertCliSuccess(second);
    assert.equal(first.stdout, second.stdout);
    const schema = parseCliJsonRecord(first);
    assert.deepEqual(schema.package, { name: "mutating-consumer", version: "0.1.0" });
    assert.equal(schema.bin, "mutating-consumer");
    assert.deepEqual(schema.topics.map((topic) => topic.name), ["catalog"]);

    const command = schema.commands.find((entry) => entry.name === "catalog prune");
    assert.ok(command, "expected catalog prune command in schema");
    assert.deepEqual(command.output, { formats: ["human", "json"], defaultFormat: "human" });
    assert.deepEqual(command.interactions, {
      json: true,
      noColor: true,
      nonInteractive: true,
      ttyPrompt: true
    });
    assert.deepEqual(command.dryRun, { supported: true });
    assert.deepEqual(command.mutation, { mutates: true, categories: ["local-files"] });
    assert.deepEqual(command.errors, [
      { kind: "catalog-prune-approval-required", description: "Catalog pruning was blocked until the consumer approval policy is satisfied.", exitCode: 5 },
      { kind: "catalog-state-invalid", description: "The catalog state file could not be read or validated.", exitCode: 3 }
    ]);
    assert.deepEqual(command.exitCodes, [
      { code: 0, category: "success", description: "The command completed successfully." },
      { code: 3, category: "validation", description: "The catalog state file was missing or invalid." },
      { code: 5, category: "safety", description: "The command was blocked until explicit approval was provided." }
    ]);
  });

  it("previews local-file mutation without changing consumer state", () => {
    const before = readState();
    const dryRun = runConsumer("catalog", "prune", stateFilePath, "--dry-run");
    const dryRunJson = runConsumer("catalog", "prune", stateFilePath, "--dry-run", "--json");
    const spacedStateFilePath = join(consumerRoot, "catalog state with spaces.json");
    writeFileSync(spacedStateFilePath, `${JSON.stringify(initialCatalogState, null, 2)}\n`);
    const spacedDryRun = runConsumer("catalog", "prune", spacedStateFilePath, "--dry-run");

    assertCliDryRun(dryRun, {
      contains: [/Mutation categories: local-files/, /State file not changed\./, /Rerun without --dry-run to apply: mutating-consumer catalog prune/],
      excludes: /MUTATING HANDLER EXECUTED/
    });
    assert.deepEqual(readState(), before);

    assertCliDryRun(spacedDryRun, {
      contains: `Rerun without --dry-run to apply: mutating-consumer catalog prune '${spacedStateFilePath}' --yes`
    });

    const envelope = assertCliJsonSuccess(dryRunJson);
    assert.equal(envelope.dryRun, true);
    assert.deepEqual(envelope.wouldRemove, ["bravo", "charlie"]);
    assert.deepEqual(envelope.remaining, ["alpha"]);
    assert.deepEqual(envelope.dryRunPlan.mutationCategories, ["local-files"]);
    assert.deepEqual(readState(), before);
  });

  it("blocks unapproved local-file mutation with a safety error", () => {
    const before = readState();
    const human = runConsumer("catalog", "prune", stateFilePath);
    const json = runConsumer("catalog", "prune", stateFilePath, "--json");

    assertCliResult(human, {
      status: 5,
      stdout: "",
      stderr: [/Error: catalog-prune-approval-required/, /Exit code category: safety/]
    });
    assertCliJsonError(json, {
      status: 5,
      envelope: {
        ok: false,
        command: "catalog prune",
        error: {
          kind: "catalog-prune-approval-required",
          operation: "prune archived catalog items",
          likelyCause: "The command would modify a local state file, but neither --dry-run nor --yes was provided.",
          suggestedNextAction: "Run with --dry-run to preview changes, or rerun with --yes after reviewing the plan.",
          category: "safety",
          exitCode: 5
        }
      }
    });
    assert.deepEqual(readState(), before);
  });

  it("blocks unapproved mutation before validating state files", () => {
    const missingStateFile = join(consumerRoot, "missing-catalog-state.json");

    assertCliJsonError(runConsumer("catalog", "prune", missingStateFile, "--json"), {
      status: 5,
      command: "catalog prune",
      kind: "catalog-prune-approval-required",
      category: "safety",
      exitCode: 5,
      operation: "prune archived catalog items"
    });
  });

  it("applies approved local-file mutation only when --yes is present", () => {
    const result = runConsumer("catalog", "prune", stateFilePath, "--yes");

    assertCliSuccess(result, {
      stdout: [/Mutation warning/, /MUTATING HANDLER EXECUTED/, /Removed 2 archived catalog items\./]
    });
    assert.deepEqual(readState(), { items: [{ id: "alpha", name: "Alpha item", status: "available" }] });

    resetState();
    const json = runConsumer("catalog", "prune", stateFilePath, "--yes", "--json");
    const envelope = assertCliJsonSuccess(json);
    assert.equal(envelope.mutated, true);
    assert.equal(envelope.dryRun, undefined);
    assert.deepEqual(envelope.removed, ["bravo", "charlie"]);
    assert.deepEqual(envelope.remaining, ["alpha"]);
    assert.deepEqual(readState(), { items: [{ id: "alpha", name: "Alpha item", status: "available" }] });
  });
});
