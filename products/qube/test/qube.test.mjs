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
  readInitRecord,
  repoQubeConfigPath,
  userQubeConfigPath,
  writeInitRecord,
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

function displayedShellArgument(value) {
  return process.platform === "win32" ? `"${value}"` : `'${value}'`;
}

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

function initEnv(packageRoot, extra = {}) {
  const isolatedHome = extra.USERPROFILE ?? mkdtempSync(path.join(tmpdir(), "qube-init-home-"));
  const systemPath = process.env.PATH ?? process.env.Path ?? "";
  return {
    PATH: systemPath,
    Path: systemPath,
    QUBE_TEST_PACKAGE_ROOT: packageRoot,
    USERPROFILE: isolatedHome,
    HOME: isolatedHome,
    ...extra,
  };
}

function writeDoctorHostRecord(cwd, providers) {
  writeFileSync(path.join(cwd, "AGENTS.md"), "instructions\n", "utf8");
  mkdirSync(path.join(cwd, ".cursor", "commands"), { recursive: true });
  writeFileSync(path.join(cwd, ".cursor", "commands", "make-it-so.md"), "make it so\n", "utf8");
  writeInitRecord(cwd, createInitRecord({
    hosts: ["cursor"],
    workProviders: [providers.work],
    ciProviders: [providers.ci],
    mcpOptIn: false,
  }));
}

function createInitComponentShim(root, componentId, options = {}) {
  const binDir = path.join(root, "node_modules", ".bin");
  const packageDir = path.join(root, "node_modules", "@tjalve", componentId);
  const scriptPath = path.join(packageDir, "init-shim.mjs");
  const configPath = path.join(packageDir, "init-shim.json");
  const logPath = path.join(root, "init-calls.ndjson");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify({
    stateful: options.stateful === true,
    plan: options.plan ?? { ok: true, command: componentId === "aiq" ? "config" : "init", actions: [{ operation: "create" }] },
    apply: options.apply ?? { ok: true, command: componentId === "aiq" ? "config" : "init", changed: true },
    labels: options.labels ?? { ok: true, command: "labels setup", changed: true },
    reviewDoctor: options.reviewDoctor ?? { ok: true, command: "review doctor", readiness: "ready" },
    doctor: options.doctor ?? (componentId === "aie"
      ? { ok: true, command: "doctor", workflowReadiness: { stages: [] } }
      : componentId === "aiu"
        ? { ok: true, command: "doctor", doctor: { status: "ok" } }
        : { ok: true, command: "doctor" }),
    exitCodes: options.exitCodes ?? {},
  }), "utf8");
  writeFileSync(scriptPath, [
    "import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from \"node:fs\";",
    "import path from \"node:path\";",
    "const component = " + JSON.stringify(componentId) + ";",
    "const config = JSON.parse(readFileSync(" + JSON.stringify(configPath) + ", \"utf8\"));",
    "const args = process.argv.slice(2);",
    "const phase = args[0] === \"labels\" ? \"labels\" : args[0] === \"review\" && args[1] === \"doctor\" ? \"reviewDoctor\" : args[0] === \"doctor\" ? \"doctor\" : args.includes(\"--dry-run\") ? \"plan\" : \"apply\";",
    "appendFileSync(" + JSON.stringify(logPath) + ", JSON.stringify({ component, phase, args, cwd: process.cwd(), layerContext: process.env.QUBE_INIT_LAYER_CONTEXT ? JSON.parse(process.env.QUBE_INIT_LAYER_CONTEXT) : null }) + \"\\n\");",
    "let payload = { ...config[phase] };",
    "if (config.stateful && phase !== \"plan\" && payload.ok === true) {",
    "  const suffix = phase === \"labels\" ? \"-labels\" : \"\";",
    "  const statePath = path.join(process.cwd(), \".qube\", \"test-init-shim\", component + suffix + \".json\");",
    "  const existed = existsSync(statePath);",
    "  if (!existed) {",
    "    mkdirSync(path.dirname(statePath), { recursive: true });",
    "    writeFileSync(statePath, JSON.stringify({ component, phase }) + \"\\n\", \"utf8\");",
    "  }",
    "  payload = { ...payload, changed: !existed };",
    "}",
    "process.stdout.write(JSON.stringify(payload) + \"\\n\");",
    "process.exitCode = Number(config.exitCodes[phase] ?? (payload.ok === true ? 0 : 1));",
    "",
  ].join("\n"), "utf8");
  const commandPath = path.join(binDir, process.platform === "win32" ? componentId + ".cmd" : componentId);
  writeFileSync(commandPath, process.platform === "win32"
    ? "@echo off\r\n\"" + process.execPath + "\" \"" + scriptPath + "\" %*\r\n"
    : "#!/bin/sh\nexec " + JSON.stringify(process.execPath) + " " + JSON.stringify(scriptPath) + " \"$@\"\n", "utf8");
  if (process.platform !== "win32") chmodSync(commandPath, 0o755);
  writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({
    name: "@tjalve/" + componentId,
    version: findQubeComponent(componentId).packageVersion,
  }) + "\n", "utf8");
}

