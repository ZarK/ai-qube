import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function getAiuPackageRoot(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDir, ".."),
    path.resolve(moduleDir, "..", ".."),
  ];

  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
  }
  return candidates[0] ?? moduleDir;
}

export function getAiuPackageVersion(): string {
  const manifestPath = path.join(getAiuPackageRoot(), "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { readonly version?: unknown };
  if (typeof manifest.version !== "string" || manifest.version.trim().length === 0) {
    throw new Error(`AI Umpire package metadata does not contain a version: ${manifestPath}`);
  }
  return manifest.version;
}
