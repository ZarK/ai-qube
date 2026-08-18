import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ADAPTER_PACKAGES } from "./workspace-packages.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const buildQubeCore = "pnpm --filter @tjalve/qube-core run build";
const buildQubeCli = "pnpm --filter @tjalve/qube-cli run build";
const buildAdapters = ADAPTER_PACKAGES.map(entry => `pnpm --filter ${entry.name} run build`).join(" && ");
const buildAieDependencies = `${buildQubeCore} && ${buildAdapters} && ${buildQubeCli}`;
const buildAiqDependencies = `${buildAieDependencies} && pnpm --filter @tjalve/aie run build && pnpm --filter @tjalve/aiu run build`;

function adapterEntry(filter, packageJson) {
  return Object.freeze({
    filter,
    packageJson,
    prepare: `${buildQubeCore} && pnpm --filter ${filter} run build`,
    verify: `pnpm --filter ${filter} run verify`,
  });
}

export const PUBLISH_PACKAGES = Object.freeze(new Map([
  ["qube-core", {
    filter: "@tjalve/qube-core",
    path: "packages/qube-core",
    packageJson: "packages/qube-core/package.json",
    prepare: buildQubeCore,
    verify: "pnpm --filter @tjalve/qube-core run verify",
    command: null,
  }],
  ...ADAPTER_PACKAGES.map(entry => [entry.key, {
    ...adapterEntry(entry.name, entry.packageJson),
    path: entry.path,
    command: null,
  }]),
  ["qube-cli", {
    filter: "@tjalve/qube-cli",
    path: "packages/qube-cli",
    packageJson: "packages/qube-cli/package.json",
    prepare: buildQubeCli,
    verify: "pnpm --filter @tjalve/qube-cli run verify",
    command: null,
  }],
  ["aib", {
    filter: "@tjalve/aib",
    path: "products/aib",
    packageJson: "products/aib/package.json",
    prepare: buildAieDependencies,
    verify: "pnpm --filter @tjalve/aib run verify",
    command: "aib",
  }],
  ["aie", {
    filter: "@tjalve/aie",
    path: "products/aie",
    packageJson: "products/aie/package.json",
    prepare: buildAieDependencies,
    verify: "pnpm --filter @tjalve/aie run verify",
    command: "aie",
  }],
  ["aiu", {
    filter: "@tjalve/aiu",
    path: "products/aiu",
    packageJson: "products/aiu/package.json",
    prepare: buildAieDependencies,
    verify: "pnpm --filter @tjalve/aiu run release:check",
    command: "aiu",
  }],
  ["aiq", {
    filter: "@tjalve/aiq",
    path: "products/aiq/packages/cli",
    inputs: Object.freeze(["products/aiq"]),
    syncPrivateVersions: true,
    packageJson: "products/aiq/packages/cli/package.json",
    prepare: buildAiqDependencies,
    verify: "pnpm --filter @tjalve/aiq-workspace run build && pnpm --filter @tjalve/aiq-workspace run test:publish-readiness",
    command: "aiq",
  }],
  ["qube", {
    filter: "@tjalve/qube",
    path: "products/qube",
    packageJson: "products/qube/package.json",
    prepare: `${buildAieDependencies} && pnpm --filter @tjalve/aib run build && pnpm --filter @tjalve/aie run build && pnpm --filter @tjalve/aiu run build && pnpm --filter @tjalve/aiq-workspace run build`,
    verify: "pnpm --filter @tjalve/qube run verify",
    command: "qube",
  }],
]));

export const PUBLISH_SET_ORDER = Object.freeze([
  "qube-core",
  "qube-cli",
  ...ADAPTER_PACKAGES.map(entry => entry.key),
  "aie",
  "aib",
  "aiu",
  "aiq",
  "qube",
]);

export const SET_PREPARE = "pnpm run build";
export const SET_VERIFY = "pnpm run version:audit && pnpm run verify:manifests";

const PACKAGE_TAG = /^publish-([a-z0-9-]+)-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;
const SET_TAG = /^publish-set-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;

export function repoRootFrom(moduleUrl = import.meta.url) {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..");
}

export async function readPackageJson(relativePath, root = ROOT) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}

function fail(message) {
  const error = new Error(message);
  error.reasonCode = "publish-tag";
  throw error;
}

async function packagePlan(key, root) {
  const entry = PUBLISH_PACKAGES.get(key);
  if (!entry) fail(`Unknown package key "${key}". Valid keys: ${[...PUBLISH_PACKAGES.keys()].join(", ")}.`);
  const packageJson = await readPackageJson(entry.packageJson, root);
  return Object.freeze({
    packageKey: key,
    packageName: packageJson.name,
    version: packageJson.version,
    filter: entry.filter,
    path: entry.path,
    packageJson: entry.packageJson,
    prepare: entry.prepare,
    verify: entry.verify,
    command: entry.command,
  });
}

