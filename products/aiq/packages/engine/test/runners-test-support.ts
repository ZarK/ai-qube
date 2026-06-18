import { execFileSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { type LanguageId, type RunStageConfigurations, languageIds } from "@tjalve/aiq/model";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runEngine } from "../src/index.js";
import { buildEngineContext } from "../src/request.js";
import { runPlannedTask } from "../src/runners.js";
import { ToolRunner } from "../src/tool-runner.js";
import * as binaries from "../src/tools/binary-resolver.js";
import { withExclusiveToolLock } from "./exclusive-tool-lock.js";
import {
  hasDotNet10Toolchain,
  hasGoToolchain,
  hasGradleToolchain,
  hasMavenToolchain,
  hasPowerShellPesterToolchain,
  hasPythonQualityToolchain,
  hasRustCoverageToolchain,
  hasRustToolchain,
} from "./toolchain-capabilities.js";

export const fixtureFile = path.resolve("test-projects/typescript/src/index.ts");
export const lintFailureFixtureFile = path.resolve("test-projects/typescript/src/lint-failure.ts");
export const fixtureJavaScriptFile = path.resolve("test-projects/javascript/index.js");
export const fixtureBashRoot = path.resolve("test-projects/bash");
export const fixtureDotNetRoot = path.resolve("test-projects/dotnet");
export const fixtureGoRoot = path.resolve("test-projects/go");
export const fixtureJavaMavenRoot = path.resolve("test-projects/java-maven");
export const fixtureKotlinGradleRoot = path.resolve("test-projects/kotlin-gradle");
export const fixturePowerShellRoot = path.resolve("test-projects/powershell");
export const fixturePythonConfigFile = path.resolve("test-projects/python/pyproject.toml");
export const fixturePythonFile = path.resolve("test-projects/python/main.py");
export const fixtureRustRoot = path.resolve("test-projects/rust");
export const fixtureTypeScriptPackageJson = path.resolve("test-projects/typescript/package.json");
export const fixtureTsconfig = path.resolve("test-projects/typescript/tsconfig.json");
export const vitestCliPath = path.resolve("node_modules/vitest/vitest.mjs");
export const sharedMetricsStages = ["sloc", "complexity", "maintainability"] as const;

export const metricsToolByLanguage = {
  bash: "bash",
  css: "css",
  documents: "documents",
  dotnet: "dotnet",
  go: "go",
  hcl: "terraform",
  html: "html",
  java: "jvm",
  javascript: "javascript",
  kotlin: "jvm",
  powershell: "powershell",
  python: "python",
  rust: "rust",
  sql: "sql",
  terraform: "terraform",
  typescript: "javascript",
  yaml: "yaml",
} as const satisfies Record<LanguageId, string>;

export function createSingleLanguageStageConfiguration(
  stageId: (typeof sharedMetricsStages)[number],
  languageId: LanguageId,
): RunStageConfigurations {
  return {
    [stageId]: {
      languages: {
        [languageId]: { toolId: metricsToolByLanguage[languageId] },
      },
    },
  } as RunStageConfigurations;
}

export function commandAvailable(command: string): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [command], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

export function expectBashSetupFailure(
  result: Awaited<ReturnType<typeof runPlannedTask>>,
  source: "bats" | "kcov",
  file: string,
): void {
  expect(JSON.stringify(result)).not.toContain("not_implemented");
  expect(result.status).toBe("failed");
  expect(result.diagnostics[0]).toMatchObject({
    file,
    severity: "error",
    source,
  });
  expect(result.toolRuns[0]).toMatchObject({ status: "failed", tool: source });
}

export function expectPowerShellSetupFailure(
  result: Awaited<ReturnType<typeof runPlannedTask>>,
  file: string,
): void {
  expect(JSON.stringify(result)).not.toContain("not_implemented");
  expect(result.status).toBe("failed");
  expect(result.diagnostics[0]).toMatchObject({
    file,
    severity: "error",
    source: "pester",
  });
  expect(result.toolRuns[0]).toMatchObject({ status: "failed", tool: "pester" });
}

export function expectJvmSetupFailure(
  result: Awaited<ReturnType<typeof runPlannedTask>>,
  file: string,
  tool = "jvm-unavailable",
): void {
  expect(JSON.stringify(result)).not.toContain("not_implemented");
  expect(result.status).toBe("failed");
  expect(result.diagnostics[0]).toMatchObject({
    file,
    severity: "error",
    source: tool,
  });
  expect(result.toolRuns[0]).toMatchObject({ status: "failed", tool });
}

export function expectProjectResolutionFailure(
  result: Awaited<ReturnType<typeof runPlannedTask>>,
  options: { artifact: string; file: string; source: string; tool?: string },
): void {
  expect(JSON.stringify(result)).not.toContain("not_implemented");
  expect(result.status).toBe("failed");
  expect(result.diagnostics).toEqual([
    expect.objectContaining({
      file: options.file,
      severity: "error",
      source: options.source,
    }),
  ]);
  expect(result.notes.join(" ")).toContain(options.artifact);
  if (options.tool !== undefined) {
    expect(result.toolRuns[0]).toMatchObject({ status: "failed", tool: options.tool });
  }
}

