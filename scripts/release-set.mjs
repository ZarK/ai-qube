import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { finalizePublishPlan, inspectRetryContents, readPackageJson, readRegistryPackagesForPlan, resolvePublishTag } from "./publish-packages.mjs";
import { planReleasePreparation, readReleaseChanges, resolveReleaseBaseline } from "./prepare-release.mjs";
import { inspectSuitePins, resolveSuiteRoot } from "./suite-pins.mjs";

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function parseReleaseArgs(argv) {
  const options = {
    help: false,
    json: false,
    dryRun: false,
    retry: false,
    repoRoot: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") options.help = true;
    else if (token === "--json") options.json = true;
    else if (token === "--dry-run") options.dryRun = true;
    else if (token === "--retry") options.retry = true;
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

function lines(value) {
  return String(value).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

function remoteTagCommit(output, tag) {
  const refs = new Map(lines(output).map(line => {
    const [sha, ref] = line.split(/\s+/, 2);
    return [ref, sha];
  }));
  return refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`) ?? null;
}

export function planRetryTag(root, setVersion, git = { run: runGit }) {
  const originalTag = `publish-set-v${setVersion}`;
  const originalRemote = git.run([
    "ls-remote", "--tags", "origin", `refs/tags/${originalTag}`, `refs/tags/${originalTag}^{}`,
  ], root);
  const originalCommit = remoteTagCommit(originalRemote, originalTag);
  if (!originalCommit) {
    throw Object.assign(new Error(`Retry requires the immutable original tag ${originalTag} on origin.`), {
      reasonCode: "retry-base",
    });
  }
  const localOriginal = git.run(["tag", "--list", originalTag], root);
  if (localOriginal) {
    const localCommit = git.run(["rev-parse", `${originalTag}^{commit}`], root);
    if (localCommit !== originalCommit) {
      throw Object.assign(new Error(`${originalTag} differs between the local repository and origin.`), {
        reasonCode: "tag-mismatch",
      });
    }
  }
  try {
    git.run(["merge-base", "--is-ancestor", originalCommit, "origin/main"], root);
  } catch (error) {
    throw Object.assign(new Error(`${originalTag} is not an ancestor of origin/main.`), {
      reasonCode: "retry-base",
      cause: error,
    });
  }

  const prefix = `${originalTag}-retry.`;
  const localRetries = lines(git.run(["tag", "--list", `${prefix}*`], root));
  const remoteRetries = lines(git.run(["ls-remote", "--tags", "origin", `refs/tags/${prefix}*`], root))
    .map(line => line.split(/\s+/, 2)[1]?.replace("refs/tags/", "").replace(/\^\{\}$/, ""))
    .filter(Boolean);
  const retryPattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([1-9][0-9]*)$`);
  const used = new Set([...localRetries, ...remoteRetries].map(tag => retryPattern.exec(tag)?.[1]).filter(Boolean).map(Number));
  const retry = used.size === 0 ? 1 : Math.max(...used) + 1;
  return { originalTag, originalCommit, retry, tag: `${prefix}${retry}` };
}

function registryPackagesFromVersions(plan, publishedByName, missingPackageNames = []) {
  const missing = new Set(missingPackageNames);
  return new Map(plan.packages.map(entry => [entry.packageName, Object.freeze({
    packageName: entry.packageName,
    exists: !missing.has(entry.packageName),
    versions: Object.freeze([...(publishedByName.get(entry.packageName) ?? [])]),
  })]));
}

function requireExistingPackageNames(plan, registryPackages) {
  const missing = plan.packages.filter(entry => registryPackages.get(entry.packageName)?.exists !== true);
  if (missing.length === 0) return;
  const details = missing.map(entry => `- ${entry.packageName} from ${entry.path} (target ${entry.version})`).join("\n");
  throw Object.assign(new Error(
    `npm staged publishing cannot create a package name. Complete a separately reviewed one-time direct bootstrap publish for each package below, configure its stage-only trusted publisher, wait until npm registry lookup succeeds, and rerun the release:\n${details}`
  ), { reasonCode: "package-bootstrap", packages: missing });
}

export async function planRelease(options = {}) {
  const root = resolveSuiteRoot(options.repoRoot ?? DEFAULT_ROOT);
  const pins = inspectSuitePins(root);
  if (!pins.ok) {
    throw Object.assign(new Error(pins.failures.join("\n")), { reasonCode: "split-pins" });
  }
  const qube = await readPackageJson("products/qube/package.json", root);
  const originalTag = `publish-set-v${qube.version}`;
  const git = options.git ?? { run: runGit };
  const retryPlan = options.retry ? planRetryTag(root, qube.version, git) : null;
  const tag = retryPlan?.tag ?? originalTag;
  const resolved = await resolvePublishTag(tag, root);
  if (retryPlan) inspectRetryContents(resolved, retryPlan.originalCommit, root, git);
  const registryPackages = options.registryPackages
    ?? (options.publishedByName
      ? registryPackagesFromVersions(resolved, options.publishedByName, options.missingPackageNames)
      : await readRegistryPackagesForPlan(resolved, options));
  requireExistingPackageNames(resolved, registryPackages);
  const publishedByName = options.publishedByName ?? new Map(
    [...registryPackages].map(([packageName, entry]) => [packageName, entry.versions])
  );
  let preparation = options.preparation ?? null;
  let baseline = options.baseline ?? null;
  if (!options.retry) {
    baseline = baseline ?? (preparation ? null : resolveReleaseBaseline(root, git));
    preparation = preparation ?? planReleasePreparation(root, {
      ...baseline,
      changedPaths: options.changedPaths ?? readReleaseChanges(root, baseline.baselineTag, git),
      publishedByName,
    });
    if (preparation.needsWrite) {
      throw Object.assign(new Error("Release preparation is incomplete. Run `pnpm release:prepare --write`, review and merge the generated changes, then release from clean current main."), {
        reasonCode: "release-unprepared",
      });
    }
  }
  const plan = finalizePublishPlan(resolved, publishedByName);
  if (options.retry && plan.skipped.length === 0) {
    throw Object.assign(new Error(`Retry is unnecessary because no versions from ${originalTag} are public.`), {
      reasonCode: "retry-unnecessary",
    });
  }
  return {
    tag,
    originalTag,
    retry: retryPlan?.retry ?? null,
    setVersion: qube.version,
    baselineTag: preparation?.baselineTag ?? baseline?.baselineTag ?? retryPlan?.originalTag ?? null,
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
    git.run(["tag", "-s", planned.tag, "-m", `Publish set ${planned.setVersion}`], root);
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
  process.stdout.write(`Usage: node scripts/release-set.mjs [--retry] [--dry-run] [--json]

Create and push publish-set-v<qubeVersion> from a clean current main.
Use --retry after part of an immutable set is public; it creates a new
publish-set-v<qubeVersion>-retry.<number> tag for only the remaining versions.
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
    if (report.retry) process.stdout.write(`retry ${report.retry} of ${report.originalTag}\n`);
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