export async function resolvePublishTag(tag, root = ROOT) {
  const setMatch = SET_TAG.exec(tag ?? "");
  if (setMatch) {
    const setVersion = setMatch[1];
    const qube = await readPackageJson("products/qube/package.json", root);
    if (qube.version !== setVersion) {
      fail(`Set tag version ${setVersion} does not match products/qube/package.json version ${qube.version}.`);
    }
    const packages = [];
    for (const key of PUBLISH_SET_ORDER) {
      packages.push(await packagePlan(key, root));
    }
    return Object.freeze({
      mode: "set",
      setVersion,
      prepare: SET_PREPARE,
      verify: SET_VERIFY,
      packages,
    });
  }

  const match = PACKAGE_TAG.exec(tag ?? "");
  if (!match) {
    fail(`Invalid publish tag "${tag}". Expected publish-<package>-v<version> or publish-set-v<qubeVersion>.`);
  }
  const [, packageKey, tagVersion] = match;
  if (packageKey === "set") {
    fail(`Invalid publish tag "${tag}". Expected publish-set-v<qubeVersion>.`);
  }
  const planned = await packagePlan(packageKey, root);
  if (planned.version !== tagVersion) {
    fail(`Tag version ${tagVersion} does not match ${planned.packageJson} version ${planned.version}.`);
  }
  return Object.freeze({
    mode: "package",
    setVersion: null,
    prepare: planned.prepare,
    verify: planned.verify,
    packages: [planned],
  });
}

export function commandPackages(plan) {
  const packages = plan.verifyPackages ?? plan.packages;
  return packages.filter(entry => typeof entry.command === "string" && entry.command.length > 0);
}

export function registryPackageUrl(packageName, registry = "https://registry.npmjs.org/") {
  const base = String(registry).endsWith("/") ? registry : `${registry}/`;
  return `${base}${String(packageName).replace("/", "%2f")}`;
}

export async function readPublishedVersions(packageName, options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const url = registryPackageUrl(packageName, options.registry);
  let response;
  try {
    response = await fetchImpl(url, { headers: { accept: "application/json" } });
  } catch (error) {
    throw Object.assign(
      new Error(`Registry lookup for ${packageName} failed.`),
      { reasonCode: "registry-lookup", cause: error }
    );
  }
  if (response.status === 404) return [];
  if (!response.ok) {
    throw Object.assign(
      new Error(`Registry lookup for ${packageName} failed (${response.status}).`),
      { reasonCode: "registry-lookup" }
    );
  }
  let body;
  try {
    body = await response.json();
  } catch (error) {
    throw Object.assign(
      new Error(`Registry lookup for ${packageName} failed.`),
      { reasonCode: "registry-lookup", cause: error }
    );
  }
  return Object.keys(body.versions ?? {});
}

export async function readPublishedVersionsForPlan(plan, options = {}) {
  const packageNames = [...new Set((plan.packages ?? []).map(entry => entry.packageName))];
  const versionSets = await Promise.all(packageNames.map(packageName => readPublishedVersions(packageName, options)));
  return new Map(packageNames.map((packageName, index) => [packageName, versionSets[index]]));
}

function failFinalize(message, reasonCode) {
  const error = new Error(message);
  error.reasonCode = reasonCode;
  throw error;
}

export function finalizePublishPlan(plan, publishedByName) {
  if (!plan || !Array.isArray(plan.packages) || plan.packages.length === 0) {
    failFinalize("Publish plan has no packages.", "empty-plan");
  }
  const publishedMap = publishedByName instanceof Map
    ? publishedByName
    : new Map(Object.entries(publishedByName ?? {}));

  if (plan.mode === "package") {
    const entry = plan.packages[0];
    const published = publishedMap.get(entry.packageName) ?? [];
    if (published.includes(entry.version)) {
      failFinalize(`${entry.packageName}@${entry.version} is already on npm.`, "already-published");
    }
    return Object.freeze({
      ...plan,
      packages: Object.freeze([...plan.packages]),
      verifyPackages: Object.freeze([...plan.packages]),
      skipped: Object.freeze([]),
    });
  }

  const selected = [];
  const skipped = [];
  for (const entry of plan.packages) {
    const published = publishedMap.get(entry.packageName) ?? [];
    if (published.includes(entry.version)) {
      skipped.push(Object.freeze({ ...entry, skipReason: "already-published" }));
    } else {
      selected.push(entry);
    }
  }
  if (selected.length === 0) {
    failFinalize("Publish set has no unpublished packages.", "nothing-to-publish");
  }
  return Object.freeze({
    ...plan,
    packages: Object.freeze(selected),
    verifyPackages: Object.freeze([...plan.packages]),
    skipped: Object.freeze(skipped),
  });
}
