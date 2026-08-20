import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ADAPTER_PACKAGES, readCatalogManifests } from "../../../scripts/workspace-packages.mjs";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const packageJson = JSON.parse(readFileSync(`${packageRoot}/package.json`, "utf8"));

const componentCatalog = [
  ["bootstrap", "aib", "@tjalve/aib"],
  ["executor", "aie", "@tjalve/aie"],
  ["quality", "aiq", "@tjalve/aiq"],
  ["umpire", "aiu", "@tjalve/aiu"]
];

export const qubePackageName = packageJson.name;
export const qubePackageVersion = packageJson.version;

export function dependencyVersion(packageName) {
  const version = packageJson.dependencies?.[packageName];
  if (!version || version === "workspace:*") {
    throw new Error(`Missing exact dependency version for ${packageName} in products/qube/package.json`);
  }
  return version;
}

export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const componentFixtures = componentCatalog.map(([id, command, packageName]) => ({
  id,
  command,
  name: packageName,
  version: dependencyVersion(packageName)
}));

export const expectedComponentRows = componentFixtures.map(({ id, command, name, version }) => [id, command, name, version]);

export const aibVersion = dependencyVersion("@tjalve/aib");
export const aieVersion = dependencyVersion("@tjalve/aie");

export const adapterPackageVersions = Object.freeze(Object.fromEntries(
  readCatalogManifests(repoRoot, ADAPTER_PACKAGES).map(entry => [entry.name, entry.version])
));

export function qubePnpmAddCommandWith(...adapterNames) {
  const specs = [
    `${qubePackageName}@${qubePackageVersion}`,
    ...[...adapterNames].sort().map(name => `${name}@${adapterPackageVersions[name]}`)
  ];
  return `pnpm add -D --save-exact --ignore-scripts ${specs.join(" ")}`;
}

export const qubePnpmAddCommand = qubePnpmAddCommandWith("@tjalve/qube-adapter-github");

export const qubeNpmGlobalInstallPattern = new RegExp(
  `npm install --global --ignore-scripts @tjalve\\/qube@${escapeRegExp(qubePackageVersion)}`
);

export const qubePnpmAddPattern = new RegExp(
  `pnpm add -D --save-exact --ignore-scripts @tjalve\\/qube@${escapeRegExp(qubePackageVersion)}`
);