export async function createDotNetFixtureProject(
  prefix: string,
): Promise<{ root: string; solutionFile: string; sourceFile: string; testFile: string }> {
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
    solutionFile: path.join(root, "DotNetFixture.slnx"),
    sourceFile: path.join(root, "src", "DotNetFixture", "Greeter.cs"),
    testFile: path.join(root, "tests", "DotNetFixture.Tests", "GreeterTests.cs"),
  };
}

export async function createJavaMavenFixtureProject(
  prefix: string,
): Promise<{ buildFile: string; root: string; sourceFile: string; testFile: string }> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(workspaceRoot);

  const root = path.join(workspaceRoot, "project");
  await cp(fixtureJavaMavenRoot, root, { recursive: true });

  return {
    buildFile: path.join(root, "pom.xml"),
    root,
    sourceFile: path.join(root, "src", "main", "java", "dev", "aiq", "fixture", "Greeting.java"),
    testFile: path.join(root, "src", "test", "java", "dev", "aiq", "fixture", "GreetingTest.java"),
  };
}

export async function createKotlinGradleFixtureProject(
  prefix: string,
): Promise<{ buildFile: string; root: string; sourceFile: string; testFile: string }> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(workspaceRoot);

  const root = path.join(workspaceRoot, "project");
  await cp(fixtureKotlinGradleRoot, root, { recursive: true });

  return {
    buildFile: path.join(root, "build.gradle.kts"),
    root,
    sourceFile: path.join(root, "src", "main", "kotlin", "dev", "aiq", "fixture", "Greeting.kt"),
    testFile: path.join(root, "src", "test", "kotlin", "dev", "aiq", "fixture", "GreetingTest.kt"),
  };
}

export async function createGoFixtureProject(
  prefix: string,
): Promise<{ moduleFile: string; root: string; sourceFile: string; testFile: string }> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(workspaceRoot);

  const root = path.join(workspaceRoot, "project");
  await cp(fixtureGoRoot, root, { recursive: true });

  return {
    moduleFile: path.join(root, "go.mod"),
    root,
    sourceFile: path.join(root, "greeter.go"),
    testFile: path.join(root, "greeter_test.go"),
  };
}

export async function createRustFixtureProject(
  prefix: string,
): Promise<{ manifestFile: string; root: string; sourceFile: string; testFile: string }> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(workspaceRoot);

  const root = path.join(workspaceRoot, "project");
  await cp(fixtureRustRoot, root, { recursive: true });

  return {
    manifestFile: path.join(root, "Cargo.toml"),
    root,
    sourceFile: path.join(root, "src", "lib.rs"),
    testFile: path.join(root, "tests", "integration.rs"),
  };
}

export async function createBashFixtureProject(
  prefix: string,
): Promise<{ root: string; sourceFile: string; testFile: string }> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(workspaceRoot);

  const root = path.join(workspaceRoot, "project");
  await cp(fixtureBashRoot, root, { recursive: true });

  return {
    root,
    sourceFile: path.join(root, "example.sh"),
    testFile: path.join(root, "example_test.bats"),
  };
}

export async function createPowerShellFixtureProject(
  prefix: string,
): Promise<{ root: string; sourceFile: string; testFile: string }> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(workspaceRoot);

  const root = path.join(workspaceRoot, "project");
  await cp(fixturePowerShellRoot, root, { recursive: true });

  return {
    root,
    sourceFile: path.join(root, "utils.ps1"),
    testFile: path.join(root, "utils.tests.ps1"),
  };
}

export function resolveCommandPath(command: string): string {
  return execFileSync("sh", ["-lc", `command -v ${command}`], { encoding: "utf8" }).trim();
}

export async function withExclusiveDotNet<T>(run: () => Promise<T>): Promise<T> {
  return withExclusiveToolLock("dotnet", run);
}

export async function withExclusiveRust<T>(run: () => Promise<T>): Promise<T> {
  return withExclusiveToolLock("rust", run);
}

export async function resolvePowerShellModuleAvailable(moduleName: string): Promise<boolean> {
  const toolRunner = new ToolRunner();
  return (await toolRunner.resolvePowerShellModuleManifest(moduleName)) !== undefined;
}

export function withToolRunnerOverride<T extends Awaited<ReturnType<typeof buildEngineContext>>>(
  context: T,
  toolRunner: ToolRunner,
): T & { toolRunner: ToolRunner } {
  return {
    ...context,
    toolRunner,
  };
}

export { createDotNetCompetingSolutionProject } from "./runners-dotnet-fixtures.js";

export const tempDirs: string[] = [];

export async function collectJavaScriptAndTypeScriptFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        return collectJavaScriptAndTypeScriptFiles(entryPath);
      }

      if (!entry.isFile()) {
        return [];
      }

      return /\.(?:[cm]?js|[cm]?ts|jsx|tsx)$/u.test(entry.name) ? [entryPath] : [];
    }),
  );

  return files.flat();
}

