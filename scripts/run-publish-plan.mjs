import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PHASES = new Set(["prepare", "verify", "stage"]);

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function run(command, cwd = ROOT) {
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

const phase = process.argv[2] ?? "";
const planPath = path.resolve(process.argv[3] ?? "publish-plan.json");
if (!PHASES.has(phase)) {
  fail(`Usage: node scripts/run-publish-plan.mjs <prepare|verify|stage> <plan.json>`);
}

const plan = JSON.parse(await readFile(planPath, "utf8"));
if (!plan || !Array.isArray(plan.packages) || plan.packages.length === 0) {
  fail("Publish plan has no packages.");
}

if (phase === "prepare") {
  run(plan.prepare);
} else if (phase === "verify") {
  run(plan.verify);
} else {
  for (const entry of plan.packages) {
    const manifest = path.join(ROOT, entry.packageJson);
    run(`node scripts/resolve-publish-dependencies.mjs "${manifest}"`);
    run(`node scripts/check-publish-manifest.mjs "${manifest}"`);
    try {
      run("npm stage publish . --access public --ignore-scripts", path.join(ROOT, entry.path));
    } finally {
      run(`node scripts/restore-publish-dependencies.mjs "${manifest}"`);
    }
  }
}
