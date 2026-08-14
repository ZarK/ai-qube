import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const COMPONENT_LINKS = Object.freeze([
  { id: "qube", command: "qube", packageDir: "products/qube", bin: "bin/run" },
  { id: "aib", command: "aib", packageDir: "products/aib", bin: "bin/run" },
  { id: "aie", command: "aie", packageDir: "products/aie", bin: "bin/run" },
  { id: "aiu", command: "aiu", packageDir: "products/aiu", bin: "dist/src/bin/aiu.js" },
  { id: "aiq", command: "aiq", packageDir: "products/aiq/packages/cli", bin: "dist/bin/aiq.js" },
]);

export const CLEANUP_PACKAGE_DIRS = Object.freeze([
  "products/qube",
  "products/aie",
  "products/aib",
  "products/aiu",
  "packages/qube-core",
  "packages/qube-cli",
  "adapters/github",
  "adapters/codex",
  "adapters/claude-code",
  "adapters/opencode",
  "adapters/gitlab",
  "adapters/linear",
  "adapters/jira",
  "adapters/jenkins",
]);

const TARBALL_NAME = /^tjalve-.*\.tgz$/i;

export function parseLocalInstallArgs(argv) {
  const options = {
    json: false,
    help: false,
    skipBuild: false,
    prefix: undefined,
    repoRoot: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json") options.json = true;
    else if (token === "--help" || token === "-h") options.help = true;
    else if (token === "--skip-build") options.skipBuild = true;
    else if (token === "--prefix") options.prefix = requireValue(argv, index += 1, "--prefix");
    else if (token === "--repo-root") options.repoRoot = requireValue(argv, index += 1, "--repo-root");
    else {
      throw Object.assign(new Error(`Unknown argument: ${token}`), { reasonCode: "usage" });
    }
  }
  return options;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("-")) {
    throw Object.assign(new Error(`${flag} requires a value.`), { reasonCode: "usage" });
  }
  return value;
}

export function resolveInsideRoot(root, candidate, label) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, candidate);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw Object.assign(new Error(`${label} escapes the repository root.`), { reasonCode: "path-escape" });
  }
  return resolved;
}

export function assertSourcePathSafe(root, candidate, label) {
  const resolved = resolveInsideRoot(root, candidate, label);
  if (existsSync(resolved)) {
    const realRoot = realpathSync.native(root);
    const realPath = realpathSync.native(resolved);
    const relative = path.relative(realRoot, realPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw Object.assign(new Error(`${label} resolves outside the repository root.`), { reasonCode: "path-escape" });
    }
  }
  return resolved;
}

export function defaultInstallPrefix(env = process.env) {
  const configured = env.QUBE_LOCAL_INSTALL_PREFIX?.trim();
  if (configured) return path.resolve(configured);
  const npmPrefix = spawnSync("npm", ["prefix", "-g"], {
    encoding: "utf8",
    shell: process.platform === "win32",
    timeout: 15_000,
  });
  if (npmPrefix.status === 0 && npmPrefix.stdout.trim()) {
    return path.resolve(npmPrefix.stdout.trim());
  }
  return path.join(os.homedir(), ".local");
}

export function prefixBinDir(prefix) {
  return path.join(prefix, "bin");
}

export function cleanupGeneratedInstallArtifacts(repoRoot) {
  const restoredManifests = [];
  const removedTarballs = [];
  for (const relativeDir of CLEANUP_PACKAGE_DIRS) {
    const dir = path.join(repoRoot, relativeDir);
    if (!existsSync(dir) || !lstatSync(dir).isDirectory()) continue;
    if (escapesRoot(repoRoot, dir)) continue;
    const restoreScript = path.join(repoRoot, "scripts", "restore-publish-dependencies.mjs");
    const packageJsonPath = path.join(dir, "package.json");
    const backupPath = `${packageJsonPath}.publish-backup`;
    if (existsSync(backupPath) && !escapesRoot(repoRoot, backupPath)) {
      if (existsSync(restoreScript)) {
        const restored = spawnSync(process.execPath, [restoreScript, packageJsonPath], {
          cwd: repoRoot,
          encoding: "utf8",
        });
        if (restored.status !== 0) {
          throw Object.assign(
            new Error(restored.stderr.trim() || `Failed to restore ${packageJsonPath}.`),
            { reasonCode: "restore-failed" }
          );
        }
      } else if (existsSync(packageJsonPath)) {
        writeFileSync(packageJsonPath, readFileSync(backupPath));
        unlinkSync(backupPath);
      }
      restoredManifests.push(relativeDir);
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !TARBALL_NAME.test(entry.name)) continue;
      const tarballPath = path.join(dir, entry.name);
      if (escapesRoot(repoRoot, tarballPath)) continue;
      unlinkSync(tarballPath);
      removedTarballs.push(path.join(relativeDir, entry.name));
    }
  }
  return { restoredManifests, removedTarballs };
}

