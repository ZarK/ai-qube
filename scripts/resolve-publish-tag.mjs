import { readFile } from "node:fs/promises";
import path from "node:path";

const buildQubeCore = "pnpm --filter @tjalve/qube-core run build";
const buildGitHubAdapter = "pnpm --filter @tjalve/qube-adapter-github run build";
const buildCodexAdapter = "pnpm --filter @tjalve/qube-adapter-codex run build";
const buildQubeCli = "pnpm --filter @tjalve/qube-cli run build";
const buildAieDependencies = `${buildQubeCore} && ${buildGitHubAdapter} && ${buildCodexAdapter} && ${buildQubeCli}`;
const buildAiqDependencies = `${buildAieDependencies} && pnpm --filter @tjalve/aie run build && pnpm --filter @tjalve/aiu run build`;

const packages = new Map([
  ["qube-cli", { filter: "@tjalve/qube-cli", path: "packages/qube-cli", packageJson: "packages/qube-cli/package.json", prepare: buildQubeCli, verify: "pnpm --filter @tjalve/qube-cli run verify" }],
  ["aib", { filter: "@tjalve/aib", path: "products/aib", packageJson: "products/aib/package.json", prepare: buildQubeCli, verify: "pnpm --filter @tjalve/aib run verify" }],
  ["aie", { filter: "@tjalve/aie", path: "products/aie", packageJson: "products/aie/package.json", prepare: buildAieDependencies, verify: "pnpm --filter @tjalve/aie run verify" }],
  ["aiu", { filter: "@tjalve/aiu", path: "products/aiu", packageJson: "products/aiu/package.json", prepare: buildQubeCli, verify: "pnpm --filter @tjalve/aiu run release:check" }],
  ["aiq", { filter: "@tjalve/aiq", path: "products/aiq/packages/cli", packageJson: "products/aiq/packages/cli/package.json", prepare: buildAiqDependencies, verify: "pnpm --filter ai-code-quality run build && pnpm --filter ai-code-quality run test:publish-readiness" }],
  ["qube", { filter: "@tjalve/qube", path: "products/qube", packageJson: "products/qube/package.json", prepare: `${buildAieDependencies} && pnpm --filter @tjalve/aib run build && pnpm --filter @tjalve/aie run build && pnpm --filter @tjalve/aiu run build && pnpm --filter ai-code-quality run build`, verify: "pnpm --filter @tjalve/qube run verify" }]
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
