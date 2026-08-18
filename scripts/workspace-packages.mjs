import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

export const ADAPTER_PACKAGES = Object.freeze([
  { key: "qube-adapter-github", name: "@tjalve/qube-adapter-github", path: "adapters/github", packageJson: "adapters/github/package.json" },
  { key: "qube-adapter-codex", name: "@tjalve/qube-adapter-codex", path: "adapters/codex", packageJson: "adapters/codex/package.json" },
  { key: "qube-adapter-opencode", name: "@tjalve/qube-adapter-opencode", path: "adapters/opencode", packageJson: "adapters/opencode/package.json" },
  { key: "qube-adapter-claude-code", name: "@tjalve/qube-adapter-claude-code", path: "adapters/claude-code", packageJson: "adapters/claude-code/package.json" },
  { key: "qube-adapter-gitlab", name: "@tjalve/qube-adapter-gitlab", path: "adapters/gitlab", packageJson: "adapters/gitlab/package.json" },
  { key: "qube-adapter-linear", name: "@tjalve/qube-adapter-linear", path: "adapters/linear", packageJson: "adapters/linear/package.json" },
  { key: "qube-adapter-jira", name: "@tjalve/qube-adapter-jira", path: "adapters/jira", packageJson: "adapters/jira/package.json" },
  { key: "qube-adapter-jenkins", name: "@tjalve/qube-adapter-jenkins", path: "adapters/jenkins", packageJson: "adapters/jenkins/package.json" },
  { key: "qube-adapter-grok-build", name: "@tjalve/qube-adapter-grok-build", path: "adapters/grok-build", packageJson: "adapters/grok-build/package.json" },
  { key: "qube-adapter-cursor", name: "@tjalve/qube-adapter-cursor", path: "adapters/cursor", packageJson: "adapters/cursor/package.json" },
]);

export function validatePackageCatalog(entries = ADAPTER_PACKAGES) {
  const keys = new Set();
  const names = new Set();
  const paths = new Set();
  for (const entry of entries) {
    if (!entry?.key || !entry?.name || !entry?.path || !entry?.packageJson) {
      throw Object.assign(new Error("Workspace package catalog entries require key, name, path, and packageJson."), { reasonCode: "invalid-catalog" });
    }
    if (keys.has(entry.key) || names.has(entry.name) || paths.has(entry.packageJson)) {
      throw Object.assign(new Error(`Duplicate workspace package catalog entry: ${entry.name}.`), { reasonCode: "duplicate-catalog-entry" });
    }
    if (entry.packageJson !== `${entry.path}/package.json`) {
      throw Object.assign(new Error(`Workspace package catalog path mismatch for ${entry.name}.`), { reasonCode: "invalid-catalog" });
    }
    keys.add(entry.key);
    names.add(entry.name);
    paths.add(entry.packageJson);
  }
  return entries;
}

export function readCatalogManifests(root, entries = ADAPTER_PACKAGES) {
  validatePackageCatalog(entries);
  const realRoot = realpathSync.native(root);
  return entries.map(entry => {
    const manifestPath = path.resolve(root, entry.packageJson);
    const relative = path.relative(root, manifestPath);
    if (relative.startsWith("..") || path.isAbsolute(relative) || !existsSync(manifestPath)) {
      throw Object.assign(new Error(`Workspace package manifest is missing or outside the suite: ${entry.packageJson}.`), { reasonCode: "invalid-package-path" });
    }
    const realManifestPath = realpathSync.native(manifestPath);
    const realRelative = path.relative(realRoot, realManifestPath);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
      throw Object.assign(new Error(`Workspace package manifest resolves outside the suite: ${entry.packageJson}.`), { reasonCode: "invalid-package-path" });
    }
    const manifest = JSON.parse(readFileSync(realManifestPath, "utf8"));
    if (manifest.name !== entry.name) {
      throw Object.assign(new Error(`${entry.packageJson} declares ${manifest.name ?? "no package name"}; expected ${entry.name}.`), { reasonCode: "package-name-mismatch" });
    }
    return Object.freeze({ ...entry, version: manifest.version });
  });
}
