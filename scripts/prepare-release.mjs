import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, globSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { inspectAdapterPins, writeAdapterPins } from "./adapter-pins.mjs";
import {
  PUBLISH_PACKAGES,
  PUBLISH_SET_ORDER,
  readPublishedVersionsForPlan,
  resolvePublishTag,
} from "./publish-packages.mjs";
import { bumpPatch, resolveSuiteRoot } from "./suite-pins.mjs";

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AUDIT_PATH = "docs/release/version-audit.json";
const SET_TAG = /^publish-set-v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function fail(message, reasonCode) {
  throw Object.assign(new Error(message), { reasonCode });
}

function runGit(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, timeout: 30_000 });
  if (result.status !== 0) fail((result.stderr ?? "").trim() || `git ${args.join(" ")} failed.`, "git");
  return result.stdout ?? "";
}

function readJson(root, relativePath) {
  return JSON.parse(readFileSync(resolveInside(root, relativePath), "utf8"));
}

function resolveInside(root, relativePath) {
  const resolved = path.resolve(root, relativePath);
  const realRoot = realpathSync.native(root);
  const realTarget = existsSync(resolved)
    ? realpathSync.native(resolved)
    : path.join(realpathSync.native(path.dirname(resolved)), path.basename(resolved));
  const relative = path.relative(realRoot, realTarget);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    fail(`${relativePath} escapes the suite root.`, "path-escape");
  }
  return resolved;
}

function replaceFile(filePath, contents) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let temporaryExists = false;
  try {
    writeFileSync(temporaryPath, contents, { encoding: "utf8", flag: "wx" });
    temporaryExists = true;
    renameSync(temporaryPath, filePath);
    temporaryExists = false;
  } finally {
    if (temporaryExists) rmSync(temporaryPath, { force: true });
  }
}

function writeJson(root, relativePath, value) {
  replaceFile(resolveInside(root, relativePath), `${JSON.stringify(value, null, 2)}\n`);
}

export function parseChangedPaths(output) {
  const paths = String(output).split("\0").filter(Boolean);
  for (const changedPath of paths) {
    const normalized = changedPath.replaceAll("\\", "/");
    if (normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
      fail(`Git returned an unsafe changed path: ${changedPath}.`, "unsafe-changed-path");
    }
  }
  return paths.map(changedPath => changedPath.replaceAll("\\", "/"));
}

export function resolveReleaseBaseline(root, git = { run: runGit }, options = {}) {
  const tags = git.run(["tag", "--merged", "HEAD", "--list", "publish-set-v*", "--sort=-version:refname"], root)
    .split(/\r?\n/)
    .map(tag => tag.trim())
    .filter(Boolean);
  const baselineTag = tags.find(tag => SET_TAG.test(tag) && tag !== options.excludeTag);
  if (!baselineTag) fail("No valid publish-set baseline tag is reachable from HEAD.", "release-baseline");
  const baselineSha = git.run(["rev-list", "-n", "1", baselineTag], root).trim();
  if (!/^[0-9a-f]{40}$/i.test(baselineSha)) fail(`Release baseline ${baselineTag} did not resolve to a commit.`, "release-baseline");
  return { baselineTag, baselineSha };
}

function readTagState(git, args, root, tag) {
  try {
    return git.run(args, root);
  } catch (error) {
    throw Object.assign(new Error(`Cannot inspect immutable set tag ${tag}; verify local and origin tag access before preparing a release.`), {
      reasonCode: "set-tag-state",
      cause: error,
    });
  }
}

function commitSha(value, label) {
  const sha = String(value ?? "").trim();
  if (!/^[0-9a-f]{40}$/i.test(sha)) fail(`${label} did not resolve to a commit.`, "set-tag-state");
  return sha;
}

