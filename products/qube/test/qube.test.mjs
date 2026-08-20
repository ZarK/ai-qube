import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { getAgentHostProfile } from "@tjalve/aie";
import { AGENT_HOST_IDS, runConnectionProbe as runCoreConnectionProbe } from "@tjalve/qube-core";

import {
  findQubeComponent,
  probeInstallState,
  adapterPackageVersions as runtimeAdapterPackageVersions,
  createPackumentFetch,
  createPassingPackument,
  requiredPublishAgeDays,
  verifyInstallRegistryGate,
  verifyInstallRegistryPackages,
  planQubeCli,
  applyUmpireHostProbes,
  probeHostToolkits,
  composeHostToolkitManifests,
  formatPlannedHostToolkits,
  createInitRecord,
  writeInitRecord,
  MCP_BYPASS_CAVEAT,
  PROVIDER_MCP_CONFIG_PATHS,
  QUBE_INIT_RECORD_PATH,
  qubeComponents,
  renderCommandSurfacesDoc,
  runConnectionDoctor,
  runModelRoutingDoctor,
  resolveCommand,
  resolveComponentCommand,
} from "../dist/index.js";
import { detectInstalledRoutingHostsOnPath } from "../dist/model_routing_local.js";
import {
  adapterPackageVersions,
  componentFixtures,
  aibVersion,
  aieVersion,
  dependencyVersion,
  qubePackageName,
  qubePackageVersion,
  qubeNpmGlobalInstallPattern,
  qubePnpmAddCommandWith,
  qubePnpmAddPattern,
} from "./workspace-versions.mjs";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const binPath = fileURLToPath(new URL("../dist/bin/qube.js", import.meta.url));

function runCli(args, options = {}) {
  const env = { ...process.env, ...options.env };
  if (process.platform === "win32" && Object.hasOwn(options.env ?? {}, "PATH") && !Object.hasOwn(options.env ?? {}, "Path")) {
    env.Path = options.env.PATH;
  }
  return spawnSync(process.execPath, [binPath, ...args], {
    cwd: options.cwd ?? packageRoot,
    encoding: "utf8",
    env
  });
}

