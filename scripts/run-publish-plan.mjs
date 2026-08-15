import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PUBLISH_PACKAGES, SET_PREPARE, SET_VERIFY } from "./publish-packages.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PHASES = new Set(["prepare", "verify", "stage"]);

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function runAllowlisted(command, cwd = ROOT) {
  const result = spawnSync(command, {
    cwd,
    encoding: "utf8",
    shell: true,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.status !== 0) {
    fail(`${command} failed with exit ${result.status ?? "unknown"}.`, result.status ?? 1);
  }
}

function runArgv(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell: false,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} failed with exit ${result.status ?? "unknown"}.`, result.status ?? 1);
  }
}

function allowlistedEntry(entry) {
  const allowed = PUBLISH_PACKAGES.get(entry.packageKey);
  if (!allowed) fail(`Unknown publish package "${entry.packageKey}".`);
  if (allowed.path !== entry.path || allowed.packageJson !== entry.packageJson || allowed.filter !== entry.filter) {
    fail(`Publish plan for ${entry.packageKey} does not match the allowlist.`);
  }
  return allowed;
}

const phase = process.argv[2] ?? "";
const planPath = path.resolve(process.argv[3] ?? "publish-plan.json");
if (!PHASES.has(phase)) {
  fail(`Usage: node scripts/run-publish-plan.mjs <prepare|verify|stage> <plan.json>`);
}

const plan = JSON.parse(await readFile(planPath, "utf8"));
if (!plan || !Array.isArray(plan.packages) || plan.packages.length === 0) {
  fail("Publish plan has no packages.");
}
for (const entry of plan.packages) allowlistedEntry(entry);

if (phase === "prepare") {
  const expected = plan.mode === "set" ? SET_PREPARE : allowlistedEntry(plan.packages[0]).prepare;
  if (plan.prepare !== expected) fail("Publish plan prepare command is not allowlisted.");
  runAllowlisted(expected);
} else if (phase === "verify") {
  const expected = plan.mode === "set" ? SET_VERIFY : allowlistedEntry(plan.packages[0]).verify;
  if (plan.verify !== expected) fail("Publish plan verify command is not allowlisted.");
  runAllowlisted(expected);
} else {
  for (const entry of plan.packages) {
    const allowed = allowlistedEntry(entry);
    const manifest = path.join(ROOT, allowed.packageJson);
    runArgv(process.execPath, [path.join(ROOT, "scripts", "resolve-publish-dependencies.mjs"), manifest], ROOT);
    runArgv(process.execPath, [path.join(ROOT, "scripts", "check-publish-manifest.mjs"), manifest], ROOT);
    try {
      runArgv("npm", ["stage", "publish", ".", "--access", "public", "--ignore-scripts"], path.join(ROOT, allowed.path));
    } finally {
      runArgv(process.execPath, [path.join(ROOT, "scripts", "restore-publish-dependencies.mjs"), manifest], ROOT);
    }
  }
}
