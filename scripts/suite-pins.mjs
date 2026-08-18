import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { inspectAdapterPins, writeAdapterPins } from "./adapter-pins.mjs";

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const QUBE_PACKAGE_JSON = "products/qube/package.json";
const AIB_PACKAGE_JSON = "products/aib/package.json";
const AIE_PACKAGE_JSON = "products/aie/package.json";
const AUDIT_PATH = "docs/release/version-audit.json";

export const COMPOSER_PINS = Object.freeze([
  { name: "@tjalve/aib", packageJson: "products/aib/package.json" },
  { name: "@tjalve/aie", packageJson: "products/aie/package.json" },
  { name: "@tjalve/aiq", packageJson: "products/aiq/packages/cli/package.json" },
  { name: "@tjalve/aiu", packageJson: "products/aiu/package.json" },
  { name: "@tjalve/qube-cli", packageJson: "packages/qube-cli/package.json" },
  { name: "@tjalve/qube-core", packageJson: "packages/qube-core/package.json" },
]);

export function parseSuitePinArgs(argv) {
  const options = {
    help: false,
    json: false,
    write: false,
    repoRoot: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") options.help = true;
    else if (token === "--json") options.json = true;
    else if (token === "--write") options.write = true;
    else if (token === "--check") options.write = false;
    else if (token === "--repo-root") {
      const value = argv[index += 1];
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

export function resolveSuiteRoot(candidate, cwd = process.cwd()) {
  const resolved = path.resolve(cwd, candidate ?? DEFAULT_ROOT);
  const qubeJson = path.join(resolved, QUBE_PACKAGE_JSON);
  if (!existsSync(qubeJson)) {
    throw Object.assign(new Error("Suite root is missing products/qube/package.json."), {
      reasonCode: "missing-suite",
    });
  }
  let realRoot;
  let realQube;
  try {
    realRoot = realpathSync.native(resolved);
    realQube = realpathSync.native(qubeJson);
  } catch {
    throw Object.assign(new Error("Suite root is unreadable."), { reasonCode: "path-escape" });
  }
  const relative = path.relative(realRoot, realQube);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw Object.assign(new Error("Suite package path escapes the suite root."), { reasonCode: "path-escape" });
  }
  return realRoot;
}

function readJson(root, relativePath) {
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw Object.assign(new Error(`${relativePath} escapes the suite root.`), { reasonCode: "path-escape" });
  }
  if (existsSync(resolved)) {
    const realRoot = realpathSync.native(root);
    const realPath = realpathSync.native(resolved);
    const realRelative = path.relative(realRoot, realPath);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
      throw Object.assign(new Error(`${relativePath} resolves outside the suite root.`), { reasonCode: "path-escape" });
    }
  }
  return JSON.parse(readFileSync(resolved, "utf8"));
}

function writeJson(root, relativePath, value) {
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw Object.assign(new Error(`${relativePath} escapes the suite root.`), { reasonCode: "path-escape" });
  }
  writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function bumpPatch(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(version));
  if (!match) {
    throw Object.assign(new Error(`Unsupported semver value: ${version}`), { reasonCode: "semver" });
  }
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

export function resolveWorkspacePin(manifest, packageName, workspaceVersion) {
  const declared = manifest.dependencies?.[packageName];
  if (declared == null) return null;
  return String(declared).startsWith("workspace:") ? workspaceVersion : String(declared);
}

function publishedVersionsFor(name, audit, publishedByName) {
  if (publishedByName?.has(name)) return publishedByName.get(name) ?? [];
  const entry = (audit.packages ?? []).find(item => item.name === name);
  if (!entry) return [];
  const versions = [...(entry.publishedVersions ?? [])];
  if (entry.latestPublished && !versions.includes(entry.latestPublished)) {
    versions.push(entry.latestPublished);
  }
  return versions;
}

function isPublished(name, version, audit, publishedByName) {
  return publishedVersionsFor(name, audit, publishedByName).includes(version);
}

