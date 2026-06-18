import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AiqEngineCancelledError,
  type RunResult,
  createRunPlan,
  normalizeFileManifest,
  resolveRunRequest,
  runEngine,
  writeReportArtifact,
} from "../src/index.js";
import { type ToolRunOutcome, ToolRunner } from "../src/tool-runner.js";
import { resolvePythonCommand } from "../src/tools/binary-resolver.js";
import { withExclusiveToolLock } from "./exclusive-tool-lock.js";
import {
  commandAvailable,
  hasDotNet10Toolchain,
  hasGoToolchain,
  hasGradleToolchain,
  hasMavenToolchain,
  hasPowerShellPesterToolchain,
  hasPythonPytestToolchain,
  hasPythonQualityToolchain,
  hasRustCoverageToolchain,
} from "./toolchain-capabilities.js";

export const fixtureFile = path.resolve("test-projects/typescript/src/index.ts");
export const lintFailureFixtureFile = path.resolve("test-projects/typescript/src/lint-failure.ts");
export const fixtureJavaScriptFile = path.resolve("test-projects/javascript/index.js");
export const fixtureJavaScriptRoot = path.resolve("test-projects/javascript");
export const fixtureBashRoot = path.resolve("test-projects/bash");
export const fixtureDotNetRoot = path.resolve("test-projects/dotnet");
export const fixtureGoRoot = path.resolve("test-projects/go");
export const fixtureHclRoot = path.resolve("test-projects/hcl");
export const fixtureHtmlFile = path.resolve("test-projects/html-css/index.html");
export const fixtureCssFile = path.resolve("test-projects/html-css/styles.css");
export const fixtureJavaMavenRoot = path.resolve("test-projects/java-maven");
export const fixtureKotlinGradleRoot = path.resolve("test-projects/kotlin-gradle");
export const fixturePowerShellRoot = path.resolve("test-projects/powershell");
export const fixturePythonFile = path.resolve("test-projects/python/main.py");
export const fixtureRustRoot = path.resolve("test-projects/rust");
export const fixtureSqlFile = path.resolve("test-projects/sql/query.sql");
export const fixtureTerraformRoot = path.resolve("test-projects/terraform");
export const fixtureTypeScriptRoot = path.resolve("test-projects/typescript");
export const fixtureYamlFile = path.resolve("test-projects/yaml/config.yaml");

export async function withExclusiveRust<T>(run: () => Promise<T>): Promise<T> {
  return withExclusiveToolLock("rust", run);
}

export async function createDotNetFixtureProject(
  prefix: string,
): Promise<{ root: string; sourceFile: string }> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(workspaceRoot);

  const root = path.join(workspaceRoot, "project");
  await cp(fixtureDotNetRoot, root, { recursive: true });
  await Promise.all([
    rm(path.join(root, "src", "DotNetFixture", "bin"), { force: true, recursive: true }),
    rm(path.join(root, "src", "DotNetFixture", "obj"), { force: true, recursive: true }),
    rm(path.join(root, "tests", "DotNetFixture.Tests", "bin"), {
      force: true,
      recursive: true,
    }),
    rm(path.join(root, "tests", "DotNetFixture.Tests", "obj"), {
      force: true,
      recursive: true,
    }),
  ]);

  return {
    root,
    sourceFile: path.join(root, "src", "DotNetFixture", "Greeter.cs"),
  };
}

export async function createGoFixtureProject(
  prefix: string,
): Promise<{ root: string; sourceFile: string }> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(workspaceRoot);

  const root = path.join(workspaceRoot, "project");
  await cp(fixtureGoRoot, root, { recursive: true });

  return {
    root,
    sourceFile: path.join(root, "greeter.go"),
  };
}

export async function createBashFixtureProject(
  prefix: string,
): Promise<{ root: string; sourceFile: string }> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(workspaceRoot);

  const root = path.join(workspaceRoot, "project");
  await cp(fixtureBashRoot, root, { recursive: true });

  return {
    root,
    sourceFile: path.join(root, "example.sh"),
  };
}

export async function createJavaScriptFixtureProject(
  prefix: string,
): Promise<{ root: string; sourceFile: string; testFile: string }> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(workspaceRoot);

  const root = path.join(workspaceRoot, "project");
  await cp(fixtureJavaScriptRoot, root, { recursive: true });

  return {
    root,
    sourceFile: path.join(root, "index.js"),
    testFile: path.join(root, "index.test.js"),
  };
}

export async function createRustFixtureProject(
  prefix: string,
): Promise<{ root: string; sourceFile: string }> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(workspaceRoot);

  const root = path.join(workspaceRoot, "project");
  await cp(fixtureRustRoot, root, { recursive: true });

  return {
    root,
    sourceFile: path.join(root, "src", "lib.rs"),
  };
}

export async function createPowerShellFixtureProject(
  prefix: string,
): Promise<{ root: string; sourceFile: string }> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(workspaceRoot);

  const root = path.join(workspaceRoot, "project");
  await cp(fixturePowerShellRoot, root, { recursive: true });

  return {
    root,
    sourceFile: path.join(root, "utils.ps1"),
  };
}

export async function resolvePowerShellModuleAvailable(moduleName: string): Promise<boolean> {
  const toolRunner = new ToolRunner();
  return (await toolRunner.resolvePowerShellModuleManifest(moduleName)) !== undefined;
}

