#!/usr/bin/env node
/**
 * Prints the ordered publish plan for the current workspace versions.
 * Seed commands require npm OTP; staged tag publishes use GitHub Actions trusted publishing.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const seedPackages = [
  { key: "qube-core", dir: "packages/qube-core", filter: "@tjalve/qube-core" },
  { key: "qube-adapter-github", dir: "adapters/github", filter: "@tjalve/qube-adapter-github" },
  { key: "qube-adapter-codex", dir: "adapters/codex", filter: "@tjalve/qube-adapter-codex" },
  { key: "qube-adapter-opencode", dir: "adapters/opencode", filter: "@tjalve/qube-adapter-opencode" },
  { key: "qube-adapter-claude-code", dir: "adapters/claude-code", filter: "@tjalve/qube-adapter-claude-code" },
  { key: "qube-adapter-gitlab", dir: "adapters/gitlab", filter: "@tjalve/qube-adapter-gitlab" },
  { key: "qube-adapter-linear", dir: "adapters/linear", filter: "@tjalve/qube-adapter-linear" },
  { key: "qube-adapter-jira", dir: "adapters/jira", filter: "@tjalve/qube-adapter-jira" },
  { key: "qube-adapter-jenkins", dir: "adapters/jenkins", filter: "@tjalve/qube-adapter-jenkins" },
];

const stagedPackages = [
  "qube-cli",
  "aib",
  "aie",
  "aiu",
  "aiq",
  "qube",
  ...seedPackages.map(entry => entry.key),
];

async function readVersion(packageJsonPath) {
  const json = JSON.parse(await readFile(path.join(ROOT, packageJsonPath), "utf8"));
  return json.version;
}

const qubeCoreVersion = await readVersion("packages/qube-core/package.json");
const qubeVersion = await readVersion("products/qube/package.json");

process.stdout.write(`QUBE ${qubeVersion} publish plan\n`);
process.stdout.write("=======================\n\n");
process.stdout.write("Adapter model: adapters are separate npm packages sourced from this monorepo.\n");
process.stdout.write("They are optionalDependencies on @tjalve/aie and installed on demand.\n");
process.stdout.write("Default GitHub + Codex workflow needs: @tjalve/aie + @tjalve/qube-adapter-github + @tjalve/qube-adapter-codex (+ @tjalve/qube-core via aie).\n\n");

process.stdout.write("0) Preflight (run from repo root)\n");
process.stdout.write("git switch main\n");
process.stdout.write("git pull --ff-only origin main\n");
process.stdout.write("pnpm install --frozen-lockfile --ignore-scripts\n");
process.stdout.write("pnpm run verify\n\n");

process.stdout.write("1) Preferred: publish the current packages as one set\n");
process.stdout.write(`git tag publish-set-v${qubeVersion}\n`);
process.stdout.write(`git push origin publish-set-v${qubeVersion}\n`);
process.stdout.write("# Approve the staged set in the npm UI after the workflow finishes.\n");
process.stdout.write("# The workflow packs the set, installs it into a temp prefix, and checks that qube, aie, aib, aiu, and aiq start.\n\n");

process.stdout.write("2) First-time seed publishes (npm OTP required; configure trusted publisher after each new package)\n");
for (const entry of seedPackages) {
  const version = await readVersion(`${entry.dir}/package.json`);
  process.stdout.write(`# ${entry.filter}@${version}\n`);
  process.stdout.write(`pnpm --filter ${entry.filter} run verify\n`);
  const backToRoot = entry.dir.startsWith("packages/") ? ".." : "../..";
  process.stdout.write(`cd ${entry.dir}\n`);
  process.stdout.write(`npm publish --access public --provenance=false --otp <otp>\n`);
  process.stdout.write(`cd ${backToRoot}\n\n`);
}

process.stdout.write("3) Optional single-package staged publishes\n");
for (const key of stagedPackages) {
  let version;
  if (key === "qube-cli") version = await readVersion("packages/qube-cli/package.json");
  else if (key === "aib") version = await readVersion("products/aib/package.json");
  else if (key === "aie") version = await readVersion("products/aie/package.json");
  else if (key === "aiu") version = await readVersion("products/aiu/package.json");
  else if (key === "aiq") version = await readVersion("products/aiq/packages/cli/package.json");
  else if (key === "qube") version = await readVersion("products/qube/package.json");
  else {
    const entry = seedPackages.find(item => item.key === key);
    version = entry ? await readVersion(`${entry.dir}/package.json`) : "?";
  }
  process.stdout.write(`git tag publish-${key}-v${version}\n`);
  process.stdout.write(`git push origin publish-${key}-v${version}\n`);
  process.stdout.write(`# Approve staged package in npm UI for publish-${key}-v${version}\n\n`);
}

process.stdout.write("4) Recommended consumer install (global npm example)\n");
const aieVersion = await readVersion("products/aie/package.json");
process.stdout.write(`npm install -g --ignore-scripts @tjalve/qube@${qubeVersion}\n`);
process.stdout.write("# or minimal executor stack:\n");
const githubAdapterVersion = await readVersion("adapters/github/package.json");
const codexAdapterVersion = await readVersion("adapters/codex/package.json");
process.stdout.write(`npm install -g --ignore-scripts @tjalve/aie@${aieVersion} @tjalve/qube-core@${qubeCoreVersion} @tjalve/qube-adapter-github@${githubAdapterVersion} @tjalve/qube-adapter-codex@${codexAdapterVersion}\n\n`);

process.stdout.write("Notes:\n");
process.stdout.write("- Seed qube-core before any adapter seed publish.\n");
process.stdout.write("- Re-run seed publishes only for package names that do not exist on npm yet.\n");
process.stdout.write("- After the first wave, prefer publish-set-v<qubeVersion>. Use publish-* tags only for a single package.\n");
process.stdout.write("- Do not publish from a local shell after the first seed. The maintainer pushes a tag.\n");