export function inspectSuitePins(root, options = {}) {
  const qube = readJson(root, QUBE_PACKAGE_JSON);
  const aib = readJson(root, AIB_PACKAGE_JSON);
  const aie = readJson(root, AIE_PACKAGE_JSON);
  const workspaceVersions = new Map();
  for (const pin of COMPOSER_PINS) {
    workspaceVersions.set(pin.name, readJson(root, pin.packageJson).version);
  }

  const failures = [];
  const adapterPins = inspectAdapterPins(root, options.adapterPackages);
  if (!adapterPins.ok) failures.push(adapterPins.failure);
  const expectedPins = {};
  for (const pin of COMPOSER_PINS) {
    const expected = workspaceVersions.get(pin.name);
    const actual = qube.dependencies?.[pin.name];
    expectedPins[pin.name] = expected;
    if (actual !== expected) {
      failures.push(`@tjalve/qube depends on ${pin.name}@${actual ?? "missing"}, expected ${expected}.`);
    }
  }

  const resolvedAie = resolveWorkspacePin(aib, "@tjalve/aie", aie.version);
  if (resolvedAie !== aie.version) {
    failures.push(`@tjalve/aib depends on @tjalve/aie@${resolvedAie ?? "missing"}, expected ${aie.version}.`);
  }

  return {
    ok: failures.length === 0,
    failures,
    expectedPins,
    qubeVersion: qube.version,
    aibVersion: aib.version,
    aieVersion: aie.version,
    resolvedAie,
    adapterPins: {
      ok: adapterPins.ok,
      changed: adapterPins.changed,
      outputPath: adapterPins.outputPath,
    },
  };
}

export function alignSuitePins(root, options = {}) {
  const inspection = inspectSuitePins(root, options);
  const audit = existsSync(path.join(root, AUDIT_PATH)) ? readJson(root, AUDIT_PATH) : { packages: [] };
  const publishedByName = options.publishedByName;
  const qube = readJson(root, QUBE_PACKAGE_JSON);
  const aib = readJson(root, AIB_PACKAGE_JSON);
  const aie = readJson(root, AIE_PACKAGE_JSON);
  const changed = [];
  const adapterPinsChanged = inspection.adapterPins.changed;

  const aiePublished = isPublished("@tjalve/aie", aie.version, audit, publishedByName);
  const aibPublished = isPublished("@tjalve/aib", aib.version, audit, publishedByName);
  if (!aiePublished && aibPublished) {
    aib.version = bumpPatch(aib.version);
    writeJson(root, AIB_PACKAGE_JSON, aib);
    changed.push({ name: "@tjalve/aib", version: aib.version });
  }

  let pinsChanged = false;
  qube.dependencies = { ...qube.dependencies };
  for (const pin of COMPOSER_PINS) {
    const expected = pin.name === "@tjalve/aib" ? aib.version : inspection.expectedPins[pin.name];
    if (qube.dependencies[pin.name] !== expected) {
      qube.dependencies[pin.name] = expected;
      pinsChanged = true;
    }
  }

  const qubePublished = isPublished("@tjalve/qube", qube.version, audit, publishedByName);
  if ((pinsChanged || adapterPinsChanged || changed.length > 0) && qubePublished) {
    qube.version = bumpPatch(qube.version);
    changed.push({ name: "@tjalve/qube", version: qube.version });
  }
  if (pinsChanged || changed.some(item => item.name === "@tjalve/qube")) {
    writeJson(root, QUBE_PACKAGE_JSON, qube);
  }
  const adapterPins = writeAdapterPins(root, options.adapterPackages);

  if (changed.length > 0 || pinsChanged || adapterPins.wrote) {
    for (const entry of audit.packages ?? []) {
      if (entry.name === "@tjalve/aib") entry.selectedVersion = aib.version;
      if (entry.name === "@tjalve/qube") entry.selectedVersion = qube.version;
    }
    if (audit.packages) writeJson(root, AUDIT_PATH, audit);
  }

  const after = inspectSuitePins(root, options);
  return {
    ...after,
    changed,
    wrote: changed.length > 0 || pinsChanged || adapterPins.wrote,
  };
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/suite-pins.mjs [--check|--write] [--json] [--repo-root <dir>]

Check that composer and generated adapter pins match workspace versions. --write
rewrites drifted pins and bumps only products that would otherwise republish an
already-public version.
`);
}

export function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseSuitePinArgs(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
    return;
  }
  if (parsed.help) {
    printHelp();
    return;
  }

  let report;
  try {
    const root = resolveSuiteRoot(parsed.repoRoot);
    report = parsed.write ? alignSuitePins(root) : inspectSuitePins(root);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error?.reasonCode === "usage" ? 2 : 1;
    return;
  }

  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } else if (report.ok) {
    process.stdout.write("Suite pins match workspace versions.\n");
  } else {
    process.stderr.write(`${report.failures.join("\n")}\n`);
  }
  if (!report.ok) process.exitCode = 1;
}

const invoked = process.argv[1] && path.normalize(process.argv[1]) === path.normalize(fileURLToPath(import.meta.url));
if (invoked) {
  main();
}
