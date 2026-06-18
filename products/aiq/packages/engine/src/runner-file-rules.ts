import path from "node:path";

import type { LanguageId, RunStageConfiguration } from "./contracts.js";
import { isJvmTaskFile as isJvmLanguageTaskFile } from "./languages/jvm.js";
import {
  pythonTaskConfigNames,
  pythonTaskExtensions as pythonExtensions,
} from "./languages/python.js";
import { isHclFile, isTerraformFile } from "./languages/terraform.js";

export const biomeExtensions = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".json",
  ".jsonc",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);
export const sharedBiomeExtensions = new Set([".json", ".jsonc"]);
const javaScriptExtensions = new Set([".cjs", ".js", ".jsx", ".mjs"]);
const typeScriptExtensions = new Set([".cts", ".mts", ".ts", ".tsx"]);
const javaScriptMetricsSourceExtensions = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);
const bashExtensions = new Set([".bash", ".sh"]);
const bashTestExtensions = new Set([".bats"]);
const powerShellExtensions = new Set([".ps1", ".psd1", ".psm1"]);
const dotNetSourceExtensions = new Set([".cs"]);
const dotNetProjectExtensions = new Set([".csproj", ".sln", ".slnx"]);
export const htmlExtensions = new Set([".htm", ".html"]);
export const cssExtensions = new Set([".css"]);
export const yamlExtensions = new Set([".yaml", ".yml"]);
export const sqlExtensions = new Set([".sql"]);
export const prettierDocumentExtensions = new Set([
  ...htmlExtensions,
  ...cssExtensions,
  ...yamlExtensions,
]);

const dotNetExtensions = new Set([...dotNetSourceExtensions, ...dotNetProjectExtensions]);
const goSourceExtensions = new Set([".go"]);
const rustSourceExtensions = new Set([".rs"]);
const javaSourceExtensions = new Set([".java"]);
const kotlinSourceExtensions = new Set([".kt"]);
const javaScriptProjectConfigNames = ["package.json"];
const goProjectConfigNames = ["go.mod", "go.sum"];
const rustProjectConfigNames = ["Cargo.toml", "Cargo.lock"];
const jvmBuildConfigNames = ["build.gradle.kts", "build.gradle", "pom.xml"];
const jvmSettingsConfigNames = ["settings.gradle.kts", "settings.gradle"];
const jvmTaskConfigNames = [...jvmBuildConfigNames, ...jvmSettingsConfigNames];
type FileMatchContext = {
  baseName: string;
  extension: string;
  file: string;
  lowerBaseName: string;
};

const languageMatchers: Partial<Record<LanguageId, (context: FileMatchContext) => boolean>> = {
  bash: ({ extension }) => bashExtensions.has(extension) || bashTestExtensions.has(extension),
  css: ({ extension }) => cssExtensions.has(extension),
  dotnet: ({ extension }) => dotNetExtensions.has(extension),
  go: ({ file }) => isGoTaskFile(file),
  html: ({ extension }) => htmlExtensions.has(extension),
  java: ({ file }) => isJvmLanguageTaskFile(file),
  javascript: ({ extension, lowerBaseName }) =>
    javaScriptExtensions.has(extension) || javaScriptProjectConfigNames.includes(lowerBaseName),
  kotlin: ({ file }) => isJvmLanguageTaskFile(file),
  powershell: ({ extension }) => powerShellExtensions.has(extension),
  python: ({ file }) => isPythonTaskFile(file),
  rust: ({ file }) => isRustTaskFile(file),
  sql: ({ extension }) => sqlExtensions.has(extension),
  terraform: ({ file }) => isTerraformFile(file),
  typescript: ({ extension, lowerBaseName }) =>
    typeScriptExtensions.has(extension) || lowerBaseName === "tsconfig.json",
  yaml: ({ extension }) => yamlExtensions.has(extension),
};

export const securityExtensions = new Set([
  ".bats",
  ".bash",
  ".cjs",
  ".css",
  ".cs",
  ".csproj",
  ".cts",
  ".go",
  ".hcl",
  ".html",
  ".mod",
  ".js",
  ".json",
  ".jsonc",
  ".java",
  ".jsx",
  ".kt",
  ".kts",
  ".mjs",
  ".mts",
  ".ps1",
  ".psd1",
  ".psm1",
  ".py",
  ".pyi",
  ".rs",
  ".sh",
  ".sql",
  ".sum",
  ".tf",
  ".tfvars",
  ".toml",
  ".gradle",
  ".lock",
  ".sln",
  ".slnx",
  ".ts",
  ".tsx",
  ".xml",
  ".yaml",
  ".yml",
]);

export function shouldSkipScriptProjectDirectory(directoryPath: string): boolean {
  const name = path.basename(directoryPath).toLowerCase();
  return [
    ".git",
    ".hg",
    ".svn",
    ".venv",
    "__pycache__",
    "bin",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "obj",
    "target",
    "vendor",
  ].includes(name);
}

