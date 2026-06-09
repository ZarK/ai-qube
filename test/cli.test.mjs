import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";

const node = process.execPath;

function runAib(args) {
  return spawnSync(node, ["bin/run", ...args], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
}

function parseJsonStdout(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("renders help and version", () => {
  const help = runAib(["--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /aib/);
  assert.match(help.stdout, /init/);
  assert.match(help.stdout, /schema/);

  const version = runAib(["--version"]);
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), "0.1.0");
});

test("schema exposes dry-run and mutation metadata", () => {
  const schema = parseJsonStdout(runAib(["schema", "--json"]));
  const init = schema.commands.find((command) => command.name === "init");
  assert.ok(init);
  assert.equal(init.dryRun.supported, true);
  assert.deepEqual(init.mutation.categories, ["local-config", "local-files"]);
  assert.equal(init.supplyChain.sensitive, false);
});

test("init dry-run returns agent-facing next action without mutating", () => {
  const result = parseJsonStdout(runAib(["init", "--dry-run", "--json", "--idea", "Local photo archive"]));
  assert.equal(result.ok, true);
  assert.equal(result.command, "init");
  assert.equal(result.mutated, false);
  assert.equal(result.dryRun, true);
  assert.equal(result.nextAction.actor, "agent");
  assert.match(result.nextAction.prompt, /product intent/i);
  assert.ok(result.sessionPath.endsWith("/.bootstrap/session.json") || result.sessionPath.endsWith("\\.bootstrap\\session.json"));
  assert.equal(result.session.project.intent, "Local photo archive");
});

test("init requires dry-run before file mutation", () => {
  const result = runAib(["init", "--json"]);
  assert.notEqual(result.status, 0);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, false);
  assert.equal(body.error.kind, "init-dry-run-required");
});

test("invalid config fails as validation error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aib-test-"));
  const configPath = join(dir, "aib.config.json");
  await writeFile(configPath, JSON.stringify({ version: 2 }), "utf8");

  const result = runAib(["init", "--dry-run", "--json", "--config", configPath]);
  assert.notEqual(result.status, 0);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, false);
  assert.equal(body.error.kind, "init-config-invalid");
});

test("valid config shapes providers paths surfaces and safety policy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aib-test-"));
  const configPath = join(dir, "aib.config.json");
  await writeFile(configPath, JSON.stringify({
    version: 1,
    providers: {
      work: "github",
      review: "local"
    },
    agent: {
      host: "codex",
      surfaces: ["codex", "opencode"],
      questionBudget: 2
    },
    paths: {
      stateDir: ".aib",
      docsDir: "planning",
      specPath: "planning/spec.md",
      milestonesDir: "planning/milestones",
      issuesDir: "planning/issues"
    },
    safety: {
      dryRunRequired: true,
      allowNetwork: false,
      packageAgeDays: 14
    }
  }), "utf8");

  const body = parseJsonStdout(runAib(["init", "--dry-run", "--json", "--config", configPath]));
  assert.equal(body.config.providers.work, "github");
  assert.equal(body.config.agent.surfaces.length, 2);
  assert.equal(body.session.safety.allowNetwork, false);
  assert.ok(body.plannedDocuments.some((item) => item.endsWith("/planning/spec.md") || item.endsWith("\\planning\\spec.md")));
});