function createInitShims(root, optionsByComponent = {}) {
  for (const componentId of ["aie", "aib", "aiq", "aiu"]) {
    createInitComponentShim(root, componentId, optionsByComponent[componentId] ?? {});
  }
  for (const [name, version] of Object.entries(adapterPackageVersions)) {
    const packageDir = path.join(root, "node_modules", ...name.split("/"));
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(path.join(packageDir, "package.json"), `${JSON.stringify({ name, version })}\n`, "utf8");
  }
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

function createWorkflowDoctorShim(root, argsLog, exitCode = 0) {
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
    ? `@echo off\r\n${argsLog ? `echo %* > ${JSON.stringify(argsLog)}\r\n` : ""}type \"%~dp0..\\@tjalve\\aie\\doctor.json\"\r\nexit /b ${exitCode}\r\n`
    : `#!/bin/sh\n${argsLog ? `printf '%s\\n' \"$@\" > ${JSON.stringify(argsLog)}\n` : ""}printf '%s\\n' '${doctorPayload}'\nexit ${exitCode}\n`, "utf8");
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

function createExecutableStub(root, name, stdout = "") {
  const binDir = path.join(root, "node_modules", ".bin");
  mkdirSync(binDir, { recursive: true });
  const scriptName = `${name}-stub.js`;
  const scriptPath = path.join(binDir, scriptName);
  writeFileSync(scriptPath, `process.stdout.write(${JSON.stringify(stdout)});\n`, "utf8");
  const commandPath = path.join(binDir, process.platform === "win32" ? `${name}.cmd` : name);
  writeFileSync(commandPath, process.platform === "win32"
    ? `@echo off\r\nrem %dp0%\\${scriptName}\r\n"${process.execPath}" "%~dp0${scriptName}" %*\r\n`
    : `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)} "$@"\n`, "utf8");
  if (process.platform !== "win32") chmodSync(commandPath, 0o755);
  return binDir;
}

function addExecutablePath(environment, binDir) {
  const currentPath = environment.PATH ?? environment.Path ?? "";
  const executablePath = currentPath ? `${binDir}${path.delimiter}${currentPath}` : binDir;
  return { ...environment, PATH: executablePath, Path: executablePath };
}

function gitOnlyEnvironment(packageRoot) {
  const executableNames = process.platform === "win32" ? ["git.exe", "git.cmd", "git.bat", "git"] : ["git"];
  const gitDirectory = (process.env.PATH ?? process.env.Path ?? "")
    .split(path.delimiter)
    .find(directory => directory && executableNames.some(name => existsSync(path.join(directory, name))));
  assert.ok(gitDirectory, "expected Git on the test PATH");
  return initEnv(packageRoot, { PATH: gitDirectory, Path: gitDirectory });
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
    assert.equal(dependencyVersion("@tjalve/qube-adapter-codex"), adapterPackageVersions["@tjalve/qube-adapter-codex"]);
    assert.equal(dependencyVersion("@tjalve/qube-adapter-github"), adapterPackageVersions["@tjalve/qube-adapter-github"]);
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
    assert.doesNotMatch(help.stdout, /^\s*install\s+/mu);
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
    assert.match(help.stdout, /init\s+Initialize user-global QUBE choices without Git, or validate Git prerequisites and prepare one repository through the complete guided setup flow\./);
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
    assert.match(installHelp.stdout, /package-manager installation migration/);
    assert.match(installHelp.stdout, /qube init/);
    assert.doesNotMatch(installHelp.stdout, /--apply|--scope|--host|--work-provider|--ci-provider/);

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
    assert.equal(installCommand?.hidden, true);
    assert.deepEqual(installCommand?.flags.map(flag => flag.name), ["json"]);
    const makeItSoCommand = parsed.commands.find(command => command.name === "make-it-so");
    assert.equal(makeItSoCommand?.dryRun.supported, true);
    const autoresearchCommand = parsed.commands.find(command => command.name === "autoresearch");
    assert.equal(autoresearchCommand?.dryRun.supported, true);
    const oneshotCommand = parsed.commands.find(command => command.name === "oneshot");
    assert.equal(oneshotCommand?.dryRun.supported, true);
    assert.deepEqual(oneshotCommand?.mutation.categories, ["local-files"]);
    const reviewSetupCommand = parsed.commands.find(command => command.name === "review setup github-app");
    assert.equal(reviewSetupCommand?.interactions.ttyPrompt, true);
    assert.deepEqual(
      parsed.sections.components.map(component => component.command),
      ["aib", "aie", "aiq", "aiu"]
    );
    assert.deepEqual(Object.fromEntries(parsed.sections.directCommands.map(command => [command.command, command.component]))["pr gate"], "aie");
  });

  it("routes short reviewer publisher help and JSON doctor output to Executor", () => {
    const shortHelp = runCli(["review", "--help"]);
    const productHelp = runCli(["aie", "review", "--help"]);
    const setupHelp = runCli(["review", "setup", "github-app", "--help"]);
    const invalidScope = runCli(["review", "setup", "github-app", "--config-scope", "machine", "--json"]);
    const globalDryRun = runCli([
      "review", "setup", "github-app", "--config-scope", "global",
      "--app-id", "123", "--installation-id", "456", "--private-key-env", "QUBE_PACKED_TEST_KEY",
      "--dry-run", "--yes", "--no-probe", "--json",
    ]);
    const doctor = runCli(["review", "doctor", "--json", "--no-probe"]);

    assert.equal(shortHelp.status, 0, shortHelp.stderr);
    assert.equal(productHelp.status, 0, productHelp.stderr);
    assert.equal(setupHelp.status, 0, setupHelp.stderr);
    assert.match(setupHelp.stdout, /--config-scope.*repo.*global/s);
    assert.notEqual(invalidScope.status, 0);
    assert.match(invalidScope.stdout || invalidScope.stderr, /config-scope.*repo, global/s);
    assert.equal(globalDryRun.status, 0, globalDryRun.stderr);
    const globalPlan = JSON.parse(globalDryRun.stdout);
    assert.equal(globalPlan.scope, "global");
    assert.equal(globalPlan.dryRun, true);
    assert.equal(globalPlan.applied, false);
    assert.match(globalPlan.configPath, /\.qube[\\/]aie[\\/]review-publisher\.json$/);
    assert.doesNotMatch(globalDryRun.stdout, /BEGIN PRIVATE KEY|github_pat_|ghp_/);
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
    assert.ok(["machine-local", "repository", "user-global", "default"].includes(parsed.publisherSource));
    assert.equal(typeof parsed.publisherFieldSources, "object");
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
    const githubApp = runCli(["review", "setup", "github-app"], { cwd, env: initEnv(packageRoot) });

    assert.equal(githubApp.status, 0, githubApp.stderr);
    assert.match(githubApp.stdout, /Pull requests: Read and write/);
    assert.match(githubApp.stdout, /Contents: Read and write/);
    assert.match(githubApp.stdout, /private key.*outside repository files/i);
    assert.match(githubApp.stdout, /installation id/i);
    assert.match(githubApp.stdout, /Review compute remains host-run/);
    assert.equal(existsSync(path.join(cwd, ".qube", "aie", "config.json")), false);
  });

  it("keeps normal setup guides on package managers plus qube init", () => {
    const workspaceRoot = path.resolve(packageRoot, "../..");
    const guidePaths = [
      "README.md",
      "docs/qube-init.md",
      "docs/qube-host-surfaces.md",
      "docs/qube-codex-host-support.md",
      "docs/qube-command-surfaces.md",
      "products/qube/README.md",
      ...readdirSync(path.join(workspaceRoot, "adapters"), { withFileTypes: true })
        .filter(entry => entry.isDirectory() && existsSync(path.join(workspaceRoot, "adapters", entry.name, "README.md")))
        .map(entry => path.join("adapters", entry.name, "README.md")),
    ];

    for (const relativePath of guidePaths) {
      const content = readFileSync(path.join(workspaceRoot, relativePath), "utf8");
      assert.doesNotMatch(content, /\bqube install\b/u, relativePath);
    }
  });

  it("keeps qube install as a hidden non-mutating migration response", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-install-migration-"));
    writeFileSync(path.join(cwd, "sentinel.txt"), "unchanged\n", "utf8");
    const before = readdirSync(cwd, { recursive: true }).map(String).sort();

    const human = runCli(["install"], { cwd });
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /npm install --global --ignore-scripts @tjalve\/qube@\d+\.\d+\.\d+/u);
    assert.match(human.stdout, /pnpm add --global --ignore-scripts @tjalve\/qube@\d+\.\d+\.\d+/u);
    assert.match(human.stdout, /qube init/u);
    assert.match(human.stdout, /No package, configuration, provider, or repository changes were made\./u);

    const json = runCli(["install", "--json"], { cwd });
    assert.equal(json.status, 0, json.stderr);
    const payload = JSON.parse(json.stdout);
    assert.deepEqual({ command: payload.command, mode: payload.mode, changed: payload.changed }, {
      command: "install",
      mode: "migration",
      changed: false,
    });
    assert.equal(payload.setupCommand, "qube init");
    assert.equal(payload.packageInstallation.commands.length, 2);
    assert.deepEqual(readdirSync(cwd, { recursive: true }).map(String).sort(), before);
    assert.equal(readFileSync(path.join(cwd, "sentinel.txt"), "utf8"), "unchanged\n");

    const legacy = runCli(["install", "--scope", "global", "--json"], { cwd });
    assert.notEqual(legacy.status, 0);
    assert.deepEqual(readdirSync(cwd, { recursive: true }).map(String).sort(), before);
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
    writeDoctorHostRecord(cwd, { work: "github", ci: "github" });
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
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.configuration.status, "valid");
    assert.equal(parsed.configuration.fields.find(field => field.id === "hosts").effective.source, "repository");
    assert.equal(parsed.connectionStatus, "unverified");
    assert.deepEqual(parsed.connections.connections.map(connection => [connection.adapterId, connection.status]), [["github", "unverified"]]);
    assert.equal(parsed.connections.connections[0].readOnly, true);
    assert.equal(parsed.workflow.status, "unavailable");
    assert.equal(parsed.ok, false);
    assert.equal(parsed.permutation.status, "ok");
    assert.equal(parsed.permutation.work.kind, "github");
    assert.equal(parsed.permutation.review.kind, "github");
    assert.equal(parsed.permutation.ci.kind, "github");
    assert.ok(parsed.permutation.work.capabilities.some(item => item.id === "listOpenWork"));
    const human = runCli(["doctor", "--offline"], { cwd, env: { PATH: "", QUBE_TEST_PACKAGE_ROOT: qualityRoot } });
    assert.match(human.stdout, /Effective configuration:/);
    assert.match(human.stdout, /- hosts: cursor \(repository\)/);
    assert.match(human.stdout, /Provider permutation:/);
    assert.match(human.stdout, /- work: github/);
  });

  it("fails doctor on an invalid composer source with scope, path, field, and one recovery action", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-invalid-composer-doctor-"));
    const qualityRoot = mkdtempSync(path.join(tmpdir(), "qube-invalid-composer-quality-"));
    createQualityDoctorShim(qualityRoot);
    mkdirSync(path.join(cwd, ".qube"), { recursive: true });
    writeFileSync(path.join(cwd, ".qube", "init.json"), '{"version":1,"unknownField":true}\n', "utf8");

    const result = runCli(["doctor", "--offline", "--json"], {
      cwd,
      env: { PATH: "", QUBE_TEST_PACKAGE_ROOT: qualityRoot, USERPROFILE: cwd, HOME: cwd },
    });
    assert.notEqual(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.configuration.status, "invalid");
    assert.match(parsed.configuration.error, /repository QUBE config is invalid/u);
    assert.match(parsed.configuration.error, /\.qube[\\/]init\.json/u);
    assert.match(parsed.configuration.error, /unknownField/u);
    assert.equal(parsed.configuration.nextAction, "Correct the invalid source configuration, then rerun `qube doctor`.");
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
      writeDoctorHostRecord(cwd, selection);
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
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.workflow.status, "unavailable");
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

  it("runs Executor local prerequisites in offline doctor mode", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-workflow-offline-"));
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-workflow-offline-packages-"));
    const argsLog = path.join(packageRoot, "aie-args.txt");
    createQualityDoctorShim(packageRoot);
    createWorkflowDoctorShim(packageRoot, argsLog);
    mkdirSync(path.join(cwd, ".qube", "aie"), { recursive: true });
    writeFileSync(path.join(cwd, ".qube", "aie", "config.json"), `${JSON.stringify({ version: 1 })}\n`, "utf8");

    const result = runCli(["doctor", "--offline", "--json"], { cwd, env: { PATH: "", QUBE_TEST_PACKAGE_ROOT: packageRoot } });
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.workflow.status, "ok", result.stderr);
    assert.match(readFileSync(argsLog, "utf8"), /doctor[\s\S]*--offline[\s\S]*--json/u);
  });

  it("preserves valid failed Executor diagnostics and returns a truthful aggregate failure", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-workflow-exit-"));
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-workflow-exit-packages-"));
    createQualityDoctorShim(packageRoot);
    createWorkflowDoctorShim(packageRoot, undefined, 3);
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
    assert.notEqual(result.status, 0);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.workflow.status, "ok", result.stderr);
    assert.equal(parsed.workflow.ok, false);
    assert.equal(parsed.workflow.exitCode, 3);
    assert.equal(parsed.workflow.readiness.stages.length, 3);
    assert.equal(parsed.workflow.readiness.stages[0].stage, "lifecycle");
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
    assert.equal(executor.capabilities.workProviders.some(provider => provider.id === "local"), false);
    assert.ok(executor.capabilities.ciProviders.some(provider => provider.id === "gitlab" && provider.support === "optional"));
    assert.ok(executor.capabilities.ciProviders.some(provider => provider.id === "jenkins" && provider.support === "optional"));
    assert.match(executor.capabilities.ciProviders.find(provider => provider.id === "jenkins").summary, /without triggering or rerunning jobs/);
    assert.ok(executor.capabilities.ciProviders.find(provider => provider.id === "jenkins").capabilities.some(capability => capability.id === "trigger-ci-run" && capability.support === "unsupported"));
    assert.equal(executor.capabilities.ciProviders.some(provider => provider.id === "local"), false);
  });

  it("keeps all five agent harnesses consistent across components and init help", async () => {
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
    const initHelp = runCli(["init", "--help"]);
    assert.equal(componentsResult.status, 0, componentsResult.stderr);
    assert.equal(initHelp.status, 0, initHelp.stderr);

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
      assert.ok(initHelp.stdout.includes(host), host);
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
    const displayedIntent = process.platform === "win32"
      ? '"Ship a local notes CLI"'
      : "'Ship a local notes CLI'";
    assert.equal(parsed.makeItSo.mappedCommand.command, `qube aib init . --idea ${displayedIntent} --json`);
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

describe("qube init orchestrator", () => {
  function readInitCalls(root) {
    const logPath = path.join(root, "init-calls.ndjson");
    if (!existsSync(logPath)) return [];
    return readFileSync(logPath, "utf8").trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  }

  function componentRows(plan) {
    return new Map(plan.components.map(component => [component.id, component]));
  }

  function optionValue(args, name) {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  }

  function writeInitSetup(filePath, setup) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(setup, null, 2)}\n`, "utf8");
  }

  function initializeRepository(root) {
    const initialized = spawnSync("git", ["init", "--quiet", "--initial-branch", "main", root], {
      encoding: "utf8",
    });
    assert.equal(initialized.status, 0, initialized.stderr);
  }

  function completeInitSetup(overrides = {}) {
    return {
      version: 1,
      hosts: ["codex"],
      workProviders: ["github"],
      ciProviders: ["github"],
      continuousShipping: true,
      umpire: { scope: "ready" },
      quality: { stages: ["unit"] },
      review: { mode: "host", harness: "codex", publisher: "user" },
      mcp: { optIn: false },
      ...overrides,
    };
  }

  function externalSelections() {
    return [
      "--host", "cursor",
      "--work-provider", "github",
      "--ci-provider", "github",
      "--review-mode", "external",
      "--external-reviewer", "coderabbit",
      "--review-publisher", "user",
      "--yes",
    ];
  }

  it("fails closed when synchronous planning receives component-spanning init selections", () => {
    const cases = [
      ["--host", "codex,grok-build", "--work-provider", "gitlab", "--ci-provider", "jenkins"],
      ["--quality-stage", "security", "--umpire-scope", "custom"],
      ["--host", "codex,grok-build", "--review-mode", "isolated", "--review-harness", "grok-build", "--review-publisher", "github-app", "--config-scope", "global"],
    ];

    for (const selections of cases) {
      const planned = planQubeCli(["init", ".", ...selections, "--yes", "--dry-run"]);
      assert.equal(planned.exitCode, 2);
      assert.equal(planned.dispatch, undefined);
      assert.equal(planned.stdout, "");
      assert.match(planned.stderr, /synchronous planning API cannot resolve QUBE init across all components/);
    }
  });

  it("does not infer init defaults or accept an ambiguous synchronous target", () => {
    const defaultPlan = planQubeCli(["init", ".", "--yes", "--dry-run"]);
    assert.equal(defaultPlan.exitCode, 2);
    assert.equal(defaultPlan.dispatch, undefined);
    assert.match(defaultPlan.stderr, /Use runQubeCli\(\) or the qube executable/);

    const ambiguousTarget = planQubeCli(["init", "first", "second", "--yes", "--dry-run"]);
    assert.equal(ambiguousTarget.exitCode, 2);
    assert.equal(ambiguousTarget.dispatch, undefined);
    assert.equal(ambiguousTarget.stderr, "QUBE init accepts at most one target directory.\n");
  });

  it("publishes the focused init surface without optional components or free-text routing", () => {
    const schema = runCli(["schema", "--json"]);
    assert.equal(schema.status, 0, schema.stderr);
    const init = JSON.parse(schema.stdout).commands.find(command => command.name === "init");
    const flags = new Set(init.flags.map(flag => flag.name));

    for (const name of ["host", "work-provider", "ci-provider", "continuous-shipping", "umpire-scope", "quality-stage", "review-mode", "review-harness", "review-publisher"]) {
      assert.equal(flags.has(name), true, name);
    }
    for (const name of ["with", "primary-host", "primary-model", "mechanical-host", "mechanical-model", "exploration-host", "exploration-model", "synthesis-host", "synthesis-model"]) {
      assert.equal(flags.has(name), false, name);
    }
  });

  it("enforces the canonical scope syntax before probes or writes", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-init-scope-syntax-"));
    mkdirSync(path.join(cwd, "global"));
    const env = initEnv(mkdtempSync(path.join(tmpdir(), "qube-init-scope-root-")));
    const cases = [
      { args: ["init", ".", "--global", "--json"], error: /does not accept a target/u },
      { args: ["init", "--global", "--git-init", "--json"], error: /applies only to repository initialization/u },
      { args: ["init", "--global", "--config-scope", "repo", "--json"], error: /conflicts with --config-scope repo/u },
    ];
    for (const testCase of cases) {
      const result = runCli(testCase.args, { cwd, env });
      assert.equal(result.status, 2, result.stderr);
      assert.match(JSON.parse(result.stdout).error, testCase.error);
      assert.deepEqual(readdirSync(cwd, { recursive: true }).map(String).sort(), ["global"]);
    }

    createInitShims(env.QUBE_TEST_PACKAGE_ROOT);
    const directoryTarget = runCli([
      "init", "global", ...externalSelections(), "--dry-run", "--json",
    ], { cwd, env });
    assert.equal(directoryTarget.status, 0, directoryTarget.stderr);
    const plan = JSON.parse(directoryTarget.stdout);
    assert.equal(plan.scope, "repository");
    assert.equal(plan.plan.target, path.join(cwd, "global"));
    assert.equal(plan.plan.git.operation, "initialize");
  });

  it("validates repository inheritance actions before probes or writes", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-init-inherit-syntax-"));
    mkdirSync(path.join(cwd, "untouched"));
    const env = initEnv(mkdtempSync(path.join(tmpdir(), "qube-init-inherit-root-")), { PATH: "", Path: "" });
    const cases = [
      { args: ["init", ".", "--inherit", "unknown.field", "--json"], error: /Unknown repository setting/u },
      { args: ["init", ".", "--inherit", "quality.stages", "--quality-stage", "unit", "--json"], error: /conflicts with --quality-stage/u },
      { args: ["init", ".", "--inherit", "hosts", "--inherit-all", "--json"], error: /--inherit-all conflicts with --inherit/u },
      { args: ["init", "--global", "--inherit-all", "--json"], error: /apply only to repository initialization/u },
    ];
    for (const testCase of cases) {
      const result = runCli(testCase.args, { cwd, env });
      assert.equal(result.status, 2, result.stderr);
      assert.match(JSON.parse(result.stdout).error, testCase.error);
      assert.deepEqual(readdirSync(cwd, { recursive: true }).map(String).sort(), ["untouched"]);
    }
  });

  it("plans and applies per-field inheritance without writing unrelated repository content", () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-init-inherit-field-root-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-init-inherit-field-cwd-"));
    const env = initEnv(packageRoot);
    createInitShims(packageRoot, {
      aie: { stateful: true },
      aib: { stateful: true },
      aiq: { stateful: true },
      aiu: { stateful: true },
    });
    initializeRepository(cwd);
    writeInitSetup(userQubeConfigPath(env.USERPROFILE), completeInitSetup({
      review: { mode: "external", externalReviewers: ["coderabbit"], publisher: "user" },
    }));
    writeInitSetup(repoQubeConfigPath(cwd), { version: 1, quality: { stages: ["build"] } });
    mkdirSync(path.join(cwd, ".qube"), { recursive: true });
    writeFileSync(path.join(cwd, ".qube", "keep.txt"), "keep\n", "utf8");

    const dryRun = runCli(["init", ".", "--inherit", "quality.stages", "--dry-run", "--json"], { cwd, env });
    assert.equal(dryRun.status, 0, dryRun.stderr);
    const planned = JSON.parse(dryRun.stdout);
    assert.equal(planned.configuration.action, "inherit");
    assert.equal(planned.plan.config.operation, "remove");
    const quality = planned.configuration.fields.find(field => field.id === "quality.stages");
    assert.equal(quality.repository.present, true);
    assert.equal(quality.planned.repositoryAction, "remove");
    assert.equal(quality.planned.source, "user-global");
    assert.equal(existsSync(repoQubeConfigPath(cwd)), true);

    const applied = runCli(["init", ".", "--inherit", "quality.stages", "--json"], { cwd, env });
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(JSON.parse(applied.stdout).configuration.action, "inherit");
    assert.equal(existsSync(repoQubeConfigPath(cwd)), false);
    assert.equal(readFileSync(path.join(cwd, ".qube", "keep.txt"), "utf8"), "keep\n");

    const noOp = runCli(["init", ".", "--inherit", "quality.stages", "--dry-run", "--json"], { cwd, env });
    assert.equal(noOp.status, 0, noOp.stderr);
    assert.equal(JSON.parse(noOp.stdout).plan.config.operation, "skip");
  });

  it("plans inherit-all as one sparse repository removal", () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-init-inherit-all-root-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-init-inherit-all-cwd-"));
    const env = initEnv(packageRoot);
    createInitShims(packageRoot);
    initializeRepository(cwd);
    writeInitSetup(userQubeConfigPath(env.USERPROFILE), completeInitSetup({
      review: { mode: "external", externalReviewers: ["coderabbit"], publisher: "user" },
    }));
    writeInitSetup(repoQubeConfigPath(cwd), {
      version: 1,
      hosts: ["cursor"],
      continuousShipping: false,
      review: { mode: "host", harness: "cursor" },
    });

    const result = runCli(["init", ".", "--inherit-all", "--dry-run", "--json"], { cwd, env });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.configuration.action, "inherit-all");
    assert.equal(payload.plan.config.operation, "remove");
    assert.equal(payload.configuration.fields.filter(field => field.planned.repositoryAction === "remove").length >= 3, true);
    assert.equal(existsSync(repoQubeConfigPath(cwd)), true);
  });

  it("applies and reruns global initialization without Git or repository inspection", () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-init-global-no-git-root-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-init-global-no-git-cwd-"));
    const env = initEnv(packageRoot, { PATH: "", Path: "" });
    createInitShims(packageRoot);
    const args = ["init", "--global", ...externalSelections(), "--json"];

    const first = runCli(args, { cwd, env });
    assert.equal(first.status, 0, first.stderr);
    const firstPayload = JSON.parse(first.stdout);
    assert.equal(firstPayload.scope, "global");
    assert.equal(firstPayload.mode, "apply");
    assert.equal(firstPayload.changed, true);
    assert.equal(firstPayload.plan.target, undefined);
    assert.equal(firstPayload.plan.git, undefined);
    assert.equal(firstPayload.plan.prerequisites.status, "not-required");
    assert.equal(firstPayload.plan.prerequisites.checks.every(check => check.status === "not-required"), true);
    assert.deepEqual(firstPayload.plan.components, []);
    assert.deepEqual(readInitCalls(packageRoot), []);
    assert.equal(existsSync(path.join(cwd, ".git")), false);
    assert.equal(existsSync(path.join(cwd, ".qube")), false);

    const second = runCli(args, { cwd, env });
    assert.equal(second.status, 0, second.stderr);
    const secondPayload = JSON.parse(second.stdout);
    assert.equal(secondPayload.changed, false);
    assert.equal(secondPayload.plan.config.operation, "skip");
    assert.deepEqual(readInitCalls(packageRoot), []);
  });

  it("plans an inherited-only repository without composer or product configuration copies", () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-init-inherited-root-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-init-inherited-cwd-"));
    const isolatedHome = mkdtempSync(path.join(tmpdir(), "qube-init-inherited-home-"));
    createInitShims(packageRoot);
    initializeRepository(cwd);
    writeInitSetup(userQubeConfigPath(isolatedHome), completeInitSetup({
      review: { mode: "external", externalReviewers: ["coderabbit"], publisher: "user" },
    }));
    const env = initEnv(packageRoot, { USERPROFILE: isolatedHome, HOME: isolatedHome });

    const result = runCli(["init", ".", "--dry-run", "--json"], { cwd, env });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.plan.config.operation, "skip");
    assert.equal(existsSync(repoQubeConfigPath(cwd)), false);
    const planCalls = readInitCalls(packageRoot);
    assert.equal(planCalls.length, 4);
    assert.ok(planCalls.every(call => call.phase === "plan"));
    for (const call of planCalls) assert.deepEqual(call.layerContext?.repository, { version: 1 });
    assert.ok(planCalls.every(call => Object.values(call.layerContext?.sources ?? {}).every(source => source !== "repository")));
    const copiedConfigActions = payload.plan.components.flatMap(component => component.actions ?? []).filter(action => {
      if (!action || typeof action !== "object" || !["create", "update", "update-config"].includes(action.operation)) return false;
      const actionPath = action.path ?? action.relativePath ?? action.absolutePath;
      return typeof actionPath === "string" && /(?:aib\.config|\.qube[\\/](?:aie|aiq|aiu)[\\/]config)\.json$/u.test(actionPath);
    });
    assert.deepEqual(copiedConfigActions, []);

    const applied = runCli(["init", ".", "--json"], { cwd, env });
    assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`);
    for (const configPath of [
      repoQubeConfigPath(cwd),
      path.join(cwd, "aib.config.json"),
      path.join(cwd, ".qube", "aie", "config.json"),
      path.join(cwd, ".qube", "aiq", "config.json"),
      path.join(cwd, ".qube", "aiu", "config.json"),
    ]) {
      assert.equal(existsSync(configPath), false, configPath);
    }
  });

  it("keeps package placement independent from global and repository configuration scope", () => {
    for (const placement of ["global", "project"]) {
      for (const scope of ["global", "repository"]) {
        const packageRoot = mkdtempSync(path.join(tmpdir(), `qube-init-package-${placement}-${scope}-`));
        const cwd = mkdtempSync(path.join(tmpdir(), `qube-init-config-${placement}-${scope}-`));
        const env = initEnv(packageRoot, { QUBE_PACKAGE_PLACEMENT: placement });
        createInitShims(packageRoot);
        const result = runCli([
          "init",
          ...(scope === "global" ? ["--global"] : ["."]),
          ...externalSelections(),
          "--dry-run",
          "--json",
        ], { cwd, env });
        assert.equal(result.status, 0, `${placement}/${scope}: ${result.stderr}`);
        const payload = JSON.parse(result.stdout);
        assert.equal(payload.scope, scope);
        assert.equal(payload.plan.packageRequirements.placement, placement);
        assert.equal(payload.plan.packageRequirements.installCommand, null);
        assert.equal(payload.plan.config.scope, scope === "global" ? "global" : "repo");
      }
    }
  });

  it("fails missing adapter preflight before Git, configuration, or component mutation", () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-init-missing-adapter-root-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-init-missing-adapter-cwd-"));
    const env = initEnv(packageRoot, { QUBE_PACKAGE_PLACEMENT: "global", npm_config_user_agent: "pnpm/10.0.0" });
    createInitShims(packageRoot);
    const missingName = "@tjalve/qube-adapter-github";
    unlinkSync(path.join(packageRoot, "node_modules", ...missingName.split("/"), "package.json"));

    const result = runCli([
      "init", ".", ...externalSelections(), "--git-init", "--json",
    ], { cwd, env });
    assert.equal(result.status, 4, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.mode, "preflight");
    assert.equal(payload.changed, false);
    assert.match(payload.error, new RegExp(`${missingName.replace("/", "\\/")}@${adapterPackageVersions[missingName].replaceAll(".", "\\.")}`));
    assert.match(payload.packageRequirements.installCommand, /^pnpm add --global --ignore-scripts /u);
    assert.match(payload.nextAction, /then rerun `qube init \.`/u);
    assert.equal(existsSync(path.join(cwd, ".git")), false);
    assert.equal(existsSync(path.join(cwd, ".qube")), false);
    assert.deepEqual(readInitCalls(packageRoot), []);
  });

  it("plans and applies a prospective repository without inventing remote readiness", () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-init-prospective-root-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-init-prospective-cwd-"));
    const env = initEnv(packageRoot);
    createInitShims(packageRoot);
    const baseArgs = ["init", ".", ...externalSelections()];

    const dryRun = runCli([...baseArgs, "--git-init", "--dry-run", "--json"], { cwd, env });
    assert.equal(dryRun.status, 0, dryRun.stderr);
    const dryPayload = JSON.parse(dryRun.stdout);
    assert.equal(dryPayload.mode, "plan");
    assert.equal(dryPayload.changed, true);
    assert.equal(dryPayload.plan.git.operation, "initialize");
    assert.equal(dryPayload.plan.git.baseBranch, "main");
    assert.equal(dryPayload.plan.prerequisites.checks.find(check => check.id === "repository").reasonCode, "not-a-repository");
    assert.equal(dryPayload.plan.components.length, 4);
    assert.deepEqual(dryPayload.plan.diagnosticActions.map(action => action.id), ["aggregate-diagnostics"]);
    assert.ok(dryPayload.plan.components.every(component => component.args.includes("--dry-run")));
    assert.equal(existsSync(path.join(cwd, ".git")), false);
    assert.equal(existsSync(repoQubeConfigPath(cwd)), false);

    const refused = runCli([...baseArgs, "--json"], { cwd, env });
    assert.equal(refused.status, 2, refused.stderr);
    assert.match(JSON.parse(refused.stdout).error, /requires --git-init/u);
    assert.equal(existsSync(path.join(cwd, ".git")), false);
    assert.equal(existsSync(repoQubeConfigPath(cwd)), false);

    const applied = runCli([...baseArgs, "--git-init", "--json"], { cwd, env });
    assert.equal(applied.status, 0, applied.stderr);
    const appliedPayload = JSON.parse(applied.stdout);
    assert.equal(appliedPayload.mode, "apply");
    assert.equal(appliedPayload.changed, true);
    assert.equal(existsSync(path.join(cwd, ".git")), true);
    assert.equal(existsSync(repoQubeConfigPath(cwd)), true);
    assert.ok(appliedPayload.pendingExternalActions.some(action => action.id === "labels-setup"));
    assert.equal(appliedPayload.readiness, "pending");
    assert.equal(appliedPayload.prerequisites.checks.find(check => check.id === "head").reasonCode, "head-missing");
    assert.equal(appliedPayload.prerequisites.checks.find(check => check.id === "remote").reasonCode, "remote-missing");
    assert.equal(appliedPayload.apply.aggregateDiagnostics.id, "aggregate-diagnostics");
    assert.match(appliedPayload.apply.aggregateDiagnostics.status, /^(?:ready|attention)$/u);
    const branch = spawnSync("git", ["-C", cwd, "symbolic-ref", "--short", "HEAD"], { encoding: "utf8" });
    assert.equal(branch.status, 0, branch.stderr);
    assert.equal(branch.stdout.trim(), "main");
    assert.equal(readInitCalls(packageRoot).some(call => call.phase === "labels"), false);

    const remote = spawnSync("git", ["-C", cwd, "remote", "add", "origin", "https://example.com/prospective.git"], {
      encoding: "utf8",
    });
    assert.equal(remote.status, 0, remote.stderr);
    const resumed = runCli([...baseArgs, "--json"], { cwd, env });
    assert.equal(resumed.status, 0, resumed.stderr);
    const resumedPayload = JSON.parse(resumed.stdout);
    assert.equal(resumedPayload.pendingExternalActions.some(action => action.id === "labels-setup"), false);
    assert.equal(readInitCalls(packageRoot).some(call => call.phase === "labels"), true);
  });

  it("returns public answers and keeps first-run human output free of component details", () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-init-public-output-root-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-init-public-output-repo-"));
    initializeRepository(cwd);
    const env = initEnv(packageRoot);
    createInitShims(packageRoot);
    const selections = [
      "init", ".",
      "--host", "codex",
      "--work-provider", "github",
      "--ci-provider", "github",
      "--review-mode", "external",
      "--external-reviewer", "coderabbit",
      "--review-publisher", "user",
      "--yes",
    ];

    const jsonPlan = runCli([...selections, "--dry-run", "--json"], { cwd, env });
    assert.equal(jsonPlan.status, 0, jsonPlan.stderr);
    const parsed = JSON.parse(jsonPlan.stdout);
    assert.equal(Array.isArray(parsed.answers), true);
    assert.ok(parsed.answers.length >= 8);
    assert.ok(parsed.answers.every(answer => (
      typeof answer.id === "string"
      && typeof answer.label === "string"
      && typeof answer.value === "string"
      && typeof answer.reason === "string"
      && answer.reason.length > 0
    )));
    assert.ok(parsed.answers.every(answer => (
      JSON.stringify(Object.keys(answer).sort()) === JSON.stringify(["id", "label", "reason", "value"])
    )));

    const human = runCli(selections, { cwd, env });
    assert.equal(human.status, 0, human.stderr);
    assert.equal(human.stderr, "");
    assert.match(human.stdout, /^Repository QUBE initialization is complete\./);
    assert.match(human.stdout, /Choices:/);
    assert.match(human.stdout, /Reason:/);
    assert.match(human.stdout, /Start a new Codex session/);
    assert.match(human.stdout, /run `\$make-it-so`\./);
    assert.doesNotMatch(human.stdout, /\b(?:aie|aib|aiq|aiu)\b/iu);
    assert.doesNotMatch(human.stdout, /Components:|QUBE config|\.qube[\\/]init\.json|--(?:tool|surfaces|local-review-agent|isolated-review-agent)/u);
  });

  it("updates global choices without reading or changing a conflicting repository override", () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-init-global-override-root-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-init-global-override-repo-"));
    const env = initEnv(packageRoot);
    const repoConfigPath = repoQubeConfigPath(cwd);
    mkdirSync(path.dirname(repoConfigPath), { recursive: true });
    writeFileSync(repoConfigPath, `${JSON.stringify({ version: 1, hosts: ["codex"] }, null, 2)}\n`, "utf8");
    writeFileSync(path.join(cwd, "AGENTS.md"), "existing instructions\n", "utf8");
    const before = readdirSync(cwd, { recursive: true }).map(String).sort();
    createInitShims(packageRoot);

    const result = runCli([
      "init", ".",
      "--host", "cursor",
      "--work-provider", "github",
      "--ci-provider", "github",
      "--config-scope", "global",
      "--yes",
      "--json",
    ], { cwd, env });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.scope, "global");
    assert.equal(parsed.plan.target, undefined);
    assert.equal(parsed.plan.git, undefined);
    assert.deepEqual(parsed.plan.components, []);
    assert.deepEqual(readInitCalls(packageRoot), []);
    assert.equal(readFileSync(repoConfigPath, "utf8"), `${JSON.stringify({ version: 1, hosts: ["codex"] }, null, 2)}\n`);
    assert.deepEqual(JSON.parse(readFileSync(userQubeConfigPath(env.USERPROFILE), "utf8")).hosts, ["cursor"]);
    assert.deepEqual(readdirSync(cwd, { recursive: true }).map(String).sort(), before);
    assert.equal(readFileSync(path.join(cwd, "AGENTS.md"), "utf8"), "existing instructions\n");
  });

  it("keeps a repository publisher-only update independent from the global review mode", () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-init-repo-publisher-root-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-init-repo-publisher-repo-"));
    initializeRepository(cwd);
    const env = initEnv(packageRoot);
    createInitShims(packageRoot);
    writeInitSetup(userQubeConfigPath(env.USERPROFILE), completeInitSetup({
      review: { mode: "external", externalReviewers: ["coderabbit"], publisher: "user" },
    }));

    const result = runCli([
      "init", ".",
      "--git-init",
      "--review-publisher", "github-app",
      "--config-scope", "repo",
      "--yes",
      "--json",
    ], { cwd, env });

      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.plan.resolved.review.mode, "external");
    assert.equal(parsed.plan.resolved.review.publisher, "github-app");
    assert.deepEqual(JSON.parse(readFileSync(repoQubeConfigPath(cwd), "utf8")), {
      version: 1,
      review: { publisher: "github-app" },
    });
  });

  it("keeps a global publisher-only update independent from repository review choices", () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-init-global-publisher-root-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-init-global-publisher-repo-"));
    createInitShims(packageRoot);
    const codexBin = createExecutableStub(
      packageRoot,
      "codex",
      `${JSON.stringify({ models: [{ slug: "shared-review" }] })}\n`,
    );
    const env = addExecutablePath(initEnv(packageRoot), codexBin);
    writeInitSetup(userQubeConfigPath(env.USERPROFILE), completeInitSetup({ review: undefined }));
    writeInitSetup(repoQubeConfigPath(cwd), {
      version: 1,
      review: { mode: "external", externalReviewers: ["coderabbit"] },
    });

    const result = runCli([
      "init", ".",
      "--review-publisher", "github-app",
      "--config-scope", "global",
      "--yes",
      "--json",
    ], { cwd, env });

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.plan.resolved.review.mode, "host");
    assert.equal(parsed.plan.resolved.review.harness, "codex");
    assert.equal(parsed.plan.resolved.review.publisher, "github-app");
    const saved = JSON.parse(readFileSync(userQubeConfigPath(env.USERPROFILE), "utf8"));
    assert.equal(saved.review.mode, undefined);
    assert.equal(saved.review.harness, undefined);
    assert.equal(saved.review.publisher, "github-app");
    assert.equal(saved.review.externalReviewers, undefined);
    assert.deepEqual(JSON.parse(readFileSync(repoQubeConfigPath(cwd), "utf8")).review, {
      mode: "external",
      externalReviewers: ["coderabbit"],
    });
  });

  it("does not read invalid repository config during an unchanged global rerun", () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-init-global-source-root-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-init-global-source-repo-"));
    const env = initEnv(packageRoot);
    createInitShims(packageRoot);
    const globalPath = userQubeConfigPath(env.USERPROFILE);
    writeInitSetup(globalPath, completeInitSetup({
      review: { mode: "external", externalReviewers: ["coderabbit"], publisher: "user" },
    }));
    mkdirSync(path.dirname(repoQubeConfigPath(cwd)), { recursive: true });
    writeFileSync(repoQubeConfigPath(cwd), "{ invalid repository json\n", "utf8");
    const before = readFileSync(globalPath, "utf8");

    const result = runCli([
      "init", ".",
      "--review-mode", "external",
      "--config-scope", "global",
      "--yes",
      "--json",
    ], { cwd, env });

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.plan.config.operation, "skip");
    assert.equal(readFileSync(globalPath, "utf8"), before);
    assert.deepEqual(JSON.parse(readFileSync(globalPath, "utf8")).review, {
      mode: "external",
      externalReviewers: ["coderabbit"],
      publisher: "user",
    });
  });

  it("normalizes an external reviewer and keeps a global host model pin cleared on rerun", () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-init-external-source-root-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-init-external-source-repo-"));
    initializeRepository(cwd);
    const env = initEnv(packageRoot);
    const stateful = { stateful: true };
    createInitShims(packageRoot, { aie: stateful, aib: stateful, aiq: stateful, aiu: stateful });
    writeInitSetup(userQubeConfigPath(env.USERPROFILE), completeInitSetup({
      review: {
        mode: "host",
        harness: "codex",
        publisher: "user",
        models: ["codex:shared-review"],
      },
    }));
    const args = [
      "init", ".",
      "--review-mode", "external",
      "--external-reviewer", "coderabbitai",
      "--yes",
      "--json",
    ];

    const first = runCli(args, { cwd, env });
    assert.equal(first.status, 0, first.stderr);
    const firstPayload = JSON.parse(first.stdout);
    assert.deepEqual(firstPayload.plan.resolved.review.externalReviewers, ["coderabbit"]);
    assert.deepEqual(firstPayload.plan.resolved.review.models, []);
    assert.equal(firstPayload.apply.changed, true);
    const firstAieArgs = componentRows(firstPayload.plan).get("aie").args;
    assert.equal(optionValue(firstAieArgs, "--review-agent"), "coderabbit");
    assert.equal(optionValue(firstAieArgs, "--review-model"), undefined);
    const configPath = repoQubeConfigPath(cwd);
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")).review, {
      mode: "external",
      externalReviewers: ["coderabbit"],
    });
    const firstConfig = readFileSync(configPath, "utf8");

    const second = runCli(args, { cwd, env });
    assert.equal(second.status, 0, second.stderr);
    const secondPayload = JSON.parse(second.stdout);
    assert.deepEqual(secondPayload.plan.resolved.review.models, []);
    assert.equal(optionValue(componentRows(secondPayload.plan).get("aie").args, "--review-model"), undefined);
    assert.equal(secondPayload.apply.changed, false);
    assert.equal(readFileSync(configPath, "utf8"), firstConfig);
    const aieApplyCalls = readInitCalls(packageRoot).filter(call => call.component === "aie" && call.phase === "apply");
    assert.equal(aieApplyCalls.length, 2);
    assert.ok(aieApplyCalls.every(call => !call.args.includes("--review-model")));
  });

  it("resets GitHub App publishing when a repository changes to GitLab", () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-init-gitlab-reset-root-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-init-gitlab-reset-repo-"));
    initializeRepository(cwd);
    createInitShims(packageRoot);
    writeInitSetup(repoQubeConfigPath(cwd), completeInitSetup({
      review: {
        mode: "external",
        externalReviewers: ["coderabbit"],
        publisher: "github-app",
      },
    }));
    const codexBin = createExecutableStub(
      packageRoot,
      "codex",
      `${JSON.stringify({ models: [{ slug: "shared-review" }] })}\n`,
    );
    const env = addExecutablePath(initEnv(packageRoot), codexBin);

    const result = runCli([
      "init", ".",
      "--work-provider", "gitlab",
      "--ci-provider", "gitlab",
      "--yes",
      "--json",
    ], { cwd, env });

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(parsed.plan.resolved.workProviders, ["gitlab"]);
    assert.equal(parsed.plan.resolved.review.mode, "host");
    assert.equal(parsed.plan.resolved.review.publisher, "user");
    assert.equal(parsed.plan.resolved.review.externalReviewers, undefined);
    const aieArgs = componentRows(parsed.plan).get("aie").args;
    assert.equal(optionValue(aieArgs, "--review-provider"), "gitlab");
    assert.equal(optionValue(aieArgs, "--publisher"), undefined);
    const saved = JSON.parse(readFileSync(repoQubeConfigPath(cwd), "utf8"));
    assert.deepEqual(saved.workProviders, ["gitlab"]);
    assert.equal(saved.review.mode, "host");
    assert.equal(saved.review.publisher, "user");
    assert.equal(saved.review.externalReviewers, undefined);
  });

  it("applies sole dependent choices without prompting when a complete setup changes to GitLab", () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-init-dependent-choice-root-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-init-dependent-choice-repo-"));
    initializeRepository(cwd);
    createInitShims(packageRoot);
    writeInitSetup(repoQubeConfigPath(cwd), completeInitSetup({
      hosts: ["claude-code"],
      review: {
        mode: "external",
        externalReviewers: ["coderabbit"],
        publisher: "github-app",
      },
    }));

    const result = runCli([
      "init", ".",
      "--work-provider", "gitlab",
      "--ci-provider", "gitlab",
      "--json",
    ], { cwd, env: initEnv(packageRoot) });

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.plan.resolved.continuousShipping, false);
    assert.equal(parsed.plan.resolved.review.mode, "host");
    assert.equal(parsed.plan.resolved.review.harness, "claude-code");
    assert.deepEqual(parsed.plan.resolved.review.models, []);
    assert.equal(parsed.plan.resolved.review.publisher, "user");
    const answers = new Map(parsed.answers.map(answer => [answer.id, answer]));
    assert.equal(answers.get("issue-tracker").value, "GitLab");
    assert.equal(answers.get("automated-checks").value, "GitLab");
    assert.equal(answers.get("continuous-shipping").value, "Off");
    assert.equal(answers.get("review-source").value, "Primary-harness subagents");
    assert.equal(answers.get("review-model").value, "Harness default (not pinned)");
    assert.equal(answers.has("review-publisher"), false);
    assert.ok([...answers.values()].every(answer => answer.reason.length > 0));
    const saved = JSON.parse(readFileSync(repoQubeConfigPath(cwd), "utf8"));
    assert.deepEqual(saved.workProviders, ["gitlab"]);
    assert.deepEqual(saved.ciProviders, ["gitlab"]);
    assert.equal(saved.continuousShipping, false);
    assert.equal(saved.review.mode, "host");
    assert.deepEqual(saved.review.models, []);
    assert.equal(saved.review.publisher, "user");
    assert.equal(saved.review.externalReviewers, undefined);
  });

  it("rejects an explicit review publisher when GitLab publishes reviews", () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-init-gitlab-publisher-root-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-init-gitlab-publisher-repo-"));
    createInitShims(packageRoot);
    const configPath = repoQubeConfigPath(cwd);
    writeInitSetup(configPath, completeInitSetup({
      workProviders: ["gitlab"],
      ciProviders: ["gitlab"],
      continuousShipping: false,
    }));
    const before = readFileSync(configPath, "utf8");

    const result = runCli([
      "init", ".",
      "--git-init",
      "--review-publisher", "github-app",
      "--yes",
      "--json",
    ], { cwd, env: initEnv(packageRoot) });

    assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.failedAction, "Repository setup choices");
    assert.equal(parsed.error, "Review publisher selection applies only when GitHub publishes reviews.");
    assert.equal(parsed.nextAction, "Correct the Review selection, then rerun qube init.");
    assert.deepEqual(readInitCalls(packageRoot), []);
    assert.equal(readFileSync(configPath, "utf8"), before);
  });

  it("rebinds a preserved live model when the primary Review host changes", () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-init-model-rebind-root-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-init-model-rebind-repo-"));
    initializeRepository(cwd);
    createInitShims(packageRoot);
    writeInitSetup(repoQubeConfigPath(cwd), completeInitSetup({
      review: {
        mode: "host",
        harness: "codex",
        publisher: "user",
        models: ["codex:shared-review"],
      },
    }));
    const grokBin = createExecutableStub(packageRoot, "grok", "Available models:\n- shared-review\n");
    const env = addExecutablePath(initEnv(packageRoot), grokBin);

    const result = runCli([
      "init", ".",
      "--host", "grok-build",
      "--yes",
      "--json",
    ], { cwd, env });

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(parsed.plan.resolved.hosts, ["grok-build"]);
    assert.deepEqual(parsed.plan.resolved.review.models, ["grok-build:shared-review"]);
    const aieArgs = componentRows(parsed.plan).get("aie").args;
    assert.equal(optionValue(aieArgs, "--local-review-agent"), "grok-build");
    assert.equal(optionValue(aieArgs, "--review-model"), "grok-build:shared-review");
    const saved = JSON.parse(readFileSync(repoQubeConfigPath(cwd), "utf8"));
    assert.deepEqual(saved.review.models, ["grok-build:shared-review"]);
    assert.equal(saved.review.models.includes("codex:shared-review"), false);
  });

  it("rejects an exact linked repository config before child planning or apply", (context) => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-init-linked-config-root-"));
    const workspace = mkdtempSync(path.join(tmpdir(), "qube-init-linked-config-workspace-"));
    const cwd = path.join(workspace, "repo");
    const env = initEnv(packageRoot);
    mkdirSync(cwd, { recursive: true });
    initializeRepository(cwd);
    createInitShims(packageRoot);
    const initArgs = [
      "init", ".",
      "--git-init",
      "--host", "codex",
      "--work-provider", "github",
      "--ci-provider", "github",
      "--review-mode", "external",
      "--external-reviewer", "coderabbit",
      "--yes",
      "--json",
    ];
    const initialized = runCli(initArgs, { cwd, env });
    assert.equal(initialized.status, 0, initialized.stderr);

    const configPath = repoQubeConfigPath(cwd);
    const exactConfig = readFileSync(configPath, "utf8");
    const outsidePath = path.join(workspace, "outside-init.json");
    writeFileSync(outsidePath, exactConfig, "utf8");
    unlinkSync(configPath);
    try {
      symlinkSync(outsidePath, configPath, "file");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EPERM") {
        context.skip("Symbolic link creation is unavailable on this platform.");
        return;
      }
      throw error;
    }
    const callLog = path.join(packageRoot, "init-calls.ndjson");
    if (existsSync(callLog)) unlinkSync(callLog);

    const rejected = runCli(initArgs, { cwd, env });
    assert.equal(rejected.status, 2, rejected.stderr);
    const payload = JSON.parse(rejected.stdout);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /repository QUBE config is invalid.*symbolic link or directory junction/iu);
    assert.deepEqual(readInitCalls(packageRoot), []);
    assert.equal(readFileSync(outsidePath, "utf8"), exactConfig);
  });

  it("plans all four components against one absolute target and canonical harness set", () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-init-plan-root-"));
    const outer = mkdtempSync(path.join(tmpdir(), "qube-init-plan-cwd-"));
    const target = path.join(outer, "repo");
    const initialized = spawnSync("git", ["init", "--quiet", target], { cwd: outer, encoding: "utf8" });
    assert.equal(initialized.status, 0, initialized.stderr);
    mkdirSync(path.join(target, "packages", "app"), { recursive: true });
    createInitShims(packageRoot, {
      aiq: {
        plan: {
          ok: true,
          command: "config",
          setup: {
            selection: {
              mode: "cumulative",
              requestedStages: ["maintainability"],
              resolvedStages: ["sloc", "maintainability"],
            },
            stageMetadata: [
              { id: "sloc", refactorDriving: false },
              {
                id: "maintainability",
                refactorDriving: true,
                warning: {
                  code: "robust-e2e-tests-recommended",
                  message: "This stage can force refactoring. Use robust end-to-end tests.",
                },
              },
            ],
          },
        },
      },
    });

    const reviewBin = createExecutableStub(packageRoot, "grok", "Available models:\n- grok-code-fast-1\n");
    const env = addExecutablePath(initEnv(packageRoot), reviewBin);
    const result = runCli([
      "init", path.join("repo", "packages", "app"),
      "--host", "cursor,grok-build,codex,cursor",
      "--work-provider", "github",
      "--ci-provider", "github",
      "--quality-stage", "maintainability",
      "--review-mode", "isolated",
      "--review-harness", "grok-build",
      "--yes",
      "--dry-run",
      "--json",
    ], { cwd: outer, env });

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual({ ok: parsed.ok, command: parsed.command, mode: parsed.mode }, { ok: true, command: "init", mode: "plan" });
    assert.equal(parsed.apply, undefined);
    assert.equal(parsed.plan.target, path.resolve(target));
    assert.deepEqual(parsed.plan.resolved.hosts, ["cursor", "grok-build", "codex"]);
    assert.deepEqual(parsed.plan.components.map(component => component.id), ["aie", "aib", "aiq", "aiu"]);
    assert.ok(parsed.plan.components.every(component => component.cwd === path.resolve(target)));
    assert.ok(parsed.plan.components.every(component => component.args.includes("--dry-run")));

    const rows = componentRows(parsed.plan);
    assert.equal(rows.get("aie").args[1], path.resolve(target));
    assert.equal(optionValue(rows.get("aie").args, "--tool"), "codex,grok-build,cursor");
    assert.equal(optionValue(rows.get("aie").args, "--primary-host"), "cursor");
    assert.equal(optionValue(rows.get("aie").args, "--isolated-review-agent"), "grok-build");
    assert.equal(optionValue(rows.get("aib").args, "--agent"), "cursor");
    assert.equal(optionValue(rows.get("aib").args, "--surfaces"), "cursor,grok-build,codex");
    assert.equal(rows.get("aib").args[1], path.resolve(target));
    assert.deepEqual(rows.get("aiq").args.slice(0, 5), ["config", "--stages", "maintainability", "--format", "json"]);
    assert.deepEqual(rows.get("aiq").selection.resolvedStages, ["sloc", "maintainability"]);
    assert.match(
      rows.get("aiq").stageMetadata.find(stage => stage.refactorDriving).warning.message,
      /robust end-to-end tests/,
    );
    assert.equal(optionValue(rows.get("aiu").args, "--tool"), "codex,grok-build");
    assert.equal(optionValue(rows.get("aiu").args, "--post-issue-scope"), "ready");
    const calls = readInitCalls(packageRoot);
    assert.equal(calls.length, 4);
    assert.ok(calls.every(call => call.layerContext?.selectedScope === "repository"));
    assert.ok(calls.every(call => JSON.stringify(call.layerContext) === JSON.stringify(calls[0].layerContext)));
    assert.deepEqual(calls[0].layerContext.effective.hosts, ["cursor", "grok-build", "codex"]);
    assert.equal(calls[0].layerContext.sources["review.harness"], "explicit");
  });

  it("plans Umpire for Cursor with an explicit unsupported-host value", () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-init-cursor-root-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-init-cursor-cwd-"));
    createInitShims(packageRoot);

    const result = runCli(["init", ".", "--host", "cursor", "--ci-provider", "github", "--yes", "--dry-run", "--json"], {
      cwd,
      env: initEnv(packageRoot),
    });

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    const rows = componentRows(parsed.plan);
    assert.deepEqual(parsed.plan.components.map(component => component.id), ["aie", "aib", "aiq", "aiu"]);
    assert.equal(optionValue(rows.get("aie").args, "--tool"), "cursor");
    assert.equal(optionValue(rows.get("aiu").args, "--tool"), "none");
  });

  it("does not apply any component when a child plan fails", () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-init-plan-failure-root-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-init-plan-failure-cwd-"));
    createInitShims(packageRoot, {
      aiq: {
        plan: {
          ok: false,
          command: "config",
          error: { kind: "invalid-stage", message: "Quality stage readability is unavailable." },
          nextAction: "Choose a stage returned by aiq schema.",
        },
        exitCodes: { plan: 7 },
      },
    });

    const result = runCli([
      "init", ".",
      "--git-init",
      "--host", "codex",
      "--ci-provider", "github",
      "--review-mode", "external",
      "--external-reviewer", "coderabbit",
      "--yes",
      "--json",
    ], {
      cwd,
      env: initEnv(packageRoot),
    });

    assert.equal(result.status, 7, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual({ ok: parsed.ok, command: parsed.command, mode: parsed.mode }, { ok: false, command: "init", mode: "plan" });
    assert.equal(parsed.apply, undefined);
    assert.equal(parsed.error, "Quality stage readability is unavailable.");
    assert.equal(parsed.nextAction, "Correct quality checks setup, then rerun `qube init .`.");
    assert.doesNotMatch(parsed.nextAction, /\baiq\b/u);
    assert.deepEqual(readInitCalls(packageRoot).map(call => call.phase), ["plan", "plan", "plan", "plan"]);
    assert.equal(existsSync(path.join(cwd, ".qube", "init.json")), false);
  });

  it("applies in stable order and stops at the first exact child failure", () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-init-apply-failure-root-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-init-apply-failure-cwd-"));
    initializeRepository(cwd);
    createInitShims(packageRoot, {
      aiq: {
        apply: {
          ok: false,
          command: "config",
          error: { message: "Quality configuration is read-only." },
          nextAction: "Make the Quality configuration writable and rerun qube init.",
        },
        exitCodes: { apply: 9 },
      },
    });

    const result = runCli([
      "init", ".",
      "--host", "codex",
      "--ci-provider", "github",
      "--review-mode", "external",
      "--external-reviewer", "coderabbit",
      "--yes",
      "--json",
    ], {
      cwd,
      env: initEnv(packageRoot),
    });

    assert.equal(result.status, 9, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.mode, "apply");
    assert.equal(parsed.error, "Quality configuration is read-only.");
    assert.equal(parsed.nextAction, "Correct quality checks setup, then rerun `qube init .`.");
    assert.deepEqual(parsed.apply.steps.map(step => [step.id, step.status]), [
      ["aie", "changed"],
      ["aib", "changed"],
      ["aiq", "failed"],
    ]);
    assert.deepEqual(
      readInitCalls(packageRoot).filter(call => call.phase === "apply").map(call => call.component),
      ["aie", "aib", "aiq"],
    );
    const saved = JSON.parse(readFileSync(path.join(cwd, ".qube", "init.json"), "utf8"));
    assert.deepEqual(saved.hosts, ["codex"]);
    assert.deepEqual(saved.workProviders, ["github"]);
    assert.deepEqual(saved.ciProviders, ["github"]);
    assert.equal(saved.continuousShipping, true);
    assert.deepEqual(saved.umpire, { scope: "ready" });
    assert.deepEqual(saved.quality, { stages: ["unit"] });
    assert.equal(saved.review.mode, "external");
    assert.deepEqual(saved.review.externalReviewers, ["coderabbit"]);
    assert.equal(saved.review.publisher, "user");
    assert.equal(saved.review.models, undefined);
    assert.equal(saved.review.harness, undefined);
  });

  it("reports the exact failed action, reason, and next action in human output", () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-init-human-failure-root-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-init-human-failure-repo-"));
    initializeRepository(cwd);
    createInitShims(packageRoot, {
      aiq: {
        apply: {
          ok: false,
          command: "config",
          error: { message: "Quality configuration is read-only." },
          nextAction: "Make the Quality configuration writable and rerun qube init.",
        },
        exitCodes: { apply: 9 },
      },
    });

    const result = runCli([
      "init", ".",
      "--host", "codex",
      "--work-provider", "github",
      "--ci-provider", "github",
      "--review-mode", "external",
      "--external-reviewer", "coderabbit",
      "--yes",
    ], { cwd, env: initEnv(packageRoot) });

    assert.equal(result.status, 9);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      [
        "Action: Quality checks setup",
        "Reason: Quality configuration is read-only.",
        "Next action: Correct quality checks setup, then rerun `qube init .`.",
        "",
      ].join("\n"),
    );
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /QUBE setup is complete|Start a new .* session/u);
  });

  it("rejects an invalid QUBE intent path before child planning", () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-init-config-failure-root-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-init-config-failure-cwd-"));
    createInitShims(packageRoot);
    writeFileSync(path.join(cwd, ".qube"), "blocks the config directory\n", "utf8");

    const result = runCli(["init", ".", "--git-init", "--host", "codex", "--ci-provider", "github", "--yes", "--json"], {
      cwd,
      env: initEnv(packageRoot),
    });

    assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /repository QUBE config is invalid.*non-directory parent/iu);
    assert.deepEqual(readInitCalls(packageRoot), []);
  });

  it("returns the QUBE Reviewer App setup as a post-init action", () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-init-app-root-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-init-app-cwd-"));
    createInitShims(packageRoot, {
      aie: {
        plan: {
          ok: true,
          command: "init",
          actions: [],
          postInitActions: [{
            id: "github-app",
            command: "qube review setup github-app",
            description: "Set up the QUBE Reviewer GitHub App after initialization.",
          }],
        },
      },
    });

    const result = runCli([
      "init", ".",
      "--git-init",
      "--host", "codex",
      "--work-provider", "github",
      "--ci-provider", "github",
      "--review-mode", "external",
      "--external-reviewer", "coderabbit",
      "--review-publisher", "github-app",
      "--yes",
      "--dry-run",
      "--json",
    ], { cwd, env: initEnv(packageRoot) });

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(parsed.plan.postInitActions, [{
      id: "github-app",
      description: "Set up the QUBE Reviewer GitHub App after initialization.",
      status: "pending",
      handledBy: "qube init",
      nextAction: "Rerun `qube init .` to resume this action.",
    }]);
    assert.equal(optionValue(componentRows(parsed.plan).get("aie").args, "--publisher"), "github-app");
    assert.ok(readInitCalls(packageRoot).every(call => call.phase === "plan"));
  });

  it("shows the GitHub App follow-up and publisher readiness after apply", () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-init-app-readiness-root-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-init-app-readiness-repo-"));
    initializeRepository(cwd);
    createInitShims(packageRoot, {
      aie: {
        plan: {
          ok: true,
          command: "init",
          actions: [],
          postInitActions: [{
            id: "github-app",
            command: "qube review setup github-app",
            description: "Set up the QUBE Reviewer GitHub App after initialization.",
          }],
        },
        reviewDoctor: {
          ok: true,
          command: "review doctor",
          readiness: "degraded",
          nextAction: "Authorize the QUBE Reviewer App, then run `qube review doctor` again.",
        },
      },
    });

    const result = runCli([
      "init", ".",
      "--host", "codex",
      "--work-provider", "github",
      "--ci-provider", "github",
      "--review-mode", "external",
      "--external-reviewer", "coderabbit",
      "--review-publisher", "github-app",
      "--yes",
    ], { cwd, env: initEnv(packageRoot) });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /GitHub review publisher: needs attention\./);
    assert.match(result.stdout, /Next actions:[\s\S]*Rerun `qube init \.` to resume this action\./);
    assert.match(result.stdout, /Rerun `qube init \.` to continue Reviewer App onboarding and readiness checks\./);
    assert.doesNotMatch(result.stdout, /qube review setup|qube review doctor/u);
    const calls = readInitCalls(packageRoot);
    assert.equal(calls.some(call => call.phase === "reviewDoctor"), true);
    assert.equal(calls.at(-1)?.phase, "doctor");
  });

  it("forwards host and isolated review harnesses to Executor", () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-init-review-root-"));
    createInitShims(packageRoot);
    createExecutableStub(
      packageRoot,
      "codex",
      `${JSON.stringify({ models: [{ slug: "shared-review" }] })}\n`,
    );
    const reviewBin = createExecutableStub(packageRoot, "grok", "Available models:\n- grok-code-fast-1\n");
    const reviewEnv = addExecutablePath(initEnv(packageRoot), reviewBin);

    const hostRepo = mkdtempSync(path.join(tmpdir(), "qube-init-host-review-"));
    const host = runCli([
      "init", ".",
      "--host", "codex",
      "--ci-provider", "github",
      "--review-mode", "host",
      "--yes",
      "--dry-run",
      "--json",
    ], { cwd: hostRepo, env: reviewEnv });
    assert.equal(host.status, 0, host.stderr);
    const hostPayload = JSON.parse(host.stdout);
    const hostPlan = hostPayload.plan;
    const hostModelAnswer = hostPayload.answers.find(answer => answer.id === "review-model");
    const hostModelArgument = optionValue(componentRows(hostPlan).get("aie").args, "--review-model");
    assert.equal(hostPlan.resolved.review.harness, "codex");
    assert.equal(optionValue(componentRows(hostPlan).get("aie").args, "--local-review-agent"), "codex");
    assert.ok(hostModelAnswer);
    assert.equal(hostModelAnswer.value, "shared-review");
    assert.equal(hostModelArgument, "codex:shared-review");
    assert.equal(hostModelArgument, `codex:${hostModelAnswer.value}`);

    const isolatedRepo = mkdtempSync(path.join(tmpdir(), "qube-init-isolated-review-"));
    const isolated = runCli([
      "init", ".",
      "--host", "codex,grok-build",
      "--ci-provider", "github",
      "--review-mode", "isolated",
      "--review-harness", "grok-build",
      "--yes",
      "--dry-run",
      "--json",
    ], { cwd: isolatedRepo, env: reviewEnv });
    assert.equal(isolated.status, 0, isolated.stderr);
    const isolatedPlan = JSON.parse(isolated.stdout).plan;
    assert.equal(isolatedPlan.resolved.review.harness, "grok-build");
    assert.equal(optionValue(componentRows(isolatedPlan).get("aie").args, "--isolated-review-agent"), "grok-build");
  });

  it("fails before child planning when a supported Review host catalog is unavailable", () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-init-catalog-missing-root-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-init-catalog-missing-repo-"));
    createInitShims(packageRoot);
    const env = gitOnlyEnvironment(packageRoot);

    const result = runCli([
      "init", ".",
      "--git-init",
      "--host", "codex",
      "--work-provider", "github",
      "--ci-provider", "github",
      "--review-mode", "host",
      "--yes",
      "--json",
    ], { cwd, env });

    assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.failedAction, "Repository setup choices");
    assert.equal(
      parsed.error,
      "Review model: codex review route is unavailable. Expose the authenticated codex CLI on PATH; QUBE does not install or authenticate model hosts.",
    );
    assert.equal(parsed.nextAction, "Make the selected harness live model list available, then rerun qube init.");
    assert.deepEqual(readInitCalls(packageRoot), []);
    assert.equal(existsSync(repoQubeConfigPath(cwd)), false);
  });

  it("reports when Cursor and GitLab have no available Review source", () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-init-review-source-root-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-init-review-source-repo-"));
    createInitShims(packageRoot);
    const env = gitOnlyEnvironment(packageRoot);

    const result = runCli([
      "init", ".",
      "--git-init",
      "--host", "cursor",
      "--work-provider", "gitlab",
      "--ci-provider", "gitlab",
      "--yes",
      "--json",
    ], { cwd, env });

    assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.failedAction, "Repository setup choices");
    assert.equal(parsed.error, "Review: no available Review source matches the selected Agent harnesses and issue tracker.");
    assert.equal(
      parsed.nextAction,
      "Select and install a compatible Review harness, or choose an issue tracker with an available external review service.",
    );
    assert.deepEqual(readInitCalls(packageRoot), []);
    assert.equal(existsSync(repoQubeConfigPath(cwd)), false);
  });

  it("rejects review harnesses that violate the selected review mode", () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-init-review-reject-root-"));
    const cases = [
      {
        hosts: "codex,grok-build",
        mode: "host",
        harness: "grok-build",
        error: /Primary-harness review must use codex/,
      },
      {
        hosts: "codex,grok-build",
        mode: "isolated",
        harness: "codex",
        error: /other than the primary harness/,
      },
      {
        hosts: "codex,opencode",
        mode: "isolated",
        harness: "opencode",
        error: /opencode does not support isolated review/,
      },
    ];

    for (const testCase of cases) {
      const cwd = mkdtempSync(path.join(tmpdir(), "qube-init-review-reject-"));
      const result = runCli([
        "init", ".",
        "--host", testCase.hosts,
        "--ci-provider", "github",
        "--review-mode", testCase.mode,
        "--review-harness", testCase.harness,
        "--yes",
        "--dry-run",
        "--json",
      ], { cwd, env: initEnv(packageRoot) });
      assert.equal(result.status, 2, result.stderr);
      assert.match(JSON.parse(result.stdout).error, testCase.error);
    }
  });

  it("rejects explicit external reviewers outside external review mode", () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-init-reviewer-reject-root-"));
    const cases = [
      { hosts: "codex", mode: "host" },
      { hosts: "codex,grok-build", mode: "isolated", harness: "grok-build" },
    ];

    for (const testCase of cases) {
      const cwd = mkdtempSync(path.join(tmpdir(), "qube-init-reviewer-reject-"));
      const result = runCli([
        "init", ".",
        "--host", testCase.hosts,
        "--ci-provider", "github",
        "--review-mode", testCase.mode,
        ...(testCase.harness ? ["--review-harness", testCase.harness] : []),
        "--external-reviewer", "coderabbit",
        "--yes",
        "--dry-run",
        "--json",
      ], { cwd, env: initEnv(packageRoot) });
      assert.equal(result.status, 2, result.stderr);
      assert.equal(
        JSON.parse(result.stdout).error,
        "External reviewer services require external review mode.",
      );
    }
  });

  it("uses one detected CI provider and the guided recommendation for conflicting markers under --yes", () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-init-ci-root-"));
    createInitShims(packageRoot);

    const gitlabRepo = mkdtempSync(path.join(tmpdir(), "qube-init-gitlab-"));
    writeFileSync(path.join(gitlabRepo, ".gitlab-ci.yml"), "test: {}\n", "utf8");
    const detected = runCli([
      "init", ".",
      "--host", "codex",
      "--review-mode", "external",
      "--external-reviewer", "coderabbit",
      "--yes",
      "--dry-run",
      "--json",
    ], {
      cwd: gitlabRepo,
      env: initEnv(packageRoot),
    });
    assert.equal(detected.status, 0, detected.stderr);
    const detectedPlan = JSON.parse(detected.stdout).plan;
    assert.deepEqual(detectedPlan.resolved.ciProviders, ["gitlab"]);
    assert.equal(detectedPlan.sources.ciProviders, "detected");
    assert.equal(optionValue(componentRows(detectedPlan).get("aie").args, "--ci-provider"), "gitlab");

    const ambiguousRepo = mkdtempSync(path.join(tmpdir(), "qube-init-ci-ambiguous-"));
    mkdirSync(path.join(ambiguousRepo, ".github", "workflows"), { recursive: true });
    writeFileSync(path.join(ambiguousRepo, ".github", "workflows", "ci.yml"), "name: ci\n", "utf8");
    writeFileSync(path.join(ambiguousRepo, ".gitlab-ci.yml"), "test: {}\n", "utf8");
    const ambiguous = runCli([
      "init", ".",
      "--host", "codex",
      "--review-mode", "external",
      "--external-reviewer", "coderabbit",
      "--yes",
      "--dry-run",
      "--json",
    ], {
      cwd: ambiguousRepo,
      env: initEnv(packageRoot),
    });
    assert.equal(ambiguous.status, 0, ambiguous.stderr);
    const ambiguousPayload = JSON.parse(ambiguous.stdout);
    assert.equal(ambiguousPayload.ok, true);
    assert.deepEqual(ambiguousPayload.plan.resolved.ciProviders, ["github"]);
    assert.equal(ambiguousPayload.plan.sources.ciProviders, "default");
    assert.equal(optionValue(componentRows(ambiguousPayload.plan).get("aie").args, "--ci-provider"), "github");
  });

  it("reports an unchanged second apply without rewriting its QUBE config", () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-init-noop-root-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-init-noop-cwd-"));
    initializeRepository(cwd);
    const remote = spawnSync("git", ["-C", cwd, "remote", "add", "origin", "https://example.com/qube-test.git"], {
      encoding: "utf8",
    });
    assert.equal(remote.status, 0, remote.stderr);
    const stateful = { stateful: true };
    createInitShims(packageRoot, { aie: stateful, aib: stateful, aiq: stateful, aiu: stateful });
    const codexBin = createExecutableStub(
      packageRoot,
      "codex",
      `${JSON.stringify({ models: [{ slug: "shared-review" }] })}\n`,
    );
    const env = addExecutablePath(initEnv(packageRoot), codexBin);
    const args = [
      "init", ".",
      "--host", "codex",
      "--work-provider", "github",
      "--ci-provider", "github",
      "--review-mode", "host",
      "--yes",
      "--json",
    ];

    const first = runCli(args, { cwd, env });
    assert.equal(first.status, 0, first.stderr);
    const firstPayload = JSON.parse(first.stdout);
    assert.equal(firstPayload.mode, "apply");
    assert.equal(firstPayload.plan.config.operation, "create");
    assert.equal(firstPayload.apply.changed, true);
    assert.deepEqual(firstPayload.apply.steps.map(step => step.id), ["aie", "aib", "aiq", "aiu", "labels"]);
    const firstModelAnswer = firstPayload.answers.find(answer => answer.id === "review-model");
    const firstModelArgument = optionValue(componentRows(firstPayload.plan).get("aie").args, "--review-model");
    assert.ok(firstModelAnswer);
    assert.equal(firstModelAnswer.value, "shared-review");
    assert.deepEqual(firstPayload.plan.resolved.review.models, ["codex:shared-review"]);
    assert.equal(firstModelArgument, `codex:${firstModelAnswer.value}`);

    const configPath = path.join(cwd, ".qube", "init.json");
    const firstConfig = readFileSync(configPath, "utf8");
    assert.deepEqual(JSON.parse(firstConfig).review.models, ["codex:shared-review"]);
    const second = runCli(args, { cwd, env });
    assert.equal(second.status, 0, second.stderr);
    const secondPayload = JSON.parse(second.stdout);
    assert.equal(secondPayload.plan.config.operation, "skip");
    assert.equal(secondPayload.apply.changed, false);
    assert.ok(secondPayload.apply.steps.every(step => step.status === "unchanged"));
    assert.equal(secondPayload.apply.aggregateDiagnostics.status, "attention");
    assert.equal(readFileSync(configPath, "utf8"), firstConfig);

    const quiet = runCli(args.filter(arg => arg !== "--json"), { cwd, env });
    assert.equal(quiet.status, 0, quiet.stderr);
    assert.match(quiet.stdout, /^Repository QUBE initialization is complete\.\nMode: apply\.\nPersistent values changed: no\./u);
    assert.match(quiet.stdout, /Correct the reported readiness problems, then rerun `qube init \.`\./u);
    assert.equal(quiet.stderr, "");
    assert.equal(readFileSync(configPath, "utf8"), firstConfig);
  });

  it("rejects unknown harnesses and blocks unanswered JSON prompts", () => {
    const unsupported = runCli(["init", ".", "--git-init", "--host", "bogus-host", "--yes", "--json"], {
      env: initEnv(mkdtempSync(path.join(tmpdir(), "qube-init-invalid-root-"))),
    });
    assert.notEqual(unsupported.status, 0);
    const unsupportedPayload = JSON.parse(unsupported.stdout);
    assert.equal(unsupportedPayload.ok, false);
    assert.equal(unsupportedPayload.command, "init");
    assert.equal(unsupportedPayload.failedAction, "Repository setup choices");
    assert.equal(unsupportedPayload.error, "Agent harnesses: includes unavailable choice: bogus-host.");
    assert.equal(unsupportedPayload.nextAction, "Correct the selected setup value, then rerun qube init.");

    const promptRoot = mkdtempSync(path.join(tmpdir(), "qube-init-prompt-root-"));
    const promptCwd = mkdtempSync(path.join(tmpdir(), "qube-init-prompt-cwd-"));
    const promptEnv = initEnv(promptRoot);
    const unanswered = runCli(["init", ".", "--git-init", "--json"], { cwd: promptCwd, env: promptEnv });
    assert.equal(unanswered.status, 2);
    const unansweredPayload = JSON.parse(unanswered.stdout);
    assert.equal(unansweredPayload.failedAction, "Repository setup choices");
    assert.equal(unansweredPayload.error, "Guided setup still needs an answer for agent-harnesses.");
    assert.equal(unansweredPayload.nextAction, "Rerun qube init in an interactive terminal, or supply the matching command option.");

    const human = runCli(["init", ".", "--git-init"], { cwd: promptCwd, env: promptEnv });
    assert.equal(human.status, 2);
    assert.equal(human.stdout, "");
    assert.equal(human.stderr, [
      "Action: Repository setup choices",
      "Reason: Guided setup still needs an answer for agent-harnesses.",
      "Next action: Rerun qube init in an interactive terminal, or supply the matching command option.",
      "",
    ].join("\n"));
    assert.deepEqual(readInitCalls(promptRoot), []);
    assert.equal(existsSync(repoQubeConfigPath(promptCwd)), false);
  });
});

