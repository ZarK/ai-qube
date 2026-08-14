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

function fileDigest(filePath) {
  if (!existsSync(filePath) || !lstatSync(filePath).isFile() || lstatSync(filePath).isSymbolicLink()) {
    return null;
  }
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

export function listGeneratedTarballs(repoRoot) {
  const found = [];
  for (const relativeDir of CLEANUP_PACKAGE_DIRS) {
    const dir = path.join(repoRoot, relativeDir);
    if (!existsSync(dir) || !lstatSync(dir).isDirectory()) continue;
    if (escapesRoot(repoRoot, dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !TARBALL_NAME.test(entry.name)) continue;
      const tarballPath = path.join(dir, entry.name);
      if (escapesRoot(repoRoot, tarballPath)) continue;
      found.push(path.join(relativeDir, entry.name));
    }
  }
  return found;
}

export function snapshotGeneratedTarballs(repoRoot) {
  const snapshot = new Map();
  for (const relativePath of listGeneratedTarballs(repoRoot)) {
    snapshot.set(relativePath, fileDigest(path.join(repoRoot, relativePath)));
  }
  return snapshot;
}

function normalizePreservedTarballs(preserveTarballs) {
  if (preserveTarballs instanceof Map) return preserveTarballs;
  const snapshot = new Map();
  for (const entry of preserveTarballs ?? []) {
    if (typeof entry === "string") snapshot.set(entry, true);
    else if (entry?.relativePath) snapshot.set(entry.relativePath, entry.digest ?? true);
  }
  return snapshot;
}

function parseRestorePayload(stdout) {
  const lines = String(stdout ?? "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {
      // Keep scanning for the last JSON object.
    }
  }
  return null;
}

function assertCheckoutRegularFile(repoRoot, candidate, label) {
  if (escapesRoot(repoRoot, candidate)) {
    throw Object.assign(new Error(`${label} resolves outside the repository root.`), { reasonCode: "path-escape" });
  }
  if (!existsSync(candidate)) return candidate;
  if (lstatSync(candidate).isSymbolicLink()) {
    throw Object.assign(new Error(`${label} is a symlink.`), { reasonCode: "path-escape" });
  }
  if (escapesRoot(repoRoot, candidate)) {
    throw Object.assign(new Error(`${label} resolves outside the repository root.`), { reasonCode: "path-escape" });
  }
  return candidate;
}

