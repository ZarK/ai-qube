import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { adapterPackageVersions, componentFixtures, expectedComponentRows, qubePackageName, qubePackageVersion } from "./workspace-versions.mjs";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const qubeCliRoot = path.resolve(packageRoot, "..", "..", "packages", "qube-cli");
const qubeCoreRoot = path.resolve(packageRoot, "..", "..", "packages", "qube-core");
const tempRoots = [];

const fakeComponents = componentFixtures;

describe("packed QUBE package and init smoke", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });

  it("installs QUBE with default adapters and dispatches package-scoped component bins", async () => {
    const root = await createTempRoot("qube-install-smoke-");
    const packDir = path.join(root, "pack");
    const target = path.join(root, "repo");
    await mkdir(packDir);
    await mkdir(target);

    const qubeTarball = await packPackage(packageRoot, packDir);
    const qubeCliTarball = await packPackage(qubeCliRoot, packDir);
    const qubeCoreTarball = await packPackage(qubeCoreRoot, packDir);
    const codexAdapterTarball = await packPackage(path.resolve(packageRoot, "..", "..", "adapters", "codex"), packDir);
    const githubAdapterTarball = await packPackage(path.resolve(packageRoot, "..", "..", "adapters", "github"), packDir);
    const componentTarballs = new Map();
    for (const component of fakeComponents) {
      componentTarballs.set(component.name, await createFakeComponentTarball(component, root, packDir));
    }

    await writeFile(
      path.join(target, "package.json"),
      `${JSON.stringify(
        {
          private: true,
          packageManager: "pnpm@11.0.4",
          dependencies: {
            "@tjalve/qube": fileSpecifier(target, qubeTarball)
          }
        },
        null,
        2
      )}\n`
    );
    await writeFile(path.join(target, ".npmrc"), "ignore-scripts=true\nsave-exact=true\n");
    await writeFile(
      path.join(target, ".pnpmfile.cjs"),
      [
        "module.exports = {",
        "  hooks: {",
        "    readPackage(pkg) {",
        "      if (pkg.name === '@tjalve/qube') {",
        "        pkg.dependencies = {",
        "          ...pkg.dependencies,",
        ...Object.entries({
          "@tjalve/qube-adapter-codex": fileSpecifier(target, codexAdapterTarball),
          "@tjalve/qube-adapter-github": fileSpecifier(target, githubAdapterTarball),
        }).map(([name, specifier]) => "          " + JSON.stringify(name) + ": " + JSON.stringify(specifier) + ","),
        `          "@tjalve/qube-cli": ${JSON.stringify(fileSpecifier(target, qubeCliTarball))},`,
        `          "@tjalve/qube-core": ${JSON.stringify(fileSpecifier(target, qubeCoreTarball))},`,
        ...fakeComponents.map(component =>
          `          ${JSON.stringify(component.name)}: ${JSON.stringify(fileSpecifier(target, componentTarballs.get(component.name)))},`
        ),
        "        };",
        "      }",
        "      return pkg;",
        "    },",
        "  },",
        "};",
        ""
      ].join("\n")
    );

    await runPnpm(["install", "--ignore-scripts"], target);
    assert.deepEqual(installedAdapterPackages(target), ["@tjalve/qube-adapter-codex", "@tjalve/qube-adapter-github"]);

    const components = await runPnpm(["exec", "qube", "components", "--json"], target);
    const parsedComponents = JSON.parse(components.stdout).components;
    assert.deepEqual(
      parsedComponents.map(component => [
        component.id,
        component.command,
        component.packageName,
        component.packageVersion
      ]),
      expectedComponentRows
    );
    const executor = parsedComponents.find(component => component.id === "executor");
    assert.equal(executor.capabilities.localReview.freshContextReviewerSupport, "host-provided");
    assert.ok(executor.capabilities.localReview.provenanceRequired.includes("providerPublishStatus"));
    assert.deepEqual(executor.capabilities.localReview.provenanceAlternatives[0].anyOf, ["taskId", "sessionId", "threadId"]);
    assert.deepEqual(
      executor.capabilities.hostSurfaces.map(host => [host.id, host.source, host.default]),
      [
        ["opencode", "agent-host-profile", false],
        ["codex", "agent-host-profile", true],
        ["claude-code", "agent-host-profile", false],
        ["grok-build", "agent-host-profile", false],
        ["cursor", "agent-host-profile", false],
      ],
    );
    assert.ok(executor.capabilities.workProviders.some(provider => provider.id === "github" && provider.support === "installed"));
    assert.ok(executor.capabilities.workProviders.find(provider => provider.id === "github").capabilities.some(capability => capability.id === "read-review-threads" && capability.support === "supported"));
    assert.ok(executor.capabilities.ciProviders.some(provider => provider.id === "jenkins" && provider.support === "optional"));

    const dispatched = await runPnpm(["exec", "qube", "run", "aib", "--", "status", "--json"], target);
    const aibFixture = fakeComponents.find(component => component.command === "aib");
    assert.ok(aibFixture);
    assert.equal(dispatched.stdout.trim(), `${aibFixture.command} ${aibFixture.version} status --json`);
  });

  it("initializes a prospective repository from a package-manager-installed QUBE tarball", async () => {
    const root = await createTempRoot("qube-init-packed-smoke-");
    const packDir = path.join(root, "pack");
    const installer = path.join(root, "installer");
    const initTarget = path.join(root, "init-target");
    const testHome = path.join(root, "home");
    const packageRootDir = path.join(root, "qube-root");
    await mkdir(packDir);
    await mkdir(installer);
    await mkdir(initTarget);
    await mkdir(testHome);

    const qubeTarball = await packPackage(packageRoot, packDir);
    const qubeCliTarball = await packPackage(qubeCliRoot, packDir);
    const qubeCoreTarball = await packPackage(qubeCoreRoot, packDir);
    const codexAdapterTarball = await packPackage(path.resolve(packageRoot, "..", "..", "adapters", "codex"), packDir);
    const githubAdapterTarball = await packPackage(path.resolve(packageRoot, "..", "..", "adapters", "github"), packDir);
    const componentTarballs = new Map();
    for (const component of fakeComponents) {
      componentTarballs.set(component.name, await createFakeComponentTarball(component, root, packDir));
    }

    await writeFile(
      path.join(installer, "package.json"),
      `${JSON.stringify({
        private: true,
        packageManager: "pnpm@11.0.4",
        dependencies: { [qubePackageName]: fileSpecifier(installer, qubeTarball) },
      }, null, 2)}\n`,
    );
    await writeFile(path.join(installer, ".npmrc"), "ignore-scripts=true\nsave-exact=true\n");
    await writeFile(
      path.join(installer, ".pnpmfile.cjs"),
      [
        "module.exports = {",
        "  hooks: {",
        "    readPackage(pkg) {",
        "      if (pkg.name === '@tjalve/qube') {",
        "        pkg.dependencies = {",
        "          ...pkg.dependencies,",
        ...Object.entries({
          "@tjalve/qube-adapter-codex": fileSpecifier(installer, codexAdapterTarball),
          "@tjalve/qube-adapter-github": fileSpecifier(installer, githubAdapterTarball),
        }).map(([name, specifier]) => "          " + JSON.stringify(name) + ": " + JSON.stringify(specifier) + ","),
        `          "@tjalve/qube-cli": ${JSON.stringify(fileSpecifier(installer, qubeCliTarball))},`,
        `          "@tjalve/qube-core": ${JSON.stringify(fileSpecifier(installer, qubeCoreTarball))},`,
        ...fakeComponents.map(component =>
          `          ${JSON.stringify(component.name)}: ${JSON.stringify(fileSpecifier(installer, componentTarballs.get(component.name)))},`
        ),
        "        };",
        "      }",
        "      return pkg;",
        "    },",
        "  },",
        "};",
        "",
      ].join("\n"),
    );
    await runPnpm(["install", "--ignore-scripts", "--frozen-lockfile=false"], installer);
    await writeApplyComponentStubs(packageRootDir);
    for (const [name, version] of Object.entries(adapterPackageVersions)) {
      const adapterRoot = path.join(packageRootDir, "node_modules", ...name.split("/"));
      await mkdir(adapterRoot, { recursive: true });
      await writeFile(path.join(adapterRoot, "package.json"), `${JSON.stringify({ name, version })}\n`);
    }

    const env = {
      ...process.env,
      HOME: testHome,
      QUBE_PACKAGE_PLACEMENT: "global",
      QUBE_TEST_PACKAGE_ROOT: packageRootDir,
      USERPROFILE: testHome,
    };
    const qubeBin = path.join(installer, "node_modules", qubePackageName, "dist", "bin", "qube.js");
    const migration = await runPackedQube(qubeBin, ["install", "--json"], { cwd: initTarget, env });
    const migrationPayload = JSON.parse(migration.stdout);
    assert.equal(migrationPayload.mode, "migration");
    assert.equal(migrationPayload.changed, false);
    assert.equal(existsSync(path.join(initTarget, ".git")), false);
    assert.equal(existsSync(path.join(initTarget, ".qube")), false);

    const initArgs = [
      "init",
      ".",
      "--git-init",
      "--yes",
      "--json",
      "--host",
      "codex",
      "--work-provider",
      "github",
      "--ci-provider",
      "github",
      "--continuous-shipping",
      "--umpire-scope",
      "ready",
      "--quality-stage",
      "unit",
      "--review-mode",
      "external",
      "--external-reviewer",
      "coderabbit",
      "--review-publisher",
      "user",
    ];
    const expectedAnswerIds = [
      "agent-harnesses",
      "issue-tracker",
      "automated-checks",
      "continuous-shipping",
      "umpire-scope",
      "quality-checks",
      "review-source",
      "external-reviewer",
      "review-publisher",
    ];
    const firstInit = await runPackedQube(qubeBin, initArgs, { cwd: initTarget, env });
    const firstInitParsed = JSON.parse(firstInit.stdout);
    assert.equal(firstInitParsed.ok, true, `${firstInit.stdout}\n${firstInit.stderr}`);
    assert.equal(firstInitParsed.command, "init");
    assert.equal(firstInitParsed.scope, "repository");
    assert.equal(firstInitParsed.mode, "apply");
    assert.equal(firstInitParsed.changed, true);
    assert.equal(firstInitParsed.plan.git.operation, "initialize");
    assert.equal(existsSync(path.join(initTarget, ".git")), true);
    assertPublicInitAnswers(firstInitParsed.answers, expectedAnswerIds);
    const firstInitArtifacts = await readInitArtifacts(initTarget);

    const secondArgs = initArgs.filter(argument => argument !== "--git-init");
    const secondInit = await runPackedQube(qubeBin, secondArgs, { cwd: initTarget, env });
    const secondInitParsed = JSON.parse(secondInit.stdout);
    assert.equal(secondInitParsed.ok, true, `${secondInit.stdout}\n${secondInit.stderr}`);
    assert.equal(secondInitParsed.command, "init");
    assert.equal(secondInitParsed.scope, "repository");
    assert.equal(secondInitParsed.mode, "apply");
    assert.equal(secondInitParsed.changed, false);
    assertPublicInitAnswers(secondInitParsed.answers, expectedAnswerIds);
    assert.deepEqual(await readInitArtifacts(initTarget), firstInitArtifacts);
    assert.equal(existsSync(path.join(initTarget, "package.json")), false);
  });
});