function remoteTagCommit(output, tag) {
  const directRef = `refs/tags/${tag}`;
  const peeledRef = `${directRef}^{}`;
  let direct = null;
  let peeled = null;
  for (const line of String(output).split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
    const match = /^([0-9a-f]{40})\s+(refs\/tags\/[^\s]+)$/i.exec(line);
    if (!match || (match[2] !== directRef && match[2] !== peeledRef)) {
      fail(`Origin returned an invalid reference while inspecting ${tag}.`, "set-tag-state");
    }
    const field = match[2] === peeledRef ? "peeled" : "direct";
    const current = field === "peeled" ? peeled : direct;
    if (current && current !== match[1]) fail(`Origin returned conflicting references for ${tag}.`, "set-tag-state");
    if (field === "peeled") peeled = match[1];
    else direct = match[1];
  }
  if (peeled && !direct) fail(`Origin returned a peeled reference without ${directRef}.`, "set-tag-state");
  return peeled ?? direct;
}

export function inspectSetTag(root, version, git = { run: runGit }) {
  const tag = `publish-set-v${version}`;
  const headSha = commitSha(readTagState(git, ["rev-parse", "HEAD"], root, tag), "HEAD");
  const localName = String(readTagState(git, ["tag", "--list", tag], root, tag)).trim();
  if (localName && localName !== tag) fail(`Local tag lookup returned an invalid reference for ${tag}.`, "set-tag-state");
  const localSha = localName
    ? commitSha(readTagState(git, ["rev-list", "-n", "1", tag], root, tag), `Local tag ${tag}`)
    : null;
  const remoteOutput = readTagState(git, ["ls-remote", "--tags", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`], root, tag);
  const remoteSha = remoteTagCommit(remoteOutput, tag);
  if (localSha && remoteSha && localSha !== remoteSha) {
    fail(`${tag} resolves to different commits locally and on origin.`, "set-tag-conflict");
  }
  const tagSha = remoteSha ?? localSha;
  return {
    tag,
    headSha,
    localSha,
    remoteSha,
    tagSha,
    status: tagSha === null ? "absent" : tagSha === headSha ? "current" : "occupied",
  };
}

export function readReleaseChanges(root, baselineTag, git = { run: runGit }) {
  return parseChangedPaths(git.run(["diff", "--name-only", "-z", `${baselineTag}...HEAD`, "--"], root));
}

function packageInputs(entry) {
  return entry.inputs ?? [entry.path];
}

function ownsPath(entry, changedPath) {
  return packageInputs(entry).some(input => changedPath === input || changedPath.startsWith(`${input}/`));
}

function publishedVersions(publishedByName, packageName) {
  const versions = publishedByName.get(packageName);
  if (!Array.isArray(versions)) fail(`Registry versions are unavailable for ${packageName}.`, "registry-lookup");
  return versions;
}

function internalDependencies(manifest, packageByName, fields = ["dependencies", "optionalDependencies"]) {
  const dependencies = [];
  for (const field of fields) {
    for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
      if (packageByName.has(name)) dependencies.push({ field, name, specifier: String(specifier) });
    }
  }
  return dependencies;
}

function readWorkspacePatterns(root) {
  const contents = readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8");
  const lines = contents.split(/\r?\n/);
  const start = lines.findIndex(line => /^packages:\s*$/.test(line));
  if (start < 0) fail("pnpm-workspace.yaml has no packages list.", "workspace-layout");
  const patterns = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const match = /^\s+-\s+["']?([^"']+?)["']?\s*$/.exec(line);
    if (match) patterns.push(match[1]);
  }
  if (patterns.length === 0) fail("pnpm-workspace.yaml has an empty packages list.", "workspace-layout");
  return patterns;
}

function readWorkspaceManifests(root) {
  const paths = new Set(existsSync(path.join(root, "package.json")) ? ["package.json"] : []);
  for (const pattern of readWorkspacePatterns(root)) {
    if (pattern.startsWith("!") || path.isAbsolute(pattern) || pattern.includes("..")) {
      fail(`Unsupported workspace package pattern: ${pattern}.`, "workspace-layout");
    }
    for (const packageJson of globSync(`${pattern}/package.json`, { cwd: root })) {
      paths.add(packageJson.replaceAll("\\", "/"));
    }
  }
  return [...paths].sort().map(packageJson => ({ packageJson, manifest: readJson(root, packageJson) }));
}

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(version));
  if (!match) fail(`Registry returned an unsupported semver value: ${version}.`, "registry-version");
  return {
    value: String(version),
    numbers: match.slice(1, 4).map(Number),
    prerelease: match[4]?.split(".") ?? [],
  };
}

function compareIdentifiers(left, right) {
  const leftNumber = /^\d+$/.test(left);
  const rightNumber = /^\d+$/.test(right);
  if (leftNumber && rightNumber) return Number(left) - Number(right);
  if (leftNumber !== rightNumber) return leftNumber ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function compareVersions(left, right) {
  const parsedLeft = parseVersion(left);
  const parsedRight = parseVersion(right);
  for (let index = 0; index < parsedLeft.numbers.length; index += 1) {
    const difference = parsedLeft.numbers[index] - parsedRight.numbers[index];
    if (difference !== 0) return difference;
  }
  if (parsedLeft.prerelease.length === 0 || parsedRight.prerelease.length === 0) {
    if (parsedLeft.prerelease.length === parsedRight.prerelease.length) return 0;
    return parsedLeft.prerelease.length === 0 ? 1 : -1;
  }
  const count = Math.max(parsedLeft.prerelease.length, parsedRight.prerelease.length);
  for (let index = 0; index < count; index += 1) {
    if (parsedLeft.prerelease[index] === undefined) return -1;
    if (parsedRight.prerelease[index] === undefined) return 1;
    const difference = compareIdentifiers(parsedLeft.prerelease[index], parsedRight.prerelease[index]);
    if (difference !== 0) return difference;
  }
  return 0;
}

function nextVersion(packageName, currentVersion, versions) {
  const sorted = [...new Set(versions)].sort(compareVersions);
  const latest = sorted.at(-1);
  if (latest && compareVersions(currentVersion, latest) < 0) {
    fail(`${packageName}@${currentVersion} is behind the published registry version ${latest}.`, "registry-version-drift");
  }
  if (!versions.includes(currentVersion)) return currentVersion;
  if (latest !== currentVersion) {
    fail(`${packageName}@${currentVersion} is not the latest published version (${latest}).`, "registry-version-drift");
  }
  const candidate = bumpPatch(currentVersion);
  if (versions.includes(candidate)) {
    fail(`${packageName}@${candidate} is already published; refusing to skip a release version.`, "registry-version-drift");
  }
  return candidate;
}

function nextReservedVersion(packageName, currentVersion, versions) {
  const registryVersion = nextVersion(packageName, currentVersion, versions);
  if (registryVersion !== currentVersion) return registryVersion;
  const candidate = bumpPatch(currentVersion);
  if (versions.includes(candidate)) {
    fail(`${packageName}@${candidate} is already published; refusing to reuse a reserved set version.`, "registry-version-drift");
  }
  return candidate;
}

function buildVersionAudit(current, reports, publishedByName) {
  const prior = new Map((current.packages ?? []).map(entry => [entry.name, entry]));
  return {
    ...current,
    packages: reports.map(report => {
      const versions = [...new Set(publishedVersions(publishedByName, report.packageName))].sort(compareVersions);
      return {
        ...(prior.get(report.packageName) ?? {}),
        name: report.packageName,
        packageJson: report.packageJson,
        published: versions.length > 0,
        latestPublished: versions.at(-1) ?? null,
        publishedVersions: versions,
        selectedVersion: report.toVersion,
      };
    }),
  };
}

export function planReleasePreparation(root, options) {
  const changedPaths = options.changedPaths ?? [];
  const publishedByName = options.publishedByName;
  if (!(publishedByName instanceof Map)) fail("Release preparation requires verified registry version sets.", "registry-lookup");

  const packages = PUBLISH_SET_ORDER.map(packageKey => {
    const catalog = PUBLISH_PACKAGES.get(packageKey);
    const manifest = readJson(root, catalog.packageJson);
    return { packageKey, catalog, manifest, originalVersion: manifest.version };
  });
  const packageByName = new Map(packages.map(entry => [entry.manifest.name, entry]));
  const directKeys = new Set(packages.filter(entry => changedPaths.some(changedPath => ownsPath(entry.catalog, changedPath))).map(entry => entry.packageKey));
  const plannedVersions = new Map(packages.map(entry => [entry.manifest.name, entry.originalVersion]));
  const setTagState = options.setTagState ?? { status: "absent", tag: null };
  if (!new Set(["absent", "current", "occupied"]).has(setTagState.status)) {
    fail("Release preparation received an invalid set tag state.", "set-tag-state");
  }
  const currentComposer = packages.find(entry => entry.packageKey === "qube");
  const currentSetTag = `publish-set-v${currentComposer.originalVersion}`;
  if (setTagState.status !== "absent" && setTagState.tag !== currentSetTag) {
    fail(`Release preparation tag state does not match ${currentSetTag}.`, "set-tag-state");
  }
  const reports = [];

  for (const entry of packages) {
    const dependencyChanges = [];
    const manifest = structuredClone(entry.manifest);
    for (const dependency of internalDependencies(manifest, packageByName, ["dependencies", "optionalDependencies", "devDependencies", "peerDependencies"])) {
      const plannedVersion = plannedVersions.get(dependency.name);
      const dependencyEntry = packageByName.get(dependency.name);
      const workspaceSpecifier = dependency.specifier.startsWith("workspace:");
      if (plannedVersion === dependencyEntry.originalVersion && (workspaceSpecifier || dependency.specifier === plannedVersion)) continue;
      dependencyChanges.push({ name: dependency.name, from: dependency.specifier, to: plannedVersion });
      if (!workspaceSpecifier) manifest[dependency.field][dependency.name] = plannedVersion;
    }

    const adapterDependencyChanged = entry.packageKey === "qube" && packages.some(candidate => (
      candidate.packageKey.startsWith("qube-adapter-")
      && plannedVersions.get(candidate.manifest.name) !== candidate.originalVersion
    ));
    const direct = directKeys.has(entry.packageKey);
    const propagated = dependencyChanges.length > 0 || adapterDependencyChanged;
    const replacement = entry.packageKey === "qube" && setTagState.status === "occupied";
    let version = entry.originalVersion;
    if (replacement) {
      version = nextReservedVersion(entry.manifest.name, version, publishedVersions(publishedByName, entry.manifest.name));
    } else if (direct || propagated) {
      const published = publishedVersions(publishedByName, entry.manifest.name);
      version = nextVersion(entry.manifest.name, version, published);
    }
    manifest.version = version;
    plannedVersions.set(entry.manifest.name, version);
    reports.push({
      packageKey: entry.packageKey,
      packageName: entry.manifest.name,
      packageJson: entry.catalog.packageJson,
      direct,
      propagated,
      replacement,
      dependencyChanges,
      fromVersion: entry.originalVersion,
      toVersion: version,
      published: publishedVersions(publishedByName, entry.manifest.name).includes(entry.originalVersion),
      manifest,
    });
  }

  const versionChanges = reports.filter(entry => entry.fromVersion !== entry.toVersion);
  const publishPaths = new Set(reports.map(report => report.packageJson));
  const workspaceChanges = [];
  for (const workspaceEntry of readWorkspaceManifests(root)) {
    if (publishPaths.has(workspaceEntry.packageJson)) continue;
    const manifest = structuredClone(workspaceEntry.manifest);
    const dependencyChanges = [];
    let versionChange = null;
    const owner = packages.find(entry => ownsPath(entry.catalog, workspaceEntry.packageJson));
    if (owner?.catalog.syncPrivateVersions === true && manifest.private === true) {
      const plannedVersion = plannedVersions.get(owner.manifest.name);
      if (manifest.version !== plannedVersion) {
        versionChange = { from: manifest.version, to: plannedVersion };
        manifest.version = plannedVersion;
      }
    }
    for (const dependency of internalDependencies(manifest, packageByName, ["dependencies", "optionalDependencies", "devDependencies", "peerDependencies"])) {
      const plannedVersion = plannedVersions.get(dependency.name);
      if (dependency.specifier.startsWith("workspace:") || dependency.specifier === plannedVersion) continue;
      manifest[dependency.field][dependency.name] = plannedVersion;
      dependencyChanges.push({ field: dependency.field, name: dependency.name, from: dependency.specifier, to: plannedVersion });
    }
    if (versionChange || dependencyChanges.length > 0) {
      workspaceChanges.push({ packageJson: workspaceEntry.packageJson, versionChange, dependencyChanges, manifest });
    }
  }
  const manifestChanges = reports.filter(entry => (
    JSON.stringify(entry.manifest) !== JSON.stringify(readJson(root, entry.packageJson))
  ));
  const currentAudit = readJson(root, AUDIT_PATH);
  const expectedAudit = buildVersionAudit(currentAudit, reports, publishedByName);
  const auditChanged = JSON.stringify(currentAudit) !== JSON.stringify(expectedAudit);
  const generatedPinsChanged = inspectAdapterPins(root).changed || reports.some(entry => (
    entry.packageKey.startsWith("qube-adapter-") && entry.fromVersion !== entry.toVersion
  ));
  const composer = reports.find(entry => entry.packageKey === "qube");
  return {
    baselineTag: options.baselineTag,
    baselineSha: options.baselineSha,
    setTag: `publish-set-v${composer.toVersion}`,
    replacesSetTag: setTagState.status === "occupied" ? setTagState.tag : null,
    setTagState: setTagState.status,
    changedPaths: [...changedPaths],
    directPackages: reports.filter(entry => entry.direct).map(entry => entry.packageKey),
    propagatedPackages: reports.filter(entry => entry.propagated).map(entry => entry.packageKey),
    replacementPackages: reports.filter(entry => entry.replacement).map(entry => entry.packageKey),
    versionChanges: versionChanges.map(entry => ({ packageKey: entry.packageKey, packageName: entry.packageName, from: entry.fromVersion, to: entry.toVersion })),
    stageOrder: reports.filter(entry => !publishedVersions(publishedByName, entry.packageName).includes(entry.toVersion)).map(entry => ({ packageKey: entry.packageKey, packageName: entry.packageName, version: entry.toVersion })),
    needsWrite: manifestChanges.length > 0 || workspaceChanges.length > 0 || auditChanged || generatedPinsChanged,
    auditChanged,
    generatedPinsChanged,
    expectedAudit,
    reports,
    workspaceChanges,
  };
}

function updateWorkspaceInstall(root, runner = spawnSync) {
  const pnpmArgs = ["install", "--ignore-scripts", "--config.verify-deps-before-run=false"];
  const windows = process.platform === "win32";
  const command = windows ? "cmd.exe" : "pnpm";
  const args = windows ? ["/d", "/s", "/c", `pnpm.cmd ${pnpmArgs.join(" ")}`] : pnpmArgs;
  const result = runner(command, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    const detail = result.error?.message ? ` (${result.error.message})` : "";
    fail(`The protected workspace install failed${detail}; generated release files were rolled back.`, "workspace-install");
  }
}

function snapshotFiles(root, relativePaths) {
  return new Map(relativePaths.map(relativePath => {
    const filePath = resolveInside(root, relativePath);
    return [relativePath, existsSync(filePath) ? readFileSync(filePath) : null];
  }));
}

function restoreFiles(root, snapshots) {
  for (const [relativePath, contents] of snapshots) {
    const filePath = resolveInside(root, relativePath);
    if (contents === null) rmSync(filePath, { force: true });
    else replaceFile(filePath, contents);
  }
}

export function applyReleasePreparation(root, plan, publishedByName, options = {}) {
  if (!plan.needsWrite) return { ...plan, wrote: false };
  const reportsByKey = new Map((plan.reports ?? []).map(report => [report.packageKey, report]));
  const reports = PUBLISH_SET_ORDER.map(packageKey => {
    const report = reportsByKey.get(packageKey);
    const catalog = PUBLISH_PACKAGES.get(packageKey);
    if (!report || report.packageJson !== catalog.packageJson) {
      fail(`Release preparation report is incomplete for ${packageKey}.`, "invalid-preparation");
    }
    return report;
  });
  const mutablePaths = [
    ...reports.map(report => report.packageJson),
    ...plan.workspaceChanges.map(change => change.packageJson),
    inspectAdapterPins(root).outputPath,
    AUDIT_PATH,
    "pnpm-lock.yaml",
  ];
  const snapshots = snapshotFiles(root, [...new Set(mutablePaths)]);
  try {
    for (const report of reports) {
      if (JSON.stringify(report.manifest) !== JSON.stringify(readJson(root, report.packageJson))) {
        writeJson(root, report.packageJson, report.manifest);
      }
    }
    for (const change of plan.workspaceChanges) {
      writeJson(root, change.packageJson, change.manifest);
    }
    writeAdapterPins(root);
    writeJson(root, AUDIT_PATH, plan.expectedAudit ?? buildVersionAudit(readJson(root, AUDIT_PATH), reports, publishedByName));
    if (options.updateLockfile !== false) updateWorkspaceInstall(root, options.runner);
  } catch (error) {
    try {
      restoreFiles(root, snapshots);
    } catch (restoreError) {
      throw Object.assign(new AggregateError([error, restoreError], "Release preparation failed and generated file rollback was incomplete."), {
        reasonCode: "rollback-failed",
      });
    }
    throw error;
  }
  return { ...plan, wrote: true };
}

export async function prepareRelease(options = {}) {
  const root = resolveSuiteRoot(options.repoRoot ?? DEFAULT_ROOT);
  const git = options.git ?? { run: runGit };
  const baseline = options.baseline ?? resolveReleaseBaseline(root, git, { excludeTag: options.excludeBaselineTag });
  const changedPaths = options.changedPaths ?? readReleaseChanges(root, baseline.baselineTag, git);
  const qube = readJson(root, "products/qube/package.json");
  const setTagState = options.setTagState ?? inspectSetTag(root, qube.version, git);
  const resolved = await resolvePublishTag(`publish-set-v${qube.version}`, root);
  const publishedByName = options.publishedByName ?? await readPublishedVersionsForPlan(resolved, options);
  const plan = planReleasePreparation(root, { ...baseline, changedPaths, publishedByName, setTagState });
  if (!options.write) return { ok: true, dryRun: true, wrote: false, ...plan, reports: undefined, workspaceChanges: plan.workspaceChanges.map(change => ({ packageJson: change.packageJson, versionChange: change.versionChange, dependencyChanges: change.dependencyChanges })), expectedAudit: undefined };
  return { ok: true, dryRun: false, ...applyReleasePreparation(root, plan, publishedByName, options), reports: undefined, workspaceChanges: plan.workspaceChanges.map(change => ({ packageJson: change.packageJson, versionChange: change.versionChange, dependencyChanges: change.dependencyChanges })), expectedAudit: undefined };
}

function parseArgs(argv) {
  const options = { write: false, json: false };
  for (const token of argv) {
    if (token === "--write") options.write = true;
    else if (token === "--dry-run") options.write = false;
    else if (token === "--json") options.json = true;
    else if (token === "--help" || token === "-h") options.help = true;
    else fail(`Unknown argument: ${token}`, "usage");
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      process.stdout.write("Usage: node scripts/prepare-release.mjs [--dry-run|--write] [--json]\n");
      return;
    }
    const report = await prepareRelease(options);
    process.stdout.write(options.json ? `${JSON.stringify(report)}\n` : `${report.setTag}: ${report.stageOrder.map(entry => `${entry.packageName}@${entry.version}`).join(", ")}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error?.reasonCode === "usage" ? 2 : 1;
  }
}

const invoked = process.argv[1] && path.normalize(process.argv[1]) === path.normalize(fileURLToPath(import.meta.url));
if (invoked) await main();