export async function createJavaMavenFixtureProject(
  prefix: string,
): Promise<{ root: string; sourceFile: string }> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(workspaceRoot);

  const root = path.join(workspaceRoot, "project");
  await cp(fixtureJavaMavenRoot, root, { recursive: true });

  return {
    root,
    sourceFile: path.join(root, "src", "main", "java", "dev", "aiq", "fixture", "Greeting.java"),
  };
}

export async function createKotlinGradleFixtureProject(
  prefix: string,
): Promise<{ root: string; sourceFile: string }> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(workspaceRoot);

  const root = path.join(workspaceRoot, "project");
  await cp(fixtureKotlinGradleRoot, root, { recursive: true });

  return {
    root,
    sourceFile: path.join(root, "src", "main", "kotlin", "dev", "aiq", "fixture", "Greeting.kt"),
  };
}

export async function createTypeScriptFixtureProject(
  prefix: string,
): Promise<{ root: string; sourceFile: string }> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(workspaceRoot);

  const root = path.join(workspaceRoot, "project");
  await cp(fixtureTypeScriptRoot, root, { recursive: true });

  return {
    root,
    sourceFile: path.join(root, "src", "index.ts"),
  };
}

export function createToolRunOutcome(overrides: Partial<ToolRunOutcome> = {}): ToolRunOutcome {
  return {
    durationMs: 1,
    exitCode: 0,
    finishedAt: "2026-03-25T00:00:01.000Z",
    startedAt: "2026-03-25T00:00:00.000Z",
    stderr: "",
    stdout: "",
    ...overrides,
  };
}

export function createLargeJavaScriptModule(index: number): string {
  return Array.from(
    { length: 2_000 },
    (_, offset) =>
      `export function generated${index}_${offset}(value) { return value + ${offset}; }`,
  ).join("\n");
}

export function createTypeScriptWorkloadModule(index: number): string {
  return [
    `export type GeneratedTuple${index} = [`,
    ...Array.from({ length: 150 }, (_, offset) => `  ${index + offset},`),
    "];",
    `export type GeneratedRecord${index} = {`,
    ...Array.from(
      { length: 150 },
      (_, offset) => `  value${offset}: GeneratedTuple${index}[${offset}];`,
    ),
    "};",
    `export const generatedValue${index}: GeneratedRecord${index} = {`,
    ...Array.from({ length: 150 }, (_, offset) => `  value${offset}: ${index + offset},`),
    "};",
  ].join("\n");
}

export function createAbortError(): Error {
  const error = new Error("simulated abort");
  error.name = "AbortError";
  return error;
}

export async function createTerraformHclFixtureProject(
  prefix: string,
): Promise<{ hclFile: string; root: string; terraformFile: string }> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(workspaceRoot);

  const root = path.join(workspaceRoot, "project");
  const terraformRoot = path.join(root, "terraform");
  const hclRoot = path.join(root, "hcl");
  await mkdir(root, { recursive: true });
  await cp(fixtureTerraformRoot, terraformRoot, { recursive: true });
  await cp(fixtureHclRoot, hclRoot, { recursive: true });

  return {
    hclFile: path.join(hclRoot, "config.hcl"),
    root,
    terraformFile: path.join(terraformRoot, "main.tf"),
  };
}

export const tempDirs: string[] = [];

export interface CanonicalArtifactPaths {
  metricsPath: string;
  planPath: string;
  reportPath: string;
}

export interface MetricsEvent {
  cacheHit?: boolean;
  event: string;
  stageId?: string;
  tool?: string;
}

export function expectSuccessfulCanonicalRun(result: RunResult, stageCount: number): void {
  expect(result.ok).toBe(true);
  expect(result.artifacts.metricsPath).toBeDefined();
  expect(result.artifacts.planPath).toBeDefined();
  expect(result.artifacts.reportPath).toBeDefined();
  expect(result.summary.diagnosticCount).toBe(0);
  expect(result.summary.notImplementedStageCount).toBe(0);
  expect(result.summary.status).toBe("passed");
  expect(result.stages).toHaveLength(stageCount);
}

export function requireCanonicalArtifactPaths(result: RunResult): CanonicalArtifactPaths {
  const { metricsPath, planPath, reportPath } = result.artifacts;
  if (planPath === undefined || reportPath === undefined || metricsPath === undefined) {
    throw new Error("Expected plan, report, and metrics artifacts to be written.");
  }

  return { metricsPath, planPath, reportPath };
}

export async function readJsonArtifact<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

export async function readMetricsEvents(metricsPath: string): Promise<MetricsEvent[]> {
  return (await readFile(metricsPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as MetricsEvent);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

export type { ToolRunOutcome };
export {
  AiqEngineCancelledError,
  ToolRunner,
  afterEach,
  commandAvailable,
  cp,
  createRunPlan,
  describe,
  execFileSync,
  expect,
  hasDotNet10Toolchain,
  hasGoToolchain,
  hasGradleToolchain,
  hasMavenToolchain,
  hasPowerShellPesterToolchain,
  hasPythonPytestToolchain,
  hasPythonQualityToolchain,
  hasRustCoverageToolchain,
  it,
  mkdir,
  mkdtemp,
  normalizeFileManifest,
  os,
  path,
  readFile,
  resolvePythonCommand,
  resolveRunRequest,
  rm,
  runEngine,
  vi,
  withExclusiveToolLock,
  writeFile,
  writeReportArtifact,
};
