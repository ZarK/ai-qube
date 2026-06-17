import { readFileSync } from "node:fs";

interface PackageMetadata {
  readonly name: string;
  readonly version: string;
}

export const aiqPackageMetadata = readPackageMetadata();
export const aiqPackageName = aiqPackageMetadata.name;
export const aiqPackageVersion = aiqPackageMetadata.version;

function readPackageMetadata(): PackageMetadata {
  const rawPackageJson = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  const parsed = JSON.parse(rawPackageJson) as Partial<PackageMetadata>;
  if (typeof parsed.name !== "string" || typeof parsed.version !== "string") {
    throw new TypeError("AIQ package.json must include string name and version fields.");
  }

  return { name: parsed.name, version: parsed.version };
}
