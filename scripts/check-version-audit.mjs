import { readFile } from "node:fs/promises";
import path from "node:path";

const auditPath = "docs/release/version-audit.json";
const audit = JSON.parse(await readFile(auditPath, "utf8"));
const failures = [];

for (const entry of audit.packages ?? []) {
  const packageJson = JSON.parse(await readFile(path.resolve(entry.packageJson), "utf8"));
  if (packageJson.name !== entry.name) {
    failures.push(`${entry.packageJson}: expected package name ${entry.name}, found ${packageJson.name}`);
  }
  if (packageJson.version !== entry.selectedVersion) {
    failures.push(`${entry.packageJson}: audit selectedVersion ${entry.selectedVersion} does not match package version ${packageJson.version}`);
  }
  if (entry.published === true && compareSemver(packageJson.version, entry.latestPublished) <= 0) {
    failures.push(`${entry.name}: package version ${packageJson.version} must be greater than audited npm latest ${entry.latestPublished}`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(`${JSON.stringify({ ok: true, auditPath, packageCount: audit.packages.length })}\n`);

function compareSemver(left, right) {
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
