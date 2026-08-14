import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createPassingPackument } from "../dist/index.js";
import { adapterPackageVersions, componentFixtures, expectedComponentRows, qubePackageName, qubePackageVersion } from "./workspace-versions.mjs";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const claudeCodeAdapterRoot = path.resolve(packageRoot, "..", "..", "adapters", "claude-code");
const qubeCliRoot = path.resolve(packageRoot, "..", "..", "packages", "qube-cli");
const qubeCoreRoot = path.resolve(packageRoot, "..", "..", "packages", "qube-core");
const tempRoots = [];

const fakeComponents = componentFixtures;

describe("packed QUBE install smoke", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });

  it("installs QUBE into a blank project and dispatches install-scoped component bins", async () => {
    const root = await createTempRoot("qube-install-smoke-");
    const packDir = path.join(root, "pack");
    const target = path.join(root, "repo");
    await mkdir(packDir);
    await mkdir(target);

    const qubeTarball = await packPackage(packageRoot, packDir);
    const claudeCodeAdapterTarball = await packPackage(claudeCodeAdapterRoot, packDir);
    const qubeCliTarball = await packPackage(qubeCliRoot, packDir);
    const qubeCoreTarball = await packPackage(qubeCoreRoot, packDir);
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
        `          "@tjalve/qube-adapter-claude-code": ${JSON.stringify(fileSpecifier(target, claudeCodeAdapterTarball))},`,
        `          "@tjalve/qube-cli": ${JSON.stringify(fileSpecifier(target, qubeCliTarball))},`,
        `          "@tjalve/qube-core": ${JSON.stringify(fileSpecifier(target, qubeCoreTarball))},`,
        ...fakeComponents.map(component =>
          `          ${JSON.stringify(component.name)}: ${JSON.stringify(fileSpecifier(target, componentTarballs.get(component.name)))},`
        ),
        "        };",
        "      }",
        "      if (pkg.name === '@tjalve/qube-adapter-claude-code') {",
        "        pkg.dependencies = {",
        "          ...pkg.dependencies,",
        `          "@tjalve/qube-core": ${JSON.stringify(fileSpecifier(target, qubeCoreTarball))},`,
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
    assert.ok(executor.capabilities.workProviders.some(provider => provider.id === "github" && provider.support === "installed"));
    assert.ok(executor.capabilities.workProviders.find(provider => provider.id === "github").capabilities.some(capability => capability.id === "read-review-threads" && capability.support === "supported"));
    assert.ok(executor.capabilities.ciProviders.some(provider => provider.id === "jenkins" && provider.support === "optional"));

    const dispatched = await runPnpm(["exec", "qube", "run", "aib", "--", "status", "--json"], target);
    const aibFixture = fakeComponents.find(component => component.command === "aib");
    assert.ok(aibFixture);
    assert.equal(dispatched.stdout.trim(), `${aibFixture.command} ${aibFixture.version} status --json`);
  });

  it("applies install end to end from packed tarballs and is a no-op on the second run", async () => {
    const root = await createTempRoot("qube-install-apply-smoke-");
    const packDir = path.join(root, "pack");
    const installer = path.join(root, "installer");
    const target = path.join(root, "blank");
    const tools = path.join(root, "tools");
    const packageRootDir = path.join(root, "qube-root");
    await mkdir(packDir);
    await mkdir(installer);
    await mkdir(target);
    await mkdir(tools);

    const qubeTarball = await packPackage(packageRoot, packDir);
    const githubAdapterRoot = path.resolve(packageRoot, "..", "..", "adapters", "github");
    const githubTarball = await packPackage(githubAdapterRoot, packDir);
    const claudeCodeAdapterTarball = await packPackage(claudeCodeAdapterRoot, packDir);
    const qubeCliTarball = await packPackage(qubeCliRoot, packDir);
    const qubeCoreTarball = await packPackage(qubeCoreRoot, packDir);
    const tarballByName = new Map([
      [qubePackageName, qubeTarball],
      ["@tjalve/qube-adapter-github", githubTarball]
    ]);
    for (const component of fakeComponents) {
      tarballByName.set(component.name, await createFakeComponentTarball(component, root, packDir));
    }

    await writeFile(
      path.join(installer, "package.json"),
      `${JSON.stringify({
        private: true,
        packageManager: "pnpm@11.0.4",
        dependencies: { [qubePackageName]: fileSpecifier(installer, qubeTarball) }
      }, null, 2)}\n`
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
        `          "@tjalve/qube-adapter-claude-code": ${JSON.stringify(fileSpecifier(installer, claudeCodeAdapterTarball))},`,
        `          "@tjalve/qube-cli": ${JSON.stringify(fileSpecifier(installer, qubeCliTarball))},`,
        `          "@tjalve/qube-core": ${JSON.stringify(fileSpecifier(installer, qubeCoreTarball))},`,
        ...fakeComponents.map(component =>
          `          ${JSON.stringify(component.name)}: ${JSON.stringify(fileSpecifier(installer, tarballByName.get(component.name)))},`
        ),
        "        };",
        "      }",
        "      if (pkg.name === '@tjalve/qube-adapter-claude-code' || pkg.name === '@tjalve/qube-adapter-github') {",
        "        pkg.dependencies = {",
        "          ...pkg.dependencies,",
        `          "@tjalve/qube-core": ${JSON.stringify(fileSpecifier(installer, qubeCoreTarball))},`,
        "        };",
        "      }",
        "      return pkg;",
        "    },",
        "  },",
        "};",
        ""
      ].join("\n")
    );
    await runPnpm(["install", "--ignore-scripts"], installer);

    const registryPath = path.join(root, "registry.json");
    const packuments = {
      [qubePackageName]: createPassingPackument(qubePackageName, qubePackageVersion)
    };
    for (const [name, version] of Object.entries(adapterPackageVersions)) {
      packuments[name] = createPassingPackument(name, version);
    }
    await writeFile(registryPath, `${JSON.stringify(packuments)}\n`);

    const pmLog = path.join(root, "pm.log");
    await writeApplyComponentStubs(packageRootDir);
    await writeApplyPnpmShim(tools, { tarballByName });

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
      "generic",
      "--work-provider",
      "github",
      "--ci-provider",
      "github",
      "--lifecycle-scripts",
      "disabled",
      "--docs",
      "--migration",
      "none"
    ];
    const env = {
      ...process.env,
      PATH: `${tools}${path.delimiter}${process.env.PATH ?? ""}`,
      QUBE_TEST_PACKAGE_ROOT: packageRootDir,
      QUBE_TEST_PM_LOG: pmLog,
      QUBE_TEST_INSTALL_PACKAGES: registryPath
    };
    const qubeBin = path.join(installer, "node_modules", qubePackageName, "dist", "bin", "qube.js");
    const first = await runPackedQube(qubeBin, applyArgs, { cwd: target, env });
    const firstParsed = JSON.parse(first.stdout);
    assert.equal(firstParsed.ok, true, `${first.stdout}\n${first.stderr}`);
    assert.equal(firstParsed.installPlan.mode, "apply");
    assert.deepEqual(firstParsed.apply.executed.map(step => step.stage), ["package-install", "workspace-init"]);
    assert.equal(firstParsed.apply.executed.every(step => step.status === "executed"), true);
    const pmCommands = (await readFile(pmLog, "utf8")).trim();
    assert.match(pmCommands, /--ignore-scripts/);
    assert.match(pmCommands, /--save-exact/);
    assert.equal(pmCommands.split(/\s+/).includes("latest"), false);
    assert.match(pmCommands, new RegExp(`${qubePackageName.replace("/", "\\/")}@${qubePackageVersion}`));
    assert.match(pmCommands, /@tjalve\/qube-adapter-github@/);

    const manifest = JSON.parse(await readFile(path.join(target, "package.json"), "utf8"));
    assert.equal(manifest.devDependencies[qubePackageName], qubePackageVersion);
    assert.equal(manifest.devDependencies["@tjalve/qube-adapter-github"], adapterPackageVersions["@tjalve/qube-adapter-github"]);
    assert.equal(existsSync(path.join(target, ".qube", "aie", "config.json")), true);
    assert.equal(firstParsed.apply.components.ok, true);
    assert.equal(firstParsed.apply.components.command, "components");
    assert.ok(Array.isArray(firstParsed.apply.components.components));
    assert.equal(typeof firstParsed.apply.doctor, "object");
    assert.ok(firstParsed.apply.doctor !== null);

    const second = await runPackedQube(qubeBin, applyArgs, { cwd: target, env });
    const secondParsed = JSON.parse(second.stdout);
    assert.equal(secondParsed.ok, true, `${second.stdout}\n${second.stderr}`);
    assert.deepEqual(secondParsed.apply.executed, []);
    assert.equal((await readFile(pmLog, "utf8")).trim().split(/\r?\n/).length, 1);
  });
});

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
    }
  };
  await writeNodeShim(binDir, "aie", `
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2).join(" ");
if (args.includes("init")) {
  mkdirSync(path.join(process.cwd(), ".qube", "aie"), { recursive: true });
  writeFileSync(path.join(process.cwd(), ".qube", "aie", "config.json"), ${JSON.stringify(`${JSON.stringify(initConfig, null, 2)}\n`)});
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
    review: { state: "fallback-only", fallbackPromptAvailable: true, fallbackEnforcesReview: false },
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

async function writeApplyPnpmShim(toolsDir, input) {
  const script = `
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const log = process.env.QUBE_TEST_PM_LOG;
if (log) appendFileSync(log, args.join(" ") + "\\n");
if (!args.includes("--ignore-scripts")) {
  process.stderr.write("apply smoke pnpm requires --ignore-scripts\\n");
  process.exit(1);
}
if (!args.includes("--save-exact")) {
  process.stderr.write("apply smoke pnpm requires --save-exact\\n");
  process.exit(1);
}
const tarballs = ${JSON.stringify(Object.fromEntries(input.tarballByName))};
const specs = args.flatMap((token) => {
  const match = token.match(/^(@[^/]+\\/[^@]+)@(\\d+\\.\\d+\\.\\d+)$/);
  return match ? [{ name: match[1], version: match[2] }] : [];
});
if (specs.length === 0) process.exit(0);
const manifestPath = path.join(process.cwd(), "package.json");
const manifest = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, "utf8"))
  : { name: "blank-app", version: "0.0.0", private: true, devDependencies: {} };
