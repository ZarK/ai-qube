import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { runConnectionProbe as runCoreConnectionProbe } from "@tjalve/qube-core";

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
  assertGrokBuildHostCapabilityAvailable,
  formatGrokBuildUnsupportedCapabilityMessage,
  findQubeComponent,
  probeInstallState,
  getCodexHostCapability,
  getGrokBuildHostCapability,
  inspectCodexWorkspace,
  inspectGrokBuildWorkspace,
  listCodexInstallFiles,
  listCodexInstallNotes,
  listCodexHostCapabilities,
  listGrokBuildHostCapabilities,
  listGrokBuildInstallFiles,
  listGrokBuildInstallNotes,
  planQubeCli,
  probeHostToolkits,
  composeHostToolkitManifests,
  createInitRecord,
  writeInitRecord,
  MCP_BYPASS_CAVEAT,
  PROVIDER_MCP_CONFIG_PATHS,
  QUBE_INIT_RECORD_PATH,
  qubeComponents,
  renderCommandSurfacesDoc,
  runConnectionDoctor,
  resolveCommand,
  resolveComponentCommand,
} from "../dist/index.js";
import {
  aibExpectedPathPattern,
  aibUnableVerifyPattern,
  aibVersion,
  dependencyVersion,
  qubePackageName,
  qubePackageVersion,
  qubeNpmGlobalInstallPattern,
  qubePnpmAddCommand,
  qubePnpmAddPattern,
} from "./workspace-versions.mjs";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const binPath = fileURLToPath(new URL("../dist/bin/qube.js", import.meta.url));

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [binPath, ...args], {
    cwd: options.cwd ?? packageRoot,
    encoding: "utf8",
    env: { ...process.env, ...options.env }
  });
}

function createQualityDoctorShim(root) {
  const binDir = path.join(root, "node_modules", ".bin");
  const packageDir = path.join(root, "node_modules", "@tjalve", "aiq");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(packageDir, { recursive: true });
  const commandPath = path.join(binDir, process.platform === "win32" ? "aiq.cmd" : "aiq");
  writeFileSync(commandPath, process.platform === "win32"
    ? "@echo off\r\necho {\"ok\":true}\r\n"
    : "#!/bin/sh\nprintf '{\"ok\":true}\\n'\n", "utf8");
  if (process.platform !== "win32") chmodSync(commandPath, 0o755);
  writeFileSync(path.join(packageDir, "package.json"), `${JSON.stringify({ name: "@tjalve/aiq", version: "0.2.3" })}\n`, "utf8");
}

function createWorkflowDoctorShim(root) {
  const binDir = path.join(root, "node_modules", ".bin");
  const packageDir = path.join(root, "node_modules", "@tjalve", "aie");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(packageDir, { recursive: true });
  const doctorPayload = JSON.stringify({
    ok: true,
    command: "doctor",
    workflowReadiness: {
      stages: [
        { stage: "lifecycle", status: "ready", detail: "Config, labels, and issue queue are healthy.", nextAction: null },
        { stage: "quality-gates", status: "unconfigured", detail: "No quality gates are configured.", nextAction: "Configure policy.gates entries." },
        { stage: "shipping", status: "manual", detail: "Manual shipping mode.", nextAction: null },
      ],
      review: { state: "fallback-only", fallbackPromptAvailable: true, fallbackEnforcesReview: false },
      shipping: { mode: "manual" },
      selectedHosts: ["codex"],
    },
  });
  writeFileSync(path.join(packageDir, "doctor.json"), `${doctorPayload}\n`, "utf8");
  const commandPath = path.join(binDir, process.platform === "win32" ? "aie.cmd" : "aie");
  // Shell builtins only: the doctor tests run with an empty PATH, so external commands like cat are unavailable.
  writeFileSync(commandPath, process.platform === "win32"
    ? "@echo off\r\ntype \"%~dp0..\\@tjalve\\aie\\doctor.json\"\r\n"
    : `#!/bin/sh\nprintf '%s\\n' '${doctorPayload}'\n`, "utf8");
  if (process.platform !== "win32") chmodSync(commandPath, 0o755);
  writeFileSync(path.join(packageDir, "package.json"), `${JSON.stringify({ name: "@tjalve/aie", version: "0.2.2" })}\n`, "utf8");
}

function createJsonEnvelopeShim(root, componentId, payload) {
  const binDir = path.join(root, "node_modules", ".bin");
  const packageDir = path.join(root, "node_modules", "@tjalve", componentId);
  mkdirSync(binDir, { recursive: true });
  mkdirSync(packageDir, { recursive: true });
  const responsePayload = `${JSON.stringify(payload)}\n`;
  writeFileSync(path.join(packageDir, "response.json"), responsePayload, "utf8");
  const commandPath = path.join(binDir, process.platform === "win32" ? `${componentId}.cmd` : componentId);
  writeFileSync(commandPath, process.platform === "win32"
    ? `@echo off\r\ntype "%~dp0..\\@tjalve\\${componentId}\\response.json"\r\n`
    : `#!/bin/sh\nprintf '%s\\n' '${responsePayload.trim()}'\n`, "utf8");
  if (process.platform !== "win32") chmodSync(commandPath, 0o755);
  writeFileSync(path.join(packageDir, "package.json"), `${JSON.stringify({ name: `@tjalve/${componentId}`, version: findQubeComponent(componentId).packageVersion })}\n`, "utf8");
}

function createAiuMergingShim(root) {
  const binDir = path.join(root, "node_modules", ".bin");
  const packageDir = path.join(root, "node_modules", "@tjalve", "aiu");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(packageDir, { recursive: true });
  const scriptPath = path.join(packageDir, "merge.mjs");
  writeFileSync(scriptPath, [
    "import { existsSync, mkdirSync, readFileSync, writeFileSync } from \"node:fs\";",
    "import path from \"node:path\";",
    "const toolIndex = process.argv.indexOf(\"--tool\");",
    "const tool = toolIndex >= 0 ? process.argv[toolIndex + 1] : \"unknown\";",
    "const configPath = path.join(process.cwd(), \".qube\", \"aiu\", \"config.json\");",
    "mkdirSync(path.dirname(configPath), { recursive: true });",
    "let enabled = [];",
    "if (existsSync(configPath)) {",
    "  enabled = JSON.parse(readFileSync(configPath, \"utf8\")).hosts.enabled;",
    "}",
    "const next = { hosts: { enabled: [...new Set([...enabled, tool])] } };",
    "await new Promise((resolve) => setTimeout(resolve, 150));",
    "writeFileSync(configPath, JSON.stringify(next));",
    "process.stdout.write(JSON.stringify({ ok: true, command: \"init\", init: { tools: [tool] } }) + \"\\n\");",
    "",
  ].join("\n"), "utf8");
  const commandPath = path.join(binDir, process.platform === "win32" ? "aiu.cmd" : "aiu");
  writeFileSync(commandPath, process.platform === "win32"
    ? `@echo off\r\n"${process.execPath}" "%~dp0..\\@tjalve\\aiu\\merge.mjs" %*\r\n`
    : `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)} "$@"\n`, "utf8");
  if (process.platform !== "win32") chmodSync(commandPath, 0o755);
  writeFileSync(path.join(packageDir, "package.json"), `${JSON.stringify({ name: "@tjalve/aiu", version: findQubeComponent("aiu").packageVersion })}\n`, "utf8");
}

function createAutoresearchPackageTarget(cwd, initialScore = 10, options = {}) {
  const target = path.join(cwd, "target");
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, "package.json"), `${JSON.stringify({
    private: true,
    packageManager: "npm@10.0.0",
    scripts: {
      test: "node metric.mjs"
    }
  }, null, 2)}\n`, "utf8");
  const sideEffectPath = options.sideEffectPath;
  writeFileSync(path.join(target, "metric.mjs"), [
    "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
    sideEffectPath ? `const sideEffectPath = ${JSON.stringify(sideEffectPath)};` : "const sideEffectPath = undefined;",
    "if (sideEffectPath) {",
    "  const count = existsSync(sideEffectPath) ? JSON.parse(readFileSync(sideEffectPath, 'utf8')).count : 0;",
    "  writeFileSync(sideEffectPath, JSON.stringify({ count: count + 1 }) + '\\n');",
    "}",
    "const score = JSON.parse(readFileSync(new URL('./score.json', import.meta.url), 'utf8')).score;",
    "console.log(JSON.stringify({ score }));"
  ].join("\n"), "utf8");
  writeFileSync(path.join(target, "score.json"), `${JSON.stringify({ score: initialScore })}\n`, "utf8");
  return target;
}

function createAutoresearchDocumentTarget(cwd) {
  const target = path.join(cwd, "docs");
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, "notes.md"), "# Notes\n\nDraft summary needs clearer sourcing.\n", "utf8");
  return target;
}

