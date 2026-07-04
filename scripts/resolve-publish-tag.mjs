import { readFile } from "node:fs/promises";
import path from "node:path";

const buildQubeCore = "pnpm --filter @tjalve/qube-core run build";
const buildGitHubAdapter = "pnpm --filter @tjalve/qube-adapter-github run build";
const buildCodexAdapter = "pnpm --filter @tjalve/qube-adapter-codex run build";
const buildClaudeCodeAdapter = "pnpm --filter @tjalve/qube-adapter-claude-code run build";
const buildOpenCodeAdapter = "pnpm --filter @tjalve/qube-adapter-opencode run build";
const buildGitLabAdapter = "pnpm --filter @tjalve/qube-adapter-gitlab run build";
const buildLinearAdapter = "pnpm --filter @tjalve/qube-adapter-linear run build";
const buildJiraAdapter = "pnpm --filter @tjalve/qube-adapter-jira run build";
const buildJenkinsAdapter = "pnpm --filter @tjalve/qube-adapter-jenkins run build";
const buildQubeCli = "pnpm --filter @tjalve/qube-cli run build";
const buildAieDependencies = `${buildQubeCore} && ${buildGitHubAdapter} && ${buildCodexAdapter} && ${buildClaudeCodeAdapter} && ${buildOpenCodeAdapter} && ${buildQubeCli}`;
const buildAiqDependencies = `${buildAieDependencies} && pnpm --filter @tjalve/aie run build && pnpm --filter @tjalve/aiu run build`;

function adapterEntry(key, filter, packageJson, verifyFilter = filter) {
  return Object.freeze({
    id: key,
    filter,
    packageJson,
    prepare: `${buildQubeCore} && pnpm --filter ${filter} run build`,
    verify: `pnpm --filter ${verifyFilter} run verify`,
  });
}

const packages = new Map([
  ["qube-cli", { filter: "@tjalve/qube-cli", path: "packages/qube-cli", packageJson: "packages/qube-cli/package.json", prepare: buildQubeCli, verify: "pnpm --filter @tjalve/qube-cli run verify" }],
  ["qube-core", { filter: "@tjalve/qube-core", path: "packages/qube-core", packageJson: "packages/qube-core/package.json", prepare: buildQubeCore, verify: "pnpm --filter @tjalve/qube-core run verify" }],
  ["qube-adapter-github", { ...adapterEntry("qube-adapter-github", "@tjalve/qube-adapter-github", "adapters/github/package.json"), path: "adapters/github" }],
  ["qube-adapter-codex", { ...adapterEntry("qube-adapter-codex", "@tjalve/qube-adapter-codex", "adapters/codex/package.json"), path: "adapters/codex" }],
  ["qube-adapter-opencode", { ...adapterEntry("qube-adapter-opencode", "@tjalve/qube-adapter-opencode", "adapters/opencode/package.json"), path: "adapters/opencode" }],
  ["qube-adapter-claude-code", { ...adapterEntry("qube-adapter-claude-code", "@tjalve/qube-adapter-claude-code", "adapters/claude-code/package.json"), path: "adapters/claude-code" }],
  ["qube-adapter-gitlab", { ...adapterEntry("qube-adapter-gitlab", "@tjalve/qube-adapter-gitlab", "adapters/gitlab/package.json"), path: "adapters/gitlab" }],
  ["qube-adapter-linear", { ...adapterEntry("qube-adapter-linear", "@tjalve/qube-adapter-linear", "adapters/linear/package.json"), path: "adapters/linear" }],
  ["qube-adapter-jira", { ...adapterEntry("qube-adapter-jira", "@tjalve/qube-adapter-jira", "adapters/jira/package.json"), path: "adapters/jira" }],
  ["qube-adapter-jenkins", { ...adapterEntry("qube-adapter-jenkins", "@tjalve/qube-adapter-jenkins", "adapters/jenkins/package.json"), path: "adapters/jenkins" }],
  ["aib", { filter: "@tjalve/aib", path: "products/aib", packageJson: "products/aib/package.json", prepare: `${buildQubeCore} && ${buildGitLabAdapter} && ${buildLinearAdapter} && ${buildJiraAdapter} && ${buildQubeCli}`, verify: "pnpm --filter @tjalve/aib run verify" }],
  ["aie", { filter: "@tjalve/aie", path: "products/aie", packageJson: "products/aie/package.json", prepare: buildAieDependencies, verify: "pnpm --filter @tjalve/aie run verify" }],
  ["aiu", { filter: "@tjalve/aiu", path: "products/aiu", packageJson: "products/aiu/package.json", prepare: buildQubeCli, verify: "pnpm --filter @tjalve/aiu run release:check" }],
  ["aiq", { filter: "@tjalve/aiq", path: "products/aiq/packages/cli", packageJson: "products/aiq/packages/cli/package.json", prepare: buildAiqDependencies, verify: "pnpm --filter @tjalve/aiq-workspace run build && pnpm --filter @tjalve/aiq-workspace run test:publish-readiness" }],
  ["qube", { filter: "@tjalve/qube", path: "products/qube", packageJson: "products/qube/package.json", prepare: `${buildAieDependencies} && pnpm --filter @tjalve/aib run build && pnpm --filter @tjalve/aie run build && pnpm --filter @tjalve/aiu run build && pnpm --filter @tjalve/aiq-workspace run build`, verify: "pnpm --filter @tjalve/qube run verify" }]
]);

const tag = process.argv[2] ?? "";
const match = /^publish-([a-z0-9-]+)-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.exec(tag);
if (!match) {
  fail(`Invalid publish tag "${tag}". Expected publish-<package>-v<version>.`);
}

const [, packageKey, tagVersion] = match;
const entry = packages.get(packageKey);
if (!entry) {
  fail(`Unknown package key "${packageKey}". Valid keys: ${[...packages.keys()].join(", ")}.`);
}

const packageJson = JSON.parse(await readFile(path.resolve(entry.packageJson), "utf8"));
if (packageJson.version !== tagVersion) {
  fail(`Tag version ${tagVersion} does not match ${entry.packageJson} version ${packageJson.version}.`);
}

process.stdout.write(`${JSON.stringify({
  packageKey,
  packageName: packageJson.name,
  version: packageJson.version,
  filter: entry.filter,
  path: entry.path,
  prepare: entry.prepare,
  verify: entry.verify
})}\n`);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}