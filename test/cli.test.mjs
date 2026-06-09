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

const forbiddenEarlyQuestionTerms = /\b(api|apis|schema|schemas|selector|selectors|ipc|ci|package manager|provider)\b/i;

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
  assert.ok(init.errors.some((error) => error.kind === "init-write-failed"));
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
    discovery: {
      referencePaths: ["../reference-docs", "../reference-repo"],
      inspectDocs: true
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
  assert.deepEqual(body.config.discovery.referencePaths, ["../reference-docs", "../reference-repo"]);
  assert.equal(body.config.discovery.inspectDocs, true);
  assert.deepEqual(body.state.discovery.referencePaths, ["../reference-docs", "../reference-repo"]);
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

test("fresh ideas receive staged high-level discovery questions", async () => {
  const ideas = [
    "Make an app for planning neighborhood events",
    "Create a CLI package for organizing project notes",
    "Bootstrap a research plan for evaluating school lunch programs",
    "Build a local AI assistant for personal document search"
  ];

  for (const idea of ideas) {
    const dir = await mkdtemp(join(tmpdir(), "aib-staged-discovery-"));
    const init = parseJsonStdout(runAib(["init", dir, "--idea", idea, "--json"]));
    const questions = init.nextAction.questions;
    assert.ok(questions.length >= 3);
    assert.ok(questions.length <= 5);
    assert.ok(questions.some((question) => question.id === "project.shape"));
    for (const question of questions) {
      assert.equal(question.phase, "project_clarification");
      assert.equal(question.depth, "high");
      assert.ok(question.id);
      assert.ok(question.text);
      assert.ok(question.why);
      assert.ok(question.recommendedDefault);
      assert.ok(Array.isArray(question.stateFields));
      assert.ok(question.stateFields.length > 0);
      assert.doesNotMatch(`${question.text} ${question.why}`, forbiddenEarlyQuestionTerms);
    }
  }
});

test("default answers become explicit assumptions instead of blockers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aib-default-answer-"));
  const init = parseJsonStdout(runAib(["init", dir, "--idea", "Build a local AI assistant", "--json"]));
  const answer = parseJsonStdout(runAib([
    "answer",
    "--state",
    init.statePath,
    "--field",
    "project.shape",
    "--value",
    "default",
    "--json"
  ]));

  assert.equal(answer.state.project.shape, "Assume a reasonable default for project.shape.");
  assert.deepEqual(answer.state.assumptions, ["project.shape: Assume a reasonable default for project.shape."]);
  const status = parseJsonStdout(runAib(["status", "--state", init.statePath, "--json"]));
  assert.ok(!status.missingDecisions.includes("project.shape"));
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

test("answer dry-run and assumptions do not mutate persisted state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aib-answer-dry-run-"));
  const init = parseJsonStdout(runAib(["init", dir, "--idea", "Build a research brief", "--json"]));
  const answer = parseJsonStdout(runAib([
    "answer",
    "--state",
    init.statePath,
    "--field",
    "project.audience",
    "--value",
    "Policy analysts",
    "--assumption",
    "--dry-run",
    "--json"
  ]));
  assert.equal(answer.mutated, false);
  assert.equal(answer.dryRun, true);
  assert.deepEqual(answer.state.assumptions, ["project.audience: Policy analysts"]);

  const stateFile = JSON.parse(await readFile(init.statePath, "utf8"));
  assert.equal(stateFile.project.audience, undefined);
  assert.deepEqual(stateFile.assumptions, []);
});

test("answer validation errors are specific and actionable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aib-answer-invalid-"));
  const init = parseJsonStdout(runAib(["init", dir, "--idea", "Build a research brief", "--json"]));

  const unknownField = runAib(["answer", "--state", init.statePath, "--field", "project.schema", "--value", "x", "--json"]);
  assert.notEqual(unknownField.status, 0);
  assert.equal(JSON.parse(unknownField.stdout).error.kind, "answer-field-invalid");

  const blankValue = runAib(["answer", "--state", init.statePath, "--field", "project.audience", "--value", "   ", "--json"]);
  assert.notEqual(blankValue.status, 0);
  assert.equal(JSON.parse(blankValue.stdout).error.kind, "answer-value-invalid");
});

test("answer rejects terminal and non-discovery phases", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aib-answer-phase-"));
  const init = parseJsonStdout(runAib(["init", dir, "--idea", "Build a research brief", "--json"]));
  const state = JSON.parse(await readFile(init.statePath, "utf8"));
  state.phase = "finalized";
  await writeFile(init.statePath, JSON.stringify(state), "utf8");

  const result = runAib(["answer", "--state", init.statePath, "--field", "project.audience", "--value", "Policy analysts", "--json"]);
  assert.notEqual(result.status, 0);
  assert.equal(JSON.parse(result.stdout).error.kind, "answer-transition-invalid");
});

test("phase next actions stop or request the correct agent action", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aib-phase-next-"));
  const init = parseJsonStdout(runAib(["init", dir, "--idea", "Build a research brief", "--json"]));
  const state = JSON.parse(await readFile(init.statePath, "utf8"));

  state.phase = "blocked";
  await writeFile(init.statePath, JSON.stringify(state), "utf8");
  const blocked = parseJsonStdout(runAib(["next", "--state", init.statePath, "--json"]));
  assert.equal(blocked.nextAction.kind, "stop");
  assert.match(blocked.nextAction.stopCondition, /blocker/i);

  state.phase = "spec_acceptance";
  await writeFile(init.statePath, JSON.stringify(state), "utf8");
  const acceptance = parseJsonStdout(runAib(["next", "--state", init.statePath, "--json"]));
  assert.equal(acceptance.nextAction.kind, "request_acceptance");

  state.phase = "discovery";
  state.project = {
    intent: "Build a research brief",
    audience: "Policy analysts",
    coreJob: "Summarize evidence",
    successNarrative: "Clear answer",
    scope: "First brief",
    nonGoals: "No publication workflow",
    shape: "document set",
    constraints: "No sensitive data"
  };
  await writeFile(init.statePath, JSON.stringify(state), "utf8");
  const draft = parseJsonStdout(runAib(["next", "--state", init.statePath, "--json"]));
  assert.equal(draft.nextAction.kind, "draft_spec");
  assert.equal(draft.nextAction.nextCommand, "aib status --json");
});

test("configured references request context inspection before human questions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aib-context-inspection-"));
  const configPath = join(dir, "aib.config.json");
  await writeFile(configPath, JSON.stringify({
    version: 1,
    discovery: {
      referencePaths: ["../private-consumer-repo/docs/spec.md"],
      inspectDocs: true
    },
    paths: {
      docsDir: "planning",
      specPath: "planning/spec.md"
    }
  }), "utf8");

  const init = parseJsonStdout(runAib([
    "init",
    dir,
    "--config",
    configPath,
    "--idea",
    "Create a reusable CLI package from existing reference notes",
    "--json"
  ]));
  assert.equal(init.nextAction.kind, "inspect_context");
  assert.equal(init.nextAction.actor, "agent");
  assert.ok(init.nextAction.contextInspection.targets.some((target) => target.kind === "reference"));
  assert.ok(init.nextAction.contextInspection.targets.some((target) => target.kind === "docs"));
  assert.ok(init.nextAction.contextInspection.targets.some((target) => target.kind === "docs" && target.path === "planning"));
  assert.deepEqual(init.nextAction.stateFields, ["discovery.inspectedSources", "discovery.knownDecisions", "discovery.unresolvedQuestions"]);
  assert.match(init.nextAction.nextCommand, /discovery\.inspectedSources/);

  const answer = parseJsonStdout(runAib([
    "answer",
    "--state",
    init.statePath,
    "--field",
    "discovery.inspectedSources",
    "--value",
    "Existing docs show a package boundary and unresolved output destination decision.",
    "--json"
  ]));
  assert.equal(answer.nextAction.kind, "ask_human");
  assert.ok(answer.nextAction.questions.length >= 3);
  assert.ok(answer.nextAction.questions.length <= 5);
  assert.ok(answer.nextAction.questions.every((question) => question.recommendedDefault));
  assert.doesNotMatch(JSON.stringify(answer.nextAction), /private-consumer-repo/);

  const decision = parseJsonStdout(runAib([
    "answer",
    "--state",
    init.statePath,
    "--field",
    "discovery.knownDecisions",
    "--value",
    "The reusable package should keep reference evidence out of generated docs.",
    "--json"
  ]));
  assert.deepEqual(decision.state.discovery.knownDecisions, [
    "The reusable package should keep reference evidence out of generated docs."
  ]);
  assert.equal(decision.nextAction.kind, "ask_human");

  const unresolved = parseJsonStdout(runAib([
    "answer",
    "--state",
    init.statePath,
    "--field",
    "discovery.unresolvedQuestions",
    "--value",
    "Confirm whether markdown output or a tracker should be used first.",
    "--json"
  ]));
  assert.deepEqual(unresolved.state.discovery.unresolvedQuestions, [
    "Confirm whether markdown output or a tracker should be used first."
  ]);
});

test("answering initial intent can move to context inspection when references are configured", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aib-intent-then-inspect-"));
  const configPath = join(dir, "aib.config.json");
  await writeFile(configPath, JSON.stringify({
    version: 1,
    discovery: {
      referencePaths: ["../reference-repo"]
    }
  }), "utf8");

  const init = parseJsonStdout(runAib(["init", dir, "--config", configPath, "--json"]));
  assert.equal(init.nextAction.kind, "ask_human");

  const answer = parseJsonStdout(runAib([
    "answer",
    "--state",
    init.statePath,
    "--field",
    "project.intent",
    "--value",
    "Build a planning package from an existing repository",
    "--json"
  ]));
  assert.equal(answer.nextAction.kind, "inspect_context");
  assert.equal(answer.state.planning.nextAction.kind, "inspect_context");
});

test("reusable package discovery asks for reuse boundary without leaking references", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aib-reuse-boundary-"));
  const init = parseJsonStdout(runAib(["init", dir, "--idea", "Create a reusable CLI package for project planning", "--json"]));
  const state = JSON.parse(await readFile(init.statePath, "utf8"));
  state.project = {
    intent: "Create a reusable CLI package for project planning",
    audience: "AI agents working with humans",
    coreJob: "Guide project planning",
    shape: "CLI package",
    successNarrative: "Agents can ask the right questions",
    scope: "First planning flow",
    nonGoals: "No implementation execution",
    constraints: "Tool and host agnostic"
  };
  await writeFile(init.statePath, JSON.stringify(state), "utf8");

  const next = parseJsonStdout(runAib(["next", "--state", init.statePath, "--json"]));
  assert.equal(next.nextAction.kind, "ask_human");
  assert.ok(next.nextAction.questions.some((question) => question.id === "project.reuseBoundary"));
  assert.ok(next.nextAction.questions.some((question) => question.id === "project.planningSurface"));
  assert.doesNotMatch(JSON.stringify(next.nextAction), /consumer repo/i);
});

test("work-tracker uncertainty becomes a concrete planning-surface question", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aib-work-tracker-"));
  const init = parseJsonStdout(runAib(["init", dir, "--idea", "Plan a document project with issue tracker handoff", "--json"]));
  const state = JSON.parse(await readFile(init.statePath, "utf8"));
  state.project = {
    intent: "Plan a document project with issue tracker handoff",
    audience: "Project maintainers",
    coreJob: "Create a useful planning packet",
    shape: "document set",
    successNarrative: "The team can start from accepted docs",
    scope: "Spec and first milestones",
    nonGoals: "No implementation work",
    constraints: "Keep private references out of product docs"
  };
  await writeFile(init.statePath, JSON.stringify(state), "utf8");

  const next = parseJsonStdout(runAib(["next", "--state", init.statePath, "--json"]));
  assert.equal(next.nextAction.kind, "ask_human");
  assert.ok(next.nextAction.questions.some((question) => question.id === "project.planningSurface"));
});

test("state validation checks question budget bounds and artifact structure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aib-state-validation-"));
  const init = parseJsonStdout(runAib(["init", dir, "--idea", "Build a research brief", "--json"]));
  const state = JSON.parse(await readFile(init.statePath, "utf8"));

  state.agent.questionBudget = 1;
  await writeFile(init.statePath, JSON.stringify(state), "utf8");
  const one = parseJsonStdout(runAib(["next", "--state", init.statePath, "--json"]));
  assert.equal(one.nextAction.questions.length, 1);

  state.agent.questionBudget = 8;
  await writeFile(init.statePath, JSON.stringify(state), "utf8");
  const eight = parseJsonStdout(runAib(["next", "--state", init.statePath, "--json"]));
  assert.ok(eight.nextAction.questions.length <= 8);

  state.agent.questionBudget = 0;
  await writeFile(init.statePath, JSON.stringify(state), "utf8");
  const zero = runAib(["status", "--state", init.statePath, "--json"]);
  assert.notEqual(zero.status, 0);
  assert.equal(JSON.parse(zero.stdout).error.kind, "state-invalid");

  state.agent.questionBudget = 9;
  await writeFile(init.statePath, JSON.stringify(state), "utf8");
  const nine = runAib(["status", "--state", init.statePath, "--json"]);
  assert.notEqual(nine.status, 0);
  assert.equal(JSON.parse(nine.stdout).error.kind, "state-invalid");

  state.agent.questionBudget = 3;
  delete state.artifacts.spec.path;
  await writeFile(init.statePath, JSON.stringify(state), "utf8");
  const missingPath = runAib(["status", "--state", init.statePath, "--json"]);
  assert.notEqual(missingPath.status, 0);
  assert.match(JSON.parse(missingPath.stdout).error.likelyCause, /artifacts\.spec\.path/);

  const nestedState = JSON.parse(await readFile(init.statePath, "utf8"));
  nestedState.artifacts.spec = { path: "docs/spec.md", status: "missing" };
  delete nestedState.planning.artifacts.spec.path;
  await writeFile(init.statePath, JSON.stringify(nestedState), "utf8");
  const missingNestedPath = runAib(["status", "--state", init.statePath, "--json"]);
  assert.notEqual(missingNestedPath.status, 0);
  assert.match(JSON.parse(missingNestedPath.stdout).error.likelyCause, /planning\.artifacts\.spec\.path/);
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