function writeAutoresearchSandboxScore(stateDirectory, score) {
  const scorePath = path.join(stateDirectory, "sandbox", "workspace", "score.json");
  writeFileSync(scorePath, `${JSON.stringify({ score })}\n`, "utf8");
  return scorePath;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashAutoresearchEvaluatorForTest(evaluator) {
  const { hash: _hash, ...hashable } = evaluator;
  return createHash("sha256").update(stableJson(hashable)).digest("hex");
}

function writeManyAutoresearchFiles(directory, count) {
  mkdirSync(directory, { recursive: true });
  for (let index = 0; index < count; index += 1) {
    writeFileSync(path.join(directory, `extra-${String(index).padStart(4, "0")}.txt`), "x\n", "utf8");
  }
}

function createAcceptedAutoresearchRun(cwd, initialScore = 10, improvedScore = 5) {
  const target = createAutoresearchPackageTarget(cwd, initialScore);
  const init = runCli(["autoresearch", "init", "target", "improve runtime performance", "--json"], { cwd });
  assert.equal(init.status, 0);
  const initialized = JSON.parse(init.stdout).autoresearch;
  assert.equal(runCli(["autoresearch", "baseline", "--json"], { cwd }).status, 0);
  writeAutoresearchSandboxScore(initialized.stateDirectory, improvedScore);
  const run = runCli(["autoresearch", "run", "--json"], { cwd });
  assert.equal(run.status, 0);
  assert.equal(JSON.parse(run.stdout).autoresearch.candidate.accepted, true);
  return { target, initialized };
}

describe("qube composer CLI", () => {
  it("keeps component package versions aligned with package.json dependencies", () => {
    for (const component of qubeComponents) {
      assert.equal(component.packageVersion, dependencyVersion(component.packageName));
    }
  });

  it("reports package version without invoking component tools", () => {
    const text = runCli(["--version"]);
    assert.equal(text.status, 0);
    assert.equal(text.stdout.trim(), qubePackageVersion);

    const short = runCli(["-v"]);
    assert.equal(short.status, 0);
    assert.equal(short.stdout.trim(), qubePackageVersion);

    const json = runCli(["-v", "--json"]);
    assert.equal(json.status, 0);
    assert.deepEqual(JSON.parse(json.stdout), {
      ok: true,
      command: "version",
      package: {
        name: qubePackageName,
        version: qubePackageVersion
      },
      version: qubePackageVersion
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
    assert.match(help.stdout, /review setup github-app\s+Configure a user-owned GitHub App reviewer publisher/);
    assert.match(help.stdout, /review setup token\s+Configure a separate-user fine-grained token reviewer publisher/);
    assert.match(help.stdout, /review doctor\s+Validate reviewer publisher readiness/);
    assert.match(help.stdout, /pr gate\s+Request and inspect configured pull request reviews\./);
    assert.match(help.stdout, /app start\s+Start a local app process for audit work\./);
    assert.match(help.stdout, /init\s+Initialize QUBE workspace setup by composing each installed component's init through its init capability contract\./);
    assert.match(help.stdout, /doctor\s+Aggregate Quality Control, Executor workflow, Umpire continuation, host toolkit completeness, and configured provider connection diagnostics\./);
    assert.match(help.stdout, /check\s+Run Quality Control checks for explicit paths\./);
    assert.match(help.stdout, /quality status\s+Show AIQ quality status\./);

    assert.match(help.stdout, /evidence\s+Emit structured AIQ quality evidence\./);
    assert.match(help.stdout, /continue\s+Show Umpire continuation status and resume guidance\./);
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
    assert.match(installHelp.stdout, /--host <value>/);
    assert.match(installHelp.stdout, /Default: generic/);
    assert.match(installHelp.stdout, /generic, codex, claude-code, grok-build, opencode/);
    assert.match(installHelp.stdout, /--work-provider <value>/);
    assert.match(installHelp.stdout, /Default: github/);
    assert.match(installHelp.stdout, /github, gitlab, linear, jira, local/);
    assert.match(installHelp.stdout, /--ci-provider <value>/);
    assert.match(installHelp.stdout, /github, jenkins, local/);

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
    assert.match(autoresearchHelp.stdout, /translate the request into <target-directory> plus <goal>/);
    assert.match(autoresearchHelp.stdout, /AIB arena synthesis/);
    assert.match(autoresearchHelp.stdout, /command metric, threshold, finding reduction, fixed rubric, or human-gated promotion policy/);
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
    for (const command of ["install", "autoresearch", "oneshot", "make-it-so", "idea", "spec draft", "milestones", "work-items render", "queue", "start", "branch create", "review setup", "review setup github-app", "review setup token", "review doctor", "review gate", "pr gate", "app start", "check", "quality status", "evidence", "status"]) {
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

  it("routes short reviewer publisher help and JSON doctor output to Executor", () => {
    const shortHelp = runCli(["review", "--help"]);
    const productHelp = runCli(["aie", "review", "--help"]);
    const doctor = runCli(["review", "doctor", "--json", "--no-probe"]);

    assert.equal(shortHelp.status, 0, shortHelp.stderr);
    assert.equal(productHelp.status, 0, productHelp.stderr);
    assert.match(shortHelp.stdout, /Usage:\s*\r?\n\s*qube review/);
    assert.match(shortHelp.stdout, /Examples:[\s\S]*qube review setup github-app/);
    assert.match(shortHelp.stdout, /Equivalent paths: `qube aie review` or `aie review`\./);
    assert.doesNotMatch(shortHelp.stdout, /Usage:\s*\r?\n\s*aie review/);
    assert.match(productHelp.stdout, /Usage:\s*\r?\n\s*aie review/);
    for (const output of [shortHelp.stdout, productHelp.stdout]) {
      assert.match(output, /review setup github-app/);
      assert.match(output, /review setup token/);
      assert.match(output, /review doctor/);
      assert.match(output, /review gate/);
    }
    assert.equal(doctor.status, 0, doctor.stderr);
    const parsed = JSON.parse(doctor.stdout);
    assert.equal(parsed.command, "review doctor");
    assert.ok(["ready", "degraded", "unavailable", "unconfigured"].includes(parsed.readiness));
    assert.equal(typeof parsed.nextAction, "string");
    assert.equal(typeof parsed.probe, "object");
  });

  it("keeps every short review help surface QUBE-primary", () => {
    const commands = [
      ["review"],
      ["review", "setup"],
      ["review", "setup", "github-app"],
      ["review", "setup", "token"],
      ["review", "doctor"],
      ["review", "gate"],
    ];

    for (const command of commands) {
      const result = runCli([...command, "--help"]);
      const commandPath = command.join(" ");
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, new RegExp(`Usage:\\s*\\r?\\n\\s*qube ${commandPath}`));
      assert.match(result.stdout, new RegExp(`Examples:[\\s\\S]*qube ${commandPath}`));
      assert.doesNotMatch(result.stdout, new RegExp(`Usage:\\s*\\r?\\n\\s*aie ${commandPath}`));
    }
  });

  it("renders concrete short-surface reviewer publisher guidance without writing incomplete config", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-review-setup-"));
    const githubApp = runCli(["review", "setup", "github-app"], { cwd });
    const token = runCli(["review", "setup", "token"], { cwd });

    assert.equal(githubApp.status, 0, githubApp.stderr);
    assert.match(githubApp.stdout, /Pull requests: Read and write/);
    assert.match(githubApp.stdout, /Contents: Read-only/);
    assert.match(githubApp.stdout, /private key.*outside repository files/i);
    assert.match(githubApp.stdout, /installation id/i);
    assert.match(githubApp.stdout, /Review compute remains host-run/);
    assert.equal(token.status, 0, token.stderr);
    assert.match(token.stdout, /separate GitHub user or bot account/i);
    assert.match(token.stdout, /formal review event/i);
    assert.match(token.stdout, /--token-env/);
    assert.equal(existsSync(path.join(cwd, ".qube", "aie", "config.json")), false);
  });

  it("renders a non-interactive guided install plan as JSON", () => {
    const result = runCli(["install", "--yes", "--dry-run", "--json"]);
    assert.equal(result.status, 0);
    const parsed = JSON.parse(result.stdout);

    assert.equal(parsed.ok, true);
    assert.equal(parsed.command, "install");
    assert.deepEqual(parsed.installPlan.package, {
      name: qubePackageName,
      version: qubePackageVersion
    });
    assert.deepEqual(parsed.installPlan.selections, {
      docs: true,
      host: "generic",
      hosts: ["generic"],
      ciProvider: "github",
      ciProviders: ["github"],
      lifecycleScripts: "disabled",
      migration: "none",
      packageManager: "pnpm",
      scope: "local",
      workProvider: "github",
      workProviders: ["github"],
      withComponents: []
    });
    assert.equal(parsed.installPlan.dryRun, true);
    assert.deepEqual(parsed.installPlan.connections.map(connection => connection.adapterId), ["github"]);
    assert.equal(parsed.installPlan.connections[0].probe.readOnly, true);
    assert.ok(parsed.installPlan.notes.some(note => note.includes("qube autoresearch --help")));
    assert.deepEqual(parsed.installPlan.commands.map(step => step.command), [
      qubePnpmAddCommand,
      "qube init . --host generic --work-provider github --ci-provider github",
      "qube aie labels setup",
      "qube doctor"
    ]);
    assert.deepEqual(parsed.installPlan.commands.map(step => step.stage), [
      "package-install",
      "workspace-init",
      "provider-setup",
      "verify"
    ]);
    assert.ok(parsed.installPlan.notes.some(note => note.includes("Run `qube components` any time")));
    assert.deepEqual(
      parsed.installPlan.options.hosts.map(option => [option.value, option.support, option.default, option.source]),
      [
        ["generic", "installed", true, "local-option"],
        ["codex", "installed", false, "adapter-contract"],
        ["claude-code", "installed", false, "adapter-contract"],
        ["grok-build", "installed", false, "host-contract"],
        ["opencode", "optional", false, "adapter-contract"]
      ]
    );
    assert.deepEqual(
      parsed.installPlan.options.workProviders.map(option => [option.value, option.support, option.default, option.source]),
      [
        ["github", "installed", true, "adapter-contract"],
        ["gitlab", "optional", false, "adapter-contract"],
        ["linear", "optional", false, "adapter-contract"],
        ["jira", "optional", false, "adapter-contract"],
        ["local", "unsupported", false, "local-option"]
      ]
    );
    assert.deepEqual(
      parsed.installPlan.options.ciProviders.map(option => [option.value, option.support, option.default, option.source]),
      [
        ["github", "installed", true, "adapter-contract"],
        ["jenkins", "optional", false, "adapter-contract"],
        ["local", "unsupported", false, "local-option"]
      ]
    );
    assert.ok(parsed.installPlan.options.workProviders.find(option => option.value === "github").capabilities.some(capability => capability.id === "read-merge-blockers" && capability.support === "supported"));
    assert.ok(parsed.installPlan.options.workProviders.find(option => option.value === "github").capabilities.some(capability => capability.id === "read-review-threads" && capability.support === "supported"));
    assert.ok(parsed.installPlan.options.workProviders.find(option => option.value === "github").capabilities.some(capability => capability.id === "resolve-review-threads" && capability.support === "supported"));
    assert.ok(parsed.installPlan.options.workProviders.find(option => option.value === "github").capabilities.some(capability => capability.id === "run-aiq-github-action" && capability.support === "standalone"));
    assert.ok(parsed.installPlan.options.workProviders.find(option => option.value === "gitlab").capabilities.some(capability => capability.id === "resolve-review-threads" && capability.support === "supported"));
    assert.ok(parsed.installPlan.options.workProviders.find(option => option.value === "gitlab").capabilities.some(capability => capability.id === "sync-issue-status" && capability.support === "unsupported"));
    const notes = parsed.installPlan.notes.join("\n");
    assert.match(notes, /No package-manager command is executed/);
    assert.match(notes, /Work provider: github \(installed, adapter-contract\)/);
    assert.match(notes, /Supported capabilities: .*read-merge-blockers/);
    assert.doesNotMatch(notes, /Supported capabilities: [^.]*run-aiq-github-action/);
    assert.match(notes, /Standalone capabilities: run-aiq-github-action/);
    assert.deepEqual(parsed.installPlan.steps.map(step => step.status), ["missing", "missing", "missing", "missing"]);
  });

  function writeManagedSection(filePath, body, checksum = null) {
    const normalized = `${String(body).replace(/\r\n/g, "\n").trimEnd()}\n`;
    const digest = checksum ?? createHash("sha256").update(normalized).digest("hex");
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, [
      "<!-- BEGIN EXECUTOR MANAGED SECTION -->",
      "<!-- executor-managed-version: 1 -->",
      `<!-- executor-managed-checksum: ${digest} -->`,
      String(body).trimEnd(),
      "<!-- END EXECUTOR MANAGED SECTION -->",
      ""
    ].join("\n"));
  }

  function writeInstalledPackage(root, name, version) {
    const packageDir = path.join(root, "node_modules", ...name.split("/"));
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(path.join(packageDir, "package.json"), `${JSON.stringify({ name, version }, null, 2)}\n`);
  }

  function writeConfiguredRepo(root, options = {}) {
    mkdirSync(path.join(root, ".qube", "aie"), { recursive: true });
    writeFileSync(path.join(root, "package.json"), `${JSON.stringify({
      name: "demo-app",
      version: "1.0.0",
      devDependencies: {
        [qubePackageName]: qubePackageVersion,
        "@tjalve/qube-adapter-github": "0.1.3",
        "@tjalve/qube-adapter-codex": "0.1.3"
      }
    }, null, 2)}\n`);
    if (options.installPackages !== false) {
      writeInstalledPackage(root, qubePackageName, qubePackageVersion);
      writeInstalledPackage(root, "@tjalve/qube-adapter-github", "0.1.3");
      writeInstalledPackage(root, "@tjalve/qube-adapter-codex", "0.1.3");
    }
    writeFileSync(path.join(root, ".qube", "aie", "config.json"), `${JSON.stringify({ version: 1, providers: { work: { kind: "github" } } }, null, 2)}\n`);
    if (options.staleManaged) {
      writeManagedSection(path.join(root, "AGENTS.md"), "Team rules.", "deadbeef");
    } else if (options.crlfManaged) {
      const body = "Team rules.";
      const digest = createHash("sha256").update(`${body.replace(/\r\n?/g, "\n").trimEnd()}\n`).digest("hex");
      writeFileSync(path.join(root, "AGENTS.md"), [
        "<!-- BEGIN EXECUTOR MANAGED SECTION -->",
        "<!-- executor-managed-version: 1 -->",
        `<!-- executor-managed-checksum: ${digest} -->`,
        body,
        "<!-- END EXECUTOR MANAGED SECTION -->",
        ""
      ].join("\r\n"));
    } else if (options.managed !== false) {
      writeManagedSection(path.join(root, "AGENTS.md"), "Team rules.");
    }
  }

  it("reports every step satisfied and a no-op command list for a configured repo", () => {
    const root = mkdtempSync(path.join(tmpdir(), "qube-install-configured-"));
    writeConfiguredRepo(root);
    const first = runCli(["install", "--yes", "--dry-run", "--json", "--host", "codex", "--work-provider", "github", "--ci-provider", "github"], { cwd: root });
    const second = runCli(["install", "--yes", "--dry-run", "--json", "--host", "codex", "--work-provider", "github", "--ci-provider", "github"], { cwd: root });
    assert.equal(first.status, 0, first.stderr);
    const parsed = JSON.parse(first.stdout);
    assert.deepEqual(parsed.installPlan.steps.map(step => [step.stage, step.status]), [
      ["package-install", "satisfied"],
      ["workspace-init", "satisfied"],
      ["provider-setup", "satisfied"],
      ["verify", "satisfied"]
    ]);
    assert.deepEqual(parsed.installPlan.commands, []);
    assert.deepEqual(JSON.parse(second.stdout).installPlan.commands, []);
  });

  it("does not treat a version-only config as a configured workspace", () => {
    const root = mkdtempSync(path.join(tmpdir(), "qube-install-version-only-"));
    writeConfiguredRepo(root);
    writeFileSync(path.join(root, ".qube", "aie", "config.json"), `${JSON.stringify({ version: 1 }, null, 2)}\n`);
    const result = runCli(["install", "--yes", "--dry-run", "--json", "--host", "codex", "--work-provider", "github", "--ci-provider", "github"], { cwd: root });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.installPlan.steps.find(step => step.stage === "workspace-init").status, "missing");
    assert.ok(parsed.installPlan.commands.some(step => step.stage === "workspace-init"));
  });

  it("plans workspace init when existing config does not match the selected providers", () => {
    const root = mkdtempSync(path.join(tmpdir(), "qube-install-provider-mismatch-"));
    writeConfiguredRepo(root);
    const result = runCli(["install", "--yes", "--dry-run", "--json", "--host", "codex", "--work-provider", "linear", "--ci-provider", "github"], { cwd: root });
    assert.equal(result.status, 0, result.stderr);
    const workspace = JSON.parse(result.stdout).installPlan.steps.find(step => step.stage === "workspace-init");
    assert.equal(workspace.status, "missing");
    assert.ok(JSON.parse(result.stdout).installPlan.commands.some(step => step.stage === "workspace-init"));
  });

  it("does not treat declared but uninstalled packages as satisfied", () => {
    const root = mkdtempSync(path.join(tmpdir(), "qube-install-declared-only-"));
    writeConfiguredRepo(root, { installPackages: false });
    const result = runCli(["install", "--yes", "--dry-run", "--json", "--host", "codex", "--work-provider", "github", "--ci-provider", "github"], { cwd: root });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.installPlan.steps.find(step => step.stage === "package-install").status, "missing");
    assert.ok(parsed.installPlan.commands.some(step => step.stage === "package-install"));
  });

  it("accepts a current managed section that uses CRLF line endings", () => {
    const root = mkdtempSync(path.join(tmpdir(), "qube-install-crlf-"));
    writeConfiguredRepo(root, { crlfManaged: true });
    const result = runCli(["install", "--yes", "--dry-run", "--json", "--host", "codex", "--work-provider", "github", "--ci-provider", "github"], { cwd: root });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).installPlan.steps.find(step => step.stage === "workspace-init").status, "satisfied");
  });

  it("plans a refresh when a managed instruction section is stale", () => {
    const root = mkdtempSync(path.join(tmpdir(), "qube-install-stale-"));
    writeConfiguredRepo(root, { staleManaged: true });
    const result = runCli(["install", "--yes", "--dry-run", "--json", "--host", "codex", "--work-provider", "github", "--ci-provider", "github"], { cwd: root });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    const workspace = parsed.installPlan.steps.find(step => step.stage === "workspace-init");
    assert.equal(workspace.status, "stale");
    assert.ok(parsed.installPlan.commands.some(step => step.stage === "workspace-init" && step.command.includes("qube init")));
  });

  it("does not treat a symlink config as a satisfied workspace", () => {
    const root = mkdtempSync(path.join(tmpdir(), "qube-install-symlink-"));
    writeConfiguredRepo(root);
    const configPath = path.join(root, ".qube", "aie", "config.json");
    const outside = path.join(root, "outside.json");
    writeFileSync(outside, "{\"version\":1}\n");
    try {
      unlinkSync(configPath);
      symlinkSync(outside, configPath);
    } catch {
      return;
    }
    const result = runCli(["install", "--yes", "--dry-run", "--json", "--host", "generic", "--work-provider", "github"], { cwd: root });
    assert.equal(result.status, 0, result.stderr);
    const workspace = JSON.parse(result.stdout).installPlan.steps.find(step => step.stage === "workspace-init");
    assert.notEqual(workspace.status, "satisfied");
  });

  it("keeps unknown package state missing instead of satisfied", () => {
    const root = mkdtempSync(path.join(tmpdir(), "qube-install-empty-"));
    const state = probeInstallState(root, { scope: "local", packageManager: "pnpm", hosts: ["generic"], workProviders: ["github"], ciProviders: ["github"] });
    assert.equal(state.find(step => step.stage === "package-install").status, "missing");
    assert.equal(state.find(step => step.stage === "workspace-init").status, "missing");
    assert.equal(state.every(step => step.status !== "satisfied"), true);
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
      "--ci-provider",
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
    assert.match(result.stdout, qubeNpmGlobalInstallPattern);
    assert.match(result.stdout, /AGENTS\.md policy notes/);
    assert.match(result.stdout, /Codex host support uses AGENTS\.md/);
    assert.match(result.stdout, /Codex does not use OpenCode-style project command files/);
    assert.match(result.stdout, /remove stale standalone global commands/);
    assert.match(result.stdout, /Connections:\s*[\s\S]*github \(cli-delegated\)/);
    assert.match(result.stdout, /Verify: gh auth status/);
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
      "--ci-provider",
      "github",
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
    assert.deepEqual(parsed.installPlan.connections.map(connection => connection.adapterId), ["linear", "github"]);
    assert.equal(parsed.installPlan.connections[0].envVars[0].name, "LINEAR_API_KEY");
    assert.equal(parsed.installPlan.connections[0].envVars[0].sensitive, true);
    assert.ok(parsed.installPlan.files.includes(".qube/aie/config.json provider notes"));
    assert.match(parsed.installPlan.notes.join("\n"), /@tjalve\/qube-adapter-linear/);
    assert.match(parsed.installPlan.notes.join("\n"), /Work provider: linear \(optional, adapter-contract\)/);
    assert.match(parsed.installPlan.notes.join("\n"), /sync-issue-status/);
  });

  it("aggregates pass, fail, and unverified statuses for configured connections", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-connection-doctor-"));
    mkdirSync(path.join(cwd, ".qube", "aie"), { recursive: true });
    writeFileSync(path.join(cwd, ".qube", "aie", "config.json"), `${JSON.stringify({
      version: 1,
      providers: {
        work: { kind: "linear", connection: { teamId: "team" } },
        review: { kind: "github" },
        ci: { kind: "github" },
        connections: { jenkins: { baseUrl: "https://jenkins.example.com", user: "ci" } },
      },
    })}\n`, "utf8");
    const statuses = { linear: "pass", github: "unverified", jenkins: "fail" };
    const result = await runConnectionDoctor({
      cwd,
      probe: async contract => ({
        adapterId: contract.adapterId,
        probeId: contract.probe.id,
        status: statuses[contract.adapterId],
        authMethod: contract.authMethod,
        summary: `${contract.adapterId} fixture status`,
        verifyCommand: contract.probe.verifyCommand,
        readOnly: true,
      }),
    });

    assert.equal(result.status, "fail");
    assert.deepEqual(result.connections.map(connection => [connection.adapterId, connection.status]), [
      ["linear", "pass"],
      ["github", "unverified"],
      ["jenkins", "fail"],
    ]);
  });

  it("reports configured connections as explicitly unverified in offline doctor mode", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-offline-doctor-"));
    const qualityRoot = mkdtempSync(path.join(tmpdir(), "qube-offline-quality-"));
    createQualityDoctorShim(qualityRoot);
    mkdirSync(path.join(cwd, ".qube", "aie"), { recursive: true });
    writeFileSync(path.join(cwd, ".qube", "aie", "config.json"), `${JSON.stringify({
      version: 1,
      providers: {
        work: { kind: "github" },
        review: { kind: "github" },
        ci: { kind: "github" },
      },
    })}\n`, "utf8");

    const result = runCli(["doctor", "--offline", "--json"], { cwd, env: { PATH: "", QUBE_TEST_PACKAGE_ROOT: qualityRoot } });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.connectionStatus, "unverified");
    assert.deepEqual(parsed.connections.connections.map(connection => [connection.adapterId, connection.status]), [["github", "unverified"]]);
    assert.equal(parsed.connections.connections[0].readOnly, true);
    assert.equal(parsed.workflow.status, "not-run");
  });

  it("preserves staged workflow readiness from the Executor doctor without flattening", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-workflow-doctor-"));
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-workflow-packages-"));
    createQualityDoctorShim(packageRoot);
    createWorkflowDoctorShim(packageRoot);
    mkdirSync(path.join(cwd, ".qube", "aie"), { recursive: true });
    writeFileSync(path.join(cwd, ".qube", "aie", "config.json"), `${JSON.stringify({
      version: 1,
      providers: {
        work: { kind: "github" },
        review: { kind: "github" },
        ci: { kind: "github" },
      },
    })}\n`, "utf8");

    const result = runCli(["doctor", "--json"], { cwd, env: { PATH: "", QUBE_TEST_PACKAGE_ROOT: packageRoot } });
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.workflow.status, "ok", result.stderr);
    assert.deepEqual(parsed.workflow.readiness.stages.map(stage => [stage.stage, stage.status]), [
      ["lifecycle", "ready"],
      ["quality-gates", "unconfigured"],
      ["shipping", "manual"],
    ]);
    assert.equal(parsed.workflow.readiness.review.state, "fallback-only");
    assert.equal(parsed.workflow.readiness.shipping.mode, "manual");

    const human = runCli(["doctor"], { cwd, env: { PATH: "", QUBE_TEST_PACKAGE_ROOT: packageRoot } });
    assert.match(human.stdout, /Workflow readiness:/);
    assert.match(human.stdout, /- quality-gates: unconfigured — No quality gates are configured\. Next: Configure policy\.gates entries\./);
    assert.match(human.stdout, /- shipping: manual — Manual shipping mode\./);
  });

  it("reports the workflow section unavailable when the Executor doctor exits with a failure", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-workflow-exit-"));
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-workflow-exit-packages-"));
    createQualityDoctorShim(packageRoot);
    createWorkflowDoctorShim(packageRoot);
    const failingCommand = path.join(packageRoot, "node_modules", ".bin", process.platform === "win32" ? "aie.cmd" : "aie");
    writeFileSync(failingCommand, process.platform === "win32"
      ? "@echo off\r\ntype \"%~dp0..\\@tjalve\\aie\\doctor.json\"\r\nexit /b 3\r\n"
      : "#!/bin/sh\nprintf '%s\\n' '{\"workflowReadiness\":{\"stages\":[]}}'\nexit 3\n", "utf8");
    if (process.platform !== "win32") chmodSync(failingCommand, 0o755);
    mkdirSync(path.join(cwd, ".qube", "aie"), { recursive: true });
    writeFileSync(path.join(cwd, ".qube", "aie", "config.json"), `${JSON.stringify({
      version: 1,
      providers: {
        work: { kind: "github" },
        review: { kind: "github" },
        ci: { kind: "github" },
      },
    })}\n`, "utf8");

    const result = runCli(["doctor", "--json"], { cwd, env: { PATH: "", QUBE_TEST_PACKAGE_ROOT: packageRoot } });
    const parsed = JSON.parse(result.stdout);
    // A failed Executor doctor invocation is never reported as successful workflow readiness, even with JSON on stdout.
    assert.equal(parsed.workflow.status, "unavailable", result.stderr);
  });

  it("reports the workflow section unavailable when the Executor component cannot run", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-workflow-missing-"));
    const qualityRoot = mkdtempSync(path.join(tmpdir(), "qube-workflow-missing-quality-"));
    createQualityDoctorShim(qualityRoot);
    mkdirSync(path.join(cwd, ".qube", "aie"), { recursive: true });
    writeFileSync(path.join(cwd, ".qube", "aie", "config.json"), `${JSON.stringify({
      version: 1,
      providers: {
        work: { kind: "github" },
        review: { kind: "github" },
        ci: { kind: "github" },
      },
    })}\n`, "utf8");

    const result = runCli(["doctor", "--json"], { cwd, env: { PATH: "", QUBE_TEST_PACKAGE_ROOT: qualityRoot } });
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.workflow.status, "unavailable", result.stderr);
    assert.equal(typeof parsed.workflow.error, "string");
    assert.notEqual(parsed.workflow.error.trim(), "");
  });

  it("preserves a missing Quality Control failure in offline doctor mode", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-offline-missing-quality-"));
    const emptyPackageRoot = mkdtempSync(path.join(tmpdir(), "qube-offline-empty-package-"));
    mkdirSync(path.join(cwd, ".qube", "aie"), { recursive: true });
    writeFileSync(path.join(cwd, ".qube", "aie", "config.json"), `${JSON.stringify({
      version: 1,
      providers: {
        work: { kind: "github" },
        review: { kind: "github" },
        ci: { kind: "github" },
      },
    })}\n`, "utf8");

    const result = runCli(["doctor", "--offline", "--json"], {
      cwd,
      env: { PATH: "", QUBE_TEST_PACKAGE_ROOT: emptyPackageRoot },
    });
    assert.equal(result.status, 4, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.quality.ok, false);
    assert.equal(parsed.connectionStatus, "unverified");
  });

  it("reports missing configured connection credentials as a doctor failure without probing the network", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-failed-connection-doctor-"));
    mkdirSync(path.join(cwd, ".qube", "aie"), { recursive: true });
    writeFileSync(path.join(cwd, ".qube", "aie", "config.json"), `${JSON.stringify({
      version: 1,
      providers: {
        work: { kind: "linear", connection: { teamId: "team" } },
        review: { kind: "github" },
        ci: { kind: "github" },
      },
    })}\n`, "utf8");

    const result = await runConnectionDoctor({
      cwd,
      env: {},
      probe: (contract, options) => contract.adapterId === "linear"
        ? runCoreConnectionProbe(contract, { ...options, mode: "fixture", fixture: { http: { status: 200, body: { data: { viewer: { id: "fixture" } } } } } })
        : Promise.resolve({ adapterId: contract.adapterId, probeId: contract.probe.id, status: "unverified", authMethod: contract.authMethod, summary: "not part of this focused assertion", verifyCommand: contract.probe.verifyCommand, readOnly: true }),
    });
    assert.equal(result.status, "fail");
    assert.equal(result.connections.find(connection => connection.adapterId === "linear").status, "fail");
  });

  it("merges connection fields with runtime role precedence when one adapter serves multiple roles", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-merged-connection-doctor-"));
    mkdirSync(path.join(cwd, ".qube", "aie"), { recursive: true });
    writeFileSync(path.join(cwd, ".qube", "aie", "config.json"), `${JSON.stringify({
      version: 1,
      providers: {
        work: { kind: "gitlab", connection: { projectId: "group/project", baseUrl: "https://runtime.example.com" } },
        review: { kind: "gitlab", connection: { projectId: "group/project", baseUrl: "https://runtime.example.com" } },
        ci: { kind: "github" },
        connections: { gitlab: { projectId: "registry/project", baseUrl: "https://doctor.example.com" } },
      },
    })}\n`, "utf8");

    const result = await runConnectionDoctor({
      cwd,
      probe: async (contract, options) => {
        if (contract.adapterId === "gitlab") {
          assert.equal(options.config.projectId, "group/project");
          assert.equal(options.config.baseUrl, "https://runtime.example.com");
        }
        return { adapterId: contract.adapterId, probeId: contract.probe.id, status: "pass", authMethod: contract.authMethod, summary: "passed", verifyCommand: contract.probe.verifyCommand, readOnly: true };
      },
    });
    assert.equal(result.status, "pass");
    assert.equal(result.connections.length, 2);
  });

  it("probes distinct role connections for the same adapter independently", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-distinct-role-connections-"));
    mkdirSync(path.join(cwd, ".qube", "aie"), { recursive: true });
    writeFileSync(path.join(cwd, ".qube", "aie", "config.json"), `${JSON.stringify({
      version: 1,
      providers: {
        work: { kind: "gitlab", connection: { projectId: "group/project", baseUrl: "https://work.example.com" } },
        review: { kind: "gitlab", connection: { projectId: "group/project", baseUrl: "https://review.example.com" } },
        ci: { kind: "github" },
      },
    })}\n`, "utf8");
    const gitLabUrls = [];
    const result = await runConnectionDoctor({
      cwd,
      probe: async (contract, options) => {
        if (contract.adapterId === "gitlab") gitLabUrls.push(options.config.baseUrl);
        return { adapterId: contract.adapterId, probeId: contract.probe.id, status: "pass", authMethod: contract.authMethod, summary: "passed", verifyCommand: contract.probe.verifyCommand, readOnly: true };
      },
    });
    assert.deepEqual(gitLabUrls.sort(), ["https://review.example.com", "https://work.example.com"]);
    assert.deepEqual(result.connections.filter(connection => connection.adapterId === "gitlab").map(connection => connection.connectionId), ["work:gitlab", "review:gitlab"]);
  });

  it("uses the same Jira legacy-option precedence as the runtime adapter", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-jira-precedence-"));
    mkdirSync(path.join(cwd, ".qube", "aie"), { recursive: true });
    writeFileSync(path.join(cwd, ".qube", "aie", "config.json"), `${JSON.stringify({
      version: 1,
      providers: {
        work: { kind: "jira", jira: { projectKey: "LEGACY", jql: "project = LEGACY" }, connection: { baseUrl: "https://jira.example.com", projectKey: "NEW", jql: "project = NEW" } },
        review: { kind: "github" },
        ci: { kind: "github" },
      },
    })}\n`, "utf8");
    await runConnectionDoctor({
      cwd,
      probe: async (contract, options) => {
        if (contract.adapterId === "jira") {
          assert.equal(options.config.projectKey, "LEGACY");
          assert.equal(options.config.jql, "project = LEGACY");
        }
        return { adapterId: contract.adapterId, probeId: contract.probe.id, status: "pass", authMethod: contract.authMethod, summary: "passed", verifyCommand: contract.probe.verifyCommand, readOnly: true };
      },
    });
  });

  it("fails doctor for malformed or structurally invalid Executor config", () => {
    const qualityRoot = mkdtempSync(path.join(tmpdir(), "qube-invalid-config-quality-"));
    createQualityDoctorShim(qualityRoot);
    const cases = [
      "{not-json",
      JSON.stringify({ version: 1, providers: { work: "github" } }),
      JSON.stringify({ version: 1, providers: { work: { kind: "linear", connection: { teamId: false } }, review: { kind: "github" }, ci: { kind: "github" } } }),
    ];
    for (const configText of cases) {
      const cwd = mkdtempSync(path.join(tmpdir(), "qube-invalid-config-"));
      mkdirSync(path.join(cwd, ".qube", "aie"), { recursive: true });
      writeFileSync(path.join(cwd, ".qube", "aie", "config.json"), `${configText}\n`, "utf8");
      const result = runCli(["doctor", "--json"], { cwd, env: { PATH: "", QUBE_TEST_PACKAGE_ROOT: qualityRoot } });
      assert.equal(result.status, 1, result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.connectionStatus, "fail");
      assert.match(parsed.connections.summary, /invalid|malformed/i);
      const humanResult = runCli(["doctor"], { cwd, env: { PATH: "", QUBE_TEST_PACKAGE_ROOT: qualityRoot } });
      assert.equal(humanResult.status, 1, humanResult.stderr);
      assert.match(humanResult.stdout, /- fail:/);
      assert.doesNotMatch(humanResult.stdout, /- unverified:/);
    }
  });

  it("aggregates Umpire continuation health into doctor", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-continuation-doctor-"));
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-continuation-packages-"));
    createQualityDoctorShim(packageRoot);
    createJsonEnvelopeShim(packageRoot, "aiu", { ok: true, command: "doctor", doctor: { status: "ok", checks: [] } });
    mkdirSync(path.join(cwd, ".qube", "aie"), { recursive: true });
    writeFileSync(path.join(cwd, ".qube", "aie", "config.json"), `${JSON.stringify({
      version: 1,
      providers: { work: { kind: "github" }, review: { kind: "github" }, ci: { kind: "github" } },
    })}\n`, "utf8");

    const result = runCli(["doctor", "--json"], { cwd, env: { PATH: "", QUBE_TEST_PACKAGE_ROOT: packageRoot } });
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.continuation.status, "ok");
    assert.equal(parsed.continuation.report.status, "ok");

    const human = runCli(["doctor"], { cwd, env: { PATH: "", QUBE_TEST_PACKAGE_ROOT: packageRoot } });
    assert.match(human.stdout, /Continuation health: ok/);
  });

  it("fails doctor when Umpire continuation health reports an error without hiding the underlying report", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-continuation-error-doctor-"));
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-continuation-error-packages-"));
    createQualityDoctorShim(packageRoot);
    createJsonEnvelopeShim(packageRoot, "aiu", { ok: true, command: "doctor", doctor: { status: "error", checks: [{ id: "stale-lock", status: "error" }] } });
    mkdirSync(path.join(cwd, ".qube", "aie"), { recursive: true });
    writeFileSync(path.join(cwd, ".qube", "aie", "config.json"), `${JSON.stringify({
      version: 1,
      providers: { work: { kind: "github" }, review: { kind: "github" }, ci: { kind: "github" } },
    })}\n`, "utf8");

    const result = runCli(["doctor", "--json"], { cwd, env: { PATH: "", QUBE_TEST_PACKAGE_ROOT: packageRoot } });
    assert.notEqual(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.continuation.report.status, "error");
  });

  it("never reports continuation as ok when the Umpire doctor is unavailable", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-continuation-missing-doctor-"));
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-continuation-missing-packages-"));
    createQualityDoctorShim(packageRoot);
    mkdirSync(path.join(cwd, ".qube", "aie"), { recursive: true });
    writeFileSync(path.join(cwd, ".qube", "aie", "config.json"), `${JSON.stringify({
      version: 1,
      providers: { work: { kind: "github" }, review: { kind: "github" }, ci: { kind: "github" } },
    })}\n`, "utf8");

    const result = runCli(["doctor", "--json"], { cwd, env: { PATH: "", QUBE_TEST_PACKAGE_ROOT: packageRoot } });
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.continuation.status, "unavailable");
    assert.notEqual(parsed.continuation.error.trim(), "");
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
      "--ci-provider",
      "github",
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
    assert.match(parsed.installPlan.notes.join("\n"), /Work provider: gitlab \(optional, adapter-contract\)/);
    assert.match(parsed.installPlan.notes.join("\n"), /sync-issue-status/);
  });

  it("renders Jira work provider install notes without prompting", () => {
    const result = runCli([
      "install",
      "--scope",
      "local",
      "--package-manager",
      "pnpm",
      "--host",
      "codex",
      "--work-provider",
      "jira",
      "--ci-provider",
      "github",
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

    assert.equal(parsed.installPlan.selections.workProvider, "jira");
    assert.ok(parsed.installPlan.files.includes(".qube/aie/config.json provider notes"));
    assert.match(parsed.installPlan.notes.join("\n"), /@tjalve\/qube-adapter-jira/);
    assert.match(parsed.installPlan.notes.join("\n"), /Work provider: jira \(optional, adapter-contract\)/);
    assert.match(parsed.installPlan.notes.join("\n"), /workflow-schema/);
    assert.match(parsed.installPlan.notes.join("\n"), /sync-issue-status/);
  });

  it("renders Jenkins CI provider install notes without prompting", () => {
    const result = runCli([
      "install",
      "--scope",
      "local",
      "--package-manager",
      "pnpm",
      "--host",
      "codex",
      "--work-provider",
      "github",
      "--ci-provider",
      "jenkins",
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

    assert.equal(parsed.installPlan.selections.ciProvider, "jenkins");
    assert.equal(parsed.installPlan.connections.find(connection => connection.adapterId === "jenkins").configPath, "providers.connections.jenkins");
    assert.ok(parsed.installPlan.files.includes(".qube/aie/gates/jenkins gate evidence notes"));
    assert.match(parsed.installPlan.notes.join("\n"), /@tjalve\/qube-adapter-jenkins/);
    assert.match(parsed.installPlan.notes.join("\n"), /CI provider: jenkins \(optional, adapter-contract\)/);
    assert.match(parsed.installPlan.notes.join("\n"), /read-ci-artifacts/);
    assert.match(parsed.installPlan.notes.join("\n"), /trigger-ci-run/);
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
      "--ci-provider",
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
    assert.match(result.stdout, qubePnpmAddPattern);
    assert.match(result.stdout, /CLAUDE\.md policy notes/);
    assert.match(result.stdout, /\.claude\/settings\.json hook notes/);
    assert.match(result.stdout, /Claude Code host support uses CLAUDE\.md/);
    assert.match(result.stdout, /Use TodoWrite and TodoRead/);
    assert.match(result.stdout, /do not create Claude Code slash command or skill assets/);
    assert.match(result.stdout, /No commands were run\./);
  });

  it("renders Grok Build install notes without installing Grok Build", () => {
    const result = runCli([
      "install",
      "--scope",
      "local",
      "--package-manager",
      "pnpm",
      "--host",
      "grok-build",
      "--work-provider",
      "github",
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

    assert.equal(parsed.installPlan.selections.host, "grok-build");
    assert.deepEqual(parsed.installPlan.commands.map(step => step.command), [
      qubePnpmAddCommand,
      "qube init . --host grok-build --work-provider github --ci-provider github",
      "qube aie labels setup",
      "qube doctor"
    ]);
    assert.ok(parsed.installPlan.files.includes("AGENTS.md policy notes: Grok Build reads AGENTS.md repository instructions; QUBE keeps durable policy in AGENTS.md and provider records."));
    assert.match(parsed.installPlan.notes.join("\n"), /Grok Build host support uses AGENTS\.md/);
    assert.match(parsed.installPlan.notes.join("\n"), /terminal-native coding agent and CLI surface/);
    assert.match(parsed.installPlan.notes.join("\n"), /headless prompt mode with -p/);
    assert.match(parsed.installPlan.notes.join("\n"), /does not install Grok Build or emit the xAI curl-pipe-shell installer/);
    assert.doesNotMatch(parsed.installPlan.commands.map(step => step.command).join("\n"), /x\.ai\/cli\/install\.sh|curl -fsSL/);
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

  it("reports Grok Build terminal host capabilities from fixtures without invoking the host", () => {
    const capabilities = listGrokBuildHostCapabilities();
    assert.equal(capabilities.filter(capability => capability.support === "supported").length, 2);
    assert.equal(capabilities.filter(capability => capability.support === "host-provided").length, 10);
    assert.equal(capabilities.filter(capability => capability.support === "unsupported").length, 5);
    assert.equal(new Set(capabilities.map(capability => capability.id)).size, capabilities.length);

    assert.equal(assertGrokBuildHostCapabilityAvailable("read-instructions").support, "supported");
    assert.equal(getGrokBuildHostCapability("run-terminal-cli").category, "terminal-cli");
    assert.equal(getGrokBuildHostCapability("use-terminal-tui").category, "terminal-tui");
    assert.equal(getGrokBuildHostCapability("run-headless-prompt").category, "automation");
    assert.equal(getGrokBuildHostCapability("use-parallel-subagents").category, "subagent");
    assert.equal(getGrokBuildHostCapability("use-worktree-subagents").category, "worktree");
    assert.equal(getGrokBuildHostCapability("install-cli").support, "unsupported");
    assert.match(getGrokBuildHostCapability("install-cli").summary, /does not install Grok Build/);
    assert.deepEqual(listGrokBuildInstallFiles(), [
      "AGENTS.md policy notes: Grok Build reads AGENTS.md repository instructions; QUBE keeps durable policy in AGENTS.md and provider records.",
    ]);
    assert.equal(listGrokBuildInstallNotes().length, 6);

    const unknownCapability = getGrokBuildHostCapability("completely-unknown-id");
    assert.equal(unknownCapability.support, "unsupported");
    assert.match(formatGrokBuildUnsupportedCapabilityMessage(unknownCapability), /completely-unknown-id/);
    assert.throws(() => assertGrokBuildHostCapabilityAvailable("install-cli"), /Unsupported Grok Build capability/);

    const repo = mkdtempSync(path.join(tmpdir(), "qube-grok-build-host-"));
    writeFileSync(path.join(repo, "AGENTS.md"), "Repository policy\n");
    const inspection = inspectGrokBuildWorkspace(repo);

    assert.equal(inspection.cwd, repo);
    assert.equal(inspection.instructionTarget.present, true);
    assert.equal(path.basename(inspection.instructionTarget.path), "AGENTS.md");
    assert.deepEqual(inspection.commandExamples, ["grok-build", "grok-build -p \"<prompt>\""]);
    assert.ok(inspection.capabilities.some(capability => capability.id === "run-terminal-cli" && capability.category === "terminal-cli"));
    assert.ok(inspection.capabilities.some(capability => capability.id === "use-terminal-tui" && capability.category === "terminal-tui"));
    assert.ok(inspection.capabilities.some(capability => capability.id === "use-acp" && capability.category === "automation"));
    assert.ok(inspection.unsupportedCapabilities.some(capability => capability.id === "open-pull-request"));
    assert.throws(() => inspection.capabilities.push(inspection.capabilities[0]), TypeError);
    assert.throws(() => {
      inspection.capabilities[0].summary = "mutated";
    }, TypeError);

    const repoWithoutInstructions = mkdtempSync(path.join(tmpdir(), "qube-grok-build-host-missing-"));
    const missingInspection = inspectGrokBuildWorkspace(repoWithoutInstructions);
    assert.equal(missingInspection.instructionTarget.present, false);
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
    assert.ok(executor.capabilities.hostSurfaces.some(surface => surface.id === "grok-build" && surface.support === "installed"));
    assert.match(executor.capabilities.hostSurfaces.find(surface => surface.id === "grok-build").summary, /without installing or invoking Grok Build/);
    assert.ok(executor.capabilities.hostSurfaces.find(surface => surface.id === "claude-code").capabilities.some(capability => capability.id === "use-task-state" && capability.support === "standalone"));
    assert.equal(executor.capabilities.hostSurfaces.find(surface => surface.id === "opencode").source, "adapter-contract");
    assert.ok(executor.capabilities.hostSurfaces.find(surface => surface.id === "opencode").capabilities.some(capability => capability.id === "open-pull-request" && capability.support === "unsupported"));
    assert.ok(executor.capabilities.workProviders.some(provider => provider.id === "github" && provider.support === "installed" && provider.default === true));
    assert.ok(executor.capabilities.workProviders.find(provider => provider.id === "github").capabilities.some(capability => capability.id === "read-merge-blockers" && capability.support === "supported"));
    assert.ok(executor.capabilities.workProviders.find(provider => provider.id === "github").capabilities.some(capability => capability.id === "read-review-threads" && capability.support === "supported"));
    assert.ok(executor.capabilities.workProviders.find(provider => provider.id === "github").capabilities.some(capability => capability.id === "resolve-review-threads" && capability.support === "supported"));
    assert.ok(executor.capabilities.workProviders.find(provider => provider.id === "gitlab").capabilities.some(capability => capability.id === "resolve-review-threads" && capability.support === "supported"));
    assert.ok(executor.capabilities.workProviders.find(provider => provider.id === "gitlab").capabilities.some(capability => capability.id === "sync-issue-status" && capability.support === "unsupported"));
    assert.ok(executor.capabilities.workProviders.some(provider => provider.id === "local" && provider.support === "unsupported"));
    assert.ok(executor.capabilities.ciProviders.some(provider => provider.id === "jenkins" && provider.support === "optional"));
    assert.match(executor.capabilities.ciProviders.find(provider => provider.id === "jenkins").summary, /without triggering or rerunning jobs/);
    assert.ok(executor.capabilities.ciProviders.find(provider => provider.id === "jenkins").capabilities.some(capability => capability.id === "trigger-ci-run" && capability.support === "unsupported"));
  });

  it("runs a bounded local autoresearch lifecycle with explicit promotion", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-autoresearch-cwd-"));
    const target = createAutoresearchPackageTarget(cwd, 10);

    const init = runCli(["autoresearch", "init", "target", "improve runtime performance", "--json"], { cwd });
    assert.equal(init.status, 0);
    const initialized = JSON.parse(init.stdout).autoresearch;
    assert.equal(initialized.action, "init");
    assert.equal(initialized.phase, "initialized");
    assert.equal(initialized.safety.targetMutationBeforePromote, false);
    assert.equal(initialized.synthesis.classification, "autoresearch");
    assert.notEqual(initialized.synthesis.objective.shape, "term-coverage");
    assert.ok(existsSync(path.join(initialized.stateDirectory, "arena.json")));
    assert.ok(existsSync(path.join(initialized.stateDirectory, "arena.md")));
    assert.ok(existsSync(path.join(initialized.stateDirectory, "evaluator.json")));
    const evaluator = JSON.parse(readFileSync(path.join(initialized.stateDirectory, "evaluator.json"), "utf8"));
    assert.equal(evaluator.kind, "command-metric");
    assert.equal(evaluator.command, "npm test");
    assert.equal(evaluator.acceptancePolicy.promotionRequiresHuman, false);
    assert.notEqual(evaluator.kind, "term-coverage");

    const baseline = runCli(["autoresearch", "baseline", "--json"], { cwd });
    assert.equal(baseline.status, 0);
    const baselined = JSON.parse(baseline.stdout).autoresearch;
    assert.equal(baselined.phase, "baselined");
    assert.equal(baselined.evaluation.evaluatorHash, initialized.evaluatorHash);
    assert.equal(baselined.evaluation.score, 10);
    assert.equal(baselined.evaluation.command, "npm test");
    assert.equal(baselined.evaluation.referee.owner, "aiq");
    assert.equal(baselined.evaluation.referee.status, "passed");
    assert.ok(existsSync(path.join(initialized.stateDirectory, "sandbox", "workspace", "score.json")));
    assert.ok(existsSync(path.join(initialized.stateDirectory, "sandbox", "baseline", "workspace", "score.json")));

    writeAutoresearchSandboxScore(initialized.stateDirectory, 5);

    const run = runCli(["autoresearch", "run", "--json"], { cwd });
    assert.equal(run.status, 0);
    const ran = JSON.parse(run.stdout).autoresearch;
    assert.equal(ran.phase, "ran");
    assert.equal(ran.candidate.owner.execution, "aie");
    assert.equal(ran.candidate.owner.evaluation, "aiq");
    assert.equal(ran.candidate.evaluation.score, 5);
    assert.ok(ran.candidate.evaluation.score < baselined.evaluation.score);
    assert.equal(ran.candidate.referee.status, "passed");
    assert.ok(ran.candidate.artifactPath.includes(path.join(".qube", "autoresearch")));
    assert.ok(ran.candidate.workspacePath.includes(path.join(".qube", "autoresearch")));
    assert.ok(existsSync(ran.candidate.artifactPath));
    assert.equal(JSON.parse(readFileSync(path.join(target, "score.json"), "utf8")).score, 10);
    assert.equal(existsSync(path.join(target, "autoresearch-result.md")), false);

    const status = runCli(["autoresearch", "status", "--json"], { cwd });
    assert.equal(status.status, 0);
    const current = JSON.parse(status.stdout).autoresearch;
    assert.equal(current.phase, "ran");
    assert.equal(current.attempts, 1);
    assert.equal(current.currentBest.id, ran.candidate.id);
    assert.equal(current.evaluatorProvenance.owner, "aiq");
    assert.equal(current.evaluatorProvenance.command, "npm test");
    assert.equal(current.evaluatorProvenance.aiqBoundary, "aiq-fixed-evaluator");
    assert.equal(current.activeCandidate.id, ran.candidate.id);
    assert.deepEqual(current.activeCandidate.changedFiles, ["score.json"]);
    assert.deepEqual(current.blockers, []);
    assert.equal(current.continuation.owner, "aiu");
    assert.equal(current.continuation.status, "ready");
    assert.match(current.continuation.resumeCommand, /qube autoresearch run --run/);
    assert.deepEqual(current.changedSurfaceSummary.files, ["score.json"]);
    assert.deepEqual(current.currentBestTrajectory.map((point) => point.id), ["baseline", ran.candidate.id]);

    const dashboard = runCli(["autoresearch", "dashboard", "--json"], { cwd });
    assert.equal(dashboard.status, 0);
    const dashboardState = JSON.parse(dashboard.stdout).autoresearch;
    assert.ok(existsSync(dashboardState.dashboardPath));
    const dashboardHtml = readFileSync(dashboardState.dashboardPath, "utf8");
    const dashboardData = JSON.parse(readFileSync(dashboardState.dashboardDataPath, "utf8"));
    assert.match(dashboardHtml, /QUBE Autoresearch/);
    assert.match(dashboardHtml, /Control Loop/);
    assert.equal(dashboardData.summary.continuation.owner, "aiu");
    assert.equal(dashboardData.summary.attemptHistory[0].id, ran.candidate.id);

    const promote = runCli(["autoresearch", "promote", "--json"], { cwd });
    assert.equal(promote.status, 0);
    const promoted = JSON.parse(promote.stdout).autoresearch;
    assert.equal(promoted.phase, "promoted");
    assert.ok(existsSync(path.join(target, "autoresearch-result.md")));
    assert.equal(promoted.promotion.outputPath, path.join(target, "autoresearch-result.md"));
  });

  it("plans autoresearch baseline and run dry-runs without executing the evaluator command", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-autoresearch-dry-cwd-"));
    const sideEffectPath = path.join(cwd, "evaluator-count.json");
    createAutoresearchPackageTarget(cwd, 10, { sideEffectPath });

    const init = runCli(["autoresearch", "init", "target", "improve runtime performance", "--json"], { cwd });
    assert.equal(init.status, 0);
    const initialized = JSON.parse(init.stdout).autoresearch;

    const baselineDryRun = runCli(["autoresearch", "baseline", "--dry-run", "--json"], { cwd });
    assert.equal(baselineDryRun.status, 0);
    assert.equal(JSON.parse(baselineDryRun.stdout).autoresearch.planned, true);
    assert.equal(existsSync(sideEffectPath), false);
    assert.equal(existsSync(path.join(initialized.stateDirectory, "baseline.json")), false);

    const baseline = runCli(["autoresearch", "baseline", "--json"], { cwd });
    assert.equal(baseline.status, 0);
    assert.equal(JSON.parse(readFileSync(sideEffectPath, "utf8")).count, 1);
    writeAutoresearchSandboxScore(initialized.stateDirectory, 5);

    const runDryRun = runCli(["autoresearch", "run", "--dry-run", "--json"], { cwd });
    assert.equal(runDryRun.status, 0);
    const planned = JSON.parse(runDryRun.stdout).autoresearch;
    assert.equal(planned.planned, true);
    assert.deepEqual(planned.changedFiles, ["score.json"]);
    assert.equal(JSON.parse(readFileSync(sideEffectPath, "utf8")).count, 1);
  });

  it("accepts autoresearch threshold and finding-reduction objective shapes with command metrics", () => {
    const thresholdCwd = mkdtempSync(path.join(tmpdir(), "qube-autoresearch-threshold-cwd-"));
    createAutoresearchPackageTarget(thresholdCwd, 10);
    const thresholdInit = runCli(["autoresearch", "init", "target", "keep score below 5 threshold", "--json"], { cwd: thresholdCwd });
    assert.equal(thresholdInit.status, 0);
    const thresholdInitialized = JSON.parse(thresholdInit.stdout).autoresearch;
    assert.equal(thresholdInitialized.synthesis.objective.shape, "threshold");
    const thresholdEvaluator = JSON.parse(readFileSync(path.join(thresholdInitialized.stateDirectory, "evaluator.json"), "utf8"));
    assert.equal(thresholdEvaluator.acceptancePolicy.mode, "threshold");
    assert.equal(thresholdEvaluator.acceptancePolicy.threshold, 5);
    assert.equal(thresholdEvaluator.acceptancePolicy.promotionRequiresHuman, false);
    assert.equal(runCli(["autoresearch", "baseline", "--json"], { cwd: thresholdCwd }).status, 0);
    writeAutoresearchSandboxScore(thresholdInitialized.stateDirectory, 5);
    const thresholdRun = runCli(["autoresearch", "run", "--json"], { cwd: thresholdCwd });
    assert.equal(thresholdRun.status, 0);
    assert.equal(JSON.parse(thresholdRun.stdout).autoresearch.candidate.accepted, true);

    const findingsCwd = mkdtempSync(path.join(tmpdir(), "qube-autoresearch-findings-cwd-"));
    createAutoresearchPackageTarget(findingsCwd, 3);
    const findingsInit = runCli(["autoresearch", "init", "target", "reduce findings count", "--json"], { cwd: findingsCwd });
    assert.equal(findingsInit.status, 0);
    const findingsInitialized = JSON.parse(findingsInit.stdout).autoresearch;
    assert.equal(findingsInitialized.synthesis.objective.shape, "finding-reduction");
    const findingsEvaluator = JSON.parse(readFileSync(path.join(findingsInitialized.stateDirectory, "evaluator.json"), "utf8"));
    assert.equal(findingsEvaluator.acceptancePolicy.mode, "finding-reduction");
    assert.equal(findingsEvaluator.acceptancePolicy.promotionRequiresHuman, false);
    assert.equal(runCli(["autoresearch", "baseline", "--json"], { cwd: findingsCwd }).status, 0);
    writeAutoresearchSandboxScore(findingsInitialized.stateDirectory, 1);
    const findingsRun = runCli(["autoresearch", "run", "--json"], { cwd: findingsCwd });
    assert.equal(findingsRun.status, 0);
    assert.equal(JSON.parse(findingsRun.stdout).autoresearch.candidate.accepted, true);
  });

  it("rejects threshold candidates that pass the threshold but regress the current score", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-autoresearch-threshold-regression-cwd-"));
    createAutoresearchPackageTarget(cwd, 1);

    const init = runCli(["autoresearch", "init", "target", "keep score below 5 threshold", "--json"], { cwd });
    assert.equal(init.status, 0);
    const initialized = JSON.parse(init.stdout).autoresearch;
    assert.equal(runCli(["autoresearch", "baseline", "--json"], { cwd }).status, 0);

    writeAutoresearchSandboxScore(initialized.stateDirectory, 4);
    const run = runCli(["autoresearch", "run", "--json"], { cwd });
    assert.equal(run.status, 0);
    const ran = JSON.parse(run.stdout).autoresearch;
    assert.equal(ran.candidate.accepted, false);
    assert.equal(ran.currentBest, null);
    assert.match(ran.candidate.referee.reasons.join("\n"), /did not improve current best 1/);
  });

  it("marks autoresearch document objectives as human-gated instead of faking automated progress", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-autoresearch-doc-cwd-"));
    createAutoresearchDocumentTarget(cwd);

    const init = runCli(["autoresearch", "init", "docs", "improve documentation quality", "--json"], { cwd });
    assert.equal(init.status, 0);
    const initialized = JSON.parse(init.stdout).autoresearch;
    assert.equal(initialized.synthesis.objective.shape, "judge-rubric");
    const evaluator = JSON.parse(readFileSync(path.join(initialized.stateDirectory, "evaluator.json"), "utf8"));
    assert.equal(evaluator.kind, "rubric-review");
    assert.equal(evaluator.acceptancePolicy.mode, "human-gated");

    const baseline = runCli(["autoresearch", "baseline", "--json"], { cwd });
    assert.equal(baseline.status, 0);
    const baselined = JSON.parse(baseline.stdout).autoresearch;
    assert.equal(baselined.phase, "baselined");
    assert.equal(baselined.evaluation.referee.status, "rejected");
    assert.match(baselined.evaluation.referee.reasons.join("\n"), /human-gated/);

    const status = runCli(["autoresearch", "status", "--json"], { cwd });
    assert.equal(status.status, 0);
    const current = JSON.parse(status.stdout).autoresearch;
    assert.equal(current.continuation.owner, "aiu");
    assert.equal(current.continuation.status, "blocked");
    assert.equal(current.continuation.resumeCommand, null);
    assert.deepEqual(current.currentBestTrajectory, []);
    assert.match(current.blockers.join("\n"), /human-gated|No trustworthy automated command evaluator/);

    const run = runCli(["autoresearch", "run", "--json"], { cwd });
    assert.equal(run.status, 2);
    assert.match(JSON.parse(run.stdout).error.likelyCause, /human-gated/);

    const promote = runCli(["autoresearch", "promote", "--json"], { cwd });
    assert.equal(promote.status, 2);
    assert.match(JSON.parse(promote.stdout).error.likelyCause, /human-gated/);
  });

  it("marks human-gated autoresearch code objectives as blocked at baseline", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-autoresearch-code-human-gated-cwd-"));
    createAutoresearchPackageTarget(cwd, 10);

    const init = runCli(["autoresearch", "init", "target", "improve documentation quality", "--json"], { cwd });
    assert.equal(init.status, 0);
    const initialized = JSON.parse(init.stdout).autoresearch;
    assert.equal(initialized.synthesis.objective.shape, "judge-rubric");
    const evaluator = JSON.parse(readFileSync(path.join(initialized.stateDirectory, "evaluator.json"), "utf8"));
    assert.equal(evaluator.acceptancePolicy.promotionRequiresHuman, true);

    const baseline = runCli(["autoresearch", "baseline", "--json"], { cwd });
    assert.equal(baseline.status, 0);
    const baselined = JSON.parse(baseline.stdout).autoresearch;
    assert.equal(baselined.evaluation.referee.status, "rejected");
    assert.match(baselined.evaluation.referee.reasons.join("\n"), /human-gated/);

    const status = runCli(["autoresearch", "status", "--json"], { cwd });
    assert.equal(status.status, 0);
    const current = JSON.parse(status.stdout).autoresearch;
    assert.equal(current.continuation.status, "blocked");
    assert.equal(current.continuation.resumeCommand, null);
    assert.deepEqual(current.currentBestTrajectory, []);
  });

  it("refuses autoresearch baseline before copying oversized targets", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-autoresearch-large-target-cwd-"));
    const target = createAutoresearchPackageTarget(cwd, 10);
    writeManyAutoresearchFiles(path.join(target, "bulk"), 2001);

    const init = runCli(["autoresearch", "init", "target", "improve runtime performance", "--json"], { cwd });
    assert.equal(init.status, 0);
    const initialized = JSON.parse(init.stdout).autoresearch;

    const dryRun = runCli(["autoresearch", "baseline", "--dry-run", "--json"], { cwd });
    assert.equal(dryRun.status, 0);
    const planned = JSON.parse(dryRun.stdout).autoresearch;
    assert.match(planned.blockers.join("\n"), /exceeding the autoresearch limit/);
    assert.equal(existsSync(path.join(initialized.stateDirectory, "sandbox", "workspace", "score.json")), false);

    const baseline = runCli(["autoresearch", "baseline", "--json"], { cwd });
    assert.equal(baseline.status, 2);
    assert.match(JSON.parse(baseline.stdout).error.likelyCause, /exceeding the autoresearch limit/);
    assert.equal(existsSync(path.join(initialized.stateDirectory, "baseline.json")), false);
    assert.equal(existsSync(path.join(initialized.stateDirectory, "sandbox", "workspace", "score.json")), false);
  });

  it("refuses autoresearch run before hashing or copying oversized workspaces", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-autoresearch-large-run-cwd-"));
    createAutoresearchPackageTarget(cwd, 10);

    const init = runCli(["autoresearch", "init", "target", "improve runtime performance", "--json"], { cwd });
    assert.equal(init.status, 0);
    const initialized = JSON.parse(init.stdout).autoresearch;
    assert.equal(runCli(["autoresearch", "baseline", "--json"], { cwd }).status, 0);
    writeManyAutoresearchFiles(path.join(initialized.stateDirectory, "sandbox", "workspace", "bulk"), 2001);

    const dryRun = runCli(["autoresearch", "run", "--dry-run", "--json"], { cwd });
    assert.equal(dryRun.status, 0);
    const planned = JSON.parse(dryRun.stdout).autoresearch;
    assert.match(planned.blockers.join("\n"), /exceeding the autoresearch limit/);
    assert.deepEqual(planned.changedFiles, []);

    const run = runCli(["autoresearch", "run", "--json"], { cwd });
    assert.equal(run.status, 2);
    assert.match(JSON.parse(run.stdout).error.likelyCause, /exceeding the autoresearch limit/);
    assert.equal(existsSync(path.join(initialized.stateDirectory, "sandbox", "candidates", "candidate-001")), false);
  });

  it("rejects non-improving autoresearch candidates and restores the sandbox workspace", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-autoresearch-reject-cwd-"));
    const target = createAutoresearchPackageTarget(cwd, 10);

    const init = runCli(["autoresearch", "init", "target", "improve runtime performance", "--json"], { cwd });
    assert.equal(init.status, 0);
    const initialized = JSON.parse(init.stdout).autoresearch;
    assert.equal(runCli(["autoresearch", "baseline", "--json"], { cwd }).status, 0);
    writeAutoresearchSandboxScore(initialized.stateDirectory, 15);

    const run = runCli(["autoresearch", "run", "--json"], { cwd });
    assert.equal(run.status, 0);
    const ran = JSON.parse(run.stdout).autoresearch;
    assert.equal(ran.candidate.accepted, false);
    assert.equal(ran.candidate.referee.status, "rejected");
    assert.match(ran.candidate.referee.reasons.join("\n"), /did not improve/);
    assert.equal(ran.currentBest, null);
    assert.equal(JSON.parse(readFileSync(path.join(initialized.stateDirectory, "sandbox", "workspace", "score.json"), "utf8")).score, 10);
    assert.equal(JSON.parse(readFileSync(path.join(target, "score.json"), "utf8")).score, 10);

    const status = runCli(["autoresearch", "status", "--json"], { cwd });
    assert.equal(status.status, 0);
    const current = JSON.parse(status.stdout).autoresearch;
    assert.deepEqual(current.blockers, []);
    assert.equal(current.continuation.status, "ready");
    assert.match(current.continuation.resumeCommand, /qube autoresearch run --run/);
  });

  it("rejects autoresearch candidates outside declared mutable surfaces", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-autoresearch-boundary-cwd-"));
    const target = createAutoresearchPackageTarget(cwd, 10);

    const init = runCli(["autoresearch", "init", "target", "improve runtime performance", "--json"], { cwd });
    assert.equal(init.status, 0);
    const initialized = JSON.parse(init.stdout).autoresearch;
    assert.equal(runCli(["autoresearch", "baseline", "--json"], { cwd }).status, 0);

    const arenaPath = path.join(initialized.stateDirectory, "arena.json");
    const arena = JSON.parse(readFileSync(arenaPath, "utf8"));
    arena.mutableSurfaces = arena.mutableSurfaces.map((surface) => ({ ...surface, permission: "read-only" }));
    writeFileSync(arenaPath, `${JSON.stringify(arena, null, 2)}\n`, "utf8");
    writeAutoresearchSandboxScore(initialized.stateDirectory, 5);

    const run = runCli(["autoresearch", "run", "--json"], { cwd });
    assert.equal(run.status, 0);
    const ran = JSON.parse(run.stdout).autoresearch;
    assert.equal(ran.candidate.accepted, false);
    assert.equal(ran.candidate.referee.status, "rejected");
    assert.match(ran.candidate.referee.reasons.join("\n"), /outside declared mutable surfaces|no declared read-write mutable surfaces/);
    assert.equal(JSON.parse(readFileSync(path.join(initialized.stateDirectory, "sandbox", "workspace", "score.json"), "utf8")).score, 10);
    assert.equal(JSON.parse(readFileSync(path.join(target, "score.json"), "utf8")).score, 10);
  });

  it("rejects autoresearch baseline when the evaluator command emits no scalar score", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-autoresearch-bad-score-cwd-"));
    const target = createAutoresearchPackageTarget(cwd, 10);
    writeFileSync(path.join(target, "metric.mjs"), "console.log('not a score');\n", "utf8");

    const init = runCli(["autoresearch", "init", "target", "improve runtime performance", "--json"], { cwd });
    assert.equal(init.status, 0);
    const initialized = JSON.parse(init.stdout).autoresearch;
    const baseline = runCli(["autoresearch", "baseline", "--json"], { cwd });
    assert.equal(baseline.status, 2);
    const parsed = JSON.parse(baseline.stdout);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error.likelyCause, /did not emit a scalar score/);
    assert.equal(existsSync(path.join(initialized.stateDirectory, "baseline.json")), false);
  });

  it("refuses autoresearch when the fixed evaluator changes", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-autoresearch-tamper-cwd-"));
    createAutoresearchPackageTarget(cwd, 10);
    const init = runCli(["autoresearch", "target", "improve runtime performance", "--json"], { cwd });
    assert.equal(init.status, 0);
    const initialized = JSON.parse(init.stdout).autoresearch;
    const evaluatorPath = path.join(initialized.stateDirectory, "evaluator.json");
    const evaluator = JSON.parse(readFileSync(evaluatorPath, "utf8"));
    evaluator.signals = [...evaluator.signals, "tampered"];
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
    const { target, initialized } = createAcceptedAutoresearchRun(cwd);
    const targetReadme = path.join(target, "metric.mjs");

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

  it("refuses autoresearch promotion when evaluator policy requires a human gate", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-autoresearch-human-promotion-cwd-"));
    const { initialized } = createAcceptedAutoresearchRun(cwd);
    const evaluatorPath = path.join(initialized.stateDirectory, "evaluator.json");
    const statePath = path.join(initialized.stateDirectory, "state.json");
    const evaluator = JSON.parse(readFileSync(evaluatorPath, "utf8"));
    evaluator.acceptancePolicy = { ...evaluator.acceptancePolicy, promotionRequiresHuman: true };
    evaluator.hash = hashAutoresearchEvaluatorForTest(evaluator);
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    state.evaluatorHash = evaluator.hash;
    writeFileSync(evaluatorPath, `${JSON.stringify(evaluator, null, 2)}\n`, "utf8");
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

    const status = runCli(["autoresearch", "status", "--json"], { cwd });
    assert.equal(status.status, 0);
    const current = JSON.parse(status.stdout).autoresearch;
    assert.equal(current.continuation.status, "blocked");
    assert.equal(current.continuation.resumeCommand, null);
    assert.match(current.blockers.join("\n"), /human-gated by evaluator policy/);

    const run = runCli(["autoresearch", "run", "--json"], { cwd });
    assert.equal(run.status, 2);
    assert.match(JSON.parse(run.stdout).error.likelyCause, /human-gated by evaluator policy/);

    const promote = runCli(["autoresearch", "promote", "--json"], { cwd });
    assert.equal(promote.status, 2);
    const parsed = JSON.parse(promote.stdout);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error.likelyCause, /human-gated by evaluator policy/);
  });

  it("refuses autoresearch promotion output outside declared mutable surfaces", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-autoresearch-output-surface-cwd-"));
    createAcceptedAutoresearchRun(cwd);

    const promote = runCli(["autoresearch", "promote", "--output", "../outside.md", "--json"], { cwd });
    assert.equal(promote.status, 2);
    const parsed = JSON.parse(promote.stdout);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error.likelyCause, /outside declared mutable surfaces/);
    assert.equal(existsSync(path.join(path.dirname(cwd), "outside.md")), false);
  });

  it("refuses autoresearch promotion when arena surfaces are tampered wider than the target", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-autoresearch-tampered-surface-cwd-"));
    const { initialized } = createAcceptedAutoresearchRun(cwd);

    const arenaPath = path.join(initialized.stateDirectory, "arena.json");
    const arena = JSON.parse(readFileSync(arenaPath, "utf8"));
    arena.mutableSurfaces = [{
      path: cwd,
      kind: "directory",
      permission: "read-write",
      reason: "tampered"
    }];
    writeFileSync(arenaPath, `${JSON.stringify(arena, null, 2)}\n`, "utf8");

    const promote = runCli(["autoresearch", "promote", "--output", "outside.md", "--json"], { cwd });
    assert.equal(promote.status, 2);
    const parsed = JSON.parse(promote.stdout);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error.likelyCause, /outside declared mutable surfaces/);
    assert.equal(existsSync(path.join(cwd, "outside.md")), false);
  });

  it("refuses autoresearch promotion through symlinks inside mutable surfaces", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-autoresearch-symlink-surface-cwd-"));
    const target = path.join(cwd, "target");
    const outside = path.join(cwd, "outside");
    createAutoresearchPackageTarget(cwd);
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, path.join(target, "linked"), process.platform === "win32" ? "junction" : "dir");

    const init = runCli(["autoresearch", "init", "target", "improve runtime performance", "--json"], { cwd });
    assert.equal(init.status, 0);
    const initialized = JSON.parse(init.stdout).autoresearch;
    assert.equal(runCli(["autoresearch", "baseline", "--json"], { cwd }).status, 0);
    writeAutoresearchSandboxScore(initialized.stateDirectory, 5);
    assert.equal(runCli(["autoresearch", "run", "--json"], { cwd }).status, 0);

    const promote = runCli(["autoresearch", "promote", "--output", path.join("target", "linked", "escaped.md"), "--json"], { cwd });
    assert.equal(promote.status, 2);
    const parsed = JSON.parse(promote.stdout);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error.likelyCause, /outside declared mutable surfaces/);
    assert.equal(existsSync(path.join(outside, "escaped.md")), false);
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
    await writeFile(path.join(pathPackageRoot, "package.json"), `${JSON.stringify({ name: "@tjalve/aib", version: aibVersion })}\n`);
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
    await writeFile(path.join(packageDir, "package.json"), `${JSON.stringify({ name: "@tjalve/aib", version: aibVersion })}\n`);
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
    assert.equal(resolution?.packageVersion, aibVersion);
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
    assert.match(planned.stderr, aibExpectedPathPattern);
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
    assert.match(planned.stderr, aibUnableVerifyPattern);
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
    // A --json direct command captures the child output; a shim that violates the JSON contract yields one synthesized error envelope.
    assert.equal(ideaWithoutText.status, 1);
    const envelope = JSON.parse(ideaWithoutText.stdout);
    assert.equal(envelope.ok, false);
    assert.match(JSON.stringify(envelope), /dispatched init \. --json/);
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

