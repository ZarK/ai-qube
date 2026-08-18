#!/usr/bin/env node
/**
 * Prints the ordered publish plan for the current workspace versions.
 * Set-tag staging uses GitHub Actions trusted publishing; approval keeps npm proof-of-presence.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PUBLISH_PACKAGES, PUBLISH_SET_ORDER } from "./publish-packages.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readVersion(packageJsonPath) {
  const json = JSON.parse(await readFile(path.join(ROOT, packageJsonPath), "utf8"));
  return json.version;
}

const qubeCoreVersion = await readVersion("packages/qube-core/package.json");
const qubeVersion = await readVersion("products/qube/package.json");

process.stdout.write(`QUBE ${qubeVersion} publish plan\n`);
process.stdout.write("=======================\n\n");
process.stdout.write("Adapter model: adapters are separate npm packages sourced from this monorepo.\n");
process.stdout.write("They are separate packages. qube install adds only the adapters the operator selects.\n");
process.stdout.write("Default GitHub + Codex workflow needs: @tjalve/aie + @tjalve/qube-adapter-github + @tjalve/qube-adapter-codex (+ @tjalve/qube-core via aie).\n\n");

process.stdout.write("0) Preflight (run from repo root)\n");
process.stdout.write("git switch main\n");
process.stdout.write("git pull --ff-only origin main\n");
process.stdout.write("pnpm install --frozen-lockfile --ignore-scripts\n");
process.stdout.write("pnpm run verify\n\n");

process.stdout.write("1) Build and stage unpublished workspace versions as one set\n");
process.stdout.write("pnpm run release\n");
process.stdout.write("# or:\n");
process.stdout.write(`git tag publish-set-v${qubeVersion}\n`);
process.stdout.write(`git push origin publish-set-v${qubeVersion}\n`);
process.stdout.write("# CI stages every workspace version that is not already on npm and skips the rest.\n");
process.stdout.write("# The workflow packs the full set from the checkout, installs those tarballs, and checks that qube, aie, aib, aiu, and aiq start.\n\n");

process.stdout.write("2) Validate and approve the complete staged set\n");
process.stdout.write(`pnpm run release:approve -- publish-set-v${qubeVersion}\n`);
process.stdout.write("# The command verifies the workflow run, tag commit, ordered stage IDs, and tarball shasums.\n");
process.stdout.write("# npm authentication and proof-of-presence remain required for each protected approval.\n");
process.stdout.write("# Re-run the same command after an interruption; matching public packages are skipped.\n\n");

process.stdout.write("3) Optional single-package staged releases (emergencies only)\n");
for (const key of PUBLISH_SET_ORDER) {
  const entry = PUBLISH_PACKAGES.get(key);
  const version = await readVersion(entry.packageJson);
  process.stdout.write(`git tag publish-${key}-v${version}\n`);
  process.stdout.write(`git push origin publish-${key}-v${version}\n`);
  process.stdout.write(`pnpm run release:approve -- publish-${key}-v${version}\n\n`);
}

process.stdout.write("4) Recommended consumer install (global npm example)\n");
const aieVersion = await readVersion("products/aie/package.json");
process.stdout.write(`npm install -g --ignore-scripts @tjalve/qube@${qubeVersion}\n`);
process.stdout.write("# or minimal executor stack:\n");
const githubAdapterVersion = await readVersion("adapters/github/package.json");
const codexAdapterVersion = await readVersion("adapters/codex/package.json");
process.stdout.write(`npm install -g --ignore-scripts @tjalve/aie@${aieVersion} @tjalve/qube-core@${qubeCoreVersion} @tjalve/qube-adapter-github@${githubAdapterVersion} @tjalve/qube-adapter-codex@${codexAdapterVersion}\n\n`);

process.stdout.write("Notes:\n");
process.stdout.write("- After the first wave, use publish-set-v<qubeVersion> or pnpm run release. Use publish-* tags only for a single package.\n");
process.stdout.write("- Each npm trusted publisher must allow only npm stage publish from .github/workflows/publish.yml and environment npm-publish.\n");
process.stdout.write("- This pipeline has no direct-publish or npm-token fallback.\n");