function escapesRoot(root, candidate) {
  try {
    const realRoot = existsSync(root) ? realpathSync.native(root) : path.resolve(root);
    const realPath = existsSync(candidate) ? realpathSync.native(candidate) : path.resolve(candidate);
    const relative = path.relative(realRoot, realPath);
    return relative.startsWith("..") || path.isAbsolute(relative);
  } catch {
    return true;
  }
}

function lockPathFor(repoRoot, lockDir) {
  const digest = createHash("sha256").update(path.resolve(repoRoot)).digest("hex").slice(0, 16);
  return path.join(lockDir, `qube-local-install-${digest}.lock`);
}

export function acquireInstallLock(repoRoot, lockDir = os.tmpdir()) {
  mkdirSync(lockDir, { recursive: true });
  const lockPath = lockPathFor(repoRoot, lockDir);
  try {
    const fd = openSync(lockPath, "wx");
    writeFileSync(fd, `${process.pid}\n`);
    closeSync(fd);
    return {
      lockPath,
      release() {
        try {
          unlinkSync(lockPath);
        } catch {
          // The lock file may already be gone after a previous cleanup.
        }
      },
    };
  } catch (error) {
    if (error && error.code === "EEXIST") {
      throw Object.assign(new Error("Another source-checkout QUBE install holds the lock."), {
        reasonCode: "lock-held",
        lockPath,
      });
    }
    throw error;
  }
}

function writeBinShim(binDir, command, scriptPath) {
  mkdirSync(binDir, { recursive: true });
  const unixPath = path.join(binDir, command);
  const windowsPath = path.join(binDir, `${command}.cmd`);
  const unixBody = [
    "#!/bin/sh",
    `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)} "$@"`,
    "",
  ].join("\n");
  writeFileSync(unixPath, unixBody);
  try {
    chmodSync(unixPath, 0o755);
  } catch {
    // Windows filesystems may reject POSIX mode bits.
  }
  writeFileSync(
    windowsPath,
    `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`
  );
  return process.platform === "win32" ? windowsPath : unixPath;
}

function trackedGitStatus(repoRoot) {
  if (!existsSync(path.join(repoRoot, ".git"))) return "";
  const result = spawnSync("git", ["status", "--porcelain", "--untracked-files=no"], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw Object.assign(new Error(result.stderr.trim() || "git status failed."), { reasonCode: "git-status" });
  }
  return result.stdout;
}

function resolveRepoRoot(requested) {
  if (!requested) {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  }
  if (requested.includes("\0")) {
    throw Object.assign(new Error("Repository root is not a valid path."), { reasonCode: "path-escape" });
  }
  const resolved = path.resolve(requested);
  if (!existsSync(resolved) || !lstatSync(resolved).isDirectory()) {
    throw Object.assign(new Error("Repository root is not a directory."), { reasonCode: "path-escape" });
  }
  const real = realpathSync.native(resolved);
  const manifestPath = path.join(real, "package.json");
  if (!existsSync(manifestPath)) {
    throw Object.assign(new Error("Repository root has no package.json."), { reasonCode: "path-escape" });
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest?.scripts?.["install:qube:local"] !== "node scripts/local-install-qube.mjs") {
    throw Object.assign(new Error("Repository root is not a QUBE source checkout."), { reasonCode: "path-escape" });
  }
  return real;
}