manifest.devDependencies = manifest.devDependencies ?? {};
for (const spec of specs) {
  if (!tarballs[spec.name]) {
    process.stderr.write("missing local tarball for " + spec.name + "\\n");
    process.exit(1);
  }
  manifest.devDependencies[spec.name] = spec.version;
  const dir = path.join(process.cwd(), "node_modules", ...spec.name.split("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: spec.name, version: spec.version }, null, 2) + "\\n");
  if (spec.name === ${JSON.stringify(qubePackageName)}) {
    const binDir = path.join(process.cwd(), "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });
    const scriptBody = "process.stdout.write(JSON.stringify({ ok: true, command: \\"components\\", components: [{ id: \\"executor\\" }] }) + \\"\\\\n\\");";
    writeFileSync(path.join(binDir, "qube.mjs"), scriptBody);
    if (process.platform === "win32") {
      writeFileSync(path.join(binDir, "qube.cmd"), "@echo off\\r\\nnode \\"%~dp0qube.mjs\\" %*\\r\\n");
    } else {
      writeFileSync(path.join(binDir, "qube"), "#!/usr/bin/env node\\n" + scriptBody);
      chmodSync(path.join(binDir, "qube"), 0o755);
    }
  }
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\\n");
`;
  await writeFile(path.join(toolsDir, "pnpm.mjs"), script);
  await writeFile(path.join(toolsDir, "pnpm.cmd"), `@echo off\r\nnode "%~dp0pnpm.mjs" %*\r\n`);
  if (process.platform !== "win32") {
    await writeFile(path.join(toolsDir, "pnpm"), `#!/usr/bin/env node\n${script}`);
    await chmod(path.join(toolsDir, "pnpm"), 0o755);
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
      "export function validateConfig(config) { return { ok: true, errors: [], config }; }\n"
    );
  }
  await writeFile(
    path.join(componentRoot, "package.json"),
    `${JSON.stringify(
      {
        name: component.name,
        version: component.version,
        type: "module",
        ...(["@tjalve/aib", "@tjalve/aie"].includes(component.name) ? {
          main: "index.js",
          exports: {
            ".": "./index.js"
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
