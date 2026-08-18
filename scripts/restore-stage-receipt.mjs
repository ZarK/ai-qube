import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CHECKPOINT_MARKER,
  createReceipt,
  encodeReceipt,
  restoreReceiptAttempt,
} from "./release-receipt.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;

function fail(message, cause) {
  throw Object.assign(new Error(message), { reasonCode: "checkpoint-restore", cause });
}

function requireContext(name, pattern) {
  const value = process.env[name] ?? "";
  if (!pattern.test(value)) fail(`Required GitHub Actions context ${name} is invalid.`);
  return value;
}

function runGh(args) {
  const result = spawnSync("gh", args, {
    cwd: ROOT,
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    fail(`GitHub Actions checkpoint lookup failed for gh ${args.slice(0, 2).join(" ")}.`, result.error);
  }
  return result.stdout;
}

function findStageStep(metadata) {
  const jobs = Array.isArray(metadata?.jobs) ? metadata.jobs : [];
  return jobs.flatMap(job => Array.isArray(job?.steps) ? job.steps : [])
    .find(step => step?.name === "Stage selected packages");
}

async function saveCheckpoint(receipt) {
  const receiptPath = path.join(ROOT, "stage-receipt.json");
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  process.stdout.write(`${CHECKPOINT_MARKER}${encodeReceipt(receipt)}\n`);
}

const planPath = path.resolve(process.argv[2] ?? "publish-plan.json");
const plan = JSON.parse(await readFile(planPath, "utf8"));
if (!plan || !Array.isArray(plan.packages) || plan.packages.length === 0) fail("Publish plan has no packages.");

const context = {
  repository: requireContext("GITHUB_REPOSITORY", REPOSITORY),
  tag: process.env.GITHUB_REF_NAME ?? "",
  headSha: process.env.GITHUB_SHA ?? "",
  runId: requireContext("GITHUB_RUN_ID", POSITIVE_INTEGER),
  runAttempt: requireContext("GITHUB_RUN_ATTEMPT", POSITIVE_INTEGER),
};
if (!context.tag || !/^[0-9a-f]{40}$/i.test(context.headSha)) fail("GitHub tag or head context is invalid.");

const currentAttempt = Number(context.runAttempt);
if (currentAttempt === 1) {
  await saveCheckpoint(createReceipt(context, plan.packages, [], false));
  process.exit(0);
}

for (let priorAttempt = currentAttempt - 1; priorAttempt >= 1; priorAttempt -= 1) {
  let metadata;
  try {
    metadata = JSON.parse(runGh([
      "run", "view", context.runId,
      "--repo", context.repository,
      "--attempt", String(priorAttempt),
      "--json", "attempt,headSha,jobs",
    ]));
  } catch (error) {
    fail(`Could not verify workflow attempt ${priorAttempt}.`, error);
  }
  const stageStep = findStageStep(metadata);
  let log = "";
  try {
    log = runGh([
      "run", "view", context.runId,
      "--repo", context.repository,
      "--attempt", String(priorAttempt),
      "--log",
    ]);
  } catch (error) {
    if (stageStep?.conclusion !== "skipped") throw error;
  }

  const restored = restoreReceiptAttempt({
    attempt: metadata.attempt,
    headSha: metadata.headSha,
    stageConclusion: stageStep?.conclusion ?? null,
    log,
  }, context, plan.packages);
  if (restored) {
    await saveCheckpoint(restored);
    process.exit(0);
  }
}

fail("No prior workflow attempt contains a trustworthy staging checkpoint.");