describe("qube init composer orchestrator", () => {
  function initEnv(packageRoot, extra = {}) {
    return { PATH: "", QUBE_TEST_PACKAGE_ROOT: packageRoot, ...extra };
  }

  it("composes aie and aiu init from one selection set for a single host", () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-init-single-host-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-init-single-cwd-"));
    createJsonEnvelopeShim(packageRoot, "aie", { ok: true, command: "init", dryRun: false, actions: [] });
    createJsonEnvelopeShim(packageRoot, "aiu", { ok: true, command: "init", init: { ok: true } });

    const result = runCli(["init", ".", "--host", "claude-code", "--work-provider", "github", "--ci-provider", "github", "--yes", "--json"], { cwd, env: initEnv(packageRoot) });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.command, "init");
    assert.deepEqual(parsed.selections.hosts, ["claude-code"]);
    assert.equal(parsed.selections.activeWorkProvider, "github");
    assert.equal(parsed.selections.activeCiProvider, "github");
    assert.equal(parsed.aie.length, 1);
    assert.deepEqual(parsed.aie[0].args, ["init", ".", "--json", "--tool", "claude-code", "--yes"]);
    assert.equal(parsed.aiu.length, 1);
    assert.deepEqual(parsed.aiu[0].args, ["init", "--json", "--tool", "claude-code"]);
    assert.deepEqual(parsed.with, []);
  });

  it("collapses to --tool all when every real host tool is selected, and fans out otherwise", () => {
    const allRoot = mkdtempSync(path.join(tmpdir(), "qube-init-all-hosts-"));
    const allCwd = mkdtempSync(path.join(tmpdir(), "qube-init-all-cwd-"));
    createJsonEnvelopeShim(allRoot, "aie", { ok: true, command: "init", actions: [] });
    createJsonEnvelopeShim(allRoot, "aiu", { ok: true, command: "init" });
    const allResult = runCli(["init", ".", "--host", "codex,claude-code,opencode", "--yes", "--json"], { cwd: allCwd, env: initEnv(allRoot) });
    assert.equal(allResult.status, 0, allResult.stderr);
    const allParsed = JSON.parse(allResult.stdout);
    assert.equal(allParsed.aie.length, 1);
    assert.ok(allParsed.aie[0].args.includes("--tool"));
    assert.ok(allParsed.aie[0].args.includes("all"));

    const partialRoot = mkdtempSync(path.join(tmpdir(), "qube-init-partial-hosts-"));
    const partialCwd = mkdtempSync(path.join(tmpdir(), "qube-init-partial-cwd-"));
    createJsonEnvelopeShim(partialRoot, "aie", { ok: true, command: "init", actions: [] });
    createJsonEnvelopeShim(partialRoot, "aiu", { ok: true, command: "init" });
    const partialResult = runCli(["init", ".", "--host", "opencode,claude-code", "--yes", "--json"], { cwd: partialCwd, env: initEnv(partialRoot) });
    assert.equal(partialResult.status, 0, partialResult.stderr);
    const partialParsed = JSON.parse(partialResult.stdout);
    assert.equal(partialParsed.aie.length, 1);
    assert.equal(partialParsed.aie[0].args[partialParsed.aie[0].args.indexOf("--tool") + 1], "opencode,claude-code");
    assert.equal(partialParsed.aiu.length, 2);
    const aiuTools = partialParsed.aiu.map(run => run.args[run.args.indexOf("--tool") + 1]).sort();
    assert.deepEqual(aiuTools, ["claude-code", "opencode"]);
  });

  it("treats Grok Build as its own init tool instead of Codex", () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-init-grok-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-init-grok-cwd-"));
    createJsonEnvelopeShim(packageRoot, "aie", { ok: true, command: "init", dryRun: true, selectedTools: ["grok-build"], actions: [] });
    createJsonEnvelopeShim(packageRoot, "aiu", { ok: true, command: "init", init: { ok: true, tools: ["grok-build"] } });
    const result = runCli(["init", ".", "--host", "grok-build", "--yes", "--dry-run", "--json"], { cwd, env: initEnv(packageRoot) });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.selections.hosts, ["grok-build"]);
    assert.equal(parsed.aie.length, 1);
    assert.deepEqual(parsed.aie[0].args, ["init", ".", "--json", "--tool", "grok-build", "--dry-run", "--yes"]);
    assert.equal(parsed.aiu.length, 1);
    assert.deepEqual(parsed.aiu[0].args, ["init", "--json", "--tool", "grok-build", "--dry-run"]);
    assert.equal(parsed.aie[0].args.includes("codex"), false);
    assert.equal(parsed.aiu[0].args.includes("codex"), false);
  });

  it("keeps classic all-host init separate from an explicit Grok Build selection", () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-init-classic-all-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-init-classic-all-cwd-"));
    createJsonEnvelopeShim(packageRoot, "aie", { ok: true, command: "init", actions: [] });
    createJsonEnvelopeShim(packageRoot, "aiu", { ok: true, command: "init" });
    const classic = runCli(["init", ".", "--host", "opencode,codex,claude-code", "--yes", "--dry-run", "--json"], { cwd, env: initEnv(packageRoot) });
    assert.equal(classic.status, 0, classic.stderr);
    const classicParsed = JSON.parse(classic.stdout);
    assert.equal(classicParsed.aie.length, 1);
    assert.equal(classicParsed.aie[0].args[classicParsed.aie[0].args.indexOf("--tool") + 1], "all");
    assert.equal(classicParsed.aiu.length, 1);
    assert.equal(classicParsed.aiu[0].args[classicParsed.aiu[0].args.indexOf("--tool") + 1], "all");

    const combined = runCli(["init", ".", "--host", "opencode,codex,claude-code,grok-build", "--yes", "--dry-run", "--json"], { cwd, env: initEnv(packageRoot) });
    assert.equal(combined.status, 0, combined.stderr);
    const combinedParsed = JSON.parse(combined.stdout);
    assert.equal(combinedParsed.aie.length, 1);
    assert.equal(combinedParsed.aie[0].args[combinedParsed.aie[0].args.indexOf("--tool") + 1], "all,grok-build");
    const combinedAiuTools = combinedParsed.aiu.map(run => run.args[run.args.indexOf("--tool") + 1]).sort();
    assert.deepEqual(combinedAiuTools, ["all", "grok-build"]);
  });

  it("applies Umpire host inits one after another so combined hosts stay in config", () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-init-aiu-seq-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-init-aiu-seq-cwd-"));
    createJsonEnvelopeShim(packageRoot, "aie", { ok: true, command: "init", actions: [] });
    createAiuMergingShim(packageRoot);
    const result = runCli(["init", ".", "--host", "grok-build,codex", "--yes", "--json"], { cwd, env: initEnv(packageRoot) });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.aiu.length, 2);
    const configPath = path.join(cwd, ".qube", "aiu", "config.json");
    assert.equal(existsSync(configPath), true);
    const enabled = JSON.parse(readFileSync(configPath, "utf8")).hosts.enabled.sort();
    assert.deepEqual(enabled, ["codex", "grok-build"]);
  });

  it("keeps one Executor init for Grok Build plus Codex and fans Umpire per host", () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-init-grok-codex-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-init-grok-codex-cwd-"));
    createJsonEnvelopeShim(packageRoot, "aie", { ok: true, command: "init", actions: [] });
    createJsonEnvelopeShim(packageRoot, "aiu", { ok: true, command: "init" });
    const result = runCli(["init", ".", "--host", "grok-build,codex", "--yes", "--json"], { cwd, env: initEnv(packageRoot) });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.aie.length, 1);
    assert.equal(parsed.aie[0].args[parsed.aie[0].args.indexOf("--tool") + 1], "codex,grok-build");
    assert.equal(parsed.aiu.length, 2);
    const aiuTools = parsed.aiu.map(run => run.args[run.args.indexOf("--tool") + 1]).sort();
    assert.deepEqual(aiuTools, ["codex", "grok-build"]);
  });

  it("also initializes aib when selected through --with", () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-init-with-aib-"));
    createJsonEnvelopeShim(packageRoot, "aie", { ok: true, command: "init", actions: [] });
    createJsonEnvelopeShim(packageRoot, "aiu", { ok: true, command: "init" });
    createJsonEnvelopeShim(packageRoot, "aib", { ok: true, command: "init", files: [] });

    const cwd = mkdtempSync(path.join(tmpdir(), "qube-init-with-aib-cwd-"));
    const result = runCli(["init", ".", "--host", "generic", "--with", "aib", "--yes", "--json"], { cwd, env: initEnv(packageRoot) });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(parsed.selections.withComponents, ["aib"]);
    assert.equal(parsed.with.length, 1);
    assert.equal(parsed.with[0].component, "aib");
    assert.ok(parsed.with[0].ok);
  });

  it("rejects an unsupported --host token with a loud, non-silent error", () => {
    const result = runCli(["init", ".", "--host", "bogus-host", "--yes", "--json"]);
    assert.notEqual(result.status, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error.likelyCause, /Unsupported choice "bogus-host"/);
  });

  it("rejects an unsupported --with token instead of silently ignoring it", () => {
    const result = runCli(["init", ".", "--with", "not-a-component", "--yes", "--json"]);
    assert.notEqual(result.status, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error.likelyCause, /Unsupported choice "not-a-component"/);
  });

  it("never reports success when a required init component is unavailable", () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-init-missing-aiu-"));
    createJsonEnvelopeShim(packageRoot, "aie", { ok: true, command: "init", actions: [] });
    // aiu is intentionally not shimmed, so it cannot be resolved.

    const result = runCli(["init", ".", "--host", "claude-code", "--yes", "--json"], { env: initEnv(packageRoot) });
    assert.notEqual(result.status, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.aie[0].ok, true);
    assert.equal(parsed.aiu[0].ok, false);
    assert.match(parsed.aiu[0].error, /cannot find aiu/i);
  });

  it("never coerces a child ok:false envelope into an overall success", () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-init-failing-aie-"));
    createJsonEnvelopeShim(packageRoot, "aie", { ok: false, command: "init", error: { kind: "conflict", likelyCause: "managed section drift" } });
    createJsonEnvelopeShim(packageRoot, "aiu", { ok: true, command: "init" });

    const result = runCli(["init", ".", "--host", "claude-code", "--yes", "--json"], { env: initEnv(packageRoot) });
    assert.notEqual(result.status, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.aie[0].ok, false);
  });

  it("blocks JSON init prompts unless flags or safe defaults are supplied", () => {
    const result = runCli(["init", ".", "--json"]);
    assert.equal(result.status, 2);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.command, "init");
    assert.equal(parsed.error.kind, "prompt-blocked");
  });
});

describe("host toolkit manifests", () => {
  function writeRequiredAssets(cwd, host) {
    if (host === "claude-code") {
      writeFileSync(path.join(cwd, "CLAUDE.md"), "instructions\n");
      mkdirSync(path.join(cwd, ".claude", "commands"), { recursive: true });
      mkdirSync(path.join(cwd, ".claude", "skills", "make-it-so"), { recursive: true });
      writeFileSync(path.join(cwd, ".claude", "commands", "make-it-so.md"), "make it so\n");
      writeFileSync(path.join(cwd, ".claude", "skills", "make-it-so", "SKILL.md"), "make it so\n");
      writeFileSync(path.join(cwd, ".claude", "settings.json"), "{}\n");
    }
    if (host === "codex") {
      writeFileSync(path.join(cwd, "AGENTS.md"), "instructions\n");
      mkdirSync(path.join(cwd, ".codex", "prompts"), { recursive: true });
      mkdirSync(path.join(cwd, ".agents", "plugins"), { recursive: true });
      mkdirSync(path.join(cwd, "plugins", "ai-umpire", ".codex-plugin"), { recursive: true });
      mkdirSync(path.join(cwd, "plugins", "ai-umpire", "hooks"), { recursive: true });
      mkdirSync(path.join(cwd, "plugins", "ai-umpire", "skills", "ai-umpire"), { recursive: true });
      writeFileSync(path.join(cwd, ".codex", "prompts", "make-it-so.md"), "make it so\n");
      writeFileSync(path.join(cwd, ".agents", "plugins", "marketplace.json"), "{}\n");
      writeFileSync(path.join(cwd, "plugins", "ai-umpire", ".codex-plugin", "plugin.json"), "{}\n");
      writeFileSync(path.join(cwd, "plugins", "ai-umpire", "hooks", "hooks.json"), "{}\n");
      writeFileSync(path.join(cwd, "plugins", "ai-umpire", "skills", "ai-umpire", "SKILL.md"), "skill\n");
    }
  }

  it("plans Claude Code instruction, command, skill, and hook assets without Claude-only files on Codex", () => {
    const claude = composeHostToolkitManifests(["claude-code"], {
      workProviders: ["github"],
      ciProviders: ["github"],
      mcpOptIn: false,
    });
    const claudePaths = claude.manifests[0].assets.filter((asset) => asset.required).map((asset) => asset.path);
    assert.deepEqual(claudePaths, [
      "CLAUDE.md",
      ".claude/commands/make-it-so.md",
      ".claude/skills/make-it-so/SKILL.md",
      ".claude/settings.json",
    ]);
    assert.ok(claude.manifests[0].assets.some((asset) => asset.kind === "subagent" && asset.required === false));
    assert.equal(claude.mcp.optIn, false);
    assert.equal(claude.mcp.configured, false);
    assert.match(claude.mcp.caveat, /bypass QUBE policy/);

    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-toolkit-claude-pkg-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-toolkit-claude-cwd-"));
    createJsonEnvelopeShim(packageRoot, "aie", { ok: true, command: "init", actions: [] });
    createJsonEnvelopeShim(packageRoot, "aiu", { ok: true, command: "init" });
    const planned = runCli([
      "init", ".", "--host", "claude-code", "--work-provider", "github", "--ci-provider", "github",
      "--yes", "--dry-run", "--json",
    ], { cwd, env: { PATH: "", QUBE_TEST_PACKAGE_ROOT: packageRoot } });
    assert.equal(planned.status, 0, planned.stderr);
    const parsed = JSON.parse(planned.stdout);
    assert.deepEqual(parsed.hosts.selected, ["claude-code"]);
    assert.deepEqual(
      parsed.hosts.manifests[0].assets.filter((asset) => asset.required).map((asset) => asset.path),
      claudePaths,
    );
    assert.equal(parsed.selections.mcp, false);
    assert.equal(existsSync(path.join(cwd, QUBE_INIT_RECORD_PATH)), false);
    for (const mcpPath of PROVIDER_MCP_CONFIG_PATHS) {
      assert.equal(existsSync(path.join(cwd, ...mcpPath.split("/"))), false);
    }

    const codex = composeHostToolkitManifests(["codex"], { workProviders: ["github"], mcpOptIn: false });
    const codexPaths = codex.manifests[0].assets.filter((asset) => asset.required).map((asset) => asset.path);
    assert.deepEqual(codexPaths, [
      "AGENTS.md",
      ".codex/prompts/make-it-so.md",
      ".agents/plugins/marketplace.json",
      "plugins/ai-umpire/.codex-plugin/plugin.json",
      "plugins/ai-umpire/hooks/hooks.json",
      "plugins/ai-umpire/skills/ai-umpire/SKILL.md",
    ]);
    assert.ok(!codexPaths.some((item) => item.includes(".claude")));
  });

  it("does not write provider MCP config without an explicit --mcp opt-in", () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-toolkit-mcp-pkg-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-toolkit-mcp-cwd-"));
    createJsonEnvelopeShim(packageRoot, "aie", { ok: true, command: "init", actions: [] });
    createJsonEnvelopeShim(packageRoot, "aiu", { ok: true, command: "init" });

    const implicit = runCli([
      "init", ".", "--host", "generic", "--work-provider", "github", "--ci-provider", "github",
      "--yes", "--json",
    ], { cwd, env: { PATH: "", QUBE_TEST_PACKAGE_ROOT: packageRoot, QUBE_MCP: "1", MCP: "1" } });
    assert.equal(implicit.status, 0, implicit.stderr);
    const implicitParsed = JSON.parse(implicit.stdout);
    assert.equal(implicitParsed.selections.mcp, false);
    assert.equal(implicitParsed.hosts.mcp.optIn, false);
    assert.equal(implicitParsed.hosts.mcp.configured, false);
    assert.equal(existsSync(path.join(cwd, QUBE_INIT_RECORD_PATH)), true);
    for (const mcpPath of PROVIDER_MCP_CONFIG_PATHS) {
      assert.equal(existsSync(path.join(cwd, ...mcpPath.split("/"))), false);
    }

    const opted = runCli([
      "init", ".", "--host", "generic", "--work-provider", "github", "--ci-provider", "github",
      "--yes", "--mcp", "--json",
    ], { cwd, env: { PATH: "", QUBE_TEST_PACKAGE_ROOT: packageRoot } });
    assert.equal(opted.status, 0, opted.stderr);
    const optedParsed = JSON.parse(opted.stdout);
    assert.equal(optedParsed.selections.mcp, true);
    assert.equal(optedParsed.hosts.mcp.optIn, true);
    assert.equal(optedParsed.hosts.mcp.configured, false);
    assert.match(optedParsed.hosts.mcp.caveat, /bypass QUBE policy/);
    assert.equal(optedParsed.hosts.mcp.caveat, MCP_BYPASS_CAVEAT);
    for (const mcpPath of PROVIDER_MCP_CONFIG_PATHS) {
      assert.equal(existsSync(path.join(cwd, ...mcpPath.split("/"))), false);
    }
  });

  it("reports per-host toolkit completeness after init and missing when a required asset is absent", () => {
    const completeRoot = mkdtempSync(path.join(tmpdir(), "qube-toolkit-complete-"));
    writeRequiredAssets(completeRoot, "claude-code");
    writeInitRecord(completeRoot, createInitRecord({
      hosts: ["claude-code"],
      workProviders: ["github"],
      ciProviders: ["github"],
      mcpOptIn: false,
    }));
    const complete = probeHostToolkits({ cwd: completeRoot, env: { PATH: "" }, offline: true });
    assert.equal(complete.status, "complete");
    assert.deepEqual(complete.selected, ["claude-code"]);
    assert.equal(complete.hosts[0].status, "complete");
    assert.equal(complete.hosts[0].missing.length, 0);
    assert.ok(!complete.recommendations.some((item) => /opencode/i.test(item)));

    const missingRoot = mkdtempSync(path.join(tmpdir(), "qube-toolkit-missing-"));
    writeFileSync(path.join(missingRoot, "CLAUDE.md"), "instructions\n");
    writeInitRecord(missingRoot, createInitRecord({
      hosts: ["claude-code"],
      workProviders: ["github"],
      ciProviders: ["github"],
      mcpOptIn: false,
    }));
    const missing = probeHostToolkits({ cwd: missingRoot, env: { PATH: "" }, offline: true });
    assert.equal(missing.status, "missing");
    assert.notEqual(missing.hosts[0].status, "complete");
    assert.ok(missing.hosts[0].missing.includes(".claude/commands/make-it-so.md"));

    const qualityRoot = mkdtempSync(path.join(tmpdir(), "qube-toolkit-doctor-pkg-"));
    createQualityDoctorShim(qualityRoot);
    const doctor = runCli(["doctor", "--offline", "--json"], { cwd: missingRoot, env: { PATH: "", QUBE_TEST_PACKAGE_ROOT: qualityRoot } });
    const parsed = JSON.parse(doctor.stdout);
    assert.equal(parsed.hosts.status, "missing");
    assert.equal(parsed.hosts.hosts[0].status, "missing");
    assert.notEqual(doctor.status, 0);
    assert.equal(parsed.ok, false);
  });

  it("does not report complete for an unknown or empty selected host record", () => {
    const unknownRoot = mkdtempSync(path.join(tmpdir(), "qube-toolkit-unknown-host-"));
    writeInitRecord(unknownRoot, createInitRecord({
      hosts: ["unsupported-host"],
      workProviders: ["github"],
      ciProviders: ["github"],
      mcpOptIn: false,
    }));
    const unknown = probeHostToolkits({ cwd: unknownRoot, env: { PATH: "" }, offline: true });
    assert.equal(unknown.status, "missing");
    assert.equal(unknown.hosts[0].status, "missing");
    assert.match(unknown.hosts[0].reason, /not a supported toolkit host/);

    const emptyRoot = mkdtempSync(path.join(tmpdir(), "qube-toolkit-empty-hosts-"));
    writeInitRecord(emptyRoot, createInitRecord({
      hosts: [],
      workProviders: ["github"],
      ciProviders: ["github"],
      mcpOptIn: false,
    }));
    const empty = probeHostToolkits({ cwd: emptyRoot, env: { PATH: "" }, offline: true });
    assert.equal(empty.status, "missing");
    assert.notEqual(empty.status, "complete");
  });

  it("does not report Codex complete when only the marketplace file is present", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-toolkit-codex-partial-"));
    writeFileSync(path.join(cwd, "AGENTS.md"), "instructions\n");
    mkdirSync(path.join(cwd, ".codex", "prompts"), { recursive: true });
    mkdirSync(path.join(cwd, ".agents", "plugins"), { recursive: true });
    writeFileSync(path.join(cwd, ".codex", "prompts", "make-it-so.md"), "make it so\n");
    writeFileSync(path.join(cwd, ".agents", "plugins", "marketplace.json"), "{}\n");
    writeInitRecord(cwd, createInitRecord({
      hosts: ["codex"],
      workProviders: ["github"],
      ciProviders: ["github"],
      mcpOptIn: false,
    }));
    const probed = probeHostToolkits({ cwd, env: { PATH: "" }, offline: true });
    assert.equal(probed.status, "missing");
    assert.ok(probed.hosts[0].missing.includes("plugins/ai-umpire/hooks/hooks.json"));
  });

  it("fails doctor when a required GitHub CLI dependency is missing", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-toolkit-gh-missing-"));
    writeRequiredAssets(cwd, "claude-code");
    writeInitRecord(cwd, createInitRecord({
      hosts: ["claude-code"],
      workProviders: ["github"],
      ciProviders: ["github"],
      mcpOptIn: false,
    }));
    const probed = probeHostToolkits({ cwd, env: { PATH: "" }, offline: false });
    assert.equal(probed.status, "partial");
    assert.equal(probed.cliDependencies[0].status, "missing");

    const qualityRoot = mkdtempSync(path.join(tmpdir(), "qube-toolkit-gh-doctor-pkg-"));
    createQualityDoctorShim(qualityRoot);
    const doctor = runCli(["doctor", "--json"], { cwd, env: { PATH: "", QUBE_TEST_PACKAGE_ROOT: qualityRoot } });
    const parsed = JSON.parse(doctor.stdout);
    assert.equal(parsed.hosts.status, "partial");
    assert.notEqual(doctor.status, 0);
    assert.equal(parsed.ok, false);
  });

  it("exports host toolkit composition from the package surface", () => {
    assert.equal(typeof composeHostToolkitManifests, "function");
    assert.equal(typeof probeHostToolkits, "function");
    assert.equal(typeof writeInitRecord, "function");
    assert.equal(QUBE_INIT_RECORD_PATH, ".qube/init.json");
  });
});

describe("composer surface envelopes and naming", () => {
  it("emits exactly one JSON object for qube plan status --json with no state", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-plan-status-json-"));
    const result = runCli(["plan", "status", "--json"], { cwd });
    const parsed = JSON.parse(result.stdout);
    assert.equal(typeof parsed, "object");
    assert.notEqual(parsed, null);
    assert.notEqual(result.status, 0);
  });

  it("preserves the planning failure exit code and cause in one JSON envelope", () => {
    // aiu is not resolvable at its pinned version in this workspace, so planning fails with the component-missing contract.
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-continue-json-"));
    const result = runCli(["continue", "--json"], { cwd });
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(result.status, 4);
    assert.match(JSON.stringify(parsed), /Cannot find aiu/);
  });

  it("rejects non-object child JSON with one synthesized error envelope", () => {
    const packageShimRoot = mkdtempSync(path.join(tmpdir(), "qube-array-envelope-packages-"));
    const binDir = path.join(packageShimRoot, "node_modules", ".bin");
    const packageDir = path.join(packageShimRoot, "node_modules", "@tjalve", "aiu");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(packageDir, { recursive: true });
    const commandPath = path.join(binDir, process.platform === "win32" ? "aiu.cmd" : "aiu");
    writeFileSync(commandPath, process.platform === "win32"
      ? "@echo off\r\necho []\r\n"
      : "#!/bin/sh\nprintf '[]\\n'\n", "utf8");
    if (process.platform !== "win32") chmodSync(commandPath, 0o755);
    writeFileSync(path.join(packageDir, "package.json"), `${JSON.stringify({ name: "@tjalve/aiu", version: "0.0.5" })}\n`, "utf8");

    const result = runCli(["continue", "--json"], { env: { QUBE_TEST_PACKAGE_ROOT: packageShimRoot } });
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.notEqual(result.status, 0);
    assert.match(JSON.stringify(parsed), /not a single JSON envelope object/);
  });

  it("lists only the canonical continuation command in root help", () => {
    // Dispatch of the hidden synonyms to aiu status stays pinned by the direct-dispatch mapping test above.
    const help = runCli(["--help"], {});
    assert.match(help.stdout, /^\s{2}continue\s{2,}/m);
    assert.doesNotMatch(help.stdout, /^\s{2}status\s{2,}/m);
    assert.doesNotMatch(help.stdout, /^\s{2}continue status\s{2,}/m);
  });

  it("renders composer-facing names in alias and direct command help", () => {
    const packageShimRoot = mkdtempSync(path.join(tmpdir(), "qube-alias-help-packages-"));
    const binDir = path.join(packageShimRoot, "node_modules", ".bin");
    const packageDir = path.join(packageShimRoot, "node_modules", "@tjalve", "aiu");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(packageDir, { recursive: true });
    const helpText = "Usage: aiu status [--json]";
    const commandPath = path.join(binDir, process.platform === "win32" ? "aiu.cmd" : "aiu");
    writeFileSync(commandPath, process.platform === "win32"
      ? `@echo off\r\necho ${helpText}\r\n`
      : `#!/bin/sh\nprintf '%s\\n' '${helpText}'\n`, "utf8");
    if (process.platform !== "win32") chmodSync(commandPath, 0o755);
    writeFileSync(path.join(packageDir, "package.json"), `${JSON.stringify({ name: "@tjalve/aiu", version: "0.0.5" })}\n`, "utf8");

    const aliasHelp = runCli(["status", "--help"], { env: { QUBE_TEST_PACKAGE_ROOT: packageShimRoot } });
    assert.match(aliasHelp.stdout, /qube continue/);
    assert.doesNotMatch(aliasHelp.stdout, /aiu status \[--json\]/);
    assert.match(aliasHelp.stdout, /Equivalent paths: `qube aiu status` or `aiu status`\./);
    const directHelp = runCli(["plan", "status", "--help"], {});
    assert.match(directHelp.stdout, /qube plan status/);
    assert.doesNotMatch(directHelp.stdout, /Usage:\s*\r?\n?\s*aib status/);
  });

  it("marks hidden synonyms in the schema", () => {
    const schema = runCli(["schema", "--json"], {});
    const parsed = JSON.parse(schema.stdout);
    const commands = parsed.commands.filter(command => command.kind === "command");
    const statusEntry = commands.find(command => command.name === "status");
    const continueEntry = commands.find(command => command.name === "continue");
    assert.equal(statusEntry.hidden, true);
    assert.equal(statusEntry.aliasOf, "continue");
    assert.equal(continueEntry.hidden, false);
    assert.equal(continueEntry.aliasOf, null);
  });

  it("regenerates the command surface doc from the registry", () => {
    const committed = readFileSync(path.join(path.resolve(packageRoot, "..", ".."), "docs", "qube-command-surfaces.md"), "utf8").replace(/\r\n/g, "\n");
    const rendered = renderCommandSurfacesDoc().replace(/\r\n/g, "\n");
    assert.equal(committed, rendered);
    assert.match(rendered, /## Hidden synonyms/);
    assert.match(rendered, /`qube status` \| `qube continue`/);
    assert.match(rendered, /`qube plan status` \| `aib status`/);
  });
});
