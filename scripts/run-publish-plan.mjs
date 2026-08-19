import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PUBLISH_PACKAGES, SET_PREPARE, SET_VERIFY } from "./publish-packages.mjs";
import { buildShellCommandPlan } from "./process-launch.mjs";
import { createReceipt, parseStageOutput, resumeReceipt, saveReceipt, writeStageIntent } from "./release-receipt.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PHASES = new Set(["prepare", "verify", "stage"]);

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function runAllowlisted(command, cwd = ROOT) {
  const invocation = buildShellCommandPlan(command);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd,
    encoding: "utf8",
    shell: false,
    stdio: "inherit",
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
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

function runCaptured(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} failed with exit ${result.status ?? "unknown"}.`, result.status ?? 1);
  }
  return result.stdout ?? "";
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
  fail("Usage: node scripts/run-publish-plan.mjs <prepare|verify|stage> <plan.json>");
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
  const context = {
    repository: process.env.GITHUB_REPOSITORY,
    tag: process.env.GITHUB_REF_NAME,
    headSha: process.env.GITHUB_SHA,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  };
  for (const [key, value] of Object.entries(context)) {
    if (!value) fail(`Required GitHub Actions context ${key} is missing.`);
  }
  const receiptPath = path.join(ROOT, "stage-receipt.json");
  let staged = [];
  try {
    const checkpoint = JSON.parse(await readFile(receiptPath, "utf8"));
    staged = resumeReceipt(checkpoint, context, plan.packages);
    await saveReceipt(createReceipt(context, plan.packages, staged, checkpoint.complete), receiptPath);
    if (checkpoint.complete) {
      process.exit(0);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    if (String(context.runAttempt) !== "1") {
      fail("A retry has no restored staging checkpoint. Refusing to restage packages.");
    }
    await saveReceipt(createReceipt(context, plan.packages, [], false), receiptPath);
  }
  for (const entry of plan.packages.slice(staged.length)) {
    const allowed = allowlistedEntry(entry);
    const manifest = path.join(ROOT, allowed.packageJson);
    runArgv(process.execPath, [path.join(ROOT, "scripts", "resolve-publish-dependencies.mjs"), manifest], ROOT);
    runArgv(process.execPath, [path.join(ROOT, "scripts", "check-publish-manifest.mjs"), manifest], ROOT);
    try {
      writeStageIntent(context, entry);
      const stdout = runCaptured(
        "npm",
        ["stage", "publish", ".", "--access", "public", "--ignore-scripts", "--json"],
        path.join(ROOT, allowed.path)
      );
      staged.push(parseStageOutput(stdout, entry));
      await saveReceipt(createReceipt(context, plan.packages, staged, false), receiptPath);
    } finally {
      runArgv(process.execPath, [path.join(ROOT, "scripts", "restore-publish-dependencies.mjs"), manifest], ROOT);
    }
  }
  await saveReceipt(createReceipt(context, plan.packages, staged, true), receiptPath);
}
