import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonPath = path.resolve(process.argv[2] ?? "package.json");
const backupPath = `${packageJsonPath}.publish-backup`;

const audit = JSON.parse(await readFile(path.join(repoRoot, "docs/release/version-audit.json"), "utf8"));
const packageVersions = new Map();

for (const entry of audit.packages ?? []) {
  const manifest = JSON.parse(await readFile(path.join(repoRoot, entry.packageJson), "utf8"));
  if (manifest.name !== entry.name) {
    throw new Error(`${entry.packageJson}: expected package name ${entry.name}, found ${manifest.name}`);
  }
  packageVersions.set(entry.name, manifest.version);
}

const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
const resolved = [];

for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
  const entries = packageJson[field];
  if (!entries || typeof entries !== "object") continue;

  for (const [name, version] of Object.entries(entries)) {
    if (!String(version).startsWith("workspace:")) continue;

    const exactVersion = packageVersions.get(name);
    if (!exactVersion) {
      throw new Error(`Cannot resolve workspace dependency ${name} for ${packageJsonPath}`);
    }

    entries[name] = exactVersion;
    resolved.push({ field, name, version: exactVersion });
  }
}

if (resolved.length > 0) {
  await copyFile(packageJsonPath, backupPath);
  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  packageJsonPath,
  name: packageJson.name,
  version: packageJson.version,
  resolved,
})}\n`);