import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { commandPackages } from "./publish-packages.mjs";
import {
  assertPrefixOutsideCheckout,
  assertSourcePathSafe,
  prefixBinDir,
} from "./local-install-qube.mjs";

const SOURCE_RUNNER = "node products/aie/bin/run";
const ISSUE_COMMANDS = Object.freeze(["schema --json", "doctor --json", "init --dry-run --json"]);

export function parseVerifyInstalledArgs(argv) {
  const options = {
    json: false,
    help: false,
    plan: undefined,
    prefix: undefined,
    repoRoot: undefined,
    packDir: undefined,
    skipPack: false,
    commands: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json") options.json = true;
    else if (token === "--help" || token === "-h") options.help = true;
    else if (token === "--skip-pack") options.skipPack = true;
    else if (token === "--plan") options.plan = requireValue(argv, index += 1, "--plan");
    else if (token === "--prefix") options.prefix = requireValue(argv, index += 1, "--prefix");
    else if (token === "--repo-root") options.repoRoot = requireValue(argv, index += 1, "--repo-root");
    else if (token === "--pack-dir") options.packDir = requireValue(argv, index += 1, "--pack-dir");
    else if (token === "--command") {
      options.commands = options.commands ?? [];
      options.commands.push(requireValue(argv, index += 1, "--command"));
    } else {
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

export function resolveRepoRoot(requested) {
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
  return realpathSync.native(resolved);
}

export function assertPackDirOutsideCheckout(repoRoot, packDir) {
  try {
    assertPrefixOutsideCheckout(repoRoot, packDir);
  } catch (error) {
    if (error?.reasonCode === "prefix-inside-checkout") {
      throw Object.assign(new Error("Pack directory must be outside the source checkout."), {
        reasonCode: "pack-dir-inside-checkout",
      });
    }
    throw error;
  }
}

export function installedBinDir(prefix) {
  const unix = path.join(prefix, "bin");
  if (existsSync(unix) && lstatSync(unix).isDirectory()) return unix;
  const nested = path.join(prefix, "node_modules", ".bin");
  if (existsSync(nested) && lstatSync(nested).isDirectory()) return nested;
  return prefixBinDir(prefix);
}

export function resolveInstalledCommand(prefix, command) {
  const binDir = installedBinDir(prefix);
  const names = process.platform === "win32" ? [`${command}.cmd`, command] : [command];
  for (const name of names) {
    const candidate = path.join(binDir, name);
    if (existsSync(candidate) && lstatSync(candidate).isFile()) return candidate;
  }
  const moduleBin = path.join(prefix, "node_modules", ".bin", process.platform === "win32" ? `${command}.cmd` : command);
  if (existsSync(moduleBin) && lstatSync(moduleBin).isFile()) return moduleBin;
  return null;
}

function filteredPath(binDir) {
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(entry => {
    const normalized = path.normalize(entry);
    return !normalized.includes(`${path.sep}node_modules${path.sep}.bin`)
      && !normalized.endsWith(`${path.sep}node_modules${path.sep}.bin`);
  });
  return [binDir, ...pathEntries].join(path.delimiter);
}

export function probeInstalledCommand(prefix, command, args = ["--help"], cwd = os.tmpdir()) {
  const resolvedPath = resolveInstalledCommand(prefix, command);
  if (!resolvedPath) {
    throw Object.assign(new Error(`Installed ${command} is missing.`), {
      reasonCode: "missing-command",
      command,
    });
  }
  const childPath = filteredPath(path.dirname(resolvedPath));
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, PATH: childPath },
    encoding: "utf8",
    shell: process.platform === "win32",
    timeout: 60_000,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw Object.assign(
      new Error((result.stderr ?? "").trim() || (result.stdout ?? "").trim() || `${command} ${args.join(" ")} failed.`),
      { reasonCode: "start-failed", command, status: result.status }
    );
  }
  return {
    command,
    args,
    resolvedPath,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function runArgv(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell: process.platform === "win32",
    timeout: 600_000,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw Object.assign(
      new Error((result.stderr ?? "").trim() || (result.stdout ?? "").trim() || `${command} ${args.join(" ")} failed.`),
      { reasonCode: "pack-failed" }
    );
  }
  return result;
}

export function packPublishPackages(repoRoot, packages, packDir) {
  assertPackDirOutsideCheckout(repoRoot, packDir);
  mkdirSync(packDir, { recursive: true });
  const tarballs = [];
  for (const entry of packages) {
    const packageDir = assertSourcePathSafe(repoRoot, entry.path, entry.packageKey);
    const manifest = path.join(packageDir, "package.json");
    const before = new Set(readdirSync(packDir));
    runArgv(process.execPath, [path.join(repoRoot, "scripts", "resolve-publish-dependencies.mjs"), manifest], repoRoot);
    try {
      runArgv("npm", ["pack", "--ignore-scripts", "--pack-destination", packDir], packageDir);
    } finally {
      runArgv(process.execPath, [path.join(repoRoot, "scripts", "restore-publish-dependencies.mjs"), manifest], repoRoot);
    }
    const created = readdirSync(packDir).filter(name => !before.has(name) && name.endsWith(".tgz"));
    if (created.length !== 1) {
      throw Object.assign(new Error(`Pack did not write one tarball for ${entry.packageName}.`), { reasonCode: "pack-failed" });
    }
    tarballs.push(path.join(packDir, created[0]));
  }
  return tarballs;
}

export function installPackedPackages(prefix, tarballs, repoRoot) {
  assertPrefixOutsideCheckout(repoRoot, prefix);
  mkdirSync(prefix, { recursive: true });
  const args = ["install", "-g", "--ignore-scripts", "--prefix", prefix, ...tarballs];
  const result = spawnSync("npm", args, {
    cwd: os.tmpdir(),
    encoding: "utf8",
    shell: process.platform === "win32",
    timeout: 600_000,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw Object.assign(
      new Error((result.stderr ?? "").trim() || (result.stdout ?? "").trim() || "npm install of packed packages failed."),
      { reasonCode: "install-failed" }
    );
  }
}

function loadPlan(planPath, repoRoot) {
  const resolved = path.resolve(planPath);
  const relative = path.relative(repoRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw Object.assign(new Error("Publish plan path escapes the repository root."), { reasonCode: "path-escape" });
  }
  return JSON.parse(readFileSync(resolved, "utf8"));
}

function writeTempGitRepo(prefix) {
  const repo = mkdtempSync(path.join(os.tmpdir(), "qube-installed-init-"));
  writeFileSync(path.join(repo, "README.md"), "installed command fixture\n");
  spawnSync("git", ["init"], { cwd: repo, encoding: "utf8", windowsHide: true, timeout: 15_000 });
  spawnSync("git", ["add", "README.md"], { cwd: repo, encoding: "utf8", windowsHide: true, timeout: 15_000 });
  spawnSync("git", ["-c", "user.name=Qube", "-c", "user.email=qube@example.invalid", "commit", "-m", "init"], {
    cwd: repo,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  });
  return repo;
}

export function assertNoSourceCheckoutRunner(text, label) {
  if (String(text).includes(SOURCE_RUNNER) || String(text).includes("products/aie/bin/run")) {
    throw Object.assign(new Error(`${label} still references a source checkout runner.`), {
      reasonCode: "source-runner",
    });
  }
}

export function runInstalledIssueCommands(prefix) {
  const aie = resolveInstalledCommand(prefix, "aie");
  const qube = resolveInstalledCommand(prefix, "qube");
  if (!aie && !qube) return [];
  const driver = aie ? "aie" : "qube";
  const prefixArgs = driver === "qube" ? ["aie"] : [];
  const reports = [];
  for (const line of ISSUE_COMMANDS) {
    const args = [...prefixArgs, ...line.split(" ")];
    const cwd = line.startsWith("init ") ? writeTempGitRepo(prefix) : os.tmpdir();
    try {
      const probed = probeInstalledCommand(prefix, driver, args, cwd);
      assertNoSourceCheckoutRunner(`${probed.stdout}\n${probed.stderr}`, `${driver} ${args.join(" ")}`);
      if (line.startsWith("init ") && probed.stdout.trim()) {
        try {
          const parsed = JSON.parse(probed.stdout);
          const blob = JSON.stringify(parsed);
          assertNoSourceCheckoutRunner(blob, "init dry-run");
        } catch (error) {
          if (error?.reasonCode === "source-runner") throw error;
        }
      }
      reports.push({ command: driver, args, ok: true });
    } finally {
      if (line.startsWith("init ")) {
        rmSync(cwd, { recursive: true, force: true });
      }
    }
  }
  return reports;
}

export async function runInstalledCommandVerification(input = {}) {
  const repoRoot = resolveRepoRoot(input.repoRoot);
  const prefix = path.resolve(input.prefix ?? mkdtempSync(path.join(os.tmpdir(), "qube-installed-prefix-")));
  assertPrefixOutsideCheckout(repoRoot, prefix);
  const report = {
    ok: false,
    command: "verify-installed-commands",
    repoRoot,
    prefix,
    probed: [],
    issueCommands: [],
  };
  try {
    let packages = input.packages;
    let planCommands = [];
    if (!packages && input.planPath) {
      const plan = loadPlan(input.planPath, repoRoot);
      packages = plan.packages;
      planCommands = commandPackages(plan).map(entry => entry.command);
    }
    packages = packages ?? [];
    const commands = input.commands ?? planCommands;
    if (commands.length === 0) {
      if (!input.planPath) {
        throw Object.assign(new Error("Provide --plan or --command."), { reasonCode: "usage" });
      }
      report.ok = true;
      report.skipped = "no-command-packages";
      return report;
    }
    if (!input.skipPack) {
      const packDir = path.resolve(input.packDir ?? mkdtempSync(path.join(os.tmpdir(), "qube-pack-")));
      assertPackDirOutsideCheckout(repoRoot, packDir);
      const tarballs = packPublishPackages(repoRoot, packages, packDir);
      installPackedPackages(prefix, tarballs, repoRoot);
      report.tarballs = tarballs;
    }
    for (const command of commands) {
      report.probed.push(probeInstalledCommand(prefix, command));
    }
    report.issueCommands = runInstalledIssueCommands(prefix);
    report.ok = true;
    return report;
  } catch (error) {
    report.ok = false;
    report.reasonCode = error?.reasonCode ?? "failed";
    report.error = error instanceof Error ? error.message : String(error);
    return report;
  }
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/verify-installed-commands.mjs [--plan <file>] [--prefix <dir>] [--json]

Pack the selected publish set, install it into a prefix outside the checkout, and
check that qube, aie, aib, aiu, and aiq start.
`);
}

export async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseVerifyInstalledArgs(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
    return;
  }
  if (parsed.help) {
    printHelp();
    return;
  }
  const report = await runInstalledCommandVerification({
    repoRoot: parsed.repoRoot,
    prefix: parsed.prefix,
    planPath: parsed.plan,
    packDir: parsed.packDir,
    skipPack: parsed.skipPack,
    commands: parsed.commands,
  });
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } else if (report.ok) {
    process.stdout.write(`Installed commands started: ${(report.probed ?? []).map(item => item.command).join(", ") || "none"}\n`);
  } else {
    process.stderr.write(`${report.error}\n`);
  }
  if (!report.ok) process.exitCode = 1;
}

const invoked = process.argv[1] && path.normalize(process.argv[1]) === path.normalize(fileURLToPath(import.meta.url));
if (invoked) {
  await main();
}