function restorePublishManifest(repoRoot, packageJsonPath) {
  const restoreScript = path.join(repoRoot, "scripts", "restore-publish-dependencies.mjs");
  const backupPath = `${packageJsonPath}.publish-backup`;
  if (!existsSync(backupPath)) return false;
  assertCheckoutRegularFile(repoRoot, backupPath, "publish backup");
  if (existsSync(packageJsonPath)) {
    assertCheckoutRegularFile(repoRoot, packageJsonPath, "package.json");
  } else if (escapesRoot(repoRoot, packageJsonPath)) {
    throw Object.assign(new Error("package.json resolves outside the repository root."), { reasonCode: "path-escape" });
  }
  if (existsSync(restoreScript)) {
    const restored = spawnSync(process.execPath, [restoreScript, packageJsonPath], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const payload = parseRestorePayload(restored.stdout);
    if (restored.status !== 0 || payload?.ok !== true || payload?.restored !== true) {
      throw Object.assign(
        new Error((restored.stderr ?? "").trim() || `Failed to restore ${packageJsonPath}.`),
        { reasonCode: "restore-failed" }
      );
    }
    return true;
  }
  if (existsSync(packageJsonPath)) {
    writeFileSync(packageJsonPath, readFileSync(backupPath));
    unlinkSync(backupPath);
    return true;
  }
  return false;
}

export function cleanupGeneratedInstallArtifacts(repoRoot, preserveTarballs = new Map()) {
  const restoredManifests = [];
  const removedTarballs = [];
  const preserved = normalizePreservedTarballs(preserveTarballs);
  for (const relativeDir of CLEANUP_PACKAGE_DIRS) {
    const dir = path.join(repoRoot, relativeDir);
    if (!existsSync(dir) || !lstatSync(dir).isDirectory()) continue;
    if (escapesRoot(repoRoot, dir)) continue;
    const packageJsonPath = path.join(dir, "package.json");
    if (restorePublishManifest(repoRoot, packageJsonPath)) {
      restoredManifests.push(relativeDir);
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !TARBALL_NAME.test(entry.name)) continue;
      const relativeTarball = path.join(relativeDir, entry.name);
      const tarballPath = path.join(dir, entry.name);
      if (escapesRoot(repoRoot, tarballPath)) continue;
      const expected = preserved.get(relativeTarball);
      if (expected === true || (typeof expected === "string" && expected === fileDigest(tarballPath))) {
        continue;
      }
      unlinkSync(tarballPath);
      removedTarballs.push(relativeTarball);
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

export function quotePosixShellArg(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function rejectSymlinkInstallPath(candidate, prefix, label) {
  if (!existsSync(candidate)) return;
  if (lstatSync(candidate).isSymbolicLink()) {
    throw Object.assign(new Error(`${label} is a symlink.`), { reasonCode: "path-escape" });
  }
  if (escapesRoot(prefix, candidate)) {
    throw Object.assign(new Error(`${label} resolves outside the install prefix.`), { reasonCode: "path-escape" });
  }
}

export function assertPrefixOutsideCheckout(repoRoot, prefix) {
  const realRepo = existsSync(repoRoot) ? realpathSync.native(repoRoot) : path.resolve(repoRoot);
  const resolvedPrefix = path.resolve(prefix);
  const realPrefix = existsSync(resolvedPrefix) ? realpathSync.native(resolvedPrefix) : resolvedPrefix;
  const relative = path.relative(realRepo, realPrefix);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw Object.assign(new Error("Install prefix must be outside the source checkout."), {
      reasonCode: "prefix-inside-checkout",
    });
  }
}

function writeBinShim(binDir, command, scriptPath, prefix) {
  rejectSymlinkInstallPath(binDir, prefix, "install bin directory");
  mkdirSync(binDir, { recursive: true });
  rejectSymlinkInstallPath(binDir, prefix, "install bin directory");
  const unixPath = path.join(binDir, command);
  const windowsPath = path.join(binDir, `${command}.cmd`);
  rejectSymlinkInstallPath(unixPath, prefix, `${command} shim`);
  rejectSymlinkInstallPath(windowsPath, prefix, `${command} shim`);
  const unixBody = [
    "#!/bin/sh",
    `exec ${quotePosixShellArg(process.execPath)} ${quotePosixShellArg(scriptPath)} "$@"`,
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
  const result = spawnSync("git", ["status", "--porcelain"], {
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

export function handleInstallInterrupt(onInterrupt, signal) {
  try {
    onInterrupt(signal);
  } catch {
    // Signal handlers must not throw.
  }
}

export function bindInstallInterruptCleanup(onInterrupt) {
  const handler = (signal) => {
    handleInstallInterrupt(onInterrupt, signal);
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  return () => {
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
  };
}

function prefixCommandPath(binDir, command) {
  const names = process.platform === "win32" ? [`${command}.cmd`, command] : [command];
  return names.map(name => path.join(binDir, name)).find(candidate => existsSync(candidate)) ?? null;
}

function verifyCommandOnPath(command, childPath, cwd, binDir) {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  const located = spawnSync(locator, [command], {
    cwd,
    env: { ...process.env, PATH: childPath },
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  if (located.status !== 0) {
    throw Object.assign(new Error(`Fresh shell cannot resolve ${command} on PATH.`), {
      reasonCode: "verify-failed",
      command,
    });
  }
  const shim = prefixCommandPath(binDir, command);
  if (!shim) {
    throw Object.assign(new Error(`Missing ${command} shim in the install prefix.`), {
      reasonCode: "missing-component",
      command,
    });
  }
  const invoked = spawnSync(command, ["--help"], {
    cwd,
    env: { ...process.env, PATH: childPath },
    encoding: "utf8",
    shell: process.platform === "win32",
    timeout: 30_000,
    windowsHide: true,
  });
  if (invoked.status !== 0) {
    throw Object.assign(
      new Error((invoked.stderr ?? "").trim() || (invoked.stdout ?? "").trim() || `${command} --help failed in a fresh shell.`),
      { reasonCode: "verify-failed", command }
    );
  }
}

function verifyComponentVersions(repoRoot, envelope) {
  const rows = Array.isArray(envelope.components) ? envelope.components : [];
  const checked = [];
  for (const component of COMPONENT_LINKS) {
    const packageDir = assertSourcePathSafe(repoRoot, component.packageDir, component.id);
    const manifestPath = path.join(packageDir, "package.json");
    if (!existsSync(manifestPath)) {
      throw Object.assign(new Error(`Missing ${component.id} package.json.`), {
        reasonCode: "version-mismatch",
        command: component.command,
      });
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const row = rows.find(item =>
      item?.packageName === manifest.name && item?.command === component.command
    );
    if (!row) {
      throw Object.assign(
        new Error(`Installed composer did not report ${component.command} in the components envelope.`),
        { reasonCode: "version-mismatch", command: component.command }
      );
    }
    if (!row.packageVersion || row.packageVersion !== manifest.version) {
      throw Object.assign(
        new Error(`Installed ${component.command} version does not match the checkout.`),
        { reasonCode: "version-mismatch", command: component.command }
      );
    }
    checked.push({ command: component.command, packageName: manifest.name, packageVersion: manifest.version });
  }
  return checked;
}

function verifyFreshShell(prefix, repoRoot, qubeScriptPath, commands) {
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
      new Error((doctor.stderr ?? "").trim() || (doctor.stdout ?? "").trim() || "qube doctor --json failed in a fresh shell."),
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
  parsed.componentVersions = verifyComponentVersions(repoRoot, parsed);
  const resolvedCommands = [];
  for (const command of commands) {
    verifyCommandOnPath(command, childPath, cwd, binDir);
    resolvedCommands.push(command);
  }
  parsed.resolvedCommands = resolvedCommands;
  return parsed;
}

export async function runLocalQubeInstall(input = {}) {
  const repoRoot = resolveRepoRoot(input.repoRoot);
  const prefix = path.resolve(input.prefix ?? defaultInstallPrefix(input.env ?? process.env));
  const lockDir = input.lockDir ?? os.tmpdir();
  const startedGit = trackedGitStatus(repoRoot);
  let lock;
  let detachSignals;
  let preserveTarballs = new Map();
  const report = {
    ok: false,
    command: "install:qube:local",
    repoRoot,
    prefix,
    linked: [],
    cleaned: { restoredManifests: [], removedTarballs: [] },
  };
  const interruptCleanup = () => {
    report.cleaned = cleanupGeneratedInstallArtifacts(repoRoot, preserveTarballs);
    lock?.release();
  };
  try {
    lock = acquireInstallLock(repoRoot, lockDir);
    assertPrefixOutsideCheckout(repoRoot, prefix);
    preserveTarballs = snapshotGeneratedTarballs(repoRoot);
    detachSignals = bindInstallInterruptCleanup(interruptCleanup);
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
      writeBinShim(binDir, component.command, resolved.binPath, prefix);
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
    report.components = verifyFreshShell(prefix, repoRoot, qubeScriptPath, report.linked);
    report.cleaned = cleanupGeneratedInstallArtifacts(repoRoot, preserveTarballs);
    const finishedGit = trackedGitStatus(repoRoot);
    if (finishedGit !== startedGit) {
      throw Object.assign(new Error("Local install left tracked files dirty."), { reasonCode: "dirty-worktree" });
    }
    report.ok = true;
    return report;
  } catch (error) {
    try {
      report.cleaned = cleanupGeneratedInstallArtifacts(repoRoot, preserveTarballs);
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
    detachSignals?.();
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
