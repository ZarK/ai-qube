import type { Dirent } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import type { LanguageId, StageId } from "@tjalve/aiq/model";

import type { DoctorCheckOutput } from "./output.js";
import { defaultProjectScopeIgnoredDirectoryNames } from "./project-scope.js";

interface NativeConfigDetection {
  biome: boolean;
  jsTest: boolean;
  lizard: boolean;
  playwright: boolean;
  pythonQuality: boolean;
  tsconfig: boolean;
}

const maxScannedFiles = 2_000;

export async function detectNativeConfigs(cwd: string): Promise<NativeConfigDetection> {
  const configs: NativeConfigDetection = {
    biome: false,
    jsTest: false,
    lizard: false,
    playwright: false,
    pythonQuality: false,
    tsconfig: false,
  };
  await collectNativeConfigs(cwd, configs, { scannedFiles: 0 });
  return configs;
}

export function resolveDoctorNativeConfigChecks(
  languages: ReadonlySet<LanguageId>,
  stages: readonly StageId[],
  configs: NativeConfigDetection,
): DoctorCheckOutput[] {
  const selected = new Set(stages);
  const checks: DoctorCheckOutput[] = [];
  const hasJavaScriptOrTypeScript = languages.has("javascript") || languages.has("typescript");

  if (hasJavaScriptOrTypeScript && usesAnyStage(selected, ["lint", "format"])) {
    checks.push({
      detail: configs.biome
        ? "detected; Biome will use repository config"
        : "not detected; Biome will use built-in defaults unless repository config is added",
      name: "Biome native config",
      ok: true,
      required: false,
      source: "project",
    });
  }

  if (languages.has("typescript") && selected.has("typecheck")) {
    checks.push({
      detail: configs.tsconfig
        ? "detected; TypeScript typecheck uses tsconfig.json"
        : "not detected; add tsconfig.json before running TypeScript typecheck",
      name: "TypeScript project config",
      ok: configs.tsconfig,
      required: true,
      source: "project",
    });
  }

  if (hasJavaScriptOrTypeScript && usesAnyStage(selected, ["unit", "coverage"])) {
    checks.push({
      detail: configs.jsTest
        ? "detected; JS/TS tests use the repository test runner config or package script"
        : "not detected; add Vitest/Jest config or a package test script before running unit or coverage",
      name: "JS/TS test config",
      ok: configs.jsTest,
      required: true,
      source: "project",
    });
  }

  if (hasJavaScriptOrTypeScript && selected.has("e2e")) {
    checks.push({
      detail: configs.playwright
        ? "detected; e2e uses Playwright config or a project e2e/audit script"
        : "not detected; add Playwright config/tests or a project e2e/audit script before running e2e",
      name: "JS/TS e2e config",
      ok: configs.playwright,
      required: true,
      source: "project",
    });
  }

  if (
    languages.has("python") &&
    usesAnyStage(selected, ["lint", "format", "complexity", "maintainability"])
  ) {
    checks.push({
      detail: configs.pythonQuality
        ? "detected; Python tools use repository quality config"
        : "not detected; Ruff and Radon-compatible tools will use their defaults unless repository config is added",
      name: "Python quality config",
      ok: true,
      required: false,
      source: "project",
    });
  }

  if (
    hasJavaScriptOrTypeScript &&
    usesAnyStage(selected, ["sloc", "complexity", "maintainability"])
  ) {
    checks.push({
      detail: configs.lizard
        ? "detected; metrics cache tracks lizard config changes"
        : "not detected; lizard metrics use AIQ defaults unless repository config is added",
      name: "Lizard metrics config",
      ok: true,
      required: false,
      source: "project",
    });
  }

  return checks;
}

async function collectNativeConfigs(
  directory: string,
  configs: NativeConfigDetection,
  state: { scannedFiles: number },
): Promise<void> {
  if (state.scannedFiles >= maxScannedFiles) {
    return;
  }

  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (state.scannedFiles >= maxScannedFiles) {
      return;
    }

    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!defaultProjectScopeIgnoredDirectoryNames.has(entry.name)) {
        await collectNativeConfigs(entryPath, configs, state);
      }
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    state.scannedFiles += 1;
    await addNativeConfig(entryPath, configs);
  }
}

async function addNativeConfig(filePath: string, configs: NativeConfigDetection): Promise<void> {
  switch (path.basename(filePath)) {
    case "biome.json":
    case "biome.jsonc":
      configs.biome = true;
      return;
    case "jest.config.cjs":
    case "jest.config.js":
    case "jest.config.mjs":
    case "jest.config.ts":
    case "vitest.config.cjs":
    case "vitest.config.cts":
    case "vitest.config.js":
    case "vitest.config.mjs":
    case "vitest.config.mts":
    case "vitest.config.ts":
      configs.jsTest = true;
      return;
    case ".lizard":
    case ".lizardrc":
    case "lizard.conf":
      configs.lizard = true;
      return;
    case "playwright.config.cjs":
    case "playwright.config.cts":
    case "playwright.config.js":
    case "playwright.config.mjs":
    case "playwright.config.mts":
    case "playwright.config.ts":
      configs.playwright = true;
      return;
    case ".ruff.toml":
    case "pyproject.toml":
    case "radon.cfg":
    case "ruff.toml":
    case "setup.cfg":
    case "tox.ini":
      configs.pythonQuality = true;
      return;
    case "tsconfig.json":
      configs.tsconfig = true;
      return;
    case "package.json":
      await addPackageNativeConfig(filePath, configs);
      return;
  }
}

async function addPackageNativeConfig(
  packageJsonPath: string,
  configs: NativeConfigDetection,
): Promise<void> {
  let packageJson: unknown;
  try {
    packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as unknown;
  } catch {
    return;
  }

  if (!isRecord(packageJson)) {
    return;
  }

  const testScript = readNestedString(packageJson, ["scripts", "test"])?.toLowerCase() ?? "";
  const e2eScripts = ["aiq:e2e", "test:e2e", "e2e", "audit:ui", "aiq:audit-ui"]
    .map((scriptName) => readNestedString(packageJson, ["scripts", scriptName])?.toLowerCase())
    .filter((script): script is string => script !== undefined);

  if (
    testScript.includes("vitest") ||
    testScript.includes("jest") ||
    hasPackageDependency(packageJson, "vitest") ||
    hasPackageDependency(packageJson, "jest")
  ) {
    configs.jsTest = true;
  }

  if (
    e2eScripts.length > 0 ||
    hasPackageDependency(packageJson, "@playwright/test") ||
    hasPackageDependency(packageJson, "playwright") ||
    e2eScripts.some(
      (script) =>
        script.includes("playwright") ||
        script.includes("agent-browser") ||
        script.includes("manual-audit"),
    )
  ) {
    configs.playwright = true;
  }
}

function hasPackageDependency(packageJson: Record<string, unknown>, dependency: string): boolean {
  return (
    readNestedString(packageJson, ["dependencies", dependency]) !== undefined ||
    readNestedString(packageJson, ["devDependencies", dependency]) !== undefined
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNestedString(record: Record<string, unknown>, keys: string[]): string | undefined {
  let current: unknown = record;

  for (const key of keys) {
    if (typeof current !== "object" || current === null || !(key in current)) {
      return undefined;
    }

    current = (current as Record<string, unknown>)[key];
  }

  return typeof current === "string" ? current : undefined;
}

function usesAnyStage(selected: ReadonlySet<StageId>, stages: readonly StageId[]): boolean {
  return stages.some((stage) => selected.has(stage));
}
