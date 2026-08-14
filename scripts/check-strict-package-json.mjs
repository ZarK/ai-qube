import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const onlyIndex = process.argv.indexOf("--only");
const onlyFiles = onlyIndex >= 0 ? process.argv.slice(onlyIndex + 1).filter(value => value && !value.startsWith("--")) : [];
const failures = [];
const checked = [];

const files = onlyFiles.length > 0
  ? onlyFiles
  : await listPublishablePackageJsons();

for (const relativePath of files) {
  const packageJsonPath = path.resolve(repoRoot, relativePath);
  let raw;
  try {
    raw = await readFile(packageJsonPath);
  } catch (error) {
    failures.push(`${relativePath}: cannot read publishable package.json (${error instanceof Error ? error.message : String(error)})`);
    continue;
  }
  if (raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
    failures.push(`${relativePath}: UTF-8 BOM is not allowed in a strict package.json`);
    continue;
  }
  try {
    const parsed = JSON.parse(raw.toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      failures.push(`${relativePath}: strict JSON must be an object`);
      continue;
    }
    checked.push(relativePath);
  } catch (error) {
    failures.push(`${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(`${JSON.stringify({ ok: true, command: "check-strict-package-json", files: checked })}\n`);

async function listPublishablePackageJsons() {
  const audit = JSON.parse(await readFile(path.join(repoRoot, "docs/release/version-audit.json"), "utf8"));
  return (audit.packages ?? []).map(entry => entry.packageJson).filter(value => typeof value === "string" && value !== "");
}
