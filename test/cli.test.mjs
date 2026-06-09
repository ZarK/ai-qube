import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
  assert.match(result.nextAction.summary, /human/i);
  assert.ok(result.sessionPath.endsWith("/.bootstrap/session.json") || result.sessionPath.endsWith("\\.bootstrap\\session.json"));
  assert.equal(result.session.project.intent, "Local photo archive");
});

test("init dry-run does not write state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aib-dry-run-"));
  const body = parseJsonStdout(runAib(["init", dir, "--dry-run", "--json"]));
  assert.equal(body.mutated, false);
  await assert.rejects(readFile(body.sessionPath, "utf8"));
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

test("init writes resumable state and next returns a small question batch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aib-state-"));
  const init = parseJsonStdout(runAib(["init", dir, "--idea", "Build a local photo catalog", "--agent", "codex", "--json"]));
  assert.equal(init.mutated, true);
  assert.equal(init.phase, "discovery");
  assert.equal(init.state.project.intent, "Build a local photo catalog");
  assert.equal(init.nextAction.kind, "ask_human");
  assert.ok(init.nextAction.questions.length >= 3);
  assert.ok(init.nextAction.questions.length <= 5);

  const stateFile = JSON.parse(await readFile(init.statePath, "utf8"));
  assert.equal(stateFile.agent.host, "codex");

  const next = parseJsonStdout(runAib(["next", "--state", init.statePath, "--json"]));
  assert.equal(next.nextAction.kind, "ask_human");
  assert.equal(next.nextAction.stopCondition, "Stop after asking this batch and wait for the human's answers.");
});

test("answer records human input and status reports missing decisions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aib-answer-"));
  const init = parseJsonStdout(runAib(["init", dir, "--idea", "Build a research brief", "--json"]));
  const answer = parseJsonStdout(runAib([
    "answer",
    "--state",
    init.statePath,
    "--field",
    "project.audience",
    "--value",
    "Policy analysts",
    "--json"
  ]));
  assert.equal(answer.mutated, true);
  assert.equal(answer.state.project.audience, "Policy analysts");

  const status = parseJsonStdout(runAib(["status", "--state", init.statePath, "--json"]));
  assert.equal(status.phase, "discovery");
  assert.ok(!status.missingDecisions.includes("project.audience"));
  assert.ok(status.missingDecisions.includes("project.coreJob"));
});

test("invalid state fails with actionable JSON error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aib-invalid-state-"));
  const statePath = join(dir, "session.json");
  await writeFile(statePath, JSON.stringify({ version: 99 }), "utf8");

  const result = runAib(["status", "--state", statePath, "--json"]);
  assert.notEqual(result.status, 0);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, false);
  assert.equal(body.error.kind, "state-invalid");
  assert.match(body.error.suggestedNextAction, /aib init/);
});