describe("QUBE routing and connection boundaries", () => {
  it("derives routing launch names from the canonical harness profiles", async () => {
    for (const host of AGENT_HOST_IDS) {
      const profile = await getAgentHostProfile(host);
      const candidates = new Set([...profile.executables.names, ...profile.executables.windowsNames]);
      assert.deepEqual(detectInstalledRoutingHostsOnPath(command => candidates.has(command)), [host], host);
    }
  });

  it("does not discover root-level Executor config files", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-current-config-doctor-"));
    writeFileSync(path.join(cwd, "aie.config.json"), JSON.stringify({
      version: 1,
      providers: {
        work: { kind: "github" },
        review: { kind: "github" },
        ci: { kind: "github" },
      },
    }) + "\n", "utf8");

    const result = await runConnectionDoctor({ cwd });

    assert.equal(result.status, "unverified");
    assert.equal(result.configPath, null);
    assert.deepEqual(result.connections, []);
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

  it("derives primary-harness review for a single Codex host record", () => {
    const record = createInitRecord({
      hosts: ["codex"],
      workProviders: ["github"],
      ciProviders: ["github"],
      mcpOptIn: false,
    });

    assert.deepEqual(record.review, {
      mode: "host",
      harness: "codex",
      publisher: "user",
    });
  });

  it("completes a record from partial global and repository config", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-toolkit-partial-repo-"));
    const home = mkdtempSync(path.join(tmpdir(), "qube-toolkit-partial-home-"));
    const globalPath = userQubeConfigPath(home);
    const repoPath = repoQubeConfigPath(cwd);
    mkdirSync(path.dirname(globalPath), { recursive: true });
    mkdirSync(path.dirname(repoPath), { recursive: true });
    writeFileSync(globalPath, `${JSON.stringify({ version: 1, hosts: ["codex"] })}\n`, "utf8");
    writeFileSync(repoPath, `${JSON.stringify({
      version: 1,
      workProviders: ["github"],
      ciProviders: ["github"],
      continuousShipping: true,
      umpire: { scope: "ready" },
      quality: { stages: ["unit"] },
      review: { publisher: "user" },
      mcp: { optIn: false },
    })}\n`, "utf8");

    const record = readInitRecord(cwd, { USERPROFILE: home, HOME: home });
    assert.deepEqual(record, {
      version: 1,
      hosts: ["codex"],
      workProviders: ["github"],
      ciProviders: ["github"],
      continuousShipping: true,
      umpire: { scope: "ready" },
      quality: { stages: ["unit"] },
      review: { mode: "host", harness: "codex", publisher: "user" },
      mcp: { optIn: false },
    });
  });

  it("finds the repository record and assets from a deeper directory", async () => {
    const outer = mkdtempSync(path.join(tmpdir(), "qube-toolkit-root-discovery-"));
    const repoRoot = path.join(outer, "repo");
    const target = path.join(repoRoot, "packages", "app");
    const deeper = path.join(target, "src", "feature");
    const initialized = spawnSync("git", ["init", "--quiet", repoRoot], { encoding: "utf8" });
    assert.equal(initialized.status, 0, initialized.stderr);
    mkdirSync(deeper, { recursive: true });
    writeRequiredAssets(repoRoot, "codex");

    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-toolkit-root-discovery-pkg-"));
    createInitShims(packageRoot);
    const env = initEnv(packageRoot);
    const initializedQube = runCli([
      "init", path.join("repo", "packages", "app"),
      "--host", "codex",
      "--work-provider", "github",
      "--ci-provider", "github",
      "--review-mode", "external",
      "--external-reviewer", "coderabbit",
      "--review-publisher", "user",
      "--yes",
      "--json",
    ], { cwd: outer, env });
    assert.equal(initializedQube.status, 0, initializedQube.stderr);
    assert.equal(JSON.parse(initializedQube.stdout).plan.target, path.resolve(repoRoot));

    const record = readInitRecord(deeper, env);
    assert.ok(record);
    assert.deepEqual(record.hosts, ["codex"]);
    const report = await probeHostToolkits({ cwd: deeper, env, offline: true });
    assert.deepEqual(report.selected, ["codex"]);
    assert.equal(report.hosts[0].status, "complete");
    assert.ok(report.hosts[0].present.includes("AGENTS.md"));
    assert.ok(report.hosts[0].present.includes("plugins/ai-umpire/hooks/hooks.json"));
  });

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
    createInitShims(packageRoot);
    const planned = runCli([
      "init", ".", "--host", "claude-code", "--work-provider", "github", "--ci-provider", "github",
      "--yes", "--dry-run", "--json",
    ], { cwd, env: initEnv(packageRoot) });
    assert.equal(planned.status, 0, planned.stderr);
    const parsed = JSON.parse(planned.stdout);
    assert.deepEqual(parsed.plan.resolved.hosts, ["claude-code"]);
    assert.deepEqual(parsed.plan.components.map((component) => component.id), ["aie", "aib", "aiq", "aiu"]);
    assert.equal(parsed.plan.resolved.mcp.optIn, false);
    assert.equal(existsSync(repoQubeConfigPath(cwd)), false);
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
    createInitShims(packageRoot);
    const planned = runCli([
      "init", ".", "--host", "grok-build", "--work-provider", "github", "--ci-provider", "github",
      "--review-mode", "external", "--external-reviewer", "coderabbit",
      "--yes", "--dry-run", "--json",
    ], { cwd, env: initEnv(packageRoot) });
    assert.equal(planned.status, 0, planned.stderr);
    const parsed = JSON.parse(planned.stdout);
    assert.deepEqual(parsed.plan.resolved.hosts, ["grok-build"]);
    assert.deepEqual(parsed.plan.components.map((component) => component.id), ["aie", "aib", "aiq", "aiu"]);
    assert.equal(parsed.plan.resolved.mcp.optIn, false);
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
    createInitShims(packageRoot);
    const env = initEnv(packageRoot, { QUBE_MCP: "1", MCP: "1" });

    const implicit = runCli([
      "init", ".", "--host", "opencode", "--work-provider", "github", "--ci-provider", "github",
      "--review-mode", "external", "--external-reviewer", "coderabbit",
      "--yes", "--git-init", "--json",
    ], { cwd, env });
    assert.equal(implicit.status, 0, implicit.stderr);
    const implicitParsed = JSON.parse(implicit.stdout);
    assert.equal(implicitParsed.plan.resolved.mcp.optIn, false);
    assert.deepEqual(implicitParsed.plan.components.map((component) => component.id), ["aie", "aib", "aiq", "aiu"]);
    assert.equal(existsSync(repoQubeConfigPath(cwd)), true);
    for (const mcpPath of PROVIDER_MCP_CONFIG_PATHS) {
      assert.equal(existsSync(path.join(cwd, ...mcpPath.split("/"))), false);
    }

    const opted = runCli([
      "init", ".", "--host", "opencode", "--work-provider", "github", "--ci-provider", "github",
      "--review-mode", "external", "--external-reviewer", "coderabbit",
      "--yes", "--mcp", "--json",
    ], { cwd, env });
    assert.equal(opted.status, 0, opted.stderr);
    const optedParsed = JSON.parse(opted.stdout);
    assert.equal(optedParsed.plan.resolved.mcp.optIn, true);
    assert.deepEqual(optedParsed.plan.components.map((component) => component.id), ["aie", "aib", "aiq", "aiu"]);
    assert.equal(JSON.parse(readFileSync(repoQubeConfigPath(cwd), "utf8")).mcp.optIn, true);
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

  it("does not report complete for an unknown host and rejects an empty host record", async () => {
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

    assert.throws(
      () => createInitRecord({
        hosts: [],
        workProviders: ["github"],
        ciProviders: ["github"],
        mcpOptIn: false,
      }),
      /QUBE init record requires at least one agent harness/,
    );
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
