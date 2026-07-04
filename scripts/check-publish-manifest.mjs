import { readFile } from "node:fs/promises";
import path from "node:path";

const exactVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const packageJsonPath = path.resolve(process.argv[2] ?? "package.json");
const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
const failures = [];

for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
  const entries = packageJson[field];
  if (!entries || typeof entries !== "object") continue;

  for (const [name, version] of Object.entries(entries)) {
    const versionText = String(version);

    if (versionText.startsWith("workspace:")) {
      failures.push(`${packageJsonPath}: ${field}.${name} uses unsupported publish protocol "${version}"`);
      continue;
    }

    if (!exactVersionPattern.test(versionText)) {
      failures.push(`${packageJsonPath}: ${field}.${name} must use an exact publish version, found "${version}"`);
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(`${JSON.stringify({ ok: true, packageJsonPath, name: packageJson.name, version: packageJson.version })}\n`);