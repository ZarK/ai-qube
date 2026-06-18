import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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

function fullSpecWithFeatureMap(features) {
  const sections = [
    ["Purpose", "purpose", "Build a dashboard for operational review."],
    ["Audience and stakeholders", "audience_stakeholders", "Operators and maintainers."],
    ["Success narrative", "success_narrative", "Operators can see what needs attention and act confidently."],
    ["Scope", "scope", "Dashboard, alerts, and export for the first useful version."],
    ["Non-goals", "non_goals", "No mobile app or unrelated workflow automation."],
    ["Project shape", "project_shape", "Web app with local planning artifacts."],
    ["Functional requirements", "functional_requirements", "The app must monitor work, flag blocked items, and export summaries."],
    ["Non-functional requirements", "non_functional_requirements", "Outputs must be reviewable, accessible, and deterministic enough for handoff."],
    ["Constraints and assumptions", "constraints_assumptions", "Accessible UI and product-language planning artifacts."],
    ["Feature or capability map", "feature_capability_map", features.map((feature) => `- ${feature}`).join("\n")],
    ["Risks and unknowns", "risks_unknowns", "- Review cadence may change.\n- Alert thresholds may need tuning."],
    ["Spec acceptance checklist", "spec_acceptance_checklist", "- [x] Purpose\n- [x] Scope\n- [x] Risks"]
  ];
  return `${[
    "# Project spec",
    "",
    ...sections.flatMap(([title, id, body]) => [
      `## ${title}`,
      `<!-- aib:spec-section ${id} -->`,
      "",
      body,
      ""
    ])
  ].join("\n")}\n`;
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
  assert.ok(acceptance.nextAction.missingDecisions.some((item) => item.startsWith("spec.acceptedSectionIds.")));

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

test("status reports spec chapter and acceptance state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aib-spec-status-"));
  const init = parseJsonStdout(runAib(["init", dir, "--idea", "Build a local AI documentation tool", "--json"]));
  const state = JSON.parse(await readFile(init.statePath, "utf8"));
  state.project = {
    intent: "Build a local AI documentation tool",
    audience: "Technical writers",
    coreJob: "Draft offline docs from local notes",
    shape: "local AI documentation app",
    successNarrative: "A writer gets a useful offline draft",
    scope: "Local draft flow",
    nonGoals: "No cloud sync",
    constraints: "offline privacy local runtime"
  };
  state.spec.acceptedSectionIds = ["purpose"];
  await writeFile(init.statePath, JSON.stringify(state), "utf8");

  const status = parseJsonStdout(runAib(["status", "--state", init.statePath, "--json"]));
  assert.ok(status.spec.chapters.some((chapter) => chapter.id === "ai_model_behavior"));
  assert.ok(status.spec.chapters.some((chapter) => chapter.id === "documentation_content_structure"));
  assert.deepEqual(status.spec.acceptedSectionIds, ["purpose"]);
  assert.equal(status.spec.canGenerateMilestones, false);
});

test("spec acceptance records sections and gates milestone generation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aib-spec-acceptance-"));
  const init = parseJsonStdout(runAib(["init", dir, "--idea", "Build a process playbook", "--json"]));
  const state = JSON.parse(await readFile(init.statePath, "utf8"));
  state.phase = "spec_acceptance";
  state.project = {
    intent: "Build a process playbook",
    audience: "Operations team",
    coreJob: "Describe handoffs",
    shape: "process playbook",
    successNarrative: "The team can run the process",
    scope: "First operating checklist",
    nonGoals: "No software implementation",
    constraints: "Stakeholder signoff required"
  };
  await writeFile(init.statePath, JSON.stringify(state), "utf8");

  const accepted = parseJsonStdout(runAib([
    "answer",
    "--state",
    init.statePath,
    "--field",
    "spec.acceptedSectionIds",
    "--value",
    "purpose",
    "--json"
  ]));
  assert.deepEqual(accepted.state.spec.acceptedSectionIds, ["purpose"]);
  assert.equal(accepted.nextAction.kind, "request_acceptance");

  const milestoneState = JSON.parse(await readFile(init.statePath, "utf8"));
  milestoneState.phase = "milestone_generation";
  milestoneState.spec.acceptedSectionIds = ["purpose"];
  await writeFile(init.statePath, JSON.stringify(milestoneState), "utf8");
  const blocked = parseJsonStdout(runAib(["next", "--state", init.statePath, "--json"]));
  assert.equal(blocked.nextAction.kind, "request_acceptance");
  assert.match(blocked.nextAction.summary, /blocked/i);
  assert.equal(blocked.nextAction.nextCommand, "aib answer --field spec.acceptedSectionIds --value <section-id> --json");

  const invalidSection = runAib([
    "answer",
    "--state",
    init.statePath,
    "--field",
    "spec.acceptedSectionIds",
    "--value",
    "not_a_section",
    "--json"
  ]);
  assert.notEqual(invalidSection.status, 0);
  assert.equal(JSON.parse(invalidSection.stdout).error.kind, "answer-value-invalid");

  for (const missingDecision of blocked.nextAction.missingDecisions) {
    const sectionId = missingDecision.replace("spec.acceptedSectionIds.", "");
    const sectionAccepted = parseJsonStdout(runAib([
      "answer",
      "--state",
      init.statePath,
      "--field",
      "spec.acceptedSectionIds",
      "--value",
      sectionId,
      "--json"
    ]));
    assert.ok(sectionAccepted.state.spec.acceptedSectionIds.includes(sectionId));
  }

  const ready = parseJsonStdout(runAib(["next", "--state", init.statePath, "--json"]));
  assert.equal(ready.nextAction.kind, "generate_artifacts");
});

test("spec draft writes a self-contained artifact and enters acceptance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aib-spec-draft-"));
  const init = parseJsonStdout(runAib(["init", dir, "--idea", "Build a local planning CLI", "--json"]));
  const state = JSON.parse(await readFile(init.statePath, "utf8"));
  state.project = {
    intent: "Build a local planning CLI",
    audience: "Agents working with maintainers",
    coreJob: "Turn discovery into accepted specs",
    shape: "CLI package",
    successNarrative: "An agent can draft and accept a spec without chat memory",
    scope: "Spec drafting and acceptance",
    nonGoals: "No milestone rendering yet",
    constraints: "Local files only",
    reuseBoundary: "Reusable package core",
    planningSurface: "Local markdown first"
  };
  await writeFile(init.statePath, JSON.stringify(state), "utf8");

  const dryRun = parseJsonStdout(runAib(["spec", "draft", "--state", init.statePath, "--dry-run", "--json"]));
  assert.equal(dryRun.mutated, false);
  assert.match(dryRun.content, /## Purpose/);
  assert.match(dryRun.content, /aib:spec-section purpose/);
  await assert.rejects(readFile(join(dir, "docs", "spec.md"), "utf8"));

  const drafted = parseJsonStdout(runAib(["spec", "draft", "--state", init.statePath, "--json"]));
  assert.equal(drafted.mutated, true);
  assert.equal(drafted.state.phase, "spec_acceptance");
  assert.equal(drafted.state.artifacts.spec.status, "draft");
  assert.ok(drafted.chapters.some((chapter) => chapter.id === "package_reuse_boundaries"));

  const spec = await readFile(join(dir, "docs", "spec.md"), "utf8");
  assert.match(spec, /Turn discovery into accepted specs/);
  assert.doesNotMatch(spec, /AppData|aib-spec-draft/);
});

test("spec validate rejects placeholder sections before acceptance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aib-spec-validate-"));
  const init = parseJsonStdout(runAib(["init", dir, "--idea", "Build a research brief", "--json"]));
  const state = JSON.parse(await readFile(init.statePath, "utf8"));
  state.project = {
    intent: "Build a research brief",
    audience: "Policy analysts",
    coreJob: "Summarize evidence",
    shape: "research brief",
    successNarrative: "Analysts can act on the summary",
    scope: "First brief",
    nonGoals: "No publication workflow",
    constraints: "No sensitive data"
  };
  await writeFile(init.statePath, JSON.stringify(state), "utf8");
  await mkdir(join(dir, "docs"), { recursive: true });
  await writeFile(
    join(dir, "docs", "spec.md"),
    [
      "# Project spec",
      "",
      "## Purpose",
      "<!-- aib:spec-section purpose -->",
      "",
      "TBD"
    ].join("\n"),
    "utf8"
  );

  const validation = parseJsonStdout(runAib(["spec", "validate", "--state", init.statePath, "--json"]));
  assert.equal(validation.validation.ok, false);
  assert.ok(validation.validation.placeholderSections.includes("Purpose"));
  assert.ok(validation.validation.missingRequiredSections.includes("audience_stakeholders"));
  assert.equal(validation.state.artifacts.spec.status, "blocked");

  const accept = runAib(["spec", "accept", "--state", init.statePath, "--section", "purpose", "--json"]);
  assert.notEqual(accept.status, 0);
  assert.equal(JSON.parse(accept.stdout).error.kind, "spec-validation-failed");
});

test("spec accept and reopen preserve section-aware acceptance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aib-spec-command-accept-"));
  const init = parseJsonStdout(runAib(["init", dir, "--idea", "Build a process playbook", "--json"]));
  const state = JSON.parse(await readFile(init.statePath, "utf8"));
  state.project = {
    intent: "Build a process playbook",
    audience: "Operations team",
    coreJob: "Describe handoffs",
    shape: "process playbook",
    successNarrative: "The team can run the process",
    scope: "First operating checklist",
    nonGoals: "No software implementation",
    constraints: "Stakeholder signoff required"
  };
  await writeFile(init.statePath, JSON.stringify(state), "utf8");
  parseJsonStdout(runAib(["spec", "draft", "--state", init.statePath, "--json"]));

  const blocked = runAib(["milestones", "generate", "--state", init.statePath, "--json"]);
  assert.notEqual(blocked.status, 0);
  assert.equal(JSON.parse(blocked.stdout).error.kind, "spec-not-accepted");

  const purpose = parseJsonStdout(runAib(["spec", "accept", "--state", init.statePath, "--section", "purpose", "--json"]));
  assert.deepEqual(purpose.state.spec.acceptedSectionIds, ["purpose"]);
  assert.equal(purpose.state.phase, "spec_acceptance");

  const all = parseJsonStdout(runAib(["spec", "accept", "--state", init.statePath, "--section", "all", "--json"]));
  assert.equal(all.state.phase, "milestone_generation");
  assert.equal(all.state.artifacts.spec.status, "accepted");
  assert.equal(all.spec.canGenerateMilestones, true);

  const allowed = parseJsonStdout(runAib(["milestones", "generate", "--state", init.statePath, "--json"]));
  assert.equal(allowed.allowed, true);

  const reopened = parseJsonStdout(runAib(["spec", "reopen", "--state", init.statePath, "--section", "purpose", "--json"]));
  assert.equal(reopened.state.phase, "spec_acceptance");
  assert.ok(!reopened.state.spec.acceptedSectionIds.includes("purpose"));
  assert.ok(reopened.state.spec.reopenedSectionIds.includes("purpose"));

  const blockedAgain = runAib(["milestones", "generate", "--state", init.statePath, "--json"]);
  assert.notEqual(blockedAgain.status, 0);
  assert.equal(JSON.parse(blockedAgain.stdout).error.kind, "spec-not-accepted");

  const reopenAgain = runAib(["spec", "reopen", "--state", init.statePath, "--section", "purpose", "--json"]);
  assert.notEqual(reopenAgain.status, 0);
  assert.equal(JSON.parse(reopenAgain.stdout).error.kind, "spec-section-invalid");

  parseJsonStdout(runAib(["spec", "accept", "--state", init.statePath, "--section", "purpose", "--json"]));
  const redraft = parseJsonStdout(runAib(["spec", "draft", "--state", init.statePath, "--json"]));
  assert.deepEqual(redraft.state.spec.acceptedSectionIds, []);
  assert.deepEqual(redraft.state.spec.reopenedSectionIds, []);
  assert.equal(redraft.state.spec.validation, undefined);
});

test("milestones generate writes planning-depth docs before work items", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aib-milestones-"));
  const init = parseJsonStdout(runAib(["init", dir, "--idea", "Build a local planning CLI", "--json"]));
  const state = JSON.parse(await readFile(init.statePath, "utf8"));
  state.project = {
    intent: "Build a local planning CLI",
    audience: "Agents working with maintainers",
    coreJob: "Turn accepted specs into delivery plans",
    shape: "CLI package",
    successNarrative: "An agent can plan milestones before issues",
    scope: "Milestone planning before work-item drafting",
    nonGoals: "No provider issue creation yet",
    constraints: "Local markdown artifacts first",
    reuseBoundary: "Reusable package core",
    planningSurface: "Local markdown first"
  };
  await writeFile(init.statePath, JSON.stringify(state), "utf8");
  parseJsonStdout(runAib(["spec", "draft", "--state", init.statePath, "--json"]));
  const unacceptedWorkItems = runAib(["work-items", "generate", "--state", init.statePath, "--json"]);
  assert.notEqual(unacceptedWorkItems.status, 0);
  assert.equal(JSON.parse(unacceptedWorkItems.stdout).error.kind, "spec-not-accepted");

  parseJsonStdout(runAib(["spec", "accept", "--state", init.statePath, "--section", "all", "--json"]));

  const blockedWorkItems = runAib(["work-items", "generate", "--state", init.statePath, "--json"]);
  assert.notEqual(blockedWorkItems.status, 0);
  assert.equal(JSON.parse(blockedWorkItems.stdout).error.kind, "milestone-required");

  const dryRun = parseJsonStdout(runAib(["milestones", "generate", "--state", init.statePath, "--dry-run", "--json"]));
  assert.equal(dryRun.mutated, false);
  assert.equal(dryRun.milestones.length, 3);
  assert.match(dryRun.recommendation, /first three milestones/i);
  await assert.rejects(readFile(join(dir, "docs", "milestones", "001-planning-foundation.md"), "utf8"));

  const generated = parseJsonStdout(runAib(["milestones", "generate", "--state", init.statePath, "--json"]));
  assert.equal(generated.mutated, true);
  assert.equal(generated.state.phase, "work_item_generation");
  assert.equal(generated.state.planning.milestoneDrafts.length, 3);
  assert.equal(generated.state.artifacts.milestones.length, 3);
  assert.equal(generated.nextAction.nextCommand, "aib work-items generate --milestone <milestone-id> --json");

  const firstDoc = await readFile(join(dir, "docs", "milestones", "001-planning-foundation.md"), "utf8");
  assert.match(firstDoc, /## Delivery goal/);
  assert.match(firstDoc, /## Boundaries/);
  assert.match(firstDoc, /## Dependencies/);
  assert.match(firstDoc, /## Proof of completion/);
  assert.match(firstDoc, /## Likely work item themes/);
  assert.match(firstDoc, /Do not include production code/);
  assert.doesNotMatch(firstDoc, /\bfunction\s+\w+\(|interface\s+\w+\s*\{/);

  const workItemDryRun = parseJsonStdout(runAib([
    "work-items",
    "generate",
    "--state",
    init.statePath,
    "--milestone",
    generated.milestones[0].id,
    "--dry-run",
    "--json"
  ]));
  assert.equal(workItemDryRun.mutated, false);
  assert.equal(workItemDryRun.drafts.length, 3);
  assert.ok(workItemDryRun.plannedWrites.every((item) => item.path.includes("docs/issues/")));
  await assert.rejects(readFile(join(dir, "docs", "issues", `${workItemDryRun.drafts[0].draftId}.md`), "utf8"));

  const allowedWorkItems = parseJsonStdout(runAib([
    "work-items",
    "generate",
    "--state",
    init.statePath,
    "--milestone",
    generated.milestones[0].id,
    "--json"
  ]));
  assert.equal(allowedWorkItems.allowed, true);
  assert.equal(allowedWorkItems.mutated, true);
  assert.equal(allowedWorkItems.state.artifacts.workItems.length, 3);
  assert.equal(allowedWorkItems.state.planning.workItemDrafts.length, 3);
  assert.equal(allowedWorkItems.drafts[0].priority, "high");
  assert.equal(allowedWorkItems.drafts[0].status, "ready");
  assert.deepEqual(allowedWorkItems.drafts[0].components, ["aib"]);
  assert.ok(allowedWorkItems.drafts[1].blockedBy.includes(allowedWorkItems.drafts[0].draftId));

  const workItemDoc = await readFile(join(dir, "docs", "issues", `${allowedWorkItems.drafts[0].draftId}.md`), "utf8");
  assert.match(workItemDoc, /## Stable selectors/);
  assert.match(workItemDoc, /draft:/);
  assert.match(workItemDoc, /## Named E2E tests/);
  assert.match(workItemDoc, /e2e:/);
  assert.match(workItemDoc, /## Definition of done/);
  assert.match(workItemDoc, /No placeholder commands, fake tests/);

  const status = parseJsonStdout(runAib(["status", "--state", init.statePath, "--json"]));
  assert.equal(status.artifacts.milestones.length, 3);
  assert.equal(status.artifacts.workItems.length, 3);
});

test("milestones distinguish sequential foundations from independent features", async () => {
  const sequentialDir = await mkdtemp(join(tmpdir(), "aib-milestone-sequential-"));
  const sequentialInit = parseJsonStdout(runAib(["init", sequentialDir, "--idea", "Build a process playbook", "--json"]));
  const sequentialState = JSON.parse(await readFile(sequentialInit.statePath, "utf8"));
  sequentialState.project = {
    intent: "Build a process playbook",
    audience: "Operations team",
    coreJob: "Describe handoffs",
    shape: "process playbook",
    successNarrative: "The team can run the process",
    scope: "First operating checklist",
    nonGoals: "No software implementation",
    constraints: "Stakeholder signoff required"
  };
  await writeFile(sequentialInit.statePath, JSON.stringify(sequentialState), "utf8");
  parseJsonStdout(runAib(["spec", "draft", "--state", sequentialInit.statePath, "--json"]));
  parseJsonStdout(runAib(["spec", "accept", "--state", sequentialInit.statePath, "--section", "all", "--json"]));
  const sequential = parseJsonStdout(runAib(["milestones", "generate", "--state", sequentialInit.statePath, "--json"]));
  assert.deepEqual(sequential.milestones[0].dependencies, []);
  assert.deepEqual(sequential.milestones[1].dependencies, [sequential.milestones[0].id]);
  assert.deepEqual(sequential.milestones[2].dependencies, [sequential.milestones[1].id]);

  const featureDir = await mkdtemp(join(tmpdir(), "aib-milestone-features-"));
  const featureInit = parseJsonStdout(runAib(["init", featureDir, "--idea", "Build a dashboard", "--json"]));
  const featureState = JSON.parse(await readFile(featureInit.statePath, "utf8"));
  featureState.project = {
    intent: "Build a dashboard",
    audience: "Operators",
    coreJob: "Monitor work",
    shape: "web app",
    successNarrative: "Operators see what needs attention",
    scope: "Dashboard, alerts, and export",
    nonGoals: "No mobile app",
    constraints: "Accessible UI"
  };
  await mkdir(join(featureDir, "docs"), { recursive: true });
  await writeFile(featureInit.statePath, JSON.stringify({
    ...featureState,
    phase: "spec_acceptance",
    spec: {
      ...featureState.spec,
      acceptedSectionIds: [
        "purpose",
        "audience_stakeholders",
        "success_narrative",
        "scope",
        "non_goals",
        "project_shape",
        "functional_requirements",
        "non_functional_requirements",
        "constraints_assumptions",
        "feature_capability_map",
        "risks_unknowns",
        "spec_acceptance_checklist"
      ],
      validation: {
        ok: true,
        missingRequiredSections: [],
        placeholderSections: []
      }
    },
    artifacts: {
      ...featureState.artifacts,
      spec: {
        ...featureState.artifacts.spec,
        status: "accepted"
      }
    }
  }), "utf8");
  await writeFile(join(featureDir, "docs", "spec.md"), fullSpecWithFeatureMap([
    "Monitor operational work queues",
    "Alert maintainers about blocked items",
    "Export a weekly review summary"
  ]), "utf8");

  const feature = parseJsonStdout(runAib(["milestones", "generate", "--state", featureInit.statePath, "--json"]));
  assert.equal(feature.milestones.length, 4);
  assert.deepEqual(feature.milestones[1].dependencies, [feature.milestones[0].id]);
  assert.deepEqual(feature.milestones[2].dependencies, [feature.milestones[0].id]);
  assert.notEqual(feature.milestones[1].id, feature.milestones[2].id);
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
  state.spec.validation = {
    ok: "yes",
    missingRequiredSections: [],
    placeholderSections: []
  };
  await writeFile(init.statePath, JSON.stringify(state), "utf8");
  const invalidValidation = runAib(["status", "--state", init.statePath, "--json"]);
  assert.notEqual(invalidValidation.status, 0);
  assert.match(JSON.parse(invalidValidation.stdout).error.likelyCause, /spec\.validation\.ok/);

  state.spec.validation = undefined;
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
