import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const monorepoRoot = path.resolve(repoRoot, "../..");
const qubeCliRoot = path.join(monorepoRoot, "packages/qube-cli");
const qubeCoreRoot = path.join(monorepoRoot, "packages/qube-core");
const runtimePackageRoots = [
  ["@tjalve/qube-cli", qubeCliRoot],
  ["@tjalve/qube-core", qubeCoreRoot],
  ["@tjalve/qube-adapter-codex", path.join(monorepoRoot, "adapters/codex")],
  ["@tjalve/qube-adapter-claude-code", path.join(monorepoRoot, "adapters/claude-code")],
  ["@tjalve/qube-adapter-opencode", path.join(monorepoRoot, "adapters/opencode")],
  ["@tjalve/qube-adapter-grok-build", path.join(monorepoRoot, "adapters/grok-build")],
] as const;
const tempRoots: string[] = [];

const expectedHostAssets = [
  ".opencode/plugins/ai-umpire-continuation.ts",
  ".opencode/package.json",
  ".agents/plugins/marketplace.json",
  "plugins/ai-umpire/.codex-plugin/plugin.json",
  "plugins/ai-umpire/hooks/hooks.json",
  "plugins/ai-umpire/skills/ai-umpire/SKILL.md",
  ".claude/settings.json",
  ".grok/hooks/ai-umpire.json",
] as const;

