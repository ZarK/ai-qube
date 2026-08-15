import { executorCiProviders, executorHostSurfaces, executorWorkProviders } from "./components.js";
import { packageName, packageVersion } from "./package.js";

export const adapterPackageVersions = Object.freeze({
  "@tjalve/qube-adapter-claude-code": "0.1.4",
  "@tjalve/qube-adapter-codex": "0.1.4",
  "@tjalve/qube-adapter-github": "0.1.4",
  "@tjalve/qube-adapter-gitlab": "0.1.4",
  "@tjalve/qube-adapter-jenkins": "0.1.4",
  "@tjalve/qube-adapter-jira": "0.1.4",
  "@tjalve/qube-adapter-linear": "0.1.4",
  "@tjalve/qube-adapter-opencode": "0.1.4"
});

export type AdapterPackageName = keyof typeof adapterPackageVersions;

export interface AdapterInstallSpec {
  readonly name: AdapterPackageName;
  readonly version: string;
}

export interface InstallPackageSelections {
  readonly scope: "local" | "global";
  readonly packageManager: "npm" | "pnpm";
  readonly hosts: readonly string[];
  readonly workProviders: readonly string[];
  readonly ciProviders: readonly string[];
  readonly lifecycleScripts?: "disabled" | "review";
}

const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

export function adapterPackageVersion(name: string): string {
  const version = (adapterPackageVersions as Readonly<Record<string, string>>)[name];
  if (!version || !EXACT_VERSION.test(version)) {
    throw new Error(`Missing exact adapter version for ${name}.`);
  }
  return version;
}

export function selectedAdapterInstallSpecs(selections: InstallPackageSelections): readonly AdapterInstallSpec[] {
  const catalogs = [...executorHostSurfaces, ...executorWorkProviders, ...executorCiProviders];
  const ids = [...selections.hosts, ...selections.workProviders, ...selections.ciProviders];
  const names = new Set<AdapterPackageName>();
  for (const id of ids) {
    const option = catalogs.find(entry => entry.id === id);
    if (!option?.packageName || option.packageName === packageName) {
      continue;
    }
    if (!(option.packageName in adapterPackageVersions)) {
      throw new Error(`Missing exact adapter version for ${option.packageName}.`);
    }
    names.add(option.packageName as AdapterPackageName);
  }
  return Object.freeze(
    [...names]
      .sort((left, right) => left.localeCompare(right))
      .map(name => Object.freeze({ name, version: adapterPackageVersion(name) }))
  );
}

export function packageInstallSpecs(selections: InstallPackageSelections): readonly string[] {
  return Object.freeze([
    `${packageName}@${packageVersion}`,
    ...selectedAdapterInstallSpecs(selections).map(spec => `${spec.name}@${spec.version}`)
  ]);
}

export function packageInstallArgv(selections: InstallPackageSelections): { readonly command: "npm" | "pnpm"; readonly args: readonly string[] } {
  const ignoreScripts = selections.lifecycleScripts === "review" || selections.lifecycleScripts === "disabled" || selections.lifecycleScripts === undefined;
  const specs = packageInstallSpecs(selections);
  if (selections.packageManager === "pnpm" && selections.scope === "local") {
    return { command: "pnpm", args: Object.freeze(["add", "-D", "--save-exact", ...(ignoreScripts ? ["--ignore-scripts"] : []), ...specs]) };
  }
  if (selections.packageManager === "pnpm" && selections.scope === "global") {
    return { command: "pnpm", args: Object.freeze(["add", "--global", ...(ignoreScripts ? ["--ignore-scripts"] : []), ...specs]) };
  }
  if (selections.packageManager === "npm" && selections.scope === "local") {
    return { command: "npm", args: Object.freeze(["install", "--save-dev", "--save-exact", ...(ignoreScripts ? ["--ignore-scripts"] : []), ...specs]) };
  }
  return { command: "npm", args: Object.freeze(["install", "--global", ...(ignoreScripts ? ["--ignore-scripts"] : []), ...specs]) };
}

export function formatPackageInstallCommand(selections: InstallPackageSelections): string {
  const argv = packageInstallArgv(selections);
  return [argv.command, ...argv.args].join(" ");
}
