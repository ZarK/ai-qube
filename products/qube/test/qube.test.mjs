import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertClaudeCodeHostCapabilityAvailable,
  formatClaudeCodeUnsupportedCapabilityMessage,
  getClaudeCodeHostCapability,
  inspectClaudeCodeWorkspace,
  listClaudeCodeHostCapabilities,
  listClaudeCodeInstallFiles,
  listClaudeCodeInstallNotes,
  assertCodexHostCapabilityAvailable,
  formatCodexUnsupportedCapabilityMessage,
  findQubeComponent,
  getCodexHostCapability,
  inspectCodexWorkspace,
  listCodexInstallFiles,
  listCodexInstallNotes,
  listCodexHostCapabilities,
  planQubeCli,
  resolveCommand,
  resolveComponentCommand,
} from "../dist/index.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const binPath = fileURLToPath(new URL("../dist/bin/qube.js", import.meta.url));

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [binPath, ...args], {
    cwd: options.cwd ?? packageRoot,
    encoding: "utf8",
    env: { ...process.env, ...options.env }
  });
}

describe("qube composer CLI", () => {
  it("reports package version without invoking component tools", () => {
    const text = runCli(["--version"]);
    assert.equal(text.status, 0);
    assert.equal(text.stdout.trim(), "0.1.1");

    const short = runCli(["-v"]);
    assert.equal(short.status, 0);
    assert.equal(short.stdout.trim(), "0.1.1");

    const json = runCli(["-v", "--json"]);
    assert.equal(json.status, 0);
    assert.deepEqual(JSON.parse(json.stdout), {
      ok: true,
      command: "version",
      package: {
        name: "@tjalve/qube",
        version: "0.1.1"
      },
      version: "0.1.1"
    });
  });

  it("renders the shared command help and schema surface", () => {
    const help = runCli(["--help"]);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /Usage:\n  qube <command> \[flags\]/);
    assert.match(help.stdout, /Commands:/);
    assert.match(help.stdout, /components\s+List QUBE component packages and commands\./);
    assert.match(help.stdout, /install\s+Build a guided, supply-chain-safe QUBE install plan\./);
    assert.match(help.stdout, /autoresearch\s+Run a safety-bounded local autoresearch arena lifecycle\./);
    assert.match(help.stdout, /oneshot\s+Create a bounded local artifact without the normal issue, PR, or review-gate workflow\./);
    assert.match(help.stdout, /make-it-so\s+Map an intent to the safest real QUBE workflow\./);
    assert.match(help.stdout, /idea\s+Start Bootstrap from a concise idea\./);
    assert.match(help.stdout, /spec draft\s+Draft the Bootstrap spec artifact\./);
    assert.match(help.stdout, /work-items render\s+Render work item drafts for a provider\./);
    assert.match(help.stdout, /queue\s+Show the Executor issue queue\./);
    assert.match(help.stdout, /start\s+Start or resume Executor issue work\./);
    assert.match(help.stdout, /pr gate\s+Request and inspect configured pull request reviews\./);
    assert.match(help.stdout, /app start\s+Start a local app process for audit work\./);
    assert.match(help.stdout, /doctor\s+Run Quality Control diagnostics\./);
    assert.match(help.stdout, /check\s+Run Quality Control checks for explicit paths\./);
    assert.match(help.stdout, /quality status\s+Show AIQ quality status\./);
    assert.match(help.stdout, /evidence\s+Emit structured AIQ quality evidence\./);
    assert.match(help.stdout, /status\s+Show Umpire continuation status\./);
    assert.match(help.stdout, /schema\s+Render deterministic command schema as JSON\./);

    const runHelp = runCli(["run", "--help"]);
    assert.equal(runHelp.status, 0);
    assert.match(runHelp.stdout, /Usage:\n  qube run \[component\] \[args\]/);
    assert.match(runHelp.stdout, /Run a QUBE component command with passthrough arguments\./);

    const installHelp = runCli(["install", "--help"]);
    assert.equal(installHelp.status, 0);
    assert.match(installHelp.stdout, /Usage:\n  qube install/);
    assert.match(installHelp.stdout, /Dry run: supported/);
    assert.match(installHelp.stdout, /Supply chain: sensitive \(dependency, package-manager\)/);

    const makeItSoHelp = runCli(["make-it-so", "--help"]);
    assert.equal(makeItSoHelp.status, 0);
    assert.match(makeItSoHelp.stdout, /Usage:\n  qube make-it-so/);
    assert.match(makeItSoHelp.stdout, /Map an intent to the safest real QUBE workflow\./);
    assert.match(makeItSoHelp.stdout, /Dry run: supported/);

    const autoresearchHelp = runCli(["autoresearch", "--help"]);
    assert.equal(autoresearchHelp.status, 0);
    assert.match(autoresearchHelp.stdout, /qube autoresearch init <target-directory> <goal>/);
    assert.match(autoresearchHelp.stdout, /Run a safety-bounded local autoresearch arena lifecycle\./);
    assert.match(autoresearchHelp.stdout, /existing local directory/);
    assert.match(autoresearchHelp.stdout, /\.qube\/autoresearch\/runs\/<run-id>\//);
    assert.match(autoresearchHelp.stdout, /promote is the only command that copies the selected best candidate/);

    const oneshotHelp = runCli(["oneshot", "--help"]);
    assert.equal(oneshotHelp.status, 0);
    assert.match(oneshotHelp.stdout, /normal issue, PR, or review-gate workflow/);
    assert.match(oneshotHelp.stdout, /\.qube\/oneshot\/<run-id>\//);
    assert.match(oneshotHelp.stdout, /no GitHub issue, branch, PR, review request, merge, or approval/);
    const plannedOneshotHelp = planQubeCli(["oneshot", "--help"], {
      cwd: mkdtempSync(path.join(tmpdir(), "qube-oneshot-help-cwd-")),
      env: {},
      packageRoot: mkdtempSync(path.join(tmpdir(), "qube-oneshot-help-root-"))
    });
    assert.equal(plannedOneshotHelp.exitCode, 0);
    assert.match(plannedOneshotHelp.stdout, /qube oneshot <idea>/);

    const schema = runCli(["schema", "--json"]);
    assert.equal(schema.status, 0);
    const parsed = JSON.parse(schema.stdout);
    assert.equal(parsed.package.name, "@tjalve/qube");
    const commandNames = parsed.commands.map(command => command.name);
    for (const command of ["install", "autoresearch", "oneshot", "make-it-so", "idea", "spec draft", "milestones", "work-items render", "queue", "start", "branch create", "review gate", "pr gate", "app start", "check", "quality status", "evidence", "status"]) {
      assert.ok(commandNames.includes(command), `expected ${command} in QUBE schema`);
    }
    const installCommand = parsed.commands.find(command => command.name === "install");
    assert.equal(installCommand?.dryRun.supported, true);
    assert.deepEqual(installCommand?.supplyChain.kinds, ["dependency", "package-manager"]);
    const makeItSoCommand = parsed.commands.find(command => command.name === "make-it-so");
    assert.equal(makeItSoCommand?.dryRun.supported, true);
    const autoresearchCommand = parsed.commands.find(command => command.name === "autoresearch");
    assert.equal(autoresearchCommand?.dryRun.supported, true);
    const oneshotCommand = parsed.commands.find(command => command.name === "oneshot");
    assert.equal(oneshotCommand?.dryRun.supported, true);
    assert.deepEqual(oneshotCommand?.mutation.categories, ["local-files"]);
    assert.deepEqual(
      parsed.sections.components.map(component => component.command),
      ["aib", "aie", "aiq", "aiu"]
    );
    assert.deepEqual(Object.fromEntries(parsed.sections.directCommands.map(command => [command.command, command.component])).status, "aiu");
    assert.deepEqual(Object.fromEntries(parsed.sections.directCommands.map(command => [command.command, command.component]))["pr gate"], "aie");
  });

  it("renders a non-interactive guided install plan as JSON", () => {
    const result = runCli(["install", "--yes", "--dry-run", "--json"]);
    assert.equal(result.status, 0);
    const parsed = JSON.parse(result.stdout);

    assert.equal(parsed.ok, true);
    assert.equal(parsed.command, "install");
    assert.deepEqual(parsed.installPlan.package, {
      name: "@tjalve/qube",
      version: "0.1.1"
    });
    assert.deepEqual(parsed.installPlan.selections, {
      docs: true,
      host: "generic",
      lifecycleScripts: "disabled",
      migration: "none",
      packageManager: "pnpm",
      scope: "local",
      workProvider: "github"
    });
    assert.equal(parsed.installPlan.dryRun, true);
    assert.deepEqual(parsed.installPlan.commands.map(step => step.command), [
      "pnpm add -D --save-exact --ignore-scripts @tjalve/qube@0.1.1",
      "pnpm exec qube components"
    ]);
    assert.match(parsed.installPlan.notes.join("\n"), /No package-manager command is executed/);
  });

  it("renders explicit global npm install commands without prompting", () => {
    const result = runCli([
      "install",
      "--scope",
      "global",
      "--package-manager",
      "npm",
      "--host",
      "codex",
      "--work-provider",
      "github",
      "--lifecycle-scripts",
      "disabled",
      "--docs",
      "--migration",
      "standalone-globals"
    ]);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /QUBE guided install plan/);
    assert.match(result.stdout, /Scope: global/);
    assert.match(result.stdout, /Host surface: codex/);
    assert.match(result.stdout, /npm install --global --ignore-scripts @tjalve\/qube@0\.1\.1/);
    assert.match(result.stdout, /AGENTS\.md policy notes/);
    assert.match(result.stdout, /Codex host support uses AGENTS\.md/);
    assert.match(result.stdout, /Codex does not use OpenCode-style project command files/);
    assert.match(result.stdout, /remove stale standalone global commands/);
    assert.match(result.stdout, /No commands were run\./);
  });

  it("renders Linear work provider install notes without prompting", () => {
    const result = runCli([
      "install",
      "--scope",
      "local",
      "--package-manager",
      "pnpm",
      "--host",
      "codex",
      "--work-provider",
      "linear",
      "--lifecycle-scripts",
      "disabled",
      "--docs",
      "--migration",
      "none",
      "--yes",
      "--dry-run",
      "--json"
    ]);

    assert.equal(result.status, 0);
    const parsed = JSON.parse(result.stdout);

    assert.equal(parsed.installPlan.selections.workProvider, "linear");
    assert.ok(parsed.installPlan.files.includes(".qube/aie/config.json provider notes"));
    assert.match(parsed.installPlan.notes.join("\n"), /@tjalve\/qube-adapter-linear/);
    assert.match(parsed.installPlan.notes.join("\n"), /LINEAR_API_KEY and LINEAR_TEAM_ID/);
    assert.match(parsed.installPlan.notes.join("\n"), /workflow-state mutations/);
  });

  it("renders GitLab work provider install notes without prompting", () => {
    const result = runCli([
      "install",
      "--scope",
      "local",
      "--package-manager",
      "pnpm",
      "--host",
      "codex",
      "--work-provider",
      "gitlab",
      "--lifecycle-scripts",
      "disabled",
      "--docs",
      "--migration",
      "none",
      "--yes",
      "--dry-run",
      "--json"
    ]);

    assert.equal(result.status, 0);
    const parsed = JSON.parse(result.stdout);

    assert.equal(parsed.installPlan.selections.workProvider, "gitlab");
    assert.ok(parsed.installPlan.files.includes(".qube/aie/config.json provider notes"));
    assert.match(parsed.installPlan.notes.join("\n"), /@tjalve\/qube-adapter-gitlab/);
    assert.match(parsed.installPlan.notes.join("\n"), /GITLAB_TOKEN, GITLAB_PROJECT_ID/);
    assert.match(parsed.installPlan.notes.join("\n"), /merge request pipeline status for CI gates stay unsupported/);
  });

  it("renders Claude Code install notes without prompting", () => {
    const result = runCli([
      "install",
      "--scope",
      "local",
      "--package-manager",
      "pnpm",
      "--host",
      "claude-code",
      "--work-provider",
      "github",
      "--lifecycle-scripts",
      "disabled",
      "--docs",
      "--migration",
      "none"
    ]);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /QUBE guided install plan/);
    assert.match(result.stdout, /Scope: local/);
    assert.match(result.stdout, /Host surface: claude-code/);
    assert.match(result.stdout, /pnpm add -D --save-exact --ignore-scripts @tjalve\/qube@0\.1\.1/);
    assert.match(result.stdout, /CLAUDE\.md policy notes/);
    assert.match(result.stdout, /\.claude\/settings\.json hook notes/);
    assert.match(result.stdout, /Claude Code host support uses CLAUDE\.md/);
    assert.match(result.stdout, /Use TodoWrite and TodoRead/);
    assert.match(result.stdout, /do not create Claude Code slash command or skill assets/);
    assert.match(result.stdout, /No commands were run\./);
  });

  it("reports Codex host capabilities without current-session assumptions", () => {
    const capabilities = listCodexHostCapabilities();
    assert.equal(capabilities.filter(capability => capability.support === "supported").length, 3);
    assert.equal(capabilities.filter(capability => capability.support === "host-provided").length, 5);
    assert.equal(capabilities.filter(capability => capability.support === "unsupported").length, 4);
    assert.equal(new Set(capabilities.map(capability => capability.id)).size, capabilities.length);

    assert.equal(assertCodexHostCapabilityAvailable("read-instructions").support, "supported");
    assert.equal(getCodexHostCapability("spawn-fresh-reviewer").support, "host-provided");
    assert.match(getCodexHostCapability("spawn-fresh-reviewer").summary, /fresh subagents/);
    assert.equal(getCodexHostCapability("install-project-command").support, "unsupported");
    assert.deepEqual(listCodexInstallFiles(), [
      "AGENTS.md policy notes: Codex project instructions use AGENTS.md with repository policy precedence.",
    ]);
    assert.equal(listCodexInstallNotes().length, 4);

    const unknownCapability = getCodexHostCapability("completely-unknown-id");
    assert.equal(unknownCapability.support, "unsupported");
    assert.match(formatCodexUnsupportedCapabilityMessage(unknownCapability), /completely-unknown-id/);
    assert.throws(() => assertCodexHostCapabilityAvailable("install-project-command"), /Unsupported Codex capability/);

    const repo = mkdtempSync(path.join(tmpdir(), "qube-codex-host-"));
    writeFileSync(path.join(repo, "AGENTS.md"), "Repository policy\n");
    const inspection = inspectCodexWorkspace(repo);

    assert.equal(inspection.cwd, repo);
    assert.equal(inspection.instructionTarget.present, true);
    assert.equal(path.basename(inspection.instructionTarget.path), "AGENTS.md");
    assert.ok(inspection.capabilities.some(capability => capability.id === "use-local-todos"));
    assert.ok(inspection.capabilities.some(capability => capability.id === "spawn-fresh-reviewer"));
    assert.ok(inspection.unsupportedCapabilities.some(capability => capability.id === "open-pull-request"));
    assert.throws(() => inspection.capabilities.push(inspection.capabilities[0]), TypeError);
    assert.throws(() => {
      inspection.capabilities[0].summary = "mutated";
    }, TypeError);

    const repoWithoutInstructions = mkdtempSync(path.join(tmpdir(), "qube-codex-host-missing-"));
    const missingInspection = inspectCodexWorkspace(repoWithoutInstructions);
    assert.equal(missingInspection.instructionTarget.present, false);
  });

  it("reports Claude Code host capabilities without mixing host assumptions", () => {
    const capabilities = listClaudeCodeHostCapabilities();
    assert.equal(capabilities.filter(capability => capability.support === "supported").length, 3);
    assert.equal(capabilities.filter(capability => capability.support === "host-provided").length, 6);
    assert.equal(capabilities.filter(capability => capability.support === "unsupported").length, 4);
    assert.equal(new Set(capabilities.map(capability => capability.id)).size, capabilities.length);

    assert.equal(assertClaudeCodeHostCapabilityAvailable("read-instructions").support, "supported");
    assert.equal(getClaudeCodeHostCapability("install-slash-command").support, "unsupported");
    assert.deepEqual(getClaudeCodeHostCapability("use-task-state").tools, ["TodoWrite", "TodoRead"]);
    assert.deepEqual(listClaudeCodeInstallFiles(), [
      "CLAUDE.md policy notes: Claude Code project instructions use CLAUDE.md with repository policy precedence.",
      ".claude/settings.json hook notes: Claude Code hooks are configured through host settings and can observe lifecycle events such as tool use and Stop.",
    ]);
    assert.equal(listClaudeCodeInstallNotes().length, 5);

    const unknownCapability = getClaudeCodeHostCapability("completely-unknown-id");
    assert.equal(unknownCapability.support, "unsupported");
    assert.match(formatClaudeCodeUnsupportedCapabilityMessage(unknownCapability), /completely-unknown-id/);
    assert.throws(() => assertClaudeCodeHostCapabilityAvailable("install-slash-command"), /Unsupported Claude Code capability/);

    const repo = mkdtempSync(path.join(tmpdir(), "qube-claude-code-host-"));
    writeFileSync(path.join(repo, "CLAUDE.md"), "Repository policy\n");
    mkdirSync(path.join(repo, ".claude", "commands"), { recursive: true });
    mkdirSync(path.join(repo, ".claude", "skills"), { recursive: true });
    writeFileSync(path.join(repo, ".claude", "settings.json"), "{}\n");
    const inspection = inspectClaudeCodeWorkspace(repo);

    assert.equal(inspection.cwd, repo);
    assert.equal(inspection.instructionTarget.present, true);
    assert.equal(path.basename(inspection.instructionTarget.path), "CLAUDE.md");
    assert.equal(inspection.settingsDirectory.present, true);
    assert.equal(inspection.projectSettings.present, true);
    assert.equal(inspection.localSettings.present, false);
    assert.equal(inspection.commandDirectory.present, true);
    assert.equal(inspection.skillsDirectory.present, true);
    assert.ok(inspection.capabilities.some(capability => capability.id === "use-task-state"));
    assert.ok(inspection.unsupportedCapabilities.some(capability => capability.id === "open-pull-request"));
    assert.throws(() => inspection.capabilities.push(inspection.capabilities[0]), TypeError);
    assert.throws(() => {
      inspection.capabilities[0].summary = "mutated";
    }, TypeError);

    const repoWithoutInstructions = mkdtempSync(path.join(tmpdir(), "qube-claude-code-host-missing-"));
    const missingInspection = inspectClaudeCodeWorkspace(repoWithoutInstructions);
    assert.equal(missingInspection.instructionTarget.present, false);
    assert.equal(missingInspection.settingsDirectory.present, false);
  });

  it("blocks JSON install prompts unless flags or safe defaults are supplied", () => {
    const result = runCli(["install", "--json"]);
    assert.equal(result.status, 2);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: false,
      command: "install",
      error: {
        kind: "prompt-blocked",
        operation: "prompt install scope",
        likelyCause: "Prompts are disabled in JSON output mode.",
        suggestedNextAction: "Provide an explicit flag value or rerun in an interactive terminal.",
        category: "usage",
        exitCode: 2
      }
    });
  });

  it("rejects invalid installer flag selections", () => {
    const result = runCli(["install", "--scope", "shared", "--yes", "--json"]);
    assert.equal(result.status, 2);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.command, "install");
    assert.equal(parsed.error.kind, "invalid-command-usage");
    assert.match(parsed.error.likelyCause, /Expected --scope=shared to be one of: local, global/);

    const planned = planQubeCli(["install", "--scope", "shared", "--yes"]);
    assert.equal(planned.exitCode, 2);
    assert.match(planned.stderr, /Invalid install option --scope=shared/);

    const missingValue = planQubeCli(["install", "--scope", "--yes"]);
    assert.equal(missingValue.exitCode, 2);
    assert.match(missingValue.stderr, /Missing value for install option --scope/);
    assert.match(missingValue.stderr, /local, global/);
  });

  it("lists standalone components without replacing them", () => {
    const result = runCli(["components", "--json"]);
    assert.equal(result.status, 0);

    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(
      parsed.components.map(component => [component.id, component.command, component.packageName]),
      [
        ["bootstrap", "aib", "@tjalve/aib"],
        ["executor", "aie", "@tjalve/aie"],
        ["quality", "aiq", "@tjalve/aiq"],
        ["umpire", "aiu", "@tjalve/aiu"]
      ]
    );
    const executor = parsed.components.find(component => component.id === "executor");
    assert.equal(executor.capabilities.localReview.freshContextReviewerSupport, "host-provided");
    assert.equal(executor.capabilities.localReview.promptOnlyFallback, true);
    assert.equal(executor.capabilities.localReview.manualEvidenceSatisfiesRequiredGate, false);
    assert.ok(executor.capabilities.localReview.provenanceRequired.includes("promptStackHash"));
    assert.ok(executor.capabilities.localReview.provenanceRequired.includes("providerPublishStatus"));
    assert.deepEqual(executor.capabilities.localReview.provenanceAlternatives[0].anyOf, ["taskId", "sessionId", "threadId"]);
    assert.match(executor.capabilities.localReview.evidencePathPattern, /<lane>\.json/);
    assert.match(executor.capabilities.localReview.hostProvenancePathPattern, /\.git\/qube\/aie\/host-provenance/);
  });

  it("runs a bounded local autoresearch lifecycle with explicit promotion", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-autoresearch-cwd-"));
    const target = path.join(cwd, "target");
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, "README.md"), "Existing notes target.\n", "utf8");

    const init = runCli(["autoresearch", "init", "target", "improve notes summary quality", "--json"], { cwd });
    assert.equal(init.status, 0);
    const initialized = JSON.parse(init.stdout).autoresearch;
    assert.equal(initialized.action, "init");
    assert.equal(initialized.phase, "initialized");
    assert.equal(initialized.safety.targetMutationBeforePromote, false);
    assert.ok(existsSync(path.join(initialized.stateDirectory, "arena.json")));
    assert.ok(existsSync(path.join(initialized.stateDirectory, "evaluator.json")));

    const baseline = runCli(["autoresearch", "baseline", "--json"], { cwd });
    assert.equal(baseline.status, 0);
    const baselined = JSON.parse(baseline.stdout).autoresearch;
    assert.equal(baselined.phase, "baselined");
    assert.equal(baselined.evaluation.evaluatorHash, initialized.evaluatorHash);
    assert.ok(baselined.evaluation.score < 1);

    const run = runCli(["autoresearch", "run", "--json"], { cwd });
    assert.equal(run.status, 0);
    const ran = JSON.parse(run.stdout).autoresearch;
    assert.equal(ran.phase, "ran");
    assert.equal(ran.candidate.owner.execution, "aie");
    assert.equal(ran.candidate.owner.evaluation, "aiq");
    assert.ok(ran.candidate.evaluation.score > baselined.evaluation.score);
    assert.ok(ran.candidate.artifactPath.includes(path.join(".qube", "autoresearch")));
    assert.ok(existsSync(ran.candidate.artifactPath));
    assert.equal(existsSync(path.join(target, "autoresearch-result.md")), false);

    const status = runCli(["autoresearch", "status", "--json"], { cwd });
    assert.equal(status.status, 0);
    const current = JSON.parse(status.stdout).autoresearch;
    assert.equal(current.phase, "ran");
    assert.equal(current.attempts, 1);
    assert.equal(current.currentBest.id, ran.candidate.id);

    const dashboard = runCli(["autoresearch", "dashboard", "--json"], { cwd });
    assert.equal(dashboard.status, 0);
    const dashboardState = JSON.parse(dashboard.stdout).autoresearch;
    assert.ok(existsSync(dashboardState.dashboardPath));
    assert.match(readFileSync(dashboardState.dashboardPath, "utf8"), /QUBE Autoresearch/);

    const promote = runCli(["autoresearch", "promote", "--json"], { cwd });
    assert.equal(promote.status, 0);
    const promoted = JSON.parse(promote.stdout).autoresearch;
    assert.equal(promoted.phase, "promoted");
    assert.ok(existsSync(path.join(target, "autoresearch-result.md")));
    assert.equal(promoted.promotion.outputPath, path.join(target, "autoresearch-result.md"));
  });

  it("refuses autoresearch when the fixed evaluator changes", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-autoresearch-tamper-cwd-"));
    mkdirSync(path.join(cwd, "target"), { recursive: true });
    const init = runCli(["autoresearch", "target", "improve notes summary quality", "--json"], { cwd });
    assert.equal(init.status, 0);
    const initialized = JSON.parse(init.stdout).autoresearch;
    const evaluatorPath = path.join(initialized.stateDirectory, "evaluator.json");
    const evaluator = JSON.parse(readFileSync(evaluatorPath, "utf8"));
    evaluator.terms = [...evaluator.terms, "tampered"];
    writeFileSync(evaluatorPath, `${JSON.stringify(evaluator, null, 2)}\n`, "utf8");

    const baseline = runCli(["autoresearch", "baseline", "--json"], { cwd });
    assert.equal(baseline.status, 2);
    const parsed = JSON.parse(baseline.stdout);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error.likelyCause, /evaluator changed/);
  });

  it("requires an existing directory autoresearch target", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-autoresearch-missing-cwd-"));
    const init = runCli(["autoresearch", "init", "missing", "improve notes summary quality", "--json"], { cwd });
    assert.equal(init.status, 2);
    const parsed = JSON.parse(init.stdout);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error.likelyCause, /existing directory target/);
  });

  it("keeps autoresearch usage errors structured regardless of flag order", () => {
    const unknown = runCli(["autoresearch", "--bogus", "--json"]);
    assert.equal(unknown.status, 2);
    const unknownParsed = JSON.parse(unknown.stdout);
    assert.equal(unknownParsed.ok, false);
    assert.match(unknownParsed.error.likelyCause, /--bogus/);

    const extra = runCli(["autoresearch", "status", "run-one", "extra", "--json"]);
    assert.equal(extra.status, 2);
    const extraParsed = JSON.parse(extra.stdout);
    assert.equal(extraParsed.ok, false);
    assert.match(extraParsed.error.likelyCause, /at most one positional run id/);

    const mixed = runCli(["autoresearch", "status", "run-one", "--run", "run-two", "--json"]);
    assert.equal(mixed.status, 2);
    const mixedParsed = JSON.parse(mixed.stdout);
    assert.equal(mixedParsed.ok, false);
    assert.match(mixedParsed.error.likelyCause, /either --run <id> or one positional run id/);
  });

  it("refuses to promote an autoresearch artifact outside the sandbox", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-autoresearch-promotion-cwd-"));
    const target = path.join(cwd, "target");
    mkdirSync(target, { recursive: true });
    const targetReadme = path.join(target, "README.md");
    writeFileSync(targetReadme, "Existing notes target.\n", "utf8");

    const init = runCli(["autoresearch", "init", "target", "improve notes summary quality", "--json"], { cwd });
    assert.equal(init.status, 0);
    const initialized = JSON.parse(init.stdout).autoresearch;
    assert.equal(runCli(["autoresearch", "baseline", "--json"], { cwd }).status, 0);
    assert.equal(runCli(["autoresearch", "run", "--json"], { cwd }).status, 0);

    const statePath = path.join(initialized.stateDirectory, "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    state.currentBest.artifactPath = targetReadme;
    state.attempts = state.attempts.map((attempt) => (
      attempt.id === state.currentBest.id ? { ...attempt, artifactPath: targetReadme } : attempt
    ));
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

    const promote = runCli(["autoresearch", "promote", "--json"], { cwd });
    assert.equal(promote.status, 2);
    const parsed = JSON.parse(promote.stdout);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error.likelyCause, /outside the sandbox/);
  });

  it("renders oneshot dry-run plans without local mutation", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-oneshot-dry-cwd-"));
    const planned = runCli(["oneshot", "Create a README draft", "--kind", "doc", "--dry-run", "--json"], { cwd });
    assert.equal(planned.status, 0);
    const parsed = JSON.parse(planned.stdout).oneshot;
    assert.equal(parsed.status, "dry-run-complete");
    assert.equal(parsed.plan.kind, "doc");
    assert.equal(parsed.plan.mutationPolicy.githubSideEffects, false);
    assert.ok(parsed.plan.mutationPolicy.allowedMutationPaths.includes(parsed.runDirectory));
    assert.equal(parsed.githubSideEffects.issueCreated, false);
    assert.equal(existsSync(path.join(cwd, ".qube", "oneshot")), false);
  });

  it("runs a local code oneshot with trusted state and no GitHub side effects", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-oneshot-code-cwd-"));
    const binDir = path.join(cwd, "bin");
    mkdirSync(binDir, { recursive: true });
    const ghLog = path.join(cwd, "gh-called.log");
    const ghShim = process.platform === "win32" ? path.join(binDir, "gh.cmd") : path.join(binDir, "gh");
    writeFileSync(
      ghShim,
      process.platform === "win32"
        ? `@echo off\r\necho gh called>>"${ghLog}"\r\nexit /b 9\r\n`
        : `#!/usr/bin/env sh\necho gh called >> "${ghLog}"\nexit 9\n`,
      "utf8"
    );
    if (process.platform !== "win32") chmodSync(ghShim, 0o755);

    const run = runCli(["oneshot", "Ship a local notes CLI", "--kind", "code", "--json"], {
      cwd,
      env: { PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` }
    });
    assert.equal(run.status, 0);
    const ran = JSON.parse(run.stdout).oneshot;
    assert.equal(ran.status, "success");
    assert.equal(ran.githubSideEffects.issueCreated, false);
    assert.equal(ran.githubSideEffects.branchCreated, false);
    assert.equal(ran.githubSideEffects.pullRequestCreated, false);
    assert.equal(ran.githubSideEffects.reviewRequested, false);
    assert.equal(existsSync(ghLog), false);
    assert.ok(existsSync(ran.artifactPath));
    assert.ok(existsSync(ran.summaryPath));
    assert.match(readFileSync(ran.summaryPath, "utf8"), /GitHub side effects: none/);

    const status = runCli(["oneshot", "status", ran.runId, "--json"], { cwd });
    assert.equal(status.status, 0);
    const current = JSON.parse(status.stdout).oneshot;
    assert.equal(current.status, "success");
    assert.equal(current.artifactPath, ran.artifactPath);

    const checks = runCli(["oneshot", "checks", ran.runId, "--json"], { cwd });
    assert.equal(checks.status, 0);
    const checkState = JSON.parse(checks.stdout).oneshot;
    assert.ok(checkState.checks.length > 0);
    assert.equal(checkState.checks.every((check) => check.status === "passed"), true);

    const summary = runCli(["oneshot", "summary", ran.runId], { cwd });
    assert.equal(summary.status, 0);
    assert.match(summary.stdout, /QUBE oneshot/);
  });

  it("supports explicit oneshot run subcommand and unique run ids", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-oneshot-run-cwd-"));
    const first = runCli(["oneshot", "run", "Create a README draft", "--kind", "doc", "--json"], { cwd });
    const second = runCli(["oneshot", "run", "Create a README draft", "--kind", "doc", "--json"], { cwd });
    assert.equal(first.status, 0);
    assert.equal(second.status, 0);
    const firstRun = JSON.parse(first.stdout).oneshot;
    const secondRun = JSON.parse(second.stdout).oneshot;
    assert.notEqual(firstRun.runId, secondRun.runId);
    assert.ok(existsSync(path.join(cwd, ".qube", "oneshot", firstRun.runId, "state.json")));
    assert.ok(existsSync(path.join(cwd, ".qube", "oneshot", secondRun.runId, "state.json")));
  });

  it("refuses unsafe oneshot targets and output overwrites", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-oneshot-safe-cwd-"));
    const existingTarget = path.join(cwd, "target");
    mkdirSync(existingTarget, { recursive: true });
    const dryRun = runCli(["oneshot", "Create a README draft", "--target", "target", "--kind", "doc", "--dry-run", "--json"], { cwd });
    assert.equal(dryRun.status, 0);
    assert.equal(JSON.parse(dryRun.stdout).oneshot.plan.mutationPolicy.targetMode, "existing-target-blocked");

    const blockedTarget = runCli(["oneshot", "Create a README draft", "--target", "target", "--kind", "doc", "--json"], { cwd });
    assert.equal(blockedTarget.status, 2);
    assert.match(JSON.parse(blockedTarget.stdout).error.likelyCause, /Existing target mutation/);

    const outputPath = path.join(cwd, "result.md");
    writeFileSync(outputPath, "keep me\n", "utf8");
    const blockedOutput = runCli(["oneshot", "Create a README draft", "--kind", "doc", "--output", "result.md", "--json"], { cwd });
    assert.equal(blockedOutput.status, 2);
    assert.match(JSON.parse(blockedOutput.stdout).error.likelyCause, /output already exists/);

    const blockedDirectoryOutput = runCli(["oneshot", "Create a README draft", "--kind", "doc", "--output", "target", "--force-output", "--json"], { cwd });
    assert.equal(blockedDirectoryOutput.status, 2);
    assert.match(JSON.parse(blockedDirectoryOutput.stdout).error.likelyCause, /must be a file path/);
  });

  it("renders make-it-so dry-run plans without dispatching", () => {
    const planned = runCli(["make-it-so", "Ship a local notes CLI", "--dry-run", "--json"]);
    assert.equal(planned.status, 0);
    const parsed = JSON.parse(planned.stdout);

    assert.equal(parsed.ok, true);
    assert.equal(parsed.command, "make-it-so");
    assert.equal(parsed.makeItSo.flow, "planned");
    assert.equal(parsed.makeItSo.status, "dispatch");
    assert.equal(parsed.makeItSo.mappedCommand.component, "aib");
    assert.deepEqual(parsed.makeItSo.mappedCommand.args, ["init", ".", "--idea", "Ship a local notes CLI", "--json"]);
    assert.match(parsed.makeItSo.boundaries.join("\n"), /does not create a GitHub issue/);

    const forwarded = runCli(["make-it-so", "Ship a local notes CLI", "--dry-run", "--json", "--", "--acceptance", "fast"]);
    assert.equal(forwarded.status, 0);
    assert.deepEqual(
      JSON.parse(forwarded.stdout).makeItSo.mappedCommand.args,
      ["init", ".", "--idea", "Ship a local notes CLI", "--acceptance", "fast", "--json"]
    );

    const forwardedJson = runCli(["make-it-so", "Ship a local notes CLI", "--dry-run", "--", "--json"]);
    assert.equal(forwardedJson.status, 0);
    assert.match(forwardedJson.stdout, /QUBE make-it-so plan/);
    assert.throws(() => JSON.parse(forwardedJson.stdout));

    const directLocal = runCli(["make-it-so", "Ship a local notes CLI", "--flow", "direct-local", "--dry-run", "--json"]);
    assert.equal(directLocal.status, 0);
    const directParsed = JSON.parse(directLocal.stdout);
    assert.equal(directParsed.makeItSo.status, "blocked");
    assert.equal(directParsed.makeItSo.mappedCommand, null);
    assert.match(directParsed.makeItSo.nextAction, /oneshot/);
  });

  it("plans dispatch through the selected standalone command", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-path-cwd-"));
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-empty-package-root-"));
    const pathPackageRoot = mkdtempSync(path.join(tmpdir(), "qube-path-package-"));
    const dir = path.join(pathPackageRoot, "bin");
    const command = process.platform === "win32" ? "aib.cmd" : "aib";
    const commandPath = path.join(dir, command);
    await mkdir(dir, { recursive: true });
    await writeFile(commandPath, process.platform === "win32" ? "@echo off\r\necho aib %*\r\n" : "#!/usr/bin/env sh\necho aib \"$@\"\n");
    await writeFile(path.join(pathPackageRoot, "package.json"), `${JSON.stringify({ name: "@tjalve/aib", version: "0.1.1" })}\n`);
    if (process.platform !== "win32") await chmod(commandPath, 0o755);

    const env = { PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}`, OS: process.env.OS };
    assert.equal(resolveCommand("aib", { cwd, env, packageRoot }), commandPath);

    const planned = planQubeCli(["run", "aib", "--", "init", "--dry-run"], { cwd, env, packageRoot });
    assert.equal(planned.exitCode, 0);
    assert.equal(planned.dispatch?.component.command, "aib");
    assert.equal(planned.dispatch?.resolution.source, "path");
    assert.deepEqual(planned.dispatch?.args, ["init", "--dry-run"]);

    const helpDispatch = planQubeCli(["run", "aib", "--help"], { cwd, env, packageRoot });
    assert.equal(helpDispatch.exitCode, 0);
    assert.equal(helpDispatch.dispatch?.component.command, "aib");
    assert.deepEqual(helpDispatch.dispatch?.args, ["--help"]);
  });

  it("maps common QUBE commands to component commands", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-direct-cwd-"));
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-direct-package-root-"));
    const binDir = path.join(packageRoot, "node_modules", ".bin");
    await mkdir(binDir, { recursive: true });

    for (const component of ["aib", "aie", "aiq", "aiu"]) {
      const command = process.platform === "win32" ? `${component}.cmd` : component;
      const commandPath = path.join(binDir, command);
      await writeFile(commandPath, process.platform === "win32" ? `@echo off\r\necho ${component} %*\r\n` : `#!/usr/bin/env sh\necho ${component} "$@"\n`);
      const packageDir = path.join(packageRoot, "node_modules", "@tjalve", component);
      await mkdir(packageDir, { recursive: true });
      await writeFile(path.join(packageDir, "package.json"), `${JSON.stringify({ name: `@tjalve/${component}`, version: findQubeComponent(component).packageVersion })}\n`);
      if (process.platform !== "win32") await chmod(commandPath, 0o755);
    }

    const env = { PATH: process.env.PATH ?? "", OS: process.env.OS };
    const cases = [
      {
        input: ["idea", "Ship a local notes CLI", "--json"],
        component: "aib",
        args: ["init", ".", "--idea", "Ship a local notes CLI", "--json"]
      },
      {
        input: ["make-it-so", "Ship a local notes CLI", "--json"],
        component: "aib",
        args: ["init", ".", "--idea", "Ship a local notes CLI", "--json"]
      },
      {
        input: ["make-it-so", "Ship a local notes CLI", "--target", "./notes"],
        component: "aib",
        args: ["init", "./notes", "--idea", "Ship a local notes CLI"]
      },
      {
        input: ["make-it-so", "Ship a local notes CLI", "--resume"],
        component: "aib",
        args: ["init", ".", "--idea", "Ship a local notes CLI", "--resume"]
      },
      {
        input: ["make-it-so", "--target", "./notes", "--resume"],
        component: "aib",
        args: ["init", "./notes", "--resume"]
      },
      {
        input: ["make-it-so", "--flow", "issue", "next", "--json"],
        component: "aie",
        args: ["start", "next", "--json"]
      },
      {
        input: ["makeitso", "--flow=issue", "#99", "--json"],
        component: "aie",
        args: ["start", "99", "--json"]
      },
      {
        input: ["idea", "--json"],
        component: "aib",
        args: ["init", ".", "--json"]
      },
      {
        input: ["spec", "draft", "--json"],
        component: "aib",
        args: ["spec", "draft", "--json"]
      },
      {
        input: ["work-items", "render", "--provider", "github", "--json"],
        component: "aib",
        args: ["work-items", "render", "--provider", "github", "--json"]
      },
      {
        input: ["queue", "--json"],
        component: "aie",
        args: ["queue", "--json"]
      },
      {
        input: ["start", "next", "--json"],
        component: "aie",
        args: ["start", "next", "--json"]
      },
      {
        input: ["branch", "create", "84", "--dry-run", "--json"],
        component: "aie",
        args: ["branch", "create", "84", "--dry-run", "--json"]
      },
      {
        input: ["pr", "--help"],
        component: "aie",
        args: ["pr", "--help"]
      },
      {
        input: ["pr", "view", "87", "--json"],
        component: "aie",
        args: ["pr", "view", "87", "--json"]
      },
      {
        input: ["pr", "body", "102", "--json"],
        component: "aie",
        args: ["pr", "body", "102", "--json"]
      },
      {
        input: ["pr", "gate", "87", "--json"],
        component: "aie",
        args: ["pr", "gate", "87", "--json"]
      },
      {
        input: ["app", "start", "--name", "ui-audit", "--", "pnpm", "dev"],
        component: "aie",
        args: ["run", "start", "--name", "ui-audit", "--", "pnpm", "dev"]
      },
      {
        input: ["doctor", "--json"],
        component: "aiq",
        args: ["doctor", "--format", "json"]
      },
      {
        input: ["check", "src", "--json"],
        component: "aiq",
        args: ["check", "src", "--format", "json"]
      },
      {
        input: ["quality", "status", "--json"],
        component: "aiq",
        args: ["status", "--format", "json"]
      },
      {
        input: ["evidence", "--json"],
        component: "aiq",
        args: ["evidence", "--format", "json"]
      },
      {
        input: ["status", "--json"],
        component: "aiu",
        args: ["status", "--json"]
      },
      {
        input: ["continue", "status", "--json"],
        component: "aiu",
        args: ["status", "--json"]
      }
    ];

    for (const testCase of cases) {
      const planned = planQubeCli(testCase.input, { cwd, env, packageRoot });
      assert.equal(planned.exitCode, 0);
      assert.equal(planned.dispatch?.component.command, testCase.component);
      assert.deepEqual(planned.dispatch?.args, testCase.args);
    }
  });

  it("explains ambiguous product-specific commands", () => {
    const planned = planQubeCli(["config", "--json"], {
      cwd: mkdtempSync(path.join(tmpdir(), "qube-ambiguous-cwd-")),
      env: { PATH: "" },
      packageRoot: mkdtempSync(path.join(tmpdir(), "qube-ambiguous-root-"))
    });

    assert.equal(planned.exitCode, 2);
    assert.match(planned.stderr, /Config exists in multiple components/);
    assert.match(planned.stderr, /qube aiq config/);
    assert.match(planned.stderr, /qube aiu config/);
  });

  it("refuses unsafe make-it-so states with actionable output", () => {
    const directLocal = planQubeCli(["make-it-so", "Ship a local notes CLI", "--flow", "direct-local", "--json"], {
      cwd: mkdtempSync(path.join(tmpdir(), "qube-make-it-so-cwd-")),
      env: { PATH: "" },
      packageRoot: mkdtempSync(path.join(tmpdir(), "qube-make-it-so-root-"))
    });

    assert.equal(directLocal.exitCode, 2);
    const directParsed = JSON.parse(directLocal.stdout);
    assert.equal(directParsed.ok, false);
    assert.equal(directParsed.error.kind, "unsupported-flow");
    assert.match(directParsed.makeItSo.nextAction, /oneshot/);

    const issueIdea = planQubeCli(["make-it-so", "--flow", "issue", "Ship a local notes CLI"], {
      cwd: mkdtempSync(path.join(tmpdir(), "qube-make-it-so-issue-cwd-")),
      env: { PATH: "" },
      packageRoot: mkdtempSync(path.join(tmpdir(), "qube-make-it-so-issue-root-"))
    });

    assert.equal(issueIdea.exitCode, 2);
    assert.match(issueIdea.stderr, /Issue flow requires an existing issue number/);

    const parseErrorJson = runCli(["make-it-so", "--flow", "--json"]);
    assert.equal(parseErrorJson.status, 2);
    const parseError = JSON.parse(parseErrorJson.stdout);
    assert.equal(parseError.ok, false);
    assert.equal(parseError.command, "make-it-so");
  });

  it("rejects JSON on helper topics that do not support JSON", () => {
    const planned = planQubeCli(["pr", "--json"], {
      cwd: mkdtempSync(path.join(tmpdir(), "qube-topic-json-cwd-")),
      env: { PATH: "" },
      packageRoot: mkdtempSync(path.join(tmpdir(), "qube-topic-json-root-"))
    });

    assert.equal(planned.exitCode, 2);
    assert.match(planned.stderr, /qube pr does not support --json/);
    assert.equal(planned.dispatch, undefined);
  });

  it("prefers install-scoped component binaries over ambient PATH", async () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-install-root-"));
    const binDir = path.join(packageRoot, "node_modules", ".bin");
    const packageDir = path.join(packageRoot, "node_modules", "@tjalve", "aib");
    const pathDir = mkdtempSync(path.join(tmpdir(), "qube-global-bin-"));
    const command = process.platform === "win32" ? "aib.cmd" : "aib";
    const installCommandPath = path.join(binDir, command);
    const pathCommandPath = path.join(pathDir, command);
    await mkdir(binDir, { recursive: true });
    await mkdir(packageDir, { recursive: true });
    await writeFile(installCommandPath, process.platform === "win32" ? "@echo off\r\necho install-scoped %*\r\n" : "#!/usr/bin/env sh\necho install-scoped \"$@\"\n");
    await writeFile(pathCommandPath, process.platform === "win32" ? "@echo off\r\necho path %*\r\n" : "#!/usr/bin/env sh\necho path \"$@\"\n");
    await writeFile(path.join(packageDir, "package.json"), `${JSON.stringify({ name: "@tjalve/aib", version: "0.1.1" })}\n`);
    if (process.platform !== "win32") {
      await chmod(installCommandPath, 0o755);
      await chmod(pathCommandPath, 0o755);
    }

    const component = findQubeComponent("aib");
    assert.ok(component);
    const env = { PATH: `${pathDir}${path.delimiter}${process.env.PATH ?? ""}`, OS: process.env.OS };
    const resolution = resolveComponentCommand(component, { cwd: path.resolve("."), env, packageRoot });

    assert.equal(resolution?.commandPath, installCommandPath);
    assert.equal(resolution?.source, "install");
    assert.equal(resolution?.packageVersion, "0.1.1");
    assert.equal(resolveCommand("aib", { cwd: path.resolve("."), env, packageRoot }), installCommandPath);
  });

  it("refuses a stale same-package binary from PATH", async () => {
    const stalePackageRoot = mkdtempSync(path.join(tmpdir(), "qube-stale-aib-"));
    const binDir = path.join(stalePackageRoot, "bin");
    const command = process.platform === "win32" ? "aib.cmd" : "aib";
    const commandPath = path.join(binDir, command);
    await mkdir(binDir, { recursive: true });
    await writeFile(commandPath, process.platform === "win32" ? "@echo off\r\necho stale %*\r\n" : "#!/usr/bin/env sh\necho stale \"$@\"\n");
    await writeFile(path.join(stalePackageRoot, "package.json"), `${JSON.stringify({ name: "@tjalve/aib", version: "0.0.1" })}\n`);
    if (process.platform !== "win32") await chmod(commandPath, 0o755);

    const env = { PATH: binDir, OS: process.env.OS };
    const planned = planQubeCli(["run", "aib", "status"], { cwd: mkdtempSync(path.join(tmpdir(), "qube-stale-cwd-")), env, packageRoot: mkdtempSync(path.join(tmpdir(), "qube-empty-install-")) });

    assert.equal(planned.exitCode, 4);
    assert.match(planned.stderr, /Refusing aib from PATH/);
    assert.match(planned.stderr, /expected @tjalve\/aib@0\.1\.1, found 0\.0\.1/);
    assert.equal(planned.dispatch, undefined);
  });

  it("refuses PATH component binary when package metadata cannot be verified", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "qube-unverified-path-"));
    const command = process.platform === "win32" ? "aib.cmd" : "aib";
    const commandPath = path.join(dir, command);
    await writeFile(commandPath, process.platform === "win32" ? "@echo off\r\necho unknown %*\r\n" : "#!/usr/bin/env sh\necho unknown \"$@\"\n");
    if (process.platform !== "win32") await chmod(commandPath, 0o755);

    const env = { PATH: dir, OS: process.env.OS };
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-unverified-cwd-"));
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-unverified-install-"));
    const planned = planQubeCli(["run", "aib", "status"], {
      cwd,
      env,
      packageRoot
    });

    assert.equal(planned.exitCode, 4);
    assert.match(planned.stderr, /Refusing aib from PATH/);
    assert.match(planned.stderr, /unable to verify @tjalve\/aib@0\.1\.1/);
    assert.equal(resolveCommand("aib", { cwd, env, packageRoot }), undefined);
  });

  it("dispatches to resolved component command shims", async () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-dispatch-root-"));
    const dir = path.join(packageRoot, "node_modules", ".bin");
    const packageDir = path.join(packageRoot, "node_modules", "@tjalve", "aib");
    const command = process.platform === "win32" ? "aib.cmd" : "aib";
    const commandPath = path.join(dir, command);
    await mkdir(dir, { recursive: true });
    await mkdir(packageDir, { recursive: true });
    await writeFile(commandPath, process.platform === "win32" ? "@echo off\r\necho dispatched %*\r\n" : "#!/usr/bin/env sh\necho dispatched \"$@\"\n");
    await writeFile(path.join(packageDir, "package.json"), `${JSON.stringify({ name: "@tjalve/aib", version: "0.1.0" })}\n`);
    if (process.platform !== "win32") await chmod(commandPath, 0o755);

    const result = runCli(["aib", "status", "--json"], {
      env: {
        PATH: process.env.PATH ?? "",
        QUBE_TEST_PACKAGE_ROOT: packageRoot,
        OS: process.env.OS
      }
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /dispatched status --json/);

    const help = runCli(["aib", "--help"], {
      env: {
        PATH: process.env.PATH ?? "",
        QUBE_TEST_PACKAGE_ROOT: packageRoot,
        OS: process.env.OS
      }
    });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /dispatched --help/);

    const ideaWithoutText = runCli(["idea", "--json"], {
      env: {
        PATH: process.env.PATH ?? "",
        QUBE_TEST_PACKAGE_ROOT: packageRoot,
        OS: process.env.OS
      }
    });
    assert.equal(ideaWithoutText.status, 0);
    assert.match(ideaWithoutText.stdout, /dispatched init \. --json/);
  });

  it("returns an actionable error when a component command is unavailable", () => {
    const component = findQubeComponent("@tjalve/aiq");
    assert.equal(component?.command, "aiq");

    const result = planQubeCli(["run", "aiq"], {
      cwd: mkdtempSync(path.join(tmpdir(), "qube-missing-cwd-")),
      env: { PATH: "" },
      packageRoot: mkdtempSync(path.join(tmpdir(), "qube-missing-root-"))
    });
    assert.equal(result.exitCode, 4);
    assert.match(result.stderr, /Cannot find aiq/);
    assert.match(result.stderr, /Install QUBE with its component dependencies/);
  });
});
