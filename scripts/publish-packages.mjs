import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const buildQubeCore = "pnpm --filter @tjalve/qube-core run build";
const buildGitHubAdapter = "pnpm --filter @tjalve/qube-adapter-github run build";
const buildCodexAdapter = "pnpm --filter @tjalve/qube-adapter-codex run build";
const buildClaudeCodeAdapter = "pnpm --filter @tjalve/qube-adapter-claude-code run build";
const buildOpenCodeAdapter = "pnpm --filter @tjalve/qube-adapter-opencode run build";
const buildGitLabAdapter = "pnpm --filter @tjalve/qube-adapter-gitlab run build";
const buildLinearAdapter = "pnpm --filter @tjalve/qube-adapter-linear run build";
const buildJiraAdapter = "pnpm --filter @tjalve/qube-adapter-jira run build";
const buildJenkinsAdapter = "pnpm --filter @tjalve/qube-adapter-jenkins run build";
const buildGrokBuildAdapter = "pnpm --filter @tjalve/qube-adapter-grok-build run build";
const buildQubeCli = "pnpm --filter @tjalve/qube-cli run build";
const buildAieDependencies = `${buildQubeCore} && ${buildGitHubAdapter} && ${buildGitLabAdapter} && ${buildLinearAdapter} && ${buildJiraAdapter} && ${buildCodexAdapter} && ${buildClaudeCodeAdapter} && ${buildOpenCodeAdapter} && ${buildGrokBuildAdapter} && ${buildQubeCli}`;
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
  ["qube-adapter-github", {
    ...adapterEntry("@tjalve/qube-adapter-github", "adapters/github/package.json"),
    path: "adapters/github",
    command: null,
  }],
  ["qube-adapter-codex", {
    ...adapterEntry("@tjalve/qube-adapter-codex", "adapters/codex/package.json"),
    path: "adapters/codex",
    command: null,
  }],
  ["qube-adapter-opencode", {
    ...adapterEntry("@tjalve/qube-adapter-opencode", "adapters/opencode/package.json"),
    path: "adapters/opencode",
    command: null,
  }],
  ["qube-adapter-claude-code", {
    ...adapterEntry("@tjalve/qube-adapter-claude-code", "adapters/claude-code/package.json"),
    path: "adapters/claude-code",
    command: null,
  }],
  ["qube-adapter-gitlab", {
    ...adapterEntry("@tjalve/qube-adapter-gitlab", "adapters/gitlab/package.json"),
    path: "adapters/gitlab",
    command: null,
  }],
  ["qube-adapter-linear", {
    ...adapterEntry("@tjalve/qube-adapter-linear", "adapters/linear/package.json"),
    path: "adapters/linear",
    command: null,
  }],
  ["qube-adapter-jira", {
    ...adapterEntry("@tjalve/qube-adapter-jira", "adapters/jira/package.json"),
    path: "adapters/jira",
    command: null,
  }],
  ["qube-adapter-jenkins", {
    ...adapterEntry("@tjalve/qube-adapter-jenkins", "adapters/jenkins/package.json"),
    path: "adapters/jenkins",
    command: null,
  }],
  ["qube-adapter-grok-build", {
    ...adapterEntry("@tjalve/qube-adapter-grok-build", "adapters/grok-build/package.json"),
    path: "adapters/grok-build",
    command: null,
  }],
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
    prepare: `${buildQubeCore} && ${buildGitLabAdapter} && ${buildLinearAdapter} && ${buildJiraAdapter} && ${buildQubeCli}`,
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
    prepare: buildQubeCli,
    verify: "pnpm --filter @tjalve/aiu run release:check",
    command: "aiu",
  }],
  ["aiq", {
    filter: "@tjalve/aiq",
    path: "products/aiq/packages/cli",
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
  "qube-adapter-github",
  "qube-adapter-codex",
  "qube-adapter-opencode",
  "qube-adapter-claude-code",
  "qube-adapter-gitlab",
  "qube-adapter-linear",
  "qube-adapter-jira",
  "qube-adapter-jenkins",
  "qube-adapter-grok-build",
  "aib",
  "aie",
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
  return plan.packages.filter(entry => typeof entry.command === "string" && entry.command.length > 0);
}