function assertPublicInitAnswers(answers, expectedIds) {
  assert.ok(Array.isArray(answers));
  assert.deepEqual(answers.map(answer => answer.id), expectedIds);
  for (const answer of answers) {
    assert.deepEqual(Object.keys(answer).sort(), ["id", "label", "reason", "value"]);
    assert.equal(typeof answer.label, "string");
    assert.notEqual(answer.label.trim(), "");
    assert.equal(typeof answer.value, "string");
    assert.notEqual(answer.value.trim(), "");
    assert.equal(typeof answer.reason, "string");
    assert.notEqual(answer.reason.trim(), "");
  }
}

async function readInitArtifacts(root) {
  const artifactPaths = [
    ".qube/init.json",
    ".qube/aie/config.json",
    "AGENTS.md",
    ".agents/skills/make-it-so/SKILL.md",
  ];
  return Object.fromEntries(await Promise.all(artifactPaths.map(async artifactPath => [
    artifactPath,
    await readFile(path.join(root, ...artifactPath.split("/")), "utf8"),
  ])));
}

async function writeApplyComponentStubs(packageRootDir) {
  const binDir = path.join(packageRootDir, "node_modules", ".bin");
  await mkdir(binDir, { recursive: true });
  const initConfig = {
    version: 1,
    providers: {
      work: { kind: "github" },
      review: { kind: "github" },
      repository: { kind: "local-git" },
      ci: { kind: "github" },
      layout: { kind: "local" }
    },
    policy: {
      reviews: { mode: "host" },
      audit: { evidenceRoot: "~/.qube/verification" },
      instructions: { noCreditWarning: true },
    },
  };
  await writeNodeShim(binDir, "aie", `
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const writeManaged = (file, body) => {
  const normalized = body.trimEnd() + "\\n";
  const digest = createHash("sha256").update(normalized).digest("hex");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, [
    "<!-- BEGIN EXECUTOR MANAGED SECTION -->",
    "<!-- executor-managed-version: 1 -->",
    "<!-- executor-managed-checksum: " + digest + " -->",
    body.trimEnd(),
    "<!-- END EXECUTOR MANAGED SECTION -->",
    ""
  ].join("\\n"));
};
const argv = process.argv.slice(2);
const args = argv.join(" ");
if (args.includes("init")) {
  const configPath = path.join(process.cwd(), ".qube", "aie", "config.json");
  const instructionsPath = path.join(process.cwd(), "AGENTS.md");
  const makeItSoPath = path.join(process.cwd(), ".agents", "skills", "make-it-so", "SKILL.md");
  const changed = !existsSync(configPath) || !existsSync(instructionsPath) || !existsSync(makeItSoPath);
  const dryRun = argv.includes("--dry-run");
  if (changed && !dryRun) {
    const configured = ${JSON.stringify(initConfig)};
    const reviewModeIndex = argv.indexOf("--review-mode");
    if (reviewModeIndex >= 0 && argv[reviewModeIndex + 1]) configured.policy.reviews.mode = argv[reviewModeIndex + 1];
    const evidenceRootIndex = argv.indexOf("--ui-audit-evidence-root");
    if (evidenceRootIndex >= 0 && argv[evidenceRootIndex + 1]) configured.policy.audit.evidenceRoot = argv[evidenceRootIndex + 1];
    configured.policy.instructions.noCreditWarning = !argv.includes("--no-credit-warning");
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify(configured, null, 2) + "\\n");
    writeManaged(instructionsPath, "Team rules.");
    writeManaged(makeItSoPath, "Run QUBE Make It So.");
  }
  process.stdout.write(JSON.stringify({ ok: true, command: "init", changed: changed && !dryRun }) + "\\n");
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
  await writeNodeShim(binDir, "aiu", `
const args = process.argv.slice(2).join(" ");
if (args.includes("init")) {
  process.stdout.write(JSON.stringify({ ok: true, command: "init" }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({ ok: true, doctor: { status: "ok" } }) + "\\n");
`);
  await writeNodeShim(binDir, "aiq", `process.stdout.write(JSON.stringify({ ok: true, command: "doctor" }) + "\\n");`);
  await writeNodeShim(binDir, "aib", `process.stdout.write(JSON.stringify({ ok: true, command: "init" }) + "\\n");`);
  for (const component of fakeComponents) {
    const dir = path.join(packageRootDir, "node_modules", ...component.name.split("/"));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "package.json"), `${JSON.stringify({ name: component.name, version: component.version }, null, 2)}\n`);
  }
}

async function writeNodeShim(binDir, name, source) {
  const scriptPath = path.join(binDir, `${name}.mjs`);
  await writeFile(scriptPath, source);
  if (process.platform === "win32") {
    await writeFile(path.join(binDir, `${name}.cmd`), `@echo off\r\nnode "${scriptPath}" %*\r\n`);
  } else {
    await writeFile(path.join(binDir, name), `#!/usr/bin/env node\n${source}`);
    await chmod(path.join(binDir, name), 0o755);
  }
}

async function createFakeComponentTarball(component, root, packDir) {
  const componentRoot = path.join(root, component.command);
  const binDir = path.join(componentRoot, "bin");
  await mkdir(binDir, { recursive: true });
  const binPath = path.join(binDir, `${component.command}.js`);
  await writeFile(
    binPath,
    [
      "#!/usr/bin/env node",
      `console.log(${JSON.stringify(`${component.command} ${component.version}`)}, process.argv.slice(2).join(" "));`
    ].join("\n")
  );
  if (process.platform !== "win32") {
    await chmod(binPath, 0o755);
  }
  if (component.name === "@tjalve/aib") {
    await writeFile(
      path.join(componentRoot, "index.js"),
      [
        "export function synthesizeAutoresearchArena() {",
        "  throw new Error('fake AIB synthesis is not available in install smoke tests');",
        "}",
        ""
      ].join("\n")
    );
  }
  if (component.name === "@tjalve/aie") {
    await writeFile(
      path.join(componentRoot, "index.js"),
      [
        "import { existsSync } from 'node:fs';",
        "export function validateConfig(config) { return { ok: true, errors: [], config }; }",
        "const prerequisiteIds = ['git', 'repository', 'identity-name', 'identity-email', 'head', 'branch', 'worktree', 'dirty-worktree', 'base-ref', 'remote', 'remote-transport'];",
        "const requiredFor = ['local-setup', 'issue-workflow', 'branch', 'review', 'completion', 'shipping'];",
        "const check = (id, status, reasonCode = null, safeDetails = {}) => ({ id, status, summary: status === 'ready' ? id + ' is ready.' : id + ' needs action.', nextAction: status === 'ready' ? null : 'Complete Git repository setup.', reasonCode, requiredFor, safeDetails });",
        "export function notRequiredGitPrerequisites() { return { status: 'not-required', checks: prerequisiteIds.map(id => check(id, 'not-required')) }; }",
        "export async function evaluateGitPrerequisites(options) {",
        "  const root = options.cwd;",
        "  const repositoryReady = existsSync(root + '/.git');",
        "  const checks = prerequisiteIds.map(id => id === 'repository' && !repositoryReady ? check(id, 'needs-action', 'not-a-repository', { root }) : check(id, 'ready', null, id === 'repository' ? { root } : {}));",
        "  return { status: repositoryReady ? 'ready' : 'needs-action', checks };",
        "}",
        "export function prerequisiteCheck(prerequisites, id) { return prerequisites.checks.find(candidate => candidate.id === id); }",
        "export function repositoryPrerequisiteStatusFor(prerequisites, stage) { const statuses = prerequisites.checks.filter(candidate => candidate.requiredFor.includes(stage)).map(candidate => candidate.status); return statuses.includes('needs-action') ? 'needs-action' : statuses.includes('unverified') ? 'unverified' : statuses.every(status => status === 'not-required') ? 'not-required' : 'ready'; }",
        "export function detectInstalledReviewHostsOnPath() { return []; }",
        "export function listHostModels(host) { return { host, status: 'ready', models: host === 'codex' ? ['smoke-review-model'] : [], diagnostic: null }; }",
        "const cap = (support, description) => ({ support, description, ...(support === 'supported' ? {} : { nextAction: 'Select a supported harness capability.' }) });",
        "const profile = (id, displayName, instructionPath, makeItSoPath, makeItSoKind, invocation, support) => ({",
        "  id, displayName,",
        "  executables: { names: [id], windowsNames: [id + '.exe'] },",
        "  instructionTarget: { id: id + '-instructions', path: instructionPath, description: displayName + ' instructions.' },",
        "  makeItSo: { id: id + '-make-it-so', path: makeItSoPath, kind: makeItSoKind, invocation, description: displayName + ' Make It So entry point.' },",
        "  taskList: { ...cap(support.taskList, displayName + ' task-list support.'), tools: [], fallback: 'Keep a visible checklist.', instruction: 'Keep task state in the main session.' },",
        "  subagents: { ...cap(support.subagents, displayName + ' subagent support.'), instruction: 'Use only tested host subagents.' },",
        "  review: {",
        "    local: { ...cap(support.localReview, displayName + ' native review support.'), freshContext: support.localReview !== 'unsupported', readOnly: false, agents: [] },",
        "    isolated: { ...cap(support.isolatedReview, displayName + ' isolated review support.'), freshContext: support.isolatedReview !== 'unsupported', readOnly: support.isolatedReview !== 'unsupported', agents: [] },",
        "  },",
        "  modelDiscovery: { ...cap(support.models, displayName + ' live model discovery.'), listModels() { return []; } },",
        "  umpire: {",
        "    continuation: { ...cap(support.umpire, displayName + ' Umpire continuation.'), delivery: support.umpire === 'unsupported' ? 'none' : 'stdout', currentIssueRecovery: support.umpire !== 'unsupported' },",
        "    probe: { ...cap(support.umpire, displayName + ' Umpire probe.'), ...(support.umpire === 'unsupported' ? {} : { command: ['qube', 'aiu', 'doctor', '--json'] }) },",
        "  },",
        "  trust: { required: false, description: 'No smoke-test trust action.', actions: [] },",
        "});",
        "const profiles = {",
        "  opencode: profile('opencode', 'OpenCode', 'AGENTS.md', '.opencode/commands/make-it-so.md', 'command', '/make-it-so', { taskList: 'supported', subagents: 'supported', localReview: 'supported', isolatedReview: 'unsupported', models: 'supported', umpire: 'supported' }),",
        "  codex: profile('codex', 'Codex', 'AGENTS.md', '.agents/skills/make-it-so/SKILL.md', 'skill', '$make-it-so', { taskList: 'supported', subagents: 'supported', localReview: 'supported', isolatedReview: 'supported', models: 'supported', umpire: 'experimental' }),",
        "  'claude-code': profile('claude-code', 'Claude Code', 'CLAUDE.md', '.claude/commands/make-it-so.md', 'command', '/make-it-so', { taskList: 'supported', subagents: 'supported', localReview: 'supported', isolatedReview: 'unsupported', models: 'unsupported', umpire: 'experimental' }),",
        "  'grok-build': profile('grok-build', 'Grok Build', 'AGENTS.md', '.grok/commands/make-it-so.md', 'command', '/make-it-so', { taskList: 'unsupported', subagents: 'supported', localReview: 'supported', isolatedReview: 'supported', models: 'supported', umpire: 'experimental' }),",
        "  cursor: profile('cursor', 'Cursor', 'AGENTS.md', '.cursor/commands/make-it-so.md', 'command', '/make-it-so', { taskList: 'unsupported', subagents: 'unsupported', localReview: 'unsupported', isolatedReview: 'supported', models: 'supported', umpire: 'unsupported' }),",
        "};",
        "export function getAgentHostProfileSync(id) { const value = profiles[id]; if (!value) throw new Error('Unknown host: ' + id); return value; }",
        "export async function getAgentHostProfile(id) { return getAgentHostProfileSync(id); }",
        "export async function getAgentHostProfiles(ids) { return ids.map(getAgentHostProfileSync); }",
        "export async function listInitExternalReviewers() { return [",
        "  { id: 'copilot', aliases: [], label: 'GitHub Copilot' },",
        "  { id: 'coderabbit', aliases: ['coderabbitai'], label: 'CodeRabbit' },",
        "  { id: 'cubic', aliases: ['cubic-dev-ai'], label: 'Cubic' },",
        "]; }",
        "",
      ].join("\n")
    );
  }
  if (component.name === "@tjalve/aiq") {
    await writeFile(
      path.join(componentRoot, "config.js"),
      [
        "export const aiqStageMetadata = Object.freeze([",
        "  Object.freeze({ description: 'Run unit tests.', id: 'unit', index: 4, refactorDriving: false }),",
        "]);",
        "",
      ].join("\n")
    );
  }
  if (component.name === "@tjalve/aiu") {
    await writeFile(
      path.join(componentRoot, "index.js"),
      [
        "export const AIU_POST_ISSUE_SCOPES = Object.freeze(['ready', 'standard', 'custom']);",
        "",
      ].join("\n")
    );
  }
  await writeFile(
    path.join(componentRoot, "package.json"),
    `${JSON.stringify(
      {
        name: component.name,
        version: component.version,
        type: "module",
        ...(["@tjalve/aib", "@tjalve/aie", "@tjalve/aiu"].includes(component.name) ? {
          main: "index.js",
          exports: {
            ".": "./index.js"
          }
        } : {}),
        ...(component.name === "@tjalve/aiq" ? {
          exports: {
            "./config": "./config.js"
          }
        } : {}),
        bin: {
          [component.command]: `bin/${component.command}.js`
        }
      },
      null,
      2
    )}\n`
  );
  return packPackage(componentRoot, packDir);
}

function installedAdapterPackages(root) {
  const found = new Set();
  const visit = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
        continue;
      }
      if (entry.name !== "package.json") continue;
      try {
        const manifest = JSON.parse(readFileSync(full, "utf8"));
        if (typeof manifest.name === "string" && manifest.name.startsWith("@tjalve/qube-adapter-")) {
          found.add(manifest.name);
        }
      } catch {
        // Ignore unreadable nested package manifests.
      }
    }
  };
  visit(path.join(root, "node_modules"));
  return [...found].sort();
}

