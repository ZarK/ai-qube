import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { finalizePublishPlan, readPackageJson, readPublishedVersionsForPlan, resolvePublishTag } from "./publish-packages.mjs";
import { planReleasePreparation, readReleaseChanges, resolveReleaseBaseline } from "./prepare-release.mjs";
import { inspectSuitePins, resolveSuiteRoot } from "./suite-pins.mjs";

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function parseReleaseArgs(argv) {
  const options = {
    help: false,
    json: false,
    dryRun: false,
    repoRoot: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") options.help = true;
    else if (token === "--json") options.json = true;
    else if (token === "--dry-run") options.dryRun = true;
    else if (token === "--repo-root") {
      index += 1;
      const value = argv[index];
      if (!value || value.startsWith("-")) {
        throw Object.assign(new Error("--repo-root requires a value."), { reasonCode: "usage" });
      }
      options.repoRoot = value;
    } else {
      throw Object.assign(new Error(`Unknown argument: ${token}`), { reasonCode: "usage" });
    }
  }
  return options;
}

function runGit(args, cwd) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  if (result.status !== 0) {
    throw Object.assign(
      new Error((result.stderr ?? "").trim() || `git ${args.join(" ")} failed.`),
      { reasonCode: "git" }
    );
  }
  return (result.stdout ?? "").trim();
}

export function inspectReleaseCheckout(root, git = { run: runGit }) {
  const branch = git.run(["rev-parse", "--abbrev-ref", "HEAD"], root);
  if (branch !== "main") {
    throw Object.assign(new Error(`Release requires branch main, found ${branch}.`), {
      reasonCode: "not-main",
    });
  }
  const status = git.run(["status", "--porcelain", "--untracked-files=normal"], root);
  if (status.length > 0) {
    throw Object.assign(new Error("Release requires a clean tracked working tree on main."), {
      reasonCode: "dirty-worktree",
    });
  }
  const head = git.run(["rev-parse", "HEAD"], root);
  const originMain = git.run(["rev-parse", "origin/main"], root);
  if (head !== originMain) {
    throw Object.assign(new Error("Release requires HEAD to match origin/main."), {
      reasonCode: "main-stale",
    });
  }
  return { branch, head };
}

export async function planRelease(options = {}) {
  const root = resolveSuiteRoot(options.repoRoot ?? DEFAULT_ROOT);
  const pins = inspectSuitePins(root);
  if (!pins.ok) {
    throw Object.assign(new Error(pins.failures.join("\n")), { reasonCode: "split-pins" });
  }
  const qube = await readPackageJson("products/qube/package.json", root);
  const tag = `publish-set-v${qube.version}`;
  const resolved = await resolvePublishTag(tag, root);
  const publishedByName = options.publishedByName ?? await readPublishedVersionsForPlan(resolved, options);
  const git = options.git ?? { run: runGit };
  const baseline = options.baseline ?? (options.preparation ? null : resolveReleaseBaseline(root, git));
  const preparation = options.preparation ?? planReleasePreparation(root, {
    ...baseline,
    changedPaths: options.changedPaths ?? readReleaseChanges(root, baseline.baselineTag, git),
    publishedByName,
  });
  if (preparation.needsWrite) {
    throw Object.assign(new Error("Release preparation is incomplete. Run `pnpm release:prepare --write`, review and merge the generated changes, then release from clean current main."), {
      reasonCode: "release-unprepared",
    });
  }
  const plan = finalizePublishPlan(resolved, publishedByName);
  return {
    tag,
    setVersion: qube.version,
    baselineTag: preparation.baselineTag ?? baseline?.baselineTag ?? null,
    packages: plan.packages.map(entry => ({
      packageKey: entry.packageKey,
      packageName: entry.packageName,
      version: entry.version,
    })),
    skipped: (plan.skipped ?? []).map(entry => ({
      packageKey: entry.packageKey,
      packageName: entry.packageName,
      version: entry.version,
      skipReason: entry.skipReason,
    })),
  };
}

export async function runRelease(options = {}) {
  if (options.dryRun) {
    const planned = await planRelease(options);
    return { ok: true, dryRun: true, pushed: false, ...planned };
  }
  const root = resolveSuiteRoot(options.repoRoot ?? DEFAULT_ROOT);
  const git = options.git ?? { run: runGit };
  const checkout = inspectReleaseCheckout(root, git);
  const planned = await planRelease({ ...options, repoRoot: root, git });
  const existing = git.run(["tag", "--list", planned.tag], root);
  if (!existing) {
    git.run(["tag", "-a", planned.tag, "-m", `Publish set ${planned.setVersion}`], root);
  } else {
    const tagCommit = git.run(["rev-parse", `${planned.tag}^{}`], root);
    if (tagCommit !== checkout.head) {
      throw Object.assign(new Error(`${planned.tag} already exists at ${tagCommit}; refusing to move an immutable release tag.`), {
        reasonCode: "tag-mismatch",
      });
    }
  }
  git.run(["push", "origin", planned.tag], root);
  return { ok: true, dryRun: false, pushed: true, ...planned };
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/release-set.mjs [--dry-run] [--json]

Create and push publish-set-v<qubeVersion> from a clean current main.
CI then stages every workspace version that is not already on npm. Run
pnpm run release:approve -- <tag> after the workflow succeeds.
`);
}

export async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseReleaseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
    return;
  }
  if (parsed.help) {
    printHelp();
    return;
  }
  try {
    const report = await runRelease(parsed);
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(report)}\n`);
      return;
    }
    process.stdout.write(`${report.tag}\n`);
    process.stdout.write(`stage ${report.packages.map(entry => `${entry.packageName}@${entry.version}`).join(", ")}\n`);
    if (report.skipped.length > 0) {
      process.stdout.write(`skip ${report.skipped.map(entry => `${entry.packageName}@${entry.version}`).join(", ")}\n`);
    }
    process.stdout.write(report.dryRun ? "dry-run: tag not pushed\n" : "pushed set tag\n");
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error?.reasonCode === "usage" ? 2 : 1;
  }
}

const invoked = process.argv[1] && path.normalize(process.argv[1]) === path.normalize(fileURLToPath(import.meta.url));
if (invoked) {
  await main();
}