describe("packed tarball install smoke", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("installs the profile-driven package surface and initializes every supported Umpire harness", async () => {
    const root = await createTempRoot("aiu-install-smoke-");
    const packDir = path.join(root, "pack");
    const target = path.join(root, "repo");
    await mkdir(packDir);
    await mkdir(target);
    const packedPackages: PackedPackage[] = [await packRuntimePackage("@tjalve/aiu", repoRoot, packDir)];
    for (const [name, packageRoot] of runtimePackageRoots) {
      packedPackages.push(await packRuntimePackage(name, packageRoot, packDir));
    }
    await createLockedBlankRepo(target, packedPackages);

    await runPnpm(["fetch", "--frozen-lockfile", "--ignore-scripts"], target);
    await rm(path.join(target, "node_modules"), { recursive: true, force: true });
    await runPnpm(["install", "--frozen-lockfile", "--ignore-scripts", "--offline"], target);
    const installedCommand = path.join(target, "node_modules", ".bin", process.platform === "win32" ? "aiu.cmd" : "aiu");
    assert.equal(existsSync(installedCommand), true, "pnpm must create the AIU command shim during install");
    const result = await runPnpm(["exec", "aiu", "init", "--json"], target);
    const parsed = JSON.parse(result.stdout) as InitEnvelope;

    assert.equal(parsed.ok, true);
    assert.equal(parsed.command, "init");
    assert.equal(parsed.init.ok, true);
    assert.equal(parsed.init.dryRun, false);
    assert.deepEqual(parsed.init.tools, ["opencode", "codex", "claude-code", "grok-build"]);
    assert.deepEqual(
      parsed.init.hostProfiles.map((profile) => [profile.tool, profile.supportLevel, profile.currentIssueRecovery]),
      [
        ["opencode", "supported", true],
        ["codex", "experimental", true],
        ["claude-code", "experimental", true],
        ["grok-build", "experimental", true],
      ],
    );
    assert.deepEqual(parsed.init.files.map((file) => file.relativePath.replaceAll("\\", "/")), expectedHostAssets);
    assert.equal(parsed.init.files.every((file) => file.operation === "create"), true);
    assert.equal(parsed.init.config.operation, "create");
    for (const relativePath of expectedHostAssets) {
      assert.equal(existsSync(path.join(target, ...relativePath.split("/"))), true, relativePath);
    }
    const opencodeWrapper = await readFile(path.join(target, ".opencode", "plugins", "ai-umpire-continuation.ts"), "utf8");
    const opencodeManifest = JSON.parse(await readFile(path.join(target, ".opencode", "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    assert.match(opencodeWrapper, /export const AiuUmpireContinuation = createAiuOpenCodeServerPlugin\(\)/);
    assert.doesNotMatch(opencodeWrapper, /export default/);
    assert.match(
      await readFile(path.join(target, "plugins", "ai-umpire", "hooks", "hooks.json"), "utf8"),
      /aiu hook-stop --tool codex/,
    );
    assert.match(
      await readFile(path.join(target, ".claude", "settings.json"), "utf8"),
      /aiu hook-stop --tool claude-code/,
    );
    assert.match(
      await readFile(path.join(target, ".grok", "hooks", "ai-umpire.json"), "utf8"),
      /aiu hook-stop --tool grok-build/,
    );

    const config = JSON.parse(await readFile(path.join(target, ".qube", "aiu", "config.json"), "utf8")) as {
      hosts: {
        enabled: string[];
        modes: Record<string, string[]>;
        stopHookBlocking: Record<string, boolean>;
      };
    };
    assert.deepEqual(config.hosts.enabled, ["opencode", "codex", "claude-code", "grok-build"]);
    assert.deepEqual(config.hosts.modes.opencode, ["continue", "repair", "wait", "stop"]);
    for (const host of ["codex", "claude-code", "grok-build"]) {
      assert.deepEqual(config.hosts.modes[host], ["continue", "repair", "stop"], host);
    }
    assert.deepEqual(config.hosts.stopHookBlocking, {
      opencode: false,
      codex: true,
      "claude-code": true,
      "grok-build": true,
    });

    const installedAiuRoot = await realpath(path.join(target, "node_modules", "@tjalve", "aiu"));
    const installedAiuManifest = JSON.parse(
      await readFile(path.join(installedAiuRoot, "package.json"), "utf8"),
    ) as { bin?: Record<string, string>; version: string };
    const installedLauncher = path.join(installedAiuRoot, "bin", "run");
    assert.deepEqual(installedAiuManifest.bin, { aiu: "bin/run" });
    assert.equal(opencodeManifest.dependencies["@tjalve/aiu"], installedAiuManifest.version);
    assert.equal(existsSync(installedLauncher), true);
    assert.match(await readFile(installedLauncher, "utf8"), /\.\.\/dist\/src\/cli\.js/);
    if (process.platform !== "win32") {
      assert.notEqual((await stat(installedLauncher)).mode & 0o111, 0, "the packed launcher must be executable");
    }
    for (const packedPackage of packedPackages) {
      const installedPackageRoot = packedPackage.name === "@tjalve/aiu"
        ? installedAiuRoot
        : path.join(path.dirname(installedAiuRoot), packedPackage.name.slice("@tjalve/".length));
      const installedManifest = JSON.parse(
        await readFile(path.join(installedPackageRoot, "package.json"), "utf8"),
      ) as { version: string };
      assert.equal(installedManifest.version, packedPackage.manifest.version, packedPackage.name);
    }
    const installedDoctor = await import(pathToFileURL(path.join(installedAiuRoot, "dist", "src", "doctor.js")).href) as {
      runAiuDoctor(options: { cwd: string }): { checks: Array<{ kind: string; status: string }> };
    };
    const doctor = installedDoctor.runAiuDoctor({ cwd: target });
    assert.ok(
      doctor.checks.some((check) => check.kind === "opencode-plugin-package-resolved" && check.status === "ok"),
      JSON.stringify(doctor.checks.filter((check) => check.kind.includes("opencode-plugin-package"))),
    );
    assert.equal(existsSync(path.join(target, "node_modules", "@tjalve", "qube-adapter-cursor")), false);
  });
});

interface InitEnvelope {
  readonly ok: boolean;
  readonly command: string;
  readonly init: {
    readonly ok: boolean;
    readonly dryRun: boolean;
    readonly tools: string[];
    readonly hostProfiles: Array<{ tool: string; supportLevel: string; currentIssueRecovery: boolean }>;
    readonly files: Array<{ relativePath: string; operation: string }>;
    readonly config: { operation: string };
  };
}

interface PackageManifest {
  readonly name: string;
  readonly version: string;
  readonly engines?: Record<string, string>;
  readonly bin?: Record<string, string> | string;
  readonly dependencies?: Record<string, string>;
}

interface PackedPackage {
  readonly name: string;
  readonly tarball: string;
  readonly manifest: PackageManifest;
}

async function packPackage(packageRoot: string, packDir: string): Promise<string> {
  const result = await runPnpm(["pack", "--pack-destination", packDir], packageRoot);
  const packedName = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.endsWith(".tgz"));

  assert.ok(packedName, `pnpm pack did not print a tarball name: ${result.stdout}`);
  return path.isAbsolute(packedName) ? packedName : path.join(packDir, packedName);
}

async function packRuntimePackage(name: string, packageRoot: string, packDir: string): Promise<PackedPackage> {
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")) as PackageManifest;
  assert.equal(manifest.name, name);
  return { name, tarball: await packPackage(packageRoot, packDir), manifest };
}

async function createLockedBlankRepo(target: string, packedPackages: readonly PackedPackage[]): Promise<void> {
  await mkdir(path.join(target, ".git"));
  const aiuPackage = packedPackages.find((candidate) => candidate.name === "@tjalve/aiu");
  assert.ok(aiuPackage);
  const aiuSpecifier = fileSpecifier(target, aiuPackage.tarball);
  await writeFile(
    path.join(target, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        packageManager: "pnpm@11.0.4",
        devDependencies: {
          "@tjalve/aiu": aiuSpecifier,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(path.join(target, ".npmrc"), "ignore-scripts=true\nsave-exact=true\n", "utf8");
  await writeFile(
    path.join(target, "pnpm-lock.yaml"),
    await buildSmokeLockfile(target, packedPackages),
    "utf8",
  );
}

async function createTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function buildSmokeLockfile(
  target: string,
  packedPackages: readonly PackedPackage[],
): Promise<string> {
  const rootLock = (await readFile(path.join(repoRoot, "pnpm-lock.yaml"), "utf8")).replace(/\r\n/g, "\n");
  const lockfileVersion = readLockfileVersion(rootLock);
  const packages = readLockfileSection(rootLock, "packages", "snapshots");
  const snapshots = readLockfileSection(rootLock, "snapshots");
  const packedByName = new Map(packedPackages.map((packedPackage) => [packedPackage.name, packedPackage]));
  const specifierByName = new Map(
    packedPackages.map((packedPackage) => [packedPackage.name, fileSpecifier(target, packedPackage.tarball)]),
  );
  const aiuSpecifier = specifierByName.get("@tjalve/aiu");
  assert.ok(aiuSpecifier);
  const localPackageEntries: string[] = [];
  const localSnapshotEntries: string[] = [];
  for (const packedPackage of packedPackages) {
    const specifier = specifierByName.get(packedPackage.name);
    assert.ok(specifier);
    const integrity = `sha512-${createHash("sha512").update(await readFile(packedPackage.tarball)).digest("base64")}`;
    localPackageEntries.push(renderPackedPackageEntry(packedPackage, specifier, integrity));
    const dependencies = Object.fromEntries(
      Object.entries(packedPackage.manifest.dependencies ?? {}).map(([name, version]) => [
        name,
        packedByName.has(name) ? specifierByName.get(name) : version,
      ]),
    ) as Record<string, string>;
    localSnapshotEntries.push([
      `  '${packedPackage.name}@${specifier}':`,
      renderSnapshotDependencies(dependencies),
    ].join("\n"));
  }

  return [
    `lockfileVersion: ${lockfileVersion}`,
    "",
    "settings:",
    "  autoInstallPeers: true",
    "  excludeLinksFromLockfile: false",
    "",
    "importers:",
    "",
    "  .:",
    "    devDependencies:",
    "      '@tjalve/aiu':",
    `        specifier: ${aiuSpecifier}`,
    `        version: ${aiuSpecifier}`,
    "",
    "packages:",
    "",
    localPackageEntries.join("\n\n"),
    "",
    packages,
    "snapshots:",
    "",
    localSnapshotEntries.join("\n\n"),
    "",
    snapshots,
  ].join("\n");
}

function renderPackedPackageEntry(packedPackage: PackedPackage, specifier: string, integrity: string): string {
  return [
    `  '${packedPackage.name}@${specifier}':`,
    `    resolution: {integrity: ${integrity}, tarball: ${specifier}}`,
    `    version: ${packedPackage.manifest.version}`,
    ...(packedPackage.manifest.engines === undefined
      ? []
      : [`    engines: ${renderInlineYamlRecord(packedPackage.manifest.engines)}`]),
    ...(packedPackage.manifest.bin === undefined ? [] : ["    hasBin: true"]),
  ].join("\n");
}

function fileSpecifier(fromDir: string, filePath: string): string {
  return `file:${path.relative(fromDir, filePath).split(path.sep).join("/")}`;
}

function renderInlineYamlRecord(record: Record<string, string>): string {
  const entries = Object.entries(record);
  assert.notEqual(entries.length, 0, "Expected at least one inline YAML record entry");
  return `{${entries.map(([key, value]) => `${key}: '${value}'`).join(", ")}}`;
}

function renderSnapshotDependencies(dependencies: Record<string, string>): string {
  const entries = Object.entries(dependencies);
  if (entries.length === 0) {
    return "    dependencies: {}";
  }
  return [
    "    dependencies:",
    ...entries.map(([name, version]) => `      '${name}': ${version}`),
  ].join("\n");
}

function readLockfileVersion(lockfile: string): string {
  const match = /^lockfileVersion:\s*(.+)$/m.exec(lockfile);
  assert.ok(match?.[1], "Missing lockfileVersion in pnpm-lock.yaml");
  return match[1];
}

function readLockfileSection(lockfile: string, heading: "packages" | "snapshots", nextHeading?: "snapshots"): string {
  const startMarker = `${heading}:\n\n`;
  const start = lockfile.indexOf(startMarker);
  assert.notEqual(start, -1, `Missing ${heading} section in pnpm-lock.yaml`);
  const contentStart = start + startMarker.length;
  const contentEnd = nextHeading === undefined ? lockfile.length : lockfile.indexOf(`\n${nextHeading}:\n\n`, contentStart);
  assert.notEqual(contentEnd, -1, `Missing ${nextHeading} section in pnpm-lock.yaml`);
  return `${lockfile.slice(contentStart, contentEnd).trimEnd()}\n`;
}

async function runPnpm(args: readonly string[], cwd: string) {
  const pnpmCommand = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "pnpm";
  const pnpmArgs = process.platform === "win32" ? ["/d", "/s", "/c", "pnpm", ...args] : [...args];
  try {
    return await execFileAsync(pnpmCommand, pnpmArgs, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120_000,
    });
  } catch (error) {
    assert(error !== null && typeof error === "object");
    const failed = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    assert.fail(
      [
        `pnpm ${args.join(" ")} failed with exit code ${failed.code ?? 1}`,
        failed.stdout ?? "",
        failed.stderr ?? "",
      ].join("\n"),
    );
  }
}
