import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PUBLISH_PACKAGES } from "./publish-packages.mjs";

const auditPath = "docs/release/version-audit.json";

export function compareSemver(left, right) {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    const delta = leftParts[index] - rightParts[index];
    if (delta !== 0) return delta;
  }
  return comparePrerelease(leftParts[3], rightParts[3]);
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(value));
  if (!match) {
    throw new Error(`Unsupported semver value: ${value}`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? ""];
}

function comparePrerelease(left, right) {
  if (left === right) return 0;
  if (left === "") return 1;
  if (right === "") return -1;
  return left < right ? -1 : 1;
}

export function collectVersionAuditFailures(audit, readManifest, expectedPackages = []) {
  const failures = [];
  const auditedPaths = new Set();
  for (const entry of audit.packages ?? []) {
    if (auditedPaths.has(entry.packageJson)) {
      failures.push(`${entry.packageJson}: duplicate version audit entry`);
      continue;
    }
    auditedPaths.add(entry.packageJson);
    const packageJson = readManifest(entry.packageJson);
    if (packageJson.name !== entry.name) {
      failures.push(`${entry.packageJson}: expected package name ${entry.name}, found ${packageJson.name}`);
    }
    if (packageJson.version !== entry.selectedVersion) {
      failures.push(`${entry.packageJson}: audit selectedVersion ${entry.selectedVersion} does not match package version ${packageJson.version}`);
    }
    if (entry.published === true && compareSemver(packageJson.version, entry.latestPublished) < 0) {
      failures.push(`${entry.name}: package version ${packageJson.version} must not be behind audited npm latest ${entry.latestPublished}`);
    }
  }
  for (const expected of expectedPackages) {
    if (!auditedPaths.has(expected.packageJson)) {
      failures.push(`${expected.packageJson}: publishable package is missing from ${auditPath}`);
    }
  }
  return failures;
}

export async function main(root = process.cwd()) {
  const audit = JSON.parse(await readFile(path.join(root, auditPath), "utf8"));
  const failures = collectVersionAuditFailures(audit, relativePath => (
    JSON.parse(readFileSync(path.resolve(root, relativePath), "utf8"))
  ), [...PUBLISH_PACKAGES.values()]);

  if (failures.length > 0) {
    process.stderr.write(`${failures.join("\n")}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`${JSON.stringify({ ok: true, auditPath, packageCount: audit.packages.length })}\n`);
}

const invoked = process.argv[1] && path.normalize(process.argv[1]) === path.normalize(fileURLToPath(import.meta.url));
if (invoked) {
  await main();
}