function assertSameCommandPath(actual, expected) {
  assert.ok(actual, "expected a resolved command path");
  if (process.platform === "win32") {
    assert.equal(path.normalize(actual).toLowerCase(), path.normalize(expected).toLowerCase());
    return;
  }
  assert.equal(actual, expected);
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

function createExecutableStub(root, name) {
  const binDir = path.join(root, "node_modules", ".bin");
  mkdirSync(binDir, { recursive: true });
  const commandPath = path.join(binDir, process.platform === "win32" ? `${name}.cmd` : name);
  writeFileSync(commandPath, process.platform === "win32" ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n", "utf8");
  if (process.platform !== "win32") chmodSync(commandPath, 0o755);
  return binDir;
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
    "const tools = toolIndex >= 0 ? process.argv[toolIndex + 1].split(\",\") : [];",
    "const configPath = path.join(process.cwd(), \".qube\", \"aiu\", \"config.json\");",
    "mkdirSync(path.dirname(configPath), { recursive: true });",
    "let enabled = [];",
    "if (existsSync(configPath)) {",
    "  enabled = JSON.parse(readFileSync(configPath, \"utf8\")).hosts.enabled;",
    "}",
    "const next = { hosts: { enabled: [...new Set([...enabled, ...tools])] } };",
    "await new Promise((resolve) => setTimeout(resolve, 150));",
    "writeFileSync(configPath, JSON.stringify(next));",
    "process.stdout.write(JSON.stringify({ ok: true, command: \"init\", init: { tools } }) + \"\\n\");",
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
    assert.match(help.stdout, /install\s+Build a guided, supply-chain-safe QUBE install plan and optionally apply it\./);
    assert.match(help.stdout, /autoresearch\s+Run a safety-bounded local autoresearch arena lifecycle\./);
    assert.match(help.stdout, /oneshot\s+Create a bounded local artifact without the normal issue, PR, or review-gate workflow\./);
    assert.match(help.stdout, /make-it-so\s+Map an intent to the safest real QUBE workflow\./);
    assert.match(help.stdout, /idea\s+Start Bootstrap from a concise idea\./);
    assert.match(help.stdout, /spec draft\s+Draft the Bootstrap spec artifact\./);
    assert.match(help.stdout, /work-items render\s+Render work item drafts for a provider\./);
    assert.match(help.stdout, /queue\s+Show the Executor issue queue\./);
    assert.match(help.stdout, /start\s+Start or resume Executor issue work\./);
    assert.match(help.stdout, /review setup github-app\s+Configure the QUBE Reviewer GitHub App/);
    assert.doesNotMatch(help.stdout, /review setup token|separate-user fine-grained token/i);
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
    assert.match(installHelp.stdout, /--apply/);
    assert.match(installHelp.stdout, /Supply chain: sensitive \(dependency, package-manager\)/);
    assert.match(installHelp.stdout, /--host <value>/);
    assert.match(installHelp.stdout, /Default: codex/);
    assert.match(installHelp.stdout, /opencode, codex, claude-code, grok-build, cursor/);
    assert.doesNotMatch(installHelp.stdout, /generic|--force|--migration/);
    assert.match(installHelp.stdout, /--work-provider <value>/);
    assert.match(installHelp.stdout, /Default: github/);
    assert.match(installHelp.stdout, /github, gitlab, linear, jira, local/);
    assert.match(installHelp.stdout, /--ci-provider <value>/);
    assert.match(installHelp.stdout, /github, gitlab, jenkins, local/);

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
    for (const command of ["install", "autoresearch", "oneshot", "make-it-so", "idea", "spec draft", "milestones", "work-items render", "queue", "start", "branch create", "review setup", "review setup github-app", "review doctor", "review gate", "pr gate", "app start", "check", "quality status", "evidence", "continue"]) {
      assert.ok(commandNames.includes(command), `expected ${command} in QUBE schema`);
    }
    assert.equal(commandNames.includes("review setup token"), false);
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
      assert.doesNotMatch(output, /review setup token|separate-user fine-grained token/i);
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

  it("renders concrete GitHub App publisher guidance without writing incomplete config", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-review-setup-"));
    const githubApp = runCli(["review", "setup", "github-app"], { cwd });

    assert.equal(githubApp.status, 0, githubApp.stderr);
    assert.match(githubApp.stdout, /Pull requests: Read and write/);
    assert.match(githubApp.stdout, /Contents: Read and write/);
    assert.match(githubApp.stdout, /private key.*outside repository files/i);
    assert.match(githubApp.stdout, /installation id/i);
    assert.match(githubApp.stdout, /Review compute remains host-run/);
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
      creditWarning: true,
      docs: true,
      host: "codex",
      hosts: ["codex"],
      ciProvider: "github",
      ciProviders: ["github"],
      lifecycleScripts: "disabled",
      packageManager: "pnpm",
      reviewMode: "isolated",
      scope: "local",
      uiAuditEvidenceRoot: "~/.qube/verification",
      workProvider: "github",
      workProviders: ["github"],
      withComponents: []
    });
    assert.equal(parsed.installPlan.dryRun, true);
    assert.deepEqual(parsed.installPlan.connections.map(connection => connection.adapterId), ["github"]);
    assert.equal(parsed.installPlan.connections[0].probe.readOnly, true);
    assert.ok(parsed.installPlan.notes.some(note => note.includes("qube autoresearch --help")));
    assert.deepEqual(parsed.installPlan.commands.map(step => step.command), [
      qubePnpmAddCommandWith(
        "@tjalve/qube-adapter-codex",
        "@tjalve/qube-adapter-github",
      ),
      "qube init . --host codex --work-provider github --ci-provider github --review-mode isolated --ui-audit-evidence-root ~/.qube/verification --credit-warning",
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
        ["opencode", "installed", false, "agent-host-profile"],
        ["codex", "installed", true, "agent-host-profile"],
        ["claude-code", "installed", false, "agent-host-profile"],
        ["grok-build", "installed", false, "agent-host-profile"],
        ["cursor", "installed", false, "agent-host-profile"]
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
        ["gitlab", "optional", false, "adapter-contract"],
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
    const instructionPath = path.join(root, "AGENTS.md");
    const makeItSoPath = path.join(root, ".agents", "skills", "make-it-so", "SKILL.md");
    mkdirSync(path.join(root, ".qube", "aie"), { recursive: true });
    writeFileSync(path.join(root, "package.json"), `${JSON.stringify({
      name: "demo-app",
      version: "1.0.0",
      devDependencies: {
        [qubePackageName]: qubePackageVersion,
        "@tjalve/qube-adapter-github": adapterPackageVersions["@tjalve/qube-adapter-github"],
        "@tjalve/qube-adapter-codex": adapterPackageVersions["@tjalve/qube-adapter-codex"]
      }
    }, null, 2)}\n`);
    if (options.installPackages !== false) {
      writeInstalledPackage(root, qubePackageName, qubePackageVersion);
      writeInstalledPackage(root, "@tjalve/qube-adapter-github", adapterPackageVersions["@tjalve/qube-adapter-github"]);
      writeInstalledPackage(root, "@tjalve/qube-adapter-codex", adapterPackageVersions["@tjalve/qube-adapter-codex"]);
    }
    writeFileSync(path.join(root, ".qube", "aie", "config.json"), `${JSON.stringify({ version: 1, providers: { work: { kind: "github" } } }, null, 2)}\n`);
    if (options.staleManaged) {
      writeManagedSection(instructionPath, "Team rules.", "deadbeef");
      writeManagedSection(makeItSoPath, "Run QUBE Make It So.");
    } else if (options.crlfManaged) {
      const body = "Team rules.";
      const digest = createHash("sha256").update(`${body.replace(/\r\n?/g, "\n").trimEnd()}\n`).digest("hex");
      writeFileSync(instructionPath, [
        "<!-- BEGIN EXECUTOR MANAGED SECTION -->",
        "<!-- executor-managed-version: 1 -->",
        `<!-- executor-managed-checksum: ${digest} -->`,
        body,
        "<!-- END EXECUTOR MANAGED SECTION -->",
        ""
      ].join("\r\n"));
      writeManagedSection(makeItSoPath, "Run QUBE Make It So.");
    } else if (options.managed !== false) {
      writeManagedSection(instructionPath, "Team rules.");
      writeManagedSection(makeItSoPath, "Run QUBE Make It So.");
    }
  }

  function writeNodeShim(binDir, name, source) {
    const scriptPath = path.join(binDir, `${name}.mjs`);
    writeFileSync(scriptPath, source);
    if (process.platform === "win32") {
      writeFileSync(path.join(binDir, `${name}.cmd`), `@echo off\r\nnode "${scriptPath}" %*\r\n`);
    } else {
      writeFileSync(path.join(binDir, name), `#!/usr/bin/env node\n${source}`);
      chmodSync(path.join(binDir, name), 0o755);
    }
  }

  function writePassingRegistryFixture(root, overrides = {}) {
    const packages = {
      [qubePackageName]: createPassingPackument(qubePackageName, qubePackageVersion, overrides[qubePackageName])
    };
    for (const [name, version] of Object.entries(adapterPackageVersions)) {
      packages[name] = createPassingPackument(name, version, overrides[name]);
    }
    const file = path.join(root, "registry.json");
    writeFileSync(file, `${JSON.stringify(packages)}\n`);
    return file;
  }

  function createInstallApplyHarness(root) {
    const cwd = path.join(root, "repo");
    const tools = path.join(root, "tools");
    const packageRootDir = path.join(root, "qube-root");
    const binDir = path.join(packageRootDir, "node_modules", ".bin");
    const pmLog = path.join(root, "pm.log");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(tools, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeNodeShim(tools, "pnpm", `
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const log = process.env.QUBE_TEST_PM_LOG;
if (log) appendFileSync(log, process.argv.slice(2).join(" ") + "\\n");
if (process.argv[2] === "root") {
  process.stdout.write(path.join(process.cwd(), "global-root") + "\\n");
  process.exit(0);
}
const specs = process.argv.slice(2).flatMap((token) => {
  const match = token.match(/^(@[^/]+\\/[^@]+)@(.+)$/) || token.match(/^([^@-]+[^@]*)@(\\d+\\.\\d+\\.\\d+)$/);
  return match ? [{ name: match[1], version: match[2] }] : [];
});
if (specs.length === 0) process.exit(0);
const manifestPath = path.join(process.cwd(), "package.json");
const manifest = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, "utf8"))
  : { name: "blank-app", version: "0.0.0", private: true, devDependencies: {} };
manifest.devDependencies = manifest.devDependencies ?? {};
for (const spec of specs) {
  manifest.devDependencies[spec.name] = spec.version;
  const dir = path.join(process.cwd(), "node_modules", ...spec.name.split("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: spec.name, version: spec.version }, null, 2) + "\\n");
  if (spec.name === "@tjalve/qube" && process.env.QUBE_TEST_SKIP_QUBE_BIN !== "1") {
    const binDir = path.join(process.cwd(), "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });
    const script = "process.stdout.write(JSON.stringify({ ok: true, command: \\"components\\", components: [{ id: \\"executor\\" }] }) + \\"\\\\n\\");";
    writeFileSync(path.join(binDir, "qube.mjs"), script);
    if (process.env.QUBE_TEST_SILENT_QUBE_SHIM === "1") {
      if (process.platform === "win32") {
        writeFileSync(path.join(binDir, "qube.cmd"), "@echo off\\r\\nexit /b 0\\r\\n");
      } else {
        writeFileSync(path.join(binDir, "qube"), "#!/bin/sh\\nexit 0\\n");
        chmodSync(path.join(binDir, "qube"), 0o755);
      }
    } else if (process.platform === "win32") {
      writeFileSync(path.join(binDir, "qube.cmd"), "@echo off\\r\\n\\"" + process.execPath + "\\" \\"%~dp0qube.mjs\\" %*\\r\\n");
    } else {
      writeFileSync(path.join(binDir, "qube"), [
        "#!/bin/sh",
        "exec " + JSON.stringify(process.execPath) + " " + JSON.stringify(path.join(binDir, "qube.mjs")) + " \\"$@\\"",
        ""
      ].join("\\n"));
      chmodSync(path.join(binDir, "qube"), 0o755);
    }
  }
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\\n");
`);
    writeNodeShim(tools, "gh", `process.stdout.write("logged in\\n");`);
    const initConfig = JSON.stringify({
      version: 1,
      providers: {
        work: { kind: "github" },
        review: { kind: "github" },
        repository: { kind: "local-git" },
        ci: { kind: "github" },
        layout: { kind: "local" }
      }
    }, null, 2);
    writeNodeShim(binDir, "aie", `
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2).join(" ");
if (args.includes("init")) {
  const cwd = process.cwd();
  mkdirSync(path.join(cwd, ".qube", "aie"), { recursive: true });
  mkdirSync(path.join(cwd, ".agents", "skills", "make-it-so"), { recursive: true });
  writeFileSync(path.join(cwd, ".qube", "aie", "config.json"), ${JSON.stringify(`${initConfig}\n`)});
  const body = "Team rules.\\n";
  const digest = createHash("sha256").update(body).digest("hex");
  writeFileSync(path.join(cwd, "AGENTS.md"), [
    "<!-- BEGIN EXECUTOR MANAGED SECTION -->",
    "<!-- executor-managed-version: 1 -->",
    "<!-- executor-managed-checksum: " + digest + " -->",
    "Team rules.",
    "<!-- END EXECUTOR MANAGED SECTION -->",
    ""
  ].join("\\n"));
  const makeItSoBody = "Run QUBE Make It So.\\n";
  const makeItSoDigest = createHash("sha256").update(makeItSoBody).digest("hex");
  writeFileSync(path.join(cwd, ".agents", "skills", "make-it-so", "SKILL.md"), [
    "<!-- BEGIN EXECUTOR MANAGED SECTION -->",
    "<!-- executor-managed-version: 1 -->",
    "<!-- executor-managed-checksum: " + makeItSoDigest + " -->",
    "Run QUBE Make It So.",
    "<!-- END EXECUTOR MANAGED SECTION -->",
    ""
  ].join("\\n"));
  process.stdout.write(JSON.stringify({ ok: true, command: "init" }) + "\\n");
  process.exit(0);
}
if (args.includes("labels")) {
  process.stdout.write(JSON.stringify({ ok: true, command: "labels setup" }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  ok: true,
  command: "doctor",
  workflowReadiness: {
    stages: [],
    shipping: { mode: "manual" },
    selectedHosts: []
  }
}) + "\\n");
`);
    writeNodeShim(binDir, "aiu", `
const args = process.argv.slice(2).join(" ");
if (args.includes("init")) {
  process.stdout.write(JSON.stringify({ ok: true, command: "init" }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({ ok: true, doctor: { status: "ok" } }) + "\\n");
`);
    writeNodeShim(binDir, "aiq", `process.stdout.write(JSON.stringify({ ok: true, command: "doctor" }) + "\\n");`);
    writeNodeShim(binDir, "aib", `process.stdout.write(JSON.stringify({ ok: true, command: "init" }) + "\\n");`);
    for (const component of componentFixtures) {
      const dir = path.join(packageRootDir, "node_modules", ...component.name.split("/"));
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ name: component.name, version: component.version }, null, 2)}\n`);
    }
    return {
      cwd,
      pmLog,
      root,
      env: {
        ...process.env,
        PATH: `${tools}${path.delimiter}${process.env.PATH ?? ""}`,
        QUBE_TEST_PACKAGE_ROOT: packageRootDir,
        QUBE_TEST_PM_LOG: pmLog,
        QUBE_TEST_INSTALL_PACKAGES: writePassingRegistryFixture(root)
      }
    };
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
    const result = runCli(["install", "--yes", "--dry-run", "--json", "--host", "codex", "--work-provider", "github"], { cwd: root });
    assert.equal(result.status, 0, result.stderr);
    const workspace = JSON.parse(result.stdout).installPlan.steps.find(step => step.stage === "workspace-init");
    assert.notEqual(workspace.status, "satisfied");
  });

  it("keeps unknown package state missing instead of satisfied", () => {
    const root = mkdtempSync(path.join(tmpdir(), "qube-install-empty-"));
    const state = probeInstallState(root, { scope: "local", packageManager: "pnpm", hosts: ["codex"], workProviders: ["github"], ciProviders: ["github"] });
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
      "--review-mode",
      "isolated",
      "--ui-audit-evidence-root",
      "~/.qube/verification",
      "--credit-warning"
    ]);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /QUBE guided install plan/);
    assert.match(result.stdout, /Scope: global/);
    assert.match(result.stdout, /Agent harnesses: codex/);
    assert.match(result.stdout, qubeNpmGlobalInstallPattern);
    assert.match(result.stdout, /AGENTS\.md agent instructions/);
    assert.match(result.stdout, /\.agents\/skills\/make-it-so\/SKILL\.md Make It So skill/);
    assert.match(result.stdout, /Codex: reads AGENTS\.md; start with \$make-it-so/);
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
    assert.equal(parsed.permutation.status, "ok");
    assert.equal(parsed.permutation.work.kind, "github");
    assert.equal(parsed.permutation.review.kind, "github");
    assert.equal(parsed.permutation.ci.kind, "github");
    assert.ok(parsed.permutation.work.capabilities.some(item => item.id === "listOpenWork"));
    const human = runCli(["doctor", "--offline"], { cwd, env: { PATH: "", QUBE_TEST_PACKAGE_ROOT: qualityRoot } });
    assert.match(human.stdout, /Provider permutation:/);
    assert.match(human.stdout, /- work: github/);
  });

  it("reports per-role capability summaries for curated provider permutations", () => {
    const cases = [
      { work: "github", review: "github", ci: "github" },
      { work: "gitlab", review: "gitlab", ci: "gitlab" },
      { work: "jira", review: "gitlab", ci: "jenkins" },
      { work: "linear", review: "github", ci: "github" },
    ];
    for (const selection of cases) {
      const cwd = mkdtempSync(path.join(tmpdir(), "qube-permutation-doctor-"));
      const qualityRoot = mkdtempSync(path.join(tmpdir(), "qube-permutation-quality-"));
      createQualityDoctorShim(qualityRoot);
      mkdirSync(path.join(cwd, ".qube", "aie"), { recursive: true });
      writeFileSync(path.join(cwd, ".qube", "aie", "config.json"), `${JSON.stringify({
        version: 1,
        providers: {
          work: { kind: selection.work },
          review: { kind: selection.review },
          ci: { kind: selection.ci },
        },
      })}\n`, "utf8");
      const result = runCli(["doctor", "--offline", "--json"], { cwd, env: { PATH: "", QUBE_TEST_PACKAGE_ROOT: qualityRoot } });
      assert.equal(result.status, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.permutation.work.kind, selection.work);
      assert.equal(parsed.permutation.review.kind, selection.review);
      assert.equal(parsed.permutation.ci.kind, selection.ci);
      assert.ok(parsed.permutation.work.capabilities.every(item => item.support === "supported" || item.support === "unsupported" || item.support === "unknown"));
      assert.ok(parsed.permutation.missing.every(item => item.support !== "supported"));
    }
  });

  it("reports modelRouting decisions and substitutions in doctor JSON", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-model-routing-doctor-"));
    const qualityRoot = mkdtempSync(path.join(tmpdir(), "qube-model-routing-quality-"));
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
    const parsed = JSON.parse(result.stdout);
    assert.ok(parsed.modelRouting);
    assert.ok(["ok", "unavailable"].includes(parsed.modelRouting.status));
    assert.equal(parsed.modelRouting.resolution.routes["independent-review"].reviewTier, "review");
    assert.ok(Array.isArray(parsed.modelRouting.resolution.substitutions));

    const unavailable = await runModelRoutingDoctor(cwd, () => false);
    assert.equal(unavailable.status, "unavailable");
    assert.notEqual(unavailable.status, "ok");
    assert.match(unavailable.summary, /No installed modelRouting host/);
    assert.ok(unavailable.resolution.substitutions.length >= 1);

    const cursorReview = await runModelRoutingDoctor(cwd, command => command === "cursor-agent", "linux");
    assert.equal(cursorReview.resolution.routes["independent-review"].host, "cursor");
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
      "--review-mode",
      "external",
      "--ui-audit-evidence-root",
      "~/.qube/verification",
      "--credit-warning"
    ]);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /QUBE guided install plan/);
    assert.match(result.stdout, /Scope: local/);
    assert.match(result.stdout, /Agent harnesses: claude-code/);
    assert.match(result.stdout, qubePnpmAddPattern);
    assert.match(result.stdout, /CLAUDE\.md agent instructions/);
    assert.match(result.stdout, /\.claude\/commands\/make-it-so\.md Make It So command/);
    assert.match(result.stdout, /\.claude\/settings\.json trust review/);
    assert.match(result.stdout, /Claude Code: reads CLAUDE\.md; start with \/make-it-so/);
    assert.match(result.stdout, /Claude Code capabilities: task list supported; subagents supported; native review supported; isolated review unsupported/);
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
      "--yes",
      "--dry-run",
      "--json"
    ]);

    assert.equal(result.status, 0);
    const parsed = JSON.parse(result.stdout);

    assert.equal(parsed.installPlan.selections.host, "grok-build");
    assert.deepEqual(parsed.installPlan.commands.map(step => step.command), [
      qubePnpmAddCommandWith("@tjalve/qube-adapter-github", "@tjalve/qube-adapter-grok-build"),
      "qube init . --host grok-build --work-provider github --ci-provider github --review-mode isolated --ui-audit-evidence-root ~/.qube/verification --credit-warning",
      "qube aie labels setup",
      "qube doctor"
    ]);
    assert.ok(parsed.installPlan.files.includes("AGENTS.md agent instructions"));
    assert.ok(parsed.installPlan.files.includes(".grok/commands/make-it-so.md Make It So command"));
    assert.ok(parsed.installPlan.files.includes(".grok/hooks/ai-umpire.json trust review"));
    assert.match(parsed.installPlan.notes.join("\n"), /Grok Build: reads AGENTS\.md; start with \/make-it-so/);
    assert.match(parsed.installPlan.notes.join("\n"), /Grok Build capabilities: task list unsupported; subagents supported; native review supported; isolated review supported/);
    assert.doesNotMatch(parsed.installPlan.commands.map(step => step.command).join("\n"), /x\.ai\/cli\/install\.sh|curl -fsSL/);
  });

  it("prints the install question list in JSON without --yes", () => {
    const result = runCli(["install", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.command, "install");
    assert.equal(parsed.awaitingAnswers, true);
    const ids = parsed.questions.map(item => item.id);
    assert.ok(ids.includes("host"));
    assert.ok(ids.includes("work-provider"));
    assert.ok(ids.includes("review-mode"));
    assert.ok(ids.includes("ui-audit-evidence"));
    assert.ok(ids.includes("attribution-hygiene"));
    const unanswered = new Set(parsed.unansweredQuestionIds);
    assert.ok(unanswered.has("host"));
    assert.ok(unanswered.has("work-provider"));
    assert.ok(unanswered.has("review-mode"));
    for (const id of ["scope", "package-manager", "lifecycle-scripts"]) {
      const item = parsed.questions.find(question => question.id === id);
      assert.equal(item.answered, true, id);
      assert.ok(item.reason);
      assert.ok(!unanswered.has(id));
    }
    const isolated = parsed.questions.find(item => item.id === "review-mode").options.find(option => option.value === "isolated");
    assert.equal(isolated.available, false);
    const workOptions = parsed.questions.find(item => item.id === "work-provider").options.map(option => option.value);
    assert.ok(workOptions.includes("local"));
    assert.deepEqual(workOptions, ["github", "gitlab", "linear", "jira", "local"]);
  });

  it("keeps answered host and work-provider flags answered on the next invocation", () => {
    const result = runCli(["install", "--json", "--host", "grok-build", "--work-provider", "github"]);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    const host = parsed.questions.find(item => item.id === "host");
    const work = parsed.questions.find(item => item.id === "work-provider");
    const review = parsed.questions.find(item => item.id === "review-mode");
    assert.equal(host.answered, true);
    assert.deepEqual(host.value, ["grok-build"]);
    assert.equal(work.answered, true);
    assert.ok(!parsed.unansweredQuestionIds.includes("host"));
    assert.ok(!parsed.unansweredQuestionIds.includes("work-provider"));
    assert.equal(review.options.find(option => option.value === "isolated").available, true);
  });

  it("does not let default-answered questions block --yes", () => {
    const result = runCli(["install", "--yes", "--dry-run", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.ok(parsed.installPlan);
    assert.equal(parsed.error, undefined);
  });

  it("accepts unanswered question answers as flags on the next install invocation", () => {
    const result = runCli([
      "install",
      "--json",
      "--host",
      "grok-build",
      "--work-provider",
      "github",
      "--review-mode",
      "isolated",
      "--ui-audit-evidence-root",
      "~/.qube/verification",
      "--credit-warning"
    ]);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.awaitingAnswers, undefined);
    assert.ok(parsed.installPlan);
    assert.equal(parsed.installPlan.selections.reviewMode, "isolated");
    assert.equal(parsed.installPlan.selections.uiAuditEvidenceRoot, "~/.qube/verification");
    assert.equal(parsed.installPlan.selections.creditWarning, true);
    const workspace = parsed.installPlan.commands.find(step => step.stage === "workspace-init")
      ?? parsed.installPlan.steps.find(step => step.stage === "workspace-init");
    assert.match(workspace.command, /--review-mode isolated/);
    assert.match(workspace.command, /--ui-audit-evidence-root ~\/\.qube\/verification/);
    assert.match(workspace.command, /--credit-warning/);
    assert.doesNotMatch(workspace.command, /--docs/);
  });

  it("keeps already-answered values answered when only some unanswered flags return", () => {
    const result = runCli([
      "install",
      "--json",
      "--host",
      "grok-build",
      "--work-provider",
      "github",
      "--review-mode",
      "isolated"
    ]);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.awaitingAnswers, true);
    const unanswered = new Set(parsed.unansweredQuestionIds);
    assert.ok(!unanswered.has("host"));
    assert.ok(!unanswered.has("work-provider"));
    assert.ok(!unanswered.has("review-mode"));
    assert.ok(unanswered.has("ui-audit-evidence"));
    assert.ok(unanswered.has("attribution-hygiene"));
    const review = parsed.questions.find(item => item.id === "review-mode");
    assert.equal(review.answered, true);
    assert.equal(review.value, "isolated");
  });

  it("rejects isolated review when the selected agent harness cannot run it", () => {
    const result = runCli([
      "install",
      "--json",
      "--host",
      "claude-code",
      "--review-mode",
      "isolated"
    ]);
    assert.equal(result.status, 2, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error.likelyCause, /Isolated review is not available/);
  });

  it("rejects parent-directory evidence roots and the custom token", () => {
    const parent = runCli([
      "install",
      "--json",
      "--ui-audit-evidence-root",
      "~/custom/../outside"
    ]);
    assert.equal(parent.status, 2, parent.stderr);
    assert.match(JSON.parse(parent.stdout).error.likelyCause, /Parent-directory segments are not allowed/);

    const custom = runCli([
      "install",
      "--json",
      "--ui-audit-evidence-root",
      "custom"
    ]);
    assert.equal(custom.status, 2, custom.stderr);
    assert.match(JSON.parse(custom.stdout).error.likelyCause, /explicit directory/);
  });

  it("uses the repository package manager recommendation for --yes", () => {
    const root = mkdtempSync(path.join(tmpdir(), "qube-install-npm-lock-"));
    writeFileSync(path.join(root, "package-lock.json"), "{}\n");
    const result = runCli(["install", "--yes", "--dry-run", "--json"], { cwd: root });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.installPlan.selections.packageManager, "npm");
    assert.equal(parsed.installPlan.selections.reviewMode, "isolated");
    assert.equal(parsed.installPlan.selections.uiAuditEvidenceRoot, "~/.qube/verification");
    assert.equal(parsed.installPlan.selections.creditWarning, true);
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

    const emptyHost = runCli(["install", "--host", "", "--yes", "--json"]);
    assert.equal(emptyHost.status, 2);
    const emptyParsed = JSON.parse(emptyHost.stdout);
    assert.match(emptyParsed.error.likelyCause, /Invalid install option --host=/);
  });

  it("includes every selected adapter at an exact pin in the same package command", () => {
    const result = runCli([
      "install",
      "--yes",
      "--dry-run",
      "--json",
      "--host",
      "opencode",
      "--work-provider",
      "linear",
      "--ci-provider",
      "jenkins"
    ]);
    assert.equal(result.status, 0, result.stderr);
    const command = JSON.parse(result.stdout).installPlan.commands.find(step => step.stage === "package-install").command;
    assert.equal(command, qubePnpmAddCommandWith(
      "@tjalve/qube-adapter-jenkins",
      "@tjalve/qube-adapter-linear",
      "@tjalve/qube-adapter-opencode"
    ));
    assert.match(command, /--ignore-scripts/);
    assert.match(command, /--save-exact/);
  });

  it("installs only the Grok Build adapter for --host grok-build", () => {
    const result = runCli([
      "install",
      "--yes",
      "--dry-run",
      "--json",
      "--host",
      "grok-build",
      "--work-provider",
      "github"
    ]);
    assert.equal(result.status, 0, result.stderr);
    const command = JSON.parse(result.stdout).installPlan.commands.find(step => step.stage === "package-install").command;
    assert.equal(command, qubePnpmAddCommandWith(
      "@tjalve/qube-adapter-github",
      "@tjalve/qube-adapter-grok-build"
    ));
    assert.doesNotMatch(command, /qube-adapter-claude-code|qube-adapter-codex|qube-adapter-opencode/);
  });

  it("installs only the Cursor review adapter for --host cursor", () => {
    const result = runCli([
      "install",
      "--yes",
      "--dry-run",
      "--json",
      "--host",
      "cursor",
      "--work-provider",
      "github"
    ]);
    assert.equal(result.status, 0, result.stderr);
    const command = JSON.parse(result.stdout).installPlan.commands.find(step => step.stage === "package-install").command;
    assert.equal(command, qubePnpmAddCommandWith(
      "@tjalve/qube-adapter-cursor",
      "@tjalve/qube-adapter-github"
    ));
    assert.doesNotMatch(command, /qube-adapter-claude-code|qube-adapter-codex|qube-adapter-grok-build|qube-adapter-opencode/);
  });

  it("keeps --apply --json without --yes in plan mode", () => {
    const root = mkdtempSync(path.join(tmpdir(), "qube-install-apply-json-plan-"));
    const result = runCli([
      "install",
      "--apply",
      "--json",
      "--scope",
      "local",
      "--package-manager",
      "pnpm",
      "--host",
      "codex",
      "--work-provider",
      "github",
      "--ci-provider",
      "github",
      "--lifecycle-scripts",
      "disabled",
      "--docs",
      "--review-mode",
      "external",
      "--ui-audit-evidence-root",
      "~/.qube/verification",
      "--no-credit-warning"
    ], { cwd: root });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.installPlan.mode, "copy-commands");
    assert.equal(parsed.apply, undefined);
    assert.equal(parsed.installPlan.selections.reviewMode, "external");
    assert.equal(parsed.installPlan.selections.creditWarning, false);
    assert.equal(existsSync(path.join(root, "package.json")), false);
  });

  it("keeps --apply --yes --dry-run in plan mode", () => {
    const result = runCli(["install", "--apply", "--yes", "--dry-run", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.installPlan.mode, "copy-commands");
    assert.equal(parsed.installPlan.dryRun, true);
    assert.equal(parsed.apply, undefined);
  });

  it("refuses apply for unsupported local providers", () => {
    const result = runCli([
      "install",
      "--apply",
      "--yes",
      "--json",
      "--scope",
      "local",
      "--package-manager",
      "pnpm",
      "--host",
      "codex",
      "--work-provider",
      "local",
      "--ci-provider",
      "local",
      "--lifecycle-scripts",
      "disabled",
      "--docs",
    ]);
    assert.equal(result.status, 3);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.kind, "unsupported-install-selection");
    assert.match(parsed.error.likelyCause, /work-provider local/);
    assert.match(parsed.error.likelyCause, /ci-provider local/);
  });

  it("blocks human --apply without confirmation", () => {
    const result = runCli([
      "install",
      "--apply",
      "--scope",
      "local",
      "--package-manager",
      "pnpm",
      "--host",
      "codex",
      "--work-provider",
      "github",
      "--ci-provider",
      "github",
      "--lifecycle-scripts",
      "disabled",
      "--docs",
    ], { env: { ...process.env, CI: "true" } });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /prompt-blocked|Prompts are disabled/);
  });

  it("applies a blank repo install, init, and verification end to end", () => {
    const root = mkdtempSync(path.join(tmpdir(), "qube-install-apply-blank-"));
    const harness = createInstallApplyHarness(root);
    const applyArgs = [
      "install",
      "--apply",
      "--yes",
      "--json",
      "--scope",
      "local",
      "--package-manager",
      "pnpm",
      "--host",
      "codex",
      "--work-provider",
      "github",
      "--ci-provider",
      "github",
      "--lifecycle-scripts",
      "disabled",
      "--docs",
    ];
    const first = runCli(applyArgs, { cwd: harness.cwd, env: harness.env });
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
    const parsed = JSON.parse(first.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.installPlan.mode, "apply");
    assert.deepEqual(parsed.apply.executed.map(step => step.stage), ["package-install", "workspace-init"]);
    assert.equal(parsed.apply.executed.every(step => step.status === "executed"), true);
    assert.equal(
      readFileSync(harness.pmLog, "utf8").trim(),
      qubePnpmAddCommandWith(
        "@tjalve/qube-adapter-codex",
        "@tjalve/qube-adapter-github",
      ).replace(/^pnpm /, ""),
    );
    const manifest = JSON.parse(readFileSync(path.join(harness.cwd, "package.json"), "utf8"));
    assert.equal(manifest.devDependencies[qubePackageName], qubePackageVersion);
    assert.equal(manifest.devDependencies["@tjalve/qube-adapter-github"], adapterPackageVersions["@tjalve/qube-adapter-github"]);
    assert.equal(manifest.devDependencies["@tjalve/qube-adapter-codex"], adapterPackageVersions["@tjalve/qube-adapter-codex"]);
    assert.ok(existsSync(path.join(harness.cwd, ".qube", "aie", "config.json")));
    assert.equal(parsed.apply.components.ok, true);
    assert.equal(parsed.apply.components.command, "components");
    assert.ok(Array.isArray(parsed.apply.components.components));
    assert.equal(typeof parsed.apply.doctor, "object");
    assert.ok(parsed.apply.doctor !== null);

    const second = runCli(applyArgs, { cwd: harness.cwd, env: harness.env });
    assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
    const secondParsed = JSON.parse(second.stdout);
    assert.deepEqual(secondParsed.apply.executed, []);
    assert.equal(readFileSync(harness.pmLog, "utf8").trim().split(/\r?\n/).length, 1);
  });

  it("reads apply components from a Node companion after the child process closes", () => {
    const root = mkdtempSync(path.join(tmpdir(), "qube-install-apply-silent-bin-"));
    const harness = createInstallApplyHarness(root);
    const result = runCli([
      "install",
      "--apply",
      "--yes",
      "--json",
      "--scope",
      "local",
      "--package-manager",
      "pnpm",
      "--host",
      "codex",
      "--work-provider",
      "github",
      "--ci-provider",
      "github",
      "--lifecycle-scripts",
      "disabled",
      "--docs",
    ], { cwd: harness.cwd, env: { ...harness.env, QUBE_TEST_SILENT_QUBE_SHIM: "1" } });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.apply.components.ok, true);
    assert.equal(parsed.apply.components.command, "components");
    assert.ok(Array.isArray(parsed.apply.components.components));
  });

  it("reports a loud components error when qube is missing after apply", () => {
    const root = mkdtempSync(path.join(tmpdir(), "qube-install-apply-no-qube-"));
    const harness = createInstallApplyHarness(root);
    const result = runCli([
      "install",
      "--apply",
      "--yes",
      "--json",
      "--scope",
      "local",
      "--package-manager",
      "pnpm",
      "--host",
      "codex",
      "--work-provider",
      "github",
      "--ci-provider",
      "github",
      "--lifecycle-scripts",
      "disabled",
      "--docs",
    ], { cwd: harness.cwd, env: { ...harness.env, QUBE_TEST_SKIP_QUBE_BIN: "1" } });
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.apply.components.error, "Cannot find qube to run components --json after apply.");
  });

  it("downgrades apply to plan when a package is too new", () => {
    const root = mkdtempSync(path.join(tmpdir(), "qube-install-too-new-"));
    const harness = createInstallApplyHarness(root);
    const result = runCli([
      "install",
      "--apply",
      "--yes",
      "--json",
      "--scope",
      "local",
      "--package-manager",
      "pnpm",
      "--host",
      "codex",
      "--work-provider",
      "github",
      "--ci-provider",
      "github",
      "--lifecycle-scripts",
      "disabled",
      "--docs",
    ], { cwd: harness.cwd, env: { ...harness.env, QUBE_TEST_INSTALL_PACKAGES: writePassingRegistryFixture(root, {
      [qubePackageName]: { publishedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() }
    }) } });
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.installPlan.mode, "copy-commands");
    assert.equal(parsed.apply.registry.status, "plan-only");
    assert.match(parsed.apply.registry.reason, /publish-age gate/);
    assert.equal(parsed.apply.executed.find(step => step.stage === "package-install").status, "plan-only");
    assert.equal(parsed.apply.executed.some(step => step.stage === "workspace-init" && step.status === "executed"), true);
    assert.equal(existsSync(harness.pmLog) ? readFileSync(harness.pmLog, "utf8").trim() : "", "");
    assert.ok(existsSync(path.join(harness.cwd, ".qube", "aie", "config.json")));
  });

  it("downgrades apply to plan when registry metadata is unverifiable", () => {
    const root = mkdtempSync(path.join(tmpdir(), "qube-install-offline-reg-"));
    const harness = createInstallApplyHarness(root);
    const result = runCli([
      "install",
      "--apply",
      "--yes",
      "--offline",
      "--json",
      "--scope",
      "local",
      "--package-manager",
      "pnpm",
      "--host",
      "codex",
      "--work-provider",
      "github",
      "--ci-provider",
      "github",
      "--lifecycle-scripts",
      "disabled",
      "--docs",
    ], { cwd: harness.cwd, env: harness.env });
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.apply.registry.status, "plan-only");
    assert.match(parsed.apply.registry.reason, /unverifiable/);
    assert.equal(parsed.apply.executed.find(step => step.stage === "package-install").status, "plan-only");
    assert.equal(existsSync(harness.pmLog) ? readFileSync(harness.pmLog, "utf8").trim() : "", "");
  });

  it("downgrades apply when the resolved manifest has install lifecycle scripts", () => {
    const root = mkdtempSync(path.join(tmpdir(), "qube-install-scripts-"));
    const harness = createInstallApplyHarness(root);
    const result = runCli([
      "install",
      "--apply",
      "--yes",
      "--json",
      "--scope",
      "local",
      "--package-manager",
      "pnpm",
      "--host",
      "codex",
      "--work-provider",
      "github",
      "--ci-provider",
      "github",
      "--lifecycle-scripts",
      "disabled",
      "--docs",
    ], { cwd: harness.cwd, env: { ...harness.env, QUBE_TEST_INSTALL_PACKAGES: writePassingRegistryFixture(root, {
      [qubePackageName]: { scripts: { postinstall: "node ./postinstall.js" } }
    }) } });
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.match(parsed.apply.registry.reason, /lifecycle scripts/);
    assert.equal(parsed.apply.executed.find(step => step.stage === "package-install").status, "plan-only");
  });

  it("uses a 14-day age gate for scoped QUBE packages and 7 days otherwise", () => {
    assert.equal(requiredPublishAgeDays("@tjalve/qube"), 14);
    assert.equal(requiredPublishAgeDays("@tjalve/qube-adapter-github"), 14);
    assert.equal(requiredPublishAgeDays("left-pad"), 7);
  });

  it("rejects a forged provenance subject that does not match the integrity digest", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "qube-registry-forged-prov-"));
    const result = await verifyInstallRegistryGate({
      selections: {
        scope: "local",
        packageManager: "pnpm",
        hosts: ["codex"],
        workProviders: ["github"],
        ciProviders: ["github"]
      },
      env: {
        QUBE_TEST_INSTALL_PACKAGES: writePassingRegistryFixture(root, {
          [qubePackageName]: { subjectDigest: "deadbeef" }
        })
      }
    });
    assert.equal(result.status, "plan-only");
    assert.match(result.reason ?? result.summary, /does not match the registry integrity digest/);
  });

  it("downgrades apply when packument dist-tags do not identify an exact version", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "qube-registry-dist-tag-"));
    const result = await verifyInstallRegistryGate({
      selections: {
        scope: "local",
        packageManager: "pnpm",
        hosts: ["codex"],
        workProviders: ["github"],
        ciProviders: ["github"]
      },
      env: {
        QUBE_TEST_INSTALL_PACKAGES: writePassingRegistryFixture(root, {
          [qubePackageName]: { omitDistTags: true }
        })
      }
    });
    assert.equal(result.status, "plan-only");
    assert.match(result.reason ?? result.summary, /dist-tag/);
  });

  it("downgrades apply when a matching subject has no provenance attestation", async () => {
    const result = await verifyInstallRegistryPackages(
      [`${qubePackageName}@${qubePackageVersion}`],
      {
        now: () => Date.now(),
        fetchImpl: createPackumentFetch({
          [qubePackageName]: createPassingPackument(qubePackageName, qubePackageVersion, {
            subjectDigest: Buffer.from(`${qubePackageName}@${qubePackageVersion}`, "utf8").toString("hex"),
            attestationPredicateType: "https://in-toto.io/Statement/v1"
          })
        })
      }
    );
    assert.equal(result.status, "plan-only");
    assert.match(result.reason ?? result.summary, /provenance/);
  });

  it("fails registry verification when provenance is missing", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "qube-registry-no-prov-"));
    const result = await verifyInstallRegistryGate({
      selections: {
        scope: "local",
        packageManager: "pnpm",
        hosts: ["codex"],
        workProviders: ["github"],
        ciProviders: ["github"]
      },
      env: {
        QUBE_TEST_INSTALL_PACKAGES: writePassingRegistryFixture(root, {
          [qubePackageName]: { omitAttestations: true }
        })
      }
    });
    assert.equal(result.status, "plan-only");
    assert.match(result.reason ?? result.summary, /provenance/);
  });

  it("pins every workspace adapter package in the shipped catalog", () => {
    const adaptersRoot = path.resolve(packageRoot, "..", "..", "adapters");
    const names = readdirSync(adaptersRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
    assert.ok(names.length > 0);
    for (const name of names) {
      const manifestPath = path.join(adaptersRoot, name, "package.json");
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      assert.equal(runtimeAdapterPackageVersions[manifest.name], manifest.version, manifest.name);
      assert.equal(adapterPackageVersions[manifest.name], manifest.version, manifest.name);
    }
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
    assert.equal(executor.capabilities.localReview.manualEvidenceSatisfiesRequiredGate, false);
    assert.ok(executor.capabilities.localReview.provenanceRequired.includes("promptStackHash"));
    assert.ok(executor.capabilities.localReview.provenanceRequired.includes("providerPublishStatus"));
    assert.deepEqual(executor.capabilities.localReview.provenanceAlternatives[0].anyOf, ["taskId", "sessionId", "threadId"]);
    assert.match(executor.capabilities.localReview.evidencePathPattern, /<lane>\.json/);
    assert.match(executor.capabilities.localReview.hostProvenancePathPattern, /\.git\/qube\/aie\/host-provenance/);
    assert.deepEqual(executor.capabilities.hostSurfaces.map(surface => surface.id), [...AGENT_HOST_IDS]);
    assert.equal(executor.capabilities.hostSurfaces.every(surface => surface.support === "installed"), true);
    assert.equal(executor.capabilities.hostSurfaces.every(surface => surface.source === "agent-host-profile"), true);
    assert.ok(executor.capabilities.workProviders.some(provider => provider.id === "github" && provider.support === "installed" && provider.default === true));
    assert.ok(executor.capabilities.workProviders.find(provider => provider.id === "github").capabilities.some(capability => capability.id === "read-merge-blockers" && capability.support === "supported"));
    assert.ok(executor.capabilities.workProviders.find(provider => provider.id === "github").capabilities.some(capability => capability.id === "read-review-threads" && capability.support === "supported"));
    assert.ok(executor.capabilities.workProviders.find(provider => provider.id === "github").capabilities.some(capability => capability.id === "resolve-review-threads" && capability.support === "supported"));
    assert.ok(executor.capabilities.workProviders.find(provider => provider.id === "gitlab").capabilities.some(capability => capability.id === "resolve-review-threads" && capability.support === "supported"));
    assert.ok(executor.capabilities.workProviders.find(provider => provider.id === "gitlab").capabilities.some(capability => capability.id === "sync-issue-status" && capability.support === "unsupported"));
    assert.ok(executor.capabilities.workProviders.some(provider => provider.id === "local" && provider.support === "unsupported"));
    assert.ok(executor.capabilities.ciProviders.some(provider => provider.id === "gitlab" && provider.support === "optional"));
    assert.ok(executor.capabilities.ciProviders.some(provider => provider.id === "jenkins" && provider.support === "optional"));
    assert.match(executor.capabilities.ciProviders.find(provider => provider.id === "jenkins").summary, /without triggering or rerunning jobs/);
    assert.ok(executor.capabilities.ciProviders.find(provider => provider.id === "jenkins").capabilities.some(capability => capability.id === "trigger-ci-run" && capability.support === "unsupported"));
  });

  it("keeps all five agent harnesses consistent across components, help, and install planning", async () => {
    const expectedHarnesses = [
      {
        host: "opencode", instructionPath: "AGENTS.md", makeItSoPath: ".opencode/commands/make-it-so.md", makeItSoKind: "command", invocation: "/make-it-so",
        support: { taskList: "supported", subagents: "supported", localReview: "supported", isolatedReview: "unsupported", umpire: "supported", models: "supported" },
      },
      {
        host: "codex", instructionPath: "AGENTS.md", makeItSoPath: ".agents/skills/make-it-so/SKILL.md", makeItSoKind: "skill", invocation: "$make-it-so",
        support: { taskList: "supported", subagents: "supported", localReview: "supported", isolatedReview: "supported", umpire: "experimental", models: "supported" },
      },
      {
        host: "claude-code", instructionPath: "CLAUDE.md", makeItSoPath: ".claude/commands/make-it-so.md", makeItSoKind: "command", invocation: "/make-it-so",
        support: { taskList: "supported", subagents: "supported", localReview: "supported", isolatedReview: "unsupported", umpire: "experimental", models: "unsupported" },
      },
      {
        host: "grok-build", instructionPath: "AGENTS.md", makeItSoPath: ".grok/commands/make-it-so.md", makeItSoKind: "command", invocation: "/make-it-so",
        support: { taskList: "unsupported", subagents: "supported", localReview: "supported", isolatedReview: "supported", umpire: "experimental", models: "supported" },
      },
      {
        host: "cursor", instructionPath: "AGENTS.md", makeItSoPath: ".cursor/commands/make-it-so.md", makeItSoKind: "command", invocation: "/make-it-so",
        support: { taskList: "unsupported", subagents: "unsupported", localReview: "unsupported", isolatedReview: "supported", umpire: "unsupported", models: "supported" },
      },
    ];
    const componentsResult = runCli(["components", "--json"]);
    const installHelp = runCli(["install", "--help"]);
    assert.equal(componentsResult.status, 0, componentsResult.stderr);
    assert.equal(installHelp.status, 0, installHelp.stderr);

    const executor = JSON.parse(componentsResult.stdout).components.find(component => component.id === "executor");
    const componentRows = new Map(executor.capabilities.hostSurfaces.map(row => [row.id, row]));
    assert.deepEqual([...componentRows.keys()], expectedHarnesses.map(expected => expected.host));
    assert.deepEqual([...AGENT_HOST_IDS], expectedHarnesses.map(expected => expected.host));

    for (const expected of expectedHarnesses) {
      const host = expected.host;
      const profile = await getAgentHostProfile(host);
      const componentRow = componentRows.get(host);
      assert.ok(componentRow, host);
      assert.equal(componentRow.source, "agent-host-profile", host);
      assert.equal(componentRow.default, host === "codex", host);
      assert.ok(installHelp.stdout.includes(host), host);
      assert.equal(profile.instructionTarget.path, expected.instructionPath, host);
      assert.equal(profile.makeItSo.path, expected.makeItSoPath, host);
      assert.equal(profile.makeItSo.kind, expected.makeItSoKind, host);
      assert.equal(profile.makeItSo.invocation, expected.invocation, host);
      assert.deepEqual({
        taskList: profile.taskList.support,
        subagents: profile.subagents.support,
        localReview: profile.review.local.support,
        isolatedReview: profile.review.isolated.support,
        umpire: profile.umpire.continuation.support,
        models: profile.modelDiscovery.support,
      }, expected.support, host);

      const supports = Object.fromEntries(componentRow.capabilities.map(capability => [capability.id, capability.support]));
      assert.deepEqual({
        taskList: supports["task-list"],
        subagents: supports.subagents,
        localReview: supports["local-review"],
        isolatedReview: supports["isolated-review"],
        umpire: supports["umpire-continuation"],
        models: supports["live-models"],
      }, expected.support, host);

      const installResult = runCli([
        "install", "--host", host, "--work-provider", "github", "--ci-provider", "github",
        "--yes", "--dry-run", "--json",
      ]);
      assert.equal(installResult.status, 0, `${host}: ${installResult.stderr}`);
      const plan = JSON.parse(installResult.stdout).installPlan;
      assert.deepEqual(plan.selections.hosts, [host], host);
      const plannedHost = plan.options.hosts.find(option => option.value === host);
      assert.ok(plannedHost, host);
      assert.equal(plannedHost.source, "agent-host-profile", host);
      assert.deepEqual(plannedHost.capabilities, componentRow.capabilities, host);
      assert.ok(plan.files.includes(`${profile.instructionTarget.path} agent instructions`), host);
      assert.deepEqual(
        plan.files.filter(file => file.includes(" Make It So ")),
        [`${profile.makeItSo.path} Make It So ${profile.makeItSo.kind}`],
        host,
      );
      assert.ok(plan.notes.some(note => note.includes(`start with ${profile.makeItSo.invocation}`)), host);
    }
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

  it("does not load component commands from ambient PATH", async () => {
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
    assert.equal(resolveCommand("aib", { cwd, env, packageRoot }), undefined);
    assert.equal(resolveComponentCommand(findQubeComponent("aib"), { cwd, env, packageRoot }), undefined);

    const planned = planQubeCli(["run", "aib", "--", "init", "--dry-run"], { cwd, env, packageRoot });
    assert.equal(planned.exitCode, 4);
    assert.equal(planned.dispatch, undefined);
    assert.match(planned.stderr, /Cannot find aib/);
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
        input: ["continue", "--json"],
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

  it("resolves install-scoped component binaries", async () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-install-root-"));
    const binDir = path.join(packageRoot, "node_modules", ".bin");
    const packageDir = path.join(packageRoot, "node_modules", "@tjalve", "aib");
    const command = process.platform === "win32" ? "aib.cmd" : "aib";
    const installCommandPath = path.join(binDir, command);
    await mkdir(binDir, { recursive: true });
    await mkdir(packageDir, { recursive: true });
    await writeFile(installCommandPath, process.platform === "win32" ? "@echo off\r\necho install-scoped %*\r\n" : "#!/usr/bin/env sh\necho install-scoped \"$@\"\n");
    await writeFile(path.join(packageDir, "package.json"), `${JSON.stringify({ name: "@tjalve/aib", version: aibVersion })}\n`);
    if (process.platform !== "win32") await chmod(installCommandPath, 0o755);

    const component = findQubeComponent("aib");
    assert.ok(component);
    const env = { PATH: process.env.PATH ?? "", OS: process.env.OS };
    const resolution = resolveComponentCommand(component, { cwd: path.resolve("."), env, packageRoot });

    assertSameCommandPath(resolution?.commandPath, installCommandPath);
    assert.equal(resolution?.source, "install");
    assert.equal(resolution?.packageVersion, aibVersion);
    assertSameCommandPath(resolveCommand("aib", { cwd: path.resolve("."), env, packageRoot }), installCommandPath);
  });

  it("resolves workspace component binaries when the QUBE install has none", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-workspace-component-cwd-"));
    const workspaceBin = path.join(cwd, "node_modules", ".bin");
    const workspacePackage = path.join(cwd, "node_modules", "@tjalve", "aie");
    const command = process.platform === "win32" ? "aie.cmd" : "aie";
    const workspaceCommandPath = path.join(workspaceBin, command);
    await mkdir(workspaceBin, { recursive: true });
    await mkdir(workspacePackage, { recursive: true });
    await writeFile(workspaceCommandPath, process.platform === "win32" ? "@echo off\r\necho workspace-aie %*\r\n" : "#!/usr/bin/env sh\necho workspace-aie \"$@\"\n");
    await writeFile(path.join(workspacePackage, "package.json"), `${JSON.stringify({ name: "@tjalve/aie", version: aieVersion })}\n`);
    if (process.platform !== "win32") await chmod(workspaceCommandPath, 0o755);

    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-workspace-component-install-"));
    const env = { PATH: process.env.PATH ?? "", OS: process.env.OS };
    const component = findQubeComponent("aie");
    assert.ok(component);
    const resolution = resolveComponentCommand(component, { cwd, env, packageRoot });

    assertSameCommandPath(resolution?.commandPath, workspaceCommandPath);
    assert.equal(resolution?.source, "workspace");
    assert.equal(resolution?.packageVersion, aieVersion);
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
    return { PATH: "", Path: "", QUBE_TEST_PACKAGE_ROOT: packageRoot, ...extra };
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
    assert.deepEqual(parsed.aie[0].args, ["init", ".", "--json", "--tool", "claude-code", "--work-provider", "github", "--review-provider", "github", "--ci-provider", "github", "--yes"]);
    const splitRoot = mkdtempSync(path.join(tmpdir(), "qube-init-split-"));
    const splitCwd = mkdtempSync(path.join(tmpdir(), "qube-init-split-cwd-"));
    createJsonEnvelopeShim(splitRoot, "aie", { ok: true, command: "init", actions: [] });
    createJsonEnvelopeShim(splitRoot, "aiu", { ok: true, command: "init" });
    const split = runCli(["init", ".", "--host", "codex", "--work-provider", "jira", "--ci-provider", "jenkins", "--yes", "--json"], { cwd: splitCwd, env: initEnv(splitRoot) });
    assert.equal(split.status, 0, split.stderr);
    assert.deepEqual(JSON.parse(split.stdout).aie[0].args, ["init", ".", "--json", "--tool", "codex", "--work-provider", "jira", "--review-provider", "github", "--ci-provider", "jenkins", "--yes"]);
    assert.equal(parsed.aiu.length, 1);
    assert.deepEqual(parsed.aiu[0].args, ["init", "--json", "--tool", "claude-code"]);
    assert.deepEqual(parsed.with, []);
  });

  it("passes each selected harness set to Executor and Umpire in one apply", async () => {
    const profiles = await Promise.all(AGENT_HOST_IDS.map(getAgentHostProfile));
    const umpireHosts = profiles
      .filter(profile => profile.umpire.continuation.support !== "unsupported")
      .map(profile => profile.id);
    const allRoot = mkdtempSync(path.join(tmpdir(), "qube-init-all-hosts-"));
    const allCwd = mkdtempSync(path.join(tmpdir(), "qube-init-all-cwd-"));
    createJsonEnvelopeShim(allRoot, "aie", { ok: true, command: "init", actions: [] });
    createJsonEnvelopeShim(allRoot, "aiu", { ok: true, command: "init" });
    const allResult = runCli(["init", ".", "--host", "opencode,codex,claude-code,grok-build,cursor", "--yes", "--json"], { cwd: allCwd, env: initEnv(allRoot) });
    assert.equal(allResult.status, 0, allResult.stderr);
    const allParsed = JSON.parse(allResult.stdout);
    assert.equal(allParsed.aie.length, 1);
    assert.equal(allParsed.aie[0].args[allParsed.aie[0].args.indexOf("--tool") + 1], "opencode,codex,claude-code,grok-build,cursor");
    assert.equal(allParsed.aiu.length, 1);
    assert.equal(allParsed.aiu[0].args[allParsed.aiu[0].args.indexOf("--tool") + 1], umpireHosts.join(","));

    const partialRoot = mkdtempSync(path.join(tmpdir(), "qube-init-partial-hosts-"));
    const partialCwd = mkdtempSync(path.join(tmpdir(), "qube-init-partial-cwd-"));
    createJsonEnvelopeShim(partialRoot, "aie", { ok: true, command: "init", actions: [] });
    createJsonEnvelopeShim(partialRoot, "aiu", { ok: true, command: "init" });
    const partialResult = runCli(["init", ".", "--host", "opencode,claude-code", "--yes", "--json"], { cwd: partialCwd, env: initEnv(partialRoot) });
    assert.equal(partialResult.status, 0, partialResult.stderr);
    const partialParsed = JSON.parse(partialResult.stdout);
    assert.equal(partialParsed.aie.length, 1);
    assert.equal(partialParsed.aie[0].args[partialParsed.aie[0].args.indexOf("--tool") + 1], "opencode,claude-code");
    assert.equal(partialParsed.aiu.length, 1);
    assert.equal(
      partialParsed.aiu[0].args[partialParsed.aiu[0].args.indexOf("--tool") + 1],
      umpireHosts.filter(host => ["opencode", "claude-code"].includes(host)).join(","),
    );
  });

  it("initializes every harness through the real component CLIs and repeats without content changes", async () => {
    const outer = mkdtempSync(path.join(tmpdir(), "qube-init-real-components-"));
    const target = path.join(outer, "repo");
    const initialized = spawnSync("git", ["init", "--quiet", target], { cwd: outer, encoding: "utf8" });
    assert.equal(initialized.status, 0, initialized.stderr);

    const requestedHosts = ["cursor", "grok-build", "codex", "opencode", "claude-code", "cursor"];
    const expectedHosts = ["cursor", "grok-build", "codex", "opencode", "claude-code"];
    const canonicalHosts = AGENT_HOST_IDS.filter(host => expectedHosts.includes(host));
    const profiles = await Promise.all(canonicalHosts.map(getAgentHostProfile));
    const umpireHosts = profiles
      .filter(profile => profile.umpire.continuation.support !== "unsupported")
      .map(profile => profile.id);
    const args = [
      "init", "repo",
      "--host", requestedHosts.join(","),
      "--work-provider", "github",
      "--ci-provider", "github",
      "--review-mode", "external",
      "--yes",
      "--json",
    ];
    const options = { cwd: outer, env: { QUBE_TEST_PACKAGE_ROOT: packageRoot } };

    const first = runCli(args, options);
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
    const firstResult = JSON.parse(first.stdout);
    assert.equal(firstResult.ok, true);
    assert.deepEqual(firstResult.selections.hosts, expectedHosts);
    assert.equal(firstResult.aie.length, 1);
    assert.equal(firstResult.aiu.length, 1);
    assert.equal(firstResult.aie[0].args[firstResult.aie[0].args.indexOf("--tool") + 1], canonicalHosts.join(","));
    assert.equal(firstResult.aiu[0].args[firstResult.aiu[0].args.indexOf("--tool") + 1], umpireHosts.join(","));
    assert.deepEqual(firstResult.aie[0].json.selectedTools, canonicalHosts);
    assert.deepEqual(firstResult.aiu[0].json.init.tools, umpireHosts);
    assert.equal(path.resolve(firstResult.aie[0].json.repoRoot), path.resolve(target));
    assert.equal(path.resolve(firstResult.aiu[0].json.init.repoRoot), path.resolve(target));

    const initRecordPath = path.join(target, ".qube", "init.json");
    const aiuConfigPath = path.join(target, ".qube", "aiu", "config.json");
    const initRecord = JSON.parse(readFileSync(initRecordPath, "utf8"));
    const aiuConfig = JSON.parse(readFileSync(aiuConfigPath, "utf8"));
    assert.deepEqual(initRecord.hosts, expectedHosts);
    assert.deepEqual(aiuConfig.hosts.enabled, umpireHosts);
    assert.equal(aiuConfig.hosts.enabled.includes("cursor"), false);
    for (const profile of profiles) {
      assert.equal(existsSync(path.join(target, profile.makeItSo.path)), true, profile.id);
    }
    const firstContents = new Map([
      [initRecordPath, readFileSync(initRecordPath, "utf8")],
      [aiuConfigPath, readFileSync(aiuConfigPath, "utf8")],
      ...profiles.map(profile => {
        const file = path.join(target, profile.makeItSo.path);
        return [file, readFileSync(file, "utf8")];
      }),
    ]);

    const second = runCli(args, options);
    assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
    const secondResult = JSON.parse(second.stdout);
    assert.equal(secondResult.ok, true);
    assert.deepEqual(secondResult.selections.hosts, expectedHosts);
    assert.deepEqual(secondResult.aie[0].json.completedChanges, []);
    assert.equal(secondResult.aiu[0].json.init.config.operation, "skip");
    assert.ok(secondResult.aiu[0].json.init.files.every(file => file.operation === "skip"));
    for (const [file, content] of firstContents) {
      assert.equal(readFileSync(file, "utf8"), content, file);
    }
  });

  it("derives routing launch names from the canonical harness profiles", async () => {
    for (const host of AGENT_HOST_IDS) {
      const profile = await getAgentHostProfile(host);
      const candidates = new Set([...profile.executables.names, ...profile.executables.windowsNames]);
      assert.deepEqual(detectInstalledRoutingHostsOnPath(command => candidates.has(command)), [host], host);
    }
  });

  it("skips Umpire init when Cursor is the only selected harness", () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-init-cursor-only-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-init-cursor-only-cwd-"));
    createJsonEnvelopeShim(packageRoot, "aie", { ok: true, command: "init", actions: [] });
    createAiuMergingShim(packageRoot);

    const result = runCli(["init", ".", "--host", "cursor", "--yes", "--json"], { cwd, env: initEnv(packageRoot) });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.selections.hosts, ["cursor"]);
    assert.equal(parsed.aie.length, 1);
    assert.equal(parsed.aie[0].args[parsed.aie[0].args.indexOf("--tool") + 1], "cursor");
    assert.deepEqual(parsed.aiu, []);
    assert.equal(existsSync(path.join(cwd, ".qube", "aiu", "config.json")), false);
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
    assert.deepEqual(parsed.aie[0].args, ["init", ".", "--json", "--tool", "grok-build", "--work-provider", "github", "--review-provider", "github", "--ci-provider", "github", "--dry-run", "--yes"]);
    assert.equal(parsed.aiu.length, 1);
    assert.deepEqual(parsed.aiu[0].args, ["init", "--json", "--tool", "grok-build", "--dry-run"]);
    assert.equal(parsed.aie[0].args.includes("codex"), false);
    assert.equal(parsed.aiu[0].args.includes("codex"), false);
  });

  it("applies the complete Umpire harness set through one child", () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-init-aiu-seq-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-init-aiu-seq-cwd-"));
    createJsonEnvelopeShim(packageRoot, "aie", { ok: true, command: "init", actions: [] });
    createAiuMergingShim(packageRoot);
    const result = runCli(["init", ".", "--host", "grok-build,codex", "--yes", "--json"], { cwd, env: initEnv(packageRoot) });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.aiu.length, 1);
    assert.equal(parsed.aiu[0].args[parsed.aiu[0].args.indexOf("--tool") + 1], "codex,grok-build");
    const configPath = path.join(cwd, ".qube", "aiu", "config.json");
    assert.equal(existsSync(configPath), true);
    const enabled = JSON.parse(readFileSync(configPath, "utf8")).hosts.enabled.sort();
    assert.deepEqual(enabled, ["codex", "grok-build"]);
  });

  it("keeps one Executor and one Umpire init for Grok Build plus Codex", () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-init-grok-codex-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-init-grok-codex-cwd-"));
    createJsonEnvelopeShim(packageRoot, "aie", { ok: true, command: "init", actions: [] });
    createJsonEnvelopeShim(packageRoot, "aiu", { ok: true, command: "init" });
    const result = runCli(["init", ".", "--host", "grok-build,codex", "--yes", "--json"], { cwd, env: initEnv(packageRoot) });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.aie.length, 1);
    assert.equal(parsed.aie[0].args[parsed.aie[0].args.indexOf("--tool") + 1], "codex,grok-build");
    assert.equal(parsed.aiu.length, 1);
    assert.equal(parsed.aiu[0].args[parsed.aiu[0].args.indexOf("--tool") + 1], "codex,grok-build");
  });

  it("also initializes aib when selected through --with", () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-init-with-aib-"));
    createJsonEnvelopeShim(packageRoot, "aie", { ok: true, command: "init", actions: [] });
    createJsonEnvelopeShim(packageRoot, "aiu", { ok: true, command: "init" });
    createJsonEnvelopeShim(packageRoot, "aib", { ok: true, command: "init", files: [] });

    const cwd = mkdtempSync(path.join(tmpdir(), "qube-init-with-aib-cwd-"));
    const result = runCli(["init", ".", "--host", "codex", "--with", "aib", "--yes", "--json"], { cwd, env: initEnv(packageRoot) });
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
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-init-missing-aiu-cwd-"));
    createJsonEnvelopeShim(packageRoot, "aie", { ok: true, command: "init", actions: [] });
    // aiu is intentionally not shimmed, so it cannot be resolved.

    const result = runCli(["init", ".", "--host", "claude-code", "--yes", "--json"], { cwd, env: initEnv(packageRoot) });
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

  it("requires each child to report explicit top-level success", () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-init-implicit-child-success-"));
    createJsonEnvelopeShim(packageRoot, "aie", { command: "init", init: { ok: false } });
    createJsonEnvelopeShim(packageRoot, "aiu", { ok: true, command: "init" });

    const result = runCli(["init", ".", "--host", "claude-code", "--yes", "--json"], { env: initEnv(packageRoot) });
    assert.notEqual(result.status, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.aie[0].ok, false);
  });

  it("accepts Cursor as a primary model-routing host", () => {
    const schema = runCli(["schema", "--json"]);
    assert.equal(schema.status, 0);
    const parsedSchema = JSON.parse(schema.stdout);
    const init = parsedSchema.commands.find(command => command.name === "init");
    const primaryHost = init.flags.find(flag => flag.name === "primary-host");
    assert.match(primaryHost.description, /cursor/i);

    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-cursor-routing-package-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-cursor-routing-init-"));
    createJsonEnvelopeShim(packageRoot, "aie", { ok: true, command: "init", actions: [] });
    const binDir = createExecutableStub(packageRoot, "cursor-agent");
    const result = runCli([
      "init", ".",
      "--host", "cursor",
      "--yes",
      "--json",
      "--primary-host", "cursor",
      "--primary-model", "cursor-model",
    ], { cwd, env: initEnv(packageRoot, { PATH: binDir, Path: binDir }) });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.aie.length, 1);
    const primaryHostIndex = parsed.aie[0].args.indexOf("--primary-host");
    assert.deepEqual(parsed.aie[0].args.slice(primaryHostIndex, primaryHostIndex + 4), [
      "--primary-host", "cursor", "--primary-model", "cursor-model",
    ]);
  });

  it("does not invent a primary model when only a routing host is selected", () => {
    const result = runCli([
      "init", ".",
      "--host", "cursor",
      "--yes",
      "--json",
      "--primary-host", "cursor",
    ]);
    assert.notEqual(result.status, 0);
    const parsed = JSON.parse(result.stdout);
    assert.match(String(parsed.error), /requires --primary-model/i);
  });

  it("does not discover root-level Executor config files", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-current-config-doctor-"));
    writeFileSync(path.join(cwd, "aie.config.json"), `${JSON.stringify({
      version: 1,
      providers: {
        work: { kind: "github" },
        review: { kind: "github" },
        ci: { kind: "github" },
      },
    })}\n`, "utf8");

    const result = await runConnectionDoctor({ cwd });

    assert.equal(result.status, "unverified");
    assert.equal(result.configPath, null);
    assert.deepEqual(result.connections, []);
  });

  it("refuses an uninstalled modelRouting host during init", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-routing-init-"));
    const result = runCli([
      "init", ".",
      "--host", "claude-code",
      "--yes",
      "--json",
      "--primary-host", "opencode",
      "--primary-model", "opencode-model",
    ], { cwd, env: { PATH: "" } });
    assert.notEqual(result.status, 0);
    const parsed = result.stdout.trim() ? JSON.parse(result.stdout) : { error: result.stderr };
    assert.match(String(parsed.error ?? result.stderr), /not installed/i);
  });

  it("blocks JSON init prompts unless flags or safe defaults are supplied", () => {
    const result = runCli(["init", ".", "--json"]);
    assert.equal(result.status, 2);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.command, "init");
    assert.equal(parsed.error.kind, "prompt-blocked");
  });

  it("keeps --defaults JSON init non-interactive and removes answered child question IDs", () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-init-defaults-package-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-init-defaults-cwd-"));
    createJsonEnvelopeShim(packageRoot, "aie", {
      ok: true,
      command: "init",
      awaitingAnswers: false,
      questions: [
        { id: "work-provider", answered: true, value: "github" },
        { id: "review-mode", answered: true, value: "host" },
      ],
      unansweredQuestionIds: ["work-provider", "review-mode"],
      actions: [],
    });
    createJsonEnvelopeShim(packageRoot, "aiu", { ok: true, command: "init" });

    const result = runCli(["init", ".", "--host", "codex", "--defaults", "--json"], { cwd, env: initEnv(packageRoot) });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.error, undefined);
    assert.ok(parsed.aie[0].args.includes("--defaults"));
    assert.deepEqual(parsed.aie[0].json.unansweredQuestionIds, []);
    assert.equal(parsed.aie[0].json.questions.every(question => question.answered === true), true);
  });
});

describe("host toolkit manifests", () => {
  function writeRequiredAssets(cwd, host) {
    if (host === "claude-code") {
      writeFileSync(path.join(cwd, "CLAUDE.md"), "instructions\n");
      mkdirSync(path.join(cwd, ".claude", "commands"), { recursive: true });
      writeFileSync(path.join(cwd, ".claude", "commands", "make-it-so.md"), "make it so\n");
      writeFileSync(path.join(cwd, ".claude", "settings.json"), "{}\n");
    }
    if (host === "grok-build") {
      writeFileSync(path.join(cwd, "AGENTS.md"), "instructions\n");
      mkdirSync(path.join(cwd, ".grok", "commands"), { recursive: true });
      mkdirSync(path.join(cwd, ".grok", "hooks"), { recursive: true });
      writeFileSync(path.join(cwd, ".grok", "commands", "make-it-so.md"), "make it so\n");
      writeFileSync(path.join(cwd, ".grok", "hooks", "ai-umpire.json"), "{}\n");
    }
    if (host === "codex") {
      writeFileSync(path.join(cwd, "AGENTS.md"), "instructions\n");
      mkdirSync(path.join(cwd, ".agents", "skills", "make-it-so"), { recursive: true });
      mkdirSync(path.join(cwd, ".agents", "plugins"), { recursive: true });
      mkdirSync(path.join(cwd, "plugins", "ai-umpire", ".codex-plugin"), { recursive: true });
      mkdirSync(path.join(cwd, "plugins", "ai-umpire", "hooks"), { recursive: true });
      mkdirSync(path.join(cwd, "plugins", "ai-umpire", "skills", "ai-umpire"), { recursive: true });
      writeFileSync(path.join(cwd, ".agents", "skills", "make-it-so", "SKILL.md"), "make it so\n");
      writeFileSync(path.join(cwd, ".agents", "plugins", "marketplace.json"), "{}\n");
      writeFileSync(path.join(cwd, "plugins", "ai-umpire", ".codex-plugin", "plugin.json"), "{}\n");
      writeFileSync(path.join(cwd, "plugins", "ai-umpire", "hooks", "hooks.json"), "{}\n");
      writeFileSync(path.join(cwd, "plugins", "ai-umpire", "skills", "ai-umpire", "SKILL.md"), "skill\n");
    }
  }

  for (const host of AGENT_HOST_IDS) {
    it(`keeps the ${host} toolkit row consistent with its canonical profile`, async () => {
      const profile = await getAgentHostProfile(host);
      const composition = await composeHostToolkitManifests([host]);
      assert.deepEqual(composition.manifests.map((manifest) => manifest.host), [host]);
      const manifest = composition.manifests[0];
      const instructionAssets = manifest.assets.filter((item) => item.kind === "instruction");
      const makeItSoAssets = manifest.assets.filter((item) => item.command === profile.makeItSo.invocation);
      const reviewAssets = manifest.assets.filter((item) => item.kind === "subagent").map((item) => item.path);
      const profileReviewPaths = profile.review.local.agents.map((target) => target.path);

      assert.deepEqual(instructionAssets.map((item) => item.path), [profile.instructionTarget.path], manifest.host);
      assert.equal(makeItSoAssets.length, 1, manifest.host);
      assert.equal(makeItSoAssets[0].kind, profile.makeItSo.kind, manifest.host);
      assert.equal(makeItSoAssets[0].path, profile.makeItSo.path, manifest.host);
      assert.deepEqual(reviewAssets, profileReviewPaths, manifest.host);
      assert.equal(manifest.capabilities.taskList.support, profile.taskList.support, manifest.host);
      assert.deepEqual(manifest.executables, profile.executables, manifest.host);
      assert.deepEqual(manifest.capabilities.taskList.tools, profile.taskList.tools, manifest.host);
      assert.equal(manifest.capabilities.subagents.support, profile.subagents.support, manifest.host);
      assert.equal(manifest.capabilities.review.local.support, profile.review.local.support, manifest.host);
      assert.equal(manifest.capabilities.review.isolated.support, profile.review.isolated.support, manifest.host);
      assert.equal(manifest.capabilities.modelDiscovery.support, profile.modelDiscovery.support, manifest.host);
      assert.equal(manifest.capabilities.umpire.continuation.support, profile.umpire.continuation.support, manifest.host);
      assert.equal(manifest.capabilities.umpire.probe.support, profile.umpire.probe.support, manifest.host);
      assert.equal(manifest.capabilities.umpire.continuation.state, host === "cursor" ? "unavailable" : "unverified", manifest.host);
      assert.equal(manifest.capabilities.umpire.continuation.effectiveDelivery, "none", manifest.host);
      assert.equal(manifest.capabilities.umpire.continuation.currentIssueRecovery, false, manifest.host);
      assert.equal(manifest.capabilities.trust.required, profile.trust.required, manifest.host);
      assert.deepEqual(manifest.capabilities.trust.actions, profile.trust.actions, manifest.host);
      assert.ok(formatPlannedHostToolkits(composition).includes(`Make It So ${profile.makeItSo.invocation}`), manifest.host);
      if (host === "cursor") {
        assert.equal(manifest.capabilities.umpire.continuation.support, "unsupported");
        assert.equal(manifest.capabilities.umpire.continuation.state, "unavailable");
        assert.equal(manifest.capabilities.umpire.continuation.effectiveDelivery, "none");
        assert.equal(manifest.capabilities.umpire.continuation.currentIssueRecovery, false);
        assert.equal(manifest.assets.some((item) => item.source === "aiu"), false);
      }
    });
  }

  it("reports Umpire continuation as active only after a successful host probe", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-toolkit-umpire-probe-"));
    writeInitRecord(cwd, createInitRecord({
      hosts: ["codex"],
      workProviders: ["github"],
      ciProviders: ["github"],
      mcpOptIn: false,
    }));
    const unverified = await probeHostToolkits({ cwd, env: { PATH: "" }, offline: true });
    const beforeProbe = unverified.hosts[0].capabilities.umpire.continuation;
    assert.equal(beforeProbe.state, "unverified");
    assert.equal(beforeProbe.effectiveDelivery, "none");
    assert.equal(beforeProbe.currentIssueRecovery, false);

    const active = applyUmpireHostProbes(unverified, {
      hostProbes: [{
        host: "codex",
        state: "active",
        effectiveDelivery: "stdout",
        currentIssueRecovery: true,
        reason: "The configured Stop hook delivered the continuation probe.",
      }],
    });
    const afterProbe = active.hosts[0].capabilities.umpire.continuation;
    assert.equal(afterProbe.state, "active");
    assert.equal(afterProbe.effectiveDelivery, "stdout");
    assert.equal(afterProbe.currentIssueRecovery, true);
  });

  it("plans Claude Code instruction, command, and hook assets without Claude-only files on Codex", async () => {
    const claude = await composeHostToolkitManifests(["claude-code"], {
      workProviders: ["github"],
      ciProviders: ["github"],
      mcpOptIn: false,
    });
    const claudePaths = claude.manifests[0].assets.filter((asset) => asset.required).map((asset) => asset.path);
    assert.deepEqual(claudePaths, [
      "CLAUDE.md",
      ".claude/commands/make-it-so.md",
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

    const codex = await composeHostToolkitManifests(["codex"], { workProviders: ["github"], mcpOptIn: false });
    const codexPaths = codex.manifests[0].assets.filter((asset) => asset.required).map((asset) => asset.path);
    assert.deepEqual(codexPaths, [
      "AGENTS.md",
      ".agents/skills/make-it-so/SKILL.md",
      ".agents/plugins/marketplace.json",
      "plugins/ai-umpire/.codex-plugin/plugin.json",
      "plugins/ai-umpire/hooks/hooks.json",
      "plugins/ai-umpire/skills/ai-umpire/SKILL.md",
    ]);
    assert.ok(!codexPaths.some((item) => item.includes(".claude")));
  });

  it("plans Grok Build instruction and command assets and reports completeness", async () => {
    const grok = await composeHostToolkitManifests(["grok-build"], { workProviders: ["github"], mcpOptIn: false });
    const grokRequired = grok.manifests[0].assets.filter((asset) => asset.required).map((asset) => asset.path);
    assert.deepEqual(grokRequired, [
      "AGENTS.md",
      ".grok/commands/make-it-so.md",
      ".grok/hooks/ai-umpire.json",
    ]);
    assert.ok(grok.manifests[0].assets.some((asset) => asset.kind === "subagent" && asset.required === false));

    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-toolkit-grok-pkg-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-toolkit-grok-cwd-"));
    createJsonEnvelopeShim(packageRoot, "aie", { ok: true, command: "init", actions: [] });
    createJsonEnvelopeShim(packageRoot, "aiu", { ok: true, command: "init" });
    const planned = runCli([
      "init", ".", "--host", "grok-build", "--yes", "--dry-run", "--json",
    ], { cwd, env: { PATH: "", QUBE_TEST_PACKAGE_ROOT: packageRoot } });
    assert.equal(planned.status, 0, planned.stderr);
    const parsed = JSON.parse(planned.stdout);
    assert.deepEqual(
      parsed.hosts.manifests[0].assets.filter((asset) => asset.required).map((asset) => asset.path),
      grokRequired,
    );
    assert.equal(parsed.selections.mcp, false);
    for (const mcpPath of PROVIDER_MCP_CONFIG_PATHS) {
      assert.equal(existsSync(path.join(cwd, ...mcpPath.split("/"))), false);
    }

    const completeRoot = mkdtempSync(path.join(tmpdir(), "qube-toolkit-grok-complete-"));
    writeRequiredAssets(completeRoot, "grok-build");
    writeInitRecord(completeRoot, createInitRecord({
      hosts: ["grok-build"],
      workProviders: ["github"],
      ciProviders: ["github"],
      mcpOptIn: false,
    }));
    const complete = await probeHostToolkits({ cwd: completeRoot, env: { PATH: "" }, offline: true });
    assert.equal(complete.hosts[0].status, "complete");
    assert.equal(complete.hosts[0].missing.length, 0);

    const missingRoot = mkdtempSync(path.join(tmpdir(), "qube-toolkit-grok-missing-"));
    writeFileSync(path.join(missingRoot, "AGENTS.md"), "instructions\n");
    writeInitRecord(missingRoot, createInitRecord({
      hosts: ["grok-build"],
      workProviders: ["github"],
      ciProviders: ["github"],
      mcpOptIn: false,
    }));
    const missing = await probeHostToolkits({ cwd: missingRoot, env: { PATH: "" }, offline: true });
    assert.equal(missing.hosts[0].status, "missing");
    assert.ok(missing.hosts[0].missing.includes(".grok/commands/make-it-so.md"));
    assert.ok(!existsSync(path.join(completeRoot, ".codex")));
    assert.ok(!existsSync(path.join(completeRoot, ".claude", "commands")));
  });

  it("does not write provider MCP config without an explicit --mcp opt-in", () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-toolkit-mcp-pkg-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-toolkit-mcp-cwd-"));
    createJsonEnvelopeShim(packageRoot, "aie", { ok: true, command: "init", actions: [] });
    createJsonEnvelopeShim(packageRoot, "aiu", { ok: true, command: "init" });

    const implicit = runCli([
      "init", ".", "--host", "opencode", "--work-provider", "github", "--ci-provider", "github",
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
      "init", ".", "--host", "opencode", "--work-provider", "github", "--ci-provider", "github",
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

  it("reports per-host toolkit completeness after init and missing when a required asset is absent", async () => {
    const completeRoot = mkdtempSync(path.join(tmpdir(), "qube-toolkit-complete-"));
    writeRequiredAssets(completeRoot, "claude-code");
    writeInitRecord(completeRoot, createInitRecord({
      hosts: ["claude-code"],
      workProviders: ["github"],
      ciProviders: ["github"],
      mcpOptIn: false,
    }));
    const complete = await probeHostToolkits({ cwd: completeRoot, env: { PATH: "" }, offline: true });
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
    const missing = await probeHostToolkits({ cwd: missingRoot, env: { PATH: "" }, offline: true });
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

  it("does not report complete for an unknown or empty selected host record", async () => {
    const unknownRoot = mkdtempSync(path.join(tmpdir(), "qube-toolkit-unknown-host-"));
    writeInitRecord(unknownRoot, createInitRecord({
      hosts: ["unsupported-host"],
      workProviders: ["github"],
      ciProviders: ["github"],
      mcpOptIn: false,
    }));
    const unknown = await probeHostToolkits({ cwd: unknownRoot, env: { PATH: "" }, offline: true });
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
    const empty = await probeHostToolkits({ cwd: emptyRoot, env: { PATH: "" }, offline: true });
    assert.equal(empty.status, "missing");
    assert.notEqual(empty.status, "complete");
  });

  it("does not report Codex complete when only the marketplace file is present", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-toolkit-codex-partial-"));
    writeFileSync(path.join(cwd, "AGENTS.md"), "instructions\n");
    mkdirSync(path.join(cwd, ".agents", "skills", "make-it-so"), { recursive: true });
    mkdirSync(path.join(cwd, ".agents", "plugins"), { recursive: true });
    writeFileSync(path.join(cwd, ".agents", "skills", "make-it-so", "SKILL.md"), "make it so\n");
    writeFileSync(path.join(cwd, ".agents", "plugins", "marketplace.json"), "{}\n");
    writeInitRecord(cwd, createInitRecord({
      hosts: ["codex"],
      workProviders: ["github"],
      ciProviders: ["github"],
      mcpOptIn: false,
    }));
    const probed = await probeHostToolkits({ cwd, env: { PATH: "" }, offline: true });
    assert.equal(probed.status, "missing");
    assert.ok(probed.hosts[0].missing.includes("plugins/ai-umpire/hooks/hooks.json"));
  });

  it("fails doctor when a required GitHub CLI dependency is missing", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-toolkit-gh-missing-"));
    writeRequiredAssets(cwd, "claude-code");
    writeInitRecord(cwd, createInitRecord({
      hosts: ["claude-code"],
      workProviders: ["github"],
      ciProviders: ["github"],
      mcpOptIn: false,
    }));
    const probed = await probeHostToolkits({ cwd, env: { PATH: "" }, offline: false });
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
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-continue-json-install-"));
    const result = runCli(["continue", "--json"], { cwd, env: { PATH: "", Path: "", QUBE_TEST_PACKAGE_ROOT: packageRoot } });
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
    const help = runCli(["--help"], {});
    assert.match(help.stdout, /^\s{2}continue\s{2,}/m);
    assert.doesNotMatch(help.stdout, /^\s{2}status\s{2,}/m);
    assert.doesNotMatch(help.stdout, /^\s{2}continue status\s{2,}/m);
  });

  it("renders the canonical planning status help", () => {
    const directHelp = runCli(["plan", "status", "--help"], {});
    assert.match(directHelp.stdout, /qube plan status/);
    assert.doesNotMatch(directHelp.stdout, /Usage:\s*\r?\n?\s*aib status/);
  });

  it("does not publish continuation aliases in the schema", () => {
    const schema = runCli(["schema", "--json"], {});
    const parsed = JSON.parse(schema.stdout);
    const commands = parsed.commands.filter(command => command.kind === "command");
    const statusEntry = commands.find(command => command.name === "status");
    const continueEntry = commands.find(command => command.name === "continue");
    assert.equal(statusEntry, undefined);
    assert.equal(continueEntry.hidden, false);
    assert.equal(continueEntry.aliasOf, null);
  });

  it("regenerates the command surface doc from the registry", () => {
    const committed = readFileSync(path.join(path.resolve(packageRoot, "..", ".."), "docs", "qube-command-surfaces.md"), "utf8").replace(/\r\n/g, "\n");
    const rendered = renderCommandSurfacesDoc().replace(/\r\n/g, "\n");
    assert.equal(committed, rendered);
    assert.doesNotMatch(rendered, /## Hidden synonyms/);
    assert.doesNotMatch(rendered, /`qube status`/);
    assert.match(rendered, /`qube plan status` \| `aib status`/);
  });
});
