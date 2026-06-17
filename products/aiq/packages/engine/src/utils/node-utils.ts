import path from "node:path";

import { findNearestConfig, hasAnyConfig } from "./path-utils.js";

export type JavaScriptTestRunner = "jest" | "vitest";
export type JavaScriptTestExecutionMode = "direct" | "npm";

export const nodeProjectConfigNames = [
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
];

export const javaScriptSourceExtensions = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);

export const javaScriptMetricsSourceExtensions = new Set(javaScriptSourceExtensions);
export const typeScriptTypecheckExtensions = new Set([".cts", ".mts", ".ts", ".tsx"]);
export const vitestConfigNames = [
  "vitest.config.cjs",
  "vitest.config.cts",
  "vitest.config.ts",
  "vitest.config.js",
  "vitest.config.mts",
  "vitest.config.mjs",
];
export const jestConfigNames = [
  "jest.config.ts",
  "jest.config.js",
  "jest.config.cjs",
  "jest.config.mjs",
];

export async function readPackageJson(filePath: string): Promise<Record<string, unknown>> {
  try {
    const module = await import("node:fs/promises");
    const content = await module.readFile(filePath, "utf8");
    const parsed = JSON.parse(content) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read package metadata at "${filePath}": ${message}`);
  }
}

export async function findNearestPackageJson(filePath: string): Promise<string | undefined> {
  return path.basename(filePath).toLowerCase() === "package.json"
    ? path.resolve(filePath)
    : findNearestConfig(filePath, "package.json");
}

export async function detectJavaScriptTestRunner(
  projectRoot: string,
): Promise<JavaScriptTestRunner | undefined> {
  if (await hasAnyConfig(projectRoot, vitestConfigNames)) {
    return "vitest";
  }

  if (await hasAnyConfig(projectRoot, jestConfigNames)) {
    return "jest";
  }

  const packageJson = await readPackageJson(path.join(projectRoot, "package.json"));
  const testScript = readNestedString(packageJson, ["scripts", "test"])?.toLowerCase() ?? "";

  if (testScript.includes("vitest") || hasPackageDependency(packageJson, "vitest")) {
    return "vitest";
  }

  if (testScript.includes("jest") || hasPackageDependency(packageJson, "jest")) {
    return "jest";
  }

  return undefined;
}

export async function resolveJavaScriptTestExecutionMode(
  projectRoot: string,
  runner: JavaScriptTestRunner,
): Promise<JavaScriptTestExecutionMode> {
  const packageJson = await readPackageJson(path.join(projectRoot, "package.json"));
  const testScript = readNestedString(packageJson, ["scripts", "test"]);
  return testScript?.trim() === runner ? "direct" : "npm";
}

export function hasPackageDependency(
  packageJson: Record<string, unknown>,
  dependency: string,
): boolean {
  return (
    readNestedString(packageJson, ["dependencies", dependency]) !== undefined ||
    readNestedString(packageJson, ["devDependencies", dependency]) !== undefined
  );
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