function runBuild(repoRoot) {
  const result = spawnSync("pnpm", ["run", "build"], {
    cwd: repoRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    throw Object.assign(new Error("Workspace build failed before local install."), { reasonCode: "build-failed" });
  }
}

function resolveComponentBin(repoRoot, component) {
  const packageDir = assertSourcePathSafe(repoRoot, component.packageDir, component.packageName ?? component.id);
  const binPath = assertSourcePathSafe(packageDir, component.bin, `${component.id} bin`);
  if (!existsSync(binPath) || !lstatSync(binPath).isFile()) {
    throw Object.assign(new Error(`Missing ${component.command} executable at ${path.relative(repoRoot, binPath)}.`), {
      reasonCode: "missing-component",
      command: component.command,
    });
  }
  return { packageDir, binPath };
}

function resolveWorkspaceCore(repoRoot, qubePackageDir) {
  const workspaceCore = assertSourcePathSafe(repoRoot, path.join("packages", "qube-core"), "qube-core");
  const fromQube = path.join(qubePackageDir, "node_modules", "@tjalve", "qube-core");
  if (!existsSync(fromQube)) {
    throw Object.assign(new Error("Installed composer cannot resolve workspace @tjalve/qube-core."), {
      reasonCode: "version-mismatch",
    });
  }
  const resolvedCore = realpathSync.native(fromQube);
  const expectedCore = realpathSync.native(workspaceCore);
  if (resolvedCore !== expectedCore) {
    throw Object.assign(
      new Error("Installed composer loaded a different @tjalve/qube-core than this checkout."),
      { reasonCode: "version-mismatch", resolvedCore, expectedCore }
    );
  }
  return resolvedCore;
}

function verifyFreshShell(prefix, repoRoot, qubeScriptPath) {
  const binDir = prefixBinDir(prefix);
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(entry => {
    const normalized = path.normalize(entry);
    return !normalized.includes(`${path.sep}node_modules${path.sep}.bin`)
      && !normalized.endsWith(`${path.sep}node_modules${path.sep}.bin`);
  });
  const childPath = [binDir, ...pathEntries].join(path.delimiter);
  const cwd = os.tmpdir();
  const result = spawnSync(process.execPath, [qubeScriptPath, "components", "--json"], {
    cwd,
    env: { ...process.env, PATH: childPath },
    encoding: "utf8",
    shell: false,
    timeout: 30_000,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw Object.assign(
      new Error((result.stderr ?? "").trim() || (result.stdout ?? "").trim() || result.error?.message || "qube components --json failed in a fresh shell."),
      { reasonCode: "verify-failed" }
    );
  }
  const doctor = spawnSync("qube", ["doctor", "--json"], {
    cwd,
    env: { ...process.env, PATH: childPath },
    encoding: "utf8",
    shell: process.platform === "win32",
    timeout: 60_000,
    windowsHide: true,
  });
  if (doctor.status !== 0) {
    throw Object.assign(
      new Error(doctor.stderr.trim() || doctor.stdout.trim() || "qube doctor --json failed in a fresh shell."),
      { reasonCode: "verify-failed" }
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw Object.assign(new Error("qube components --json did not return a JSON envelope."), {
      reasonCode: "verify-failed",
    });
  }
  if (!parsed || parsed.ok !== true || parsed.command !== "components" || !Array.isArray(parsed.components)) {
    throw Object.assign(new Error("qube components --json did not return a components envelope."), {
      reasonCode: "verify-failed",
    });
  }
  const qubeManifest = JSON.parse(readFileSync(path.join(repoRoot, "products/qube/package.json"), "utf8"));
  const qubeRow = parsed.components.find(row => row.packageName === "@tjalve/qube" || row.id === "composer" || row.command === "qube");
  if (qubeRow?.packageVersion && qubeRow.packageVersion !== qubeManifest.version) {
    throw Object.assign(new Error("Installed qube version does not match the checkout."), {
      reasonCode: "version-mismatch",
    });
  }
  const locator = process.platform === "win32" ? "where" : "which";
  const located = spawnSync(locator, ["qube"], {
    cwd,
    env: { ...process.env, PATH: childPath },
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  if (located.status !== 0) {
    throw Object.assign(new Error("Fresh shell cannot resolve qube on PATH."), { reasonCode: "verify-failed" });
  }
  return parsed;
}

export async function runLocalQubeInstall(input = {}) {
  const repoRoot = resolveRepoRoot(input.repoRoot);
  const prefix = path.resolve(input.prefix ?? defaultInstallPrefix(input.env ?? process.env));
  const lockDir = input.lockDir ?? os.tmpdir();
  const startedGit = trackedGitStatus(repoRoot);
  let lock;
  const report = {
    ok: false,
    command: "install:qube:local",
    repoRoot,
    prefix,
    linked: [],
    cleaned: { restoredManifests: [], removedTarballs: [] },
  };
  try {
    lock = acquireInstallLock(repoRoot, lockDir);
    if (input.injectFailure === "build" || input.injectFailure === "pack") {
      const qubeDir = assertSourcePathSafe(repoRoot, "products/qube", "qube package");
      mkdirSync(qubeDir, { recursive: true });
      const packageJsonPath = path.join(qubeDir, "package.json");
      if (existsSync(packageJsonPath) && !existsSync(`${packageJsonPath}.publish-backup`)) {
        writeFileSync(`${packageJsonPath}.publish-backup`, readFileSync(packageJsonPath));
        const rewritten = JSON.parse(readFileSync(packageJsonPath, "utf8"));
        rewritten._localInstallRewrite = true;
        writeFileSync(packageJsonPath, `${JSON.stringify(rewritten, null, 2)}\n`);
      }
      if (input.injectFailure === "pack") {
        writeFileSync(path.join(qubeDir, `tjalve-qube-0.0.0.tgz`), "not-a-tarball\n");
      }
      throw Object.assign(new Error(`Injected ${input.injectFailure} failure.`), {
        reasonCode: input.injectFailure === "build" ? "build-failed" : "pack-failed",
      });
    }
    if (!input.skipBuild) {
      runBuild(repoRoot);
    }
    const binDir = prefixBinDir(prefix);
    mkdirSync(binDir, { recursive: true });
    let qubePackageDir;
    let qubeScriptPath;
    for (const component of COMPONENT_LINKS) {
      const resolved = resolveComponentBin(repoRoot, component);
      if (component.command === "qube") {
        qubePackageDir = resolved.packageDir;
        qubeScriptPath = resolved.binPath;
      }
      writeBinShim(binDir, component.command, resolved.binPath);
      report.linked.push(component.command);
    }
    const missing = COMPONENT_LINKS
      .filter(component => !existsSync(path.join(binDir, process.platform === "win32" ? `${component.command}.cmd` : component.command)));
    if (missing.length > 0) {
      throw Object.assign(new Error(`Missing component executable: ${missing.map(item => item.command).join(", ")}.`), {
        reasonCode: "missing-component",
      });
    }
    if (!qubePackageDir || !qubeScriptPath) {
      throw Object.assign(new Error("Missing qube executable."), { reasonCode: "missing-component" });
    }
    report.coreModule = resolveWorkspaceCore(repoRoot, qubePackageDir);
    report.components = verifyFreshShell(prefix, repoRoot, qubeScriptPath);
    report.cleaned = cleanupGeneratedInstallArtifacts(repoRoot);
    const finishedGit = trackedGitStatus(repoRoot);
    if (finishedGit !== startedGit) {
      throw Object.assign(new Error("Local install left tracked files dirty."), { reasonCode: "dirty-worktree" });
    }
    report.ok = true;
    return report;
  } catch (error) {
    try {
      report.cleaned = cleanupGeneratedInstallArtifacts(repoRoot);
    } catch {
      // Keep the original failure. Cleanup errors must not hide it.
    }
    report.ok = false;
    report.reasonCode = error?.reasonCode ?? "failed";
    report.error = error instanceof Error ? error.message : String(error);
    const finishedGit = existsSync(path.join(repoRoot, ".git")) ? trackedGitStatus(repoRoot) : startedGit;
    if (finishedGit !== startedGit) {
      report.dirtyWorktree = true;
    }
    return report;
  } finally {
    lock?.release();
  }
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/local-install-qube.mjs [--prefix <dir>] [--json]

Build the workspace QUBE closure and link qube, aie, aib, aiu, and aiq into a user-scoped prefix.
Does not pack tarballs into the checkout. Restores publish-manifest backups and removes generated tarballs on success or failure.
`);
}

export async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseLocalInstallArgs(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
    return;
  }
  if (parsed.help) {
    printHelp();
    return;
  }
  const report = await runLocalQubeInstall(parsed);
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } else if (report.ok) {
    process.stdout.write(`Linked ${report.linked.join(", ")} into ${report.prefix}\n`);
  } else {
    process.stderr.write(`${report.error}\n`);
  }
  process.exitCode = report.ok ? 0 : report.reasonCode === "usage" ? 2 : 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const thisPath = fileURLToPath(import.meta.url);
if (invokedPath && pathToFileURL(invokedPath).href === pathToFileURL(thisPath).href) {
  await main();
}