function isPythonTaskFile(file: string): boolean {
  const extension = path.extname(file).toLowerCase();
  return (
    pythonExtensions.has(extension) ||
    pythonTaskConfigNames.includes(path.basename(file).toLowerCase())
  );
}

function isJavaScriptMetricsTaskFile(file: string): boolean {
  const extension = path.extname(file).toLowerCase();
  return (
    javaScriptMetricsSourceExtensions.has(extension) ||
    path.basename(file).toLowerCase() === "package.json"
  );
}

function isGoTaskFile(file: string): boolean {
  const extension = path.extname(file).toLowerCase();
  return (
    goSourceExtensions.has(extension) ||
    goProjectConfigNames.includes(path.basename(file).toLowerCase())
  );
}

function isRustTaskFile(file: string): boolean {
  const extension = path.extname(file).toLowerCase();
  return (
    rustSourceExtensions.has(extension) ||
    rustProjectConfigNames.includes(path.basename(file).toLowerCase())
  );
}

export function isSharedMetricsSupportedFile(filePath: string): boolean {
  const extension = path.extname(filePath).toLowerCase();
  const basename = path.basename(filePath).toLowerCase();
  return (
    javaScriptMetricsSourceExtensions.has(extension) ||
    basename === "package.json" ||
    pythonExtensions.has(extension) ||
    goSourceExtensions.has(extension) ||
    rustSourceExtensions.has(extension) ||
    dotNetSourceExtensions.has(extension) ||
    javaSourceExtensions.has(extension) ||
    kotlinSourceExtensions.has(extension) ||
    jvmTaskConfigNames.includes(basename)
  );
}

export function isSharedMetricsCompanionFile(filePath: string): boolean {
  return path.basename(filePath).toLowerCase() === "tsconfig.json";
}

export function isSharedMetricsSelectionFile(filePath: string): boolean {
  return isSharedMetricsSupportedFile(filePath) || isSharedMetricsCompanionFile(filePath);
}

export function groupConfiguredStageLanguages(
  stageConfiguration: RunStageConfiguration,
): Array<{ languageIds: LanguageId[]; toolId: string }> {
  const grouped = new Map<string, LanguageId[]>();
  for (const [languageId, value] of Object.entries(stageConfiguration.languages)) {
    const languageIds = grouped.get(value.toolId) ?? [];
    languageIds.push(languageId as LanguageId);
    grouped.set(value.toolId, languageIds);
  }
  return [...grouped].map(([toolId, languageIds]) => ({ languageIds, toolId }));
}

export function filterFilesForConfiguredLanguages(
  files: readonly string[],
  languageId: LanguageId,
  toolId: string,
): string[] {
  if (toolId === "biome") {
    return files.filter((file) => fileMatchesConfiguredBiomeLanguage(file, languageId));
  }

  if (toolId === "javascript") {
    return files.filter((file) => fileMatchesConfiguredJavaScriptRunnerLanguage(file, languageId));
  }

  return files.filter((file) => fileMatchesLanguage(file, languageId));
}

export function filterFilesForConfiguredToolLanguages(
  files: readonly string[],
  languageIds: readonly LanguageId[],
  toolId: string,
): string[] {
  const filtered = new Set<string>();
  for (const languageId of languageIds) {
    for (const file of filterFilesForConfiguredLanguages(files, languageId, toolId)) {
      filtered.add(file);
    }
  }
  return [...filtered];
}

function fileMatchesConfiguredBiomeLanguage(file: string, languageId: LanguageId): boolean {
  const normalizedPath = path.resolve(file);
  const extension = path.extname(normalizedPath).toLowerCase();
  const lowerBaseName = path.basename(normalizedPath).toLowerCase();
  if (sharedBiomeExtensions.has(extension)) {
    return languageId === "javascript" || languageId === "typescript";
  }
  if (lowerBaseName === "tsconfig.json") {
    return languageId === "typescript";
  }
  return fileMatchesLanguage(file, languageId);
}

function fileMatchesConfiguredJavaScriptRunnerLanguage(
  file: string,
  languageId: LanguageId,
): boolean {
  const lowerBaseName = path.basename(path.resolve(file)).toLowerCase();
  if (lowerBaseName === "package.json") {
    return languageId === "javascript" || languageId === "typescript";
  }

  return fileMatchesLanguage(file, languageId);
}

function fileMatchesLanguage(file: string, languageId: LanguageId): boolean {
  const normalizedPath = path.resolve(file);
  const baseName = path.basename(normalizedPath);
  const context = {
    baseName,
    extension: path.extname(normalizedPath).toLowerCase(),
    file,
    lowerBaseName: baseName.toLowerCase(),
  };
  return (languageMatchers[languageId] ?? defaultLanguageMatcher)(context);
}

function defaultLanguageMatcher({ file }: FileMatchContext): boolean {
  return isHclFile(file) || isJavaScriptMetricsTaskFile(file);
}
