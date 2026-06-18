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
const jsTestConfigNames = new Set([
  "jest.config.cjs",
  "jest.config.js",
  "jest.config.mjs",
  "jest.config.ts",
  "vitest.config.cjs",
  "vitest.config.cts",
  "vitest.config.js",
  "vitest.config.mjs",
  "vitest.config.mts",
  "vitest.config.ts",
]);
const playwrightConfigNames = new Set([
  "playwright.config.cjs",
  "playwright.config.cts",
  "playwright.config.js",
  "playwright.config.mjs",
  "playwright.config.mts",
  "playwright.config.ts",
]);
const pythonQualityConfigNames = new Set([
  ".ruff.toml",
  "pyproject.toml",
  "radon.cfg",
  "ruff.toml",
  "setup.cfg",
  "tox.ini",
]);
const nativeConfigSetters: ReadonlyMap<string, (configs: NativeConfigDetection) => void> = new Map([
  [
    "biome.json",
    (configs) => {
      configs.biome = true;
    },
  ],
  [
    "biome.jsonc",
    (configs) => {
      configs.biome = true;
    },
  ],
  [
    ".lizard",
    (configs) => {
      configs.lizard = true;
    },
  ],
  [
    ".lizardrc",
    (configs) => {
      configs.lizard = true;
    },
  ],
  [
    "lizard.conf",
    (configs) => {
      configs.lizard = true;
    },
  ],
  [
    "tsconfig.json",
    (configs) => {
      configs.tsconfig = true;
    },
  ],
]);

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
  return nativeConfigCheckRules
    .filter((rule) => rule.applies(languages, selected))
    .map((rule) => rule.create(configs));
}

const nativeConfigCheckRules: Array<{
  applies: (languages: ReadonlySet<LanguageId>, selected: ReadonlySet<StageId>) => boolean;
  create: (configs: NativeConfigDetection) => DoctorCheckOutput;
}> = [
  {
    applies: (languages, selected) =>
      hasJavaScriptOrTypeScript(languages) && usesAnyStage(selected, ["lint", "format"]),
    create: (configs) => ({
      detail: configs.biome
        ? "detected; Biome will use repository config"
        : "not detected; Biome will use built-in defaults unless repository config is added",
      name: "Biome native config",
      ok: true,
      required: false,
      source: "project",
    }),
  },
  {
    applies: (languages, selected) => languages.has("typescript") && selected.has("typecheck"),
    create: (configs) => ({
      detail: configs.tsconfig
        ? "detected; TypeScript typecheck uses tsconfig.json"
        : "not detected; add tsconfig.json before running TypeScript typecheck",
      name: "TypeScript project config",
      ok: configs.tsconfig,
      required: true,
      source: "project",
    }),
  },
  {
    applies: (languages, selected) =>
      hasJavaScriptOrTypeScript(languages) && usesAnyStage(selected, ["unit", "coverage"]),
    create: (configs) => ({
      detail: configs.jsTest
        ? "detected; JS/TS tests use the repository test runner config or package script"
        : "not detected; add Vitest/Jest config or a package test script before running unit or coverage",
      name: "JS/TS test config",
      ok: configs.jsTest,
      required: true,
      source: "project",
    }),
  },
  {
    applies: (languages, selected) => hasJavaScriptOrTypeScript(languages) && selected.has("e2e"),
    create: (configs) => ({
      detail: configs.playwright
        ? "detected; e2e uses Playwright config or a project e2e/audit script"
        : "not detected; add Playwright config/tests or a project e2e/audit script before running e2e",
      name: "JS/TS e2e config",
      ok: configs.playwright,
      required: true,
      source: "project",
    }),
  },
  {
    applies: (languages, selected) =>
      languages.has("python") &&
      usesAnyStage(selected, ["lint", "format", "complexity", "maintainability"]),
    create: (configs) => ({
      detail: configs.pythonQuality
        ? "detected; Python tools use repository quality config"
        : "not detected; Ruff and Radon-compatible tools will use their defaults unless repository config is added",
      name: "Python quality config",
      ok: true,
      required: false,
      source: "project",
    }),
  },
  {
    applies: (languages, selected) =>
      hasJavaScriptOrTypeScript(languages) &&
      usesAnyStage(selected, ["sloc", "complexity", "maintainability"]),
    create: (configs) => ({
      detail: configs.lizard
        ? "detected; metrics cache tracks lizard config changes"
        : "not detected; lizard metrics use AIQ defaults unless repository config is added",
      name: "Lizard metrics config",
      ok: true,
      required: false,
      source: "project",
    }),
  },
];

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
  const baseName = path.basename(filePath);
  nativeConfigSetters.get(baseName)?.(configs);
  if (jsTestConfigNames.has(baseName)) {
    configs.jsTest = true;
  }
  if (playwrightConfigNames.has(baseName)) {
    configs.playwright = true;
  }
  if (pythonQualityConfigNames.has(baseName)) {
    configs.pythonQuality = true;
  }
  if (baseName === "package.json") {
    await addPackageNativeConfig(filePath, configs);
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

  if (hasPackageJsTestConfig(packageJson, testScript)) {
    configs.jsTest = true;
  }

  if (hasPackagePlaywrightConfig(packageJson, e2eScripts)) {
    configs.playwright = true;
  }
}

function hasPackageJsTestConfig(packageJson: Record<string, unknown>, testScript: string): boolean {
  return (
    testScript.includes("vitest") ||
    testScript.includes("jest") ||
    hasPackageDependency(packageJson, "vitest") ||
    hasPackageDependency(packageJson, "jest")
  );
}

function hasPackagePlaywrightConfig(
  packageJson: Record<string, unknown>,
  e2eScripts: readonly string[],
): boolean {
  return (
    e2eScripts.length > 0 ||
    hasPackageDependency(packageJson, "@playwright/test") ||
    hasPackageDependency(packageJson, "playwright") ||
    e2eScripts.some(isPlaywrightLikeScript)
  );
}

function isPlaywrightLikeScript(script: string): boolean {
  return (
    script.includes("playwright") ||
    script.includes("agent-browser") ||
    script.includes("manual-audit")
  );
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

function hasJavaScriptOrTypeScript(languages: ReadonlySet<LanguageId>): boolean {
  return languages.has("javascript") || languages.has("typescript");
}