export async function createCustomJavaScriptRunnerProject(options: {
  prefix: string;
  runner: "jest" | "vitest";
  runnerScript: string;
}): Promise<{
  packageJsonPath: string;
  root: string;
  sourceFile: string;
  tsconfigPath: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), options.prefix));
  tempDirs.push(root);

  const srcDir = path.join(root, "src");
  await mkdir(srcDir, { recursive: true });

  const packageJsonPath = path.join(root, "package.json");
  const tsconfigPath = path.join(root, "tsconfig.json");
  const sourceFile = path.join(srcDir, "index.ts");

  await writeFile(
    packageJsonPath,
    `${JSON.stringify({ name: options.prefix, private: true, scripts: { test: "node runner.cjs" } }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(root, options.runner === "vitest" ? "vitest.config.ts" : "jest.config.js"),
    options.runner === "vitest" ? "export default {};\n" : "module.exports = {};\n",
    "utf8",
  );
  await writeFile(path.join(root, "runner.cjs"), options.runnerScript, "utf8");
  await writeFile(
    tsconfigPath,
    JSON.stringify(
      {
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          target: "ES2022",
        },
        include: ["src/**/*.ts"],
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(sourceFile, "export const value = 1;\n", "utf8");

  return {
    packageJsonPath,
    root,
    sourceFile,
    tsconfigPath,
  };
}

export async function createCustomJavaScriptE2eProject(options: {
  e2eScript?: string;
  packageJson?: Record<string, unknown>;
  prefix: string;
}): Promise<{
  packageJsonPath: string;
  root: string;
  sourceFile: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), options.prefix));
  tempDirs.push(root);

  const srcDir = path.join(root, "src");
  await mkdir(srcDir, { recursive: true });

  const packageJsonPath = path.join(root, "package.json");
  const sourceFile = path.join(srcDir, "index.ts");
  const packageJson = options.packageJson ?? {
    name: options.prefix,
    private: true,
    scripts:
      options.e2eScript === undefined
        ? {}
        : {
            "aiq:e2e": options.e2eScript,
          },
  };

  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  await writeFile(sourceFile, "export const value = 1;\n", "utf8");

  return {
    packageJsonPath,
    root,
    sourceFile,
  };
}

export async function createCustomPythonRunnerProject(options: {
  prefix: string;
  runnerScript: string;
}): Promise<{
  root: string;
  shimDir: string;
  sourceFile: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), options.prefix));
  tempDirs.push(root);

  const sourceFile = path.join(root, "main.py");
  const shimDir = path.join(root, "bin");
  await mkdir(shimDir, { recursive: true });
  await writeFile(
    path.join(root, "pyproject.toml"),
    '[tool.pytest.ini_options]\npythonpath = ["."]\n',
    "utf8",
  );
  await writeFile(sourceFile, "def main() -> int:\n    return 1\n", "utf8");
  await writeFile(path.join(root, "python3.cjs"), options.runnerScript, "utf8");

  if (process.platform === "win32") {
    const shimPath = path.join(shimDir, "python.cmd");
    await writeFile(shimPath, '@echo off\r\n"%~dp0node.cmd" "%~dp0python.cjs" %*\r\n', "utf8");
    await writeFile(path.join(shimDir, "python.cjs"), options.runnerScript, "utf8");
    await writeFile(
      path.join(shimDir, "node.cmd"),
      `@echo off\r\n"${process.execPath}" %*\r\n`,
      "utf8",
    );
  } else {
    const shimPath = path.join(shimDir, "python3");
    await writeFile(shimPath, '#!/bin/sh\nexec node "$0.cjs" "$@"\n', "utf8");
    await chmod(shimPath, 0o755);
    await writeFile(`${shimPath}.cjs`, options.runnerScript, "utf8");
  }

  return {
    root,
    shimDir,
    sourceFile,
  };
}

export async function withPathedPythonShim<T>(shimDir: string, run: () => Promise<T>): Promise<T> {
  const previousPath = process.env.PATH ?? "";
  const pythonShimPath = path.join(
    shimDir,
    process.platform === "win32" ? "python.cmd" : "python3",
  );
  const resolverSpy = vi.spyOn(binaries, "resolvePythonCommand").mockReturnValue(pythonShimPath);
  process.env.PATH = `${shimDir}${path.delimiter}${previousPath}`;

  try {
    return await run();
  } finally {
    resolverSpy.mockRestore();
    process.env.PATH = previousPath;
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});
export type { LanguageId, RunStageConfigurations };
export {
  ToolRunner,
  afterEach,
  binaries,
  buildEngineContext,
  chmod,
  cp,
  describe,
  execFileSync,
  expect,
  hasDotNet10Toolchain,
  hasGoToolchain,
  hasGradleToolchain,
  hasMavenToolchain,
  hasPowerShellPesterToolchain,
  hasPythonQualityToolchain,
  hasRustCoverageToolchain,
  hasRustToolchain,
  it,
  languageIds,
  mkdir,
  mkdtemp,
  os,
  path,
  readFile,
  readdir,
  rm,
  runEngine,
  runPlannedTask,
  vi,
  withExclusiveToolLock,
  writeFile,
};
