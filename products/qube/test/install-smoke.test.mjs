import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const qubeCliRoot = path.resolve(packageRoot, "..", "..", "packages", "qube-cli");
const tempRoots = [];

const fakeComponents = [
  { name: "@tjalve/aib", command: "aib", version: "0.1.0" },
  { name: "@tjalve/aie", command: "aie", version: "0.1.3" },
  { name: "@tjalve/aiq", command: "aiq", version: "0.2.1" },
  { name: "@tjalve/aiu", command: "aiu", version: "0.0.3" }
];

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
    const qubeCliTarball = await packPackage(qubeCliRoot, packDir);
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
        `          "@tjalve/qube-cli": ${JSON.stringify(fileSpecifier(target, qubeCliTarball))},`,
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

    const components = await runPnpm(["exec", "qube", "components", "--json"], target);
    assert.deepEqual(
      JSON.parse(components.stdout).components.map(component => [
        component.id,
        component.command,
        component.packageName,
        component.packageVersion
      ]),
      [
        ["bootstrap", "aib", "@tjalve/aib", "0.1.0"],
        ["executor", "aie", "@tjalve/aie", "0.1.3"],
        ["quality", "aiq", "@tjalve/aiq", "0.2.1"],
        ["umpire", "aiu", "@tjalve/aiu", "0.0.3"]
      ]
    );

    const dispatched = await runPnpm(["exec", "qube", "run", "aib", "--", "status", "--json"], target);
    assert.equal(dispatched.stdout.trim(), "aib 0.1.0 status --json");
  });
});

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
  await writeFile(
    path.join(componentRoot, "package.json"),
    `${JSON.stringify(
      {
        name: component.name,
        version: component.version,
        type: "module",
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