async function packPackage(root, packDir) {
  const result = await runPnpm(["pack", "--pack-destination", packDir], root);
  const packedName = result.stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line.endsWith(".tgz"));

  assert.ok(packedName, `pnpm pack did not print a tarball name: ${result.stdout}`);
  return path.isAbsolute(packedName) ? packedName : path.join(packDir, packedName);
}

async function createTempRoot(prefix) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function fileSpecifier(fromDir, filePath) {
  return `file:${path.relative(fromDir, filePath).split(path.sep).join("/")}`;
}

async function runPackedQube(qubeBin, args, options) {
  try {
    return await execFileAsync(process.execPath, [qubeBin, ...args], {
      cwd: options.cwd,
      env: options.env,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120_000
    });
  } catch (error) {
    assert(error !== null && typeof error === "object");
    return {
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      status: error.code ?? 1
    };
  }
}

async function runPnpm(args, cwd) {
  const pnpmCommand = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "pnpm";
  const pnpmArgs = process.platform === "win32" ? ["/d", "/s", "/c", "pnpm", ...args] : [...args];
  try {
    return await execFileAsync(pnpmCommand, pnpmArgs, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120_000
    });
  } catch (error) {
    assert(error !== null && typeof error === "object");
    const failed = error;
    assert.fail(
      [
        `pnpm ${args.join(" ")} failed with exit code ${failed.code ?? 1}`,
        failed.stdout ?? "",
        failed.stderr ?? ""
      ].join("\n")
    );
  }
}
