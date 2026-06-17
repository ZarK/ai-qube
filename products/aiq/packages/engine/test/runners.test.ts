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

const fixtureFile = path.resolve("test-projects/typescript/src/index.ts");
const lintFailureFixtureFile = path.resolve("test-projects/typescript/src/lint-failure.ts");
const fixtureJavaScriptFile = path.resolve("test-projects/javascript/index.js");
const fixtureBashRoot = path.resolve("test-projects/bash");
const fixtureDotNetRoot = path.resolve("test-projects/dotnet");
const fixtureGoRoot = path.resolve("test-projects/go");
const fixtureJavaMavenRoot = path.resolve("test-projects/java-maven");
const fixtureKotlinGradleRoot = path.resolve("test-projects/kotlin-gradle");
const fixturePowerShellRoot = path.resolve("test-projects/powershell");
const fixturePythonConfigFile = path.resolve("test-projects/python/pyproject.toml");
const fixturePythonFile = path.resolve("test-projects/python/main.py");
const fixtureRustRoot = path.resolve("test-projects/rust");
const fixtureTypeScriptPackageJson = path.resolve("test-projects/typescript/package.json");
const fixtureTsconfig = path.resolve("test-projects/typescript/tsconfig.json");
const vitestCliPath = path.resolve("node_modules/vitest/vitest.mjs");
const sharedMetricsStages = ["sloc", "complexity", "maintainability"] as const;

const metricsToolByLanguage = {
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

function createSingleLanguageStageConfiguration(
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

function commandAvailable(command: string): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [command], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function expectBashSetupFailure(
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

function expectPowerShellSetupFailure(
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

function expectJvmSetupFailure(
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

async function createDotNetFixtureProject(
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

async function createJavaMavenFixtureProject(
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

async function createKotlinGradleFixtureProject(
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

async function createGoFixtureProject(
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

async function createRustFixtureProject(
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

async function createBashFixtureProject(
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

async function createPowerShellFixtureProject(
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

function resolveCommandPath(command: string): string {
  return execFileSync("sh", ["-lc", `command -v ${command}`], { encoding: "utf8" }).trim();
}

async function withExclusiveDotNet<T>(run: () => Promise<T>): Promise<T> {
  return withExclusiveToolLock("dotnet", run);
}

async function withExclusiveRust<T>(run: () => Promise<T>): Promise<T> {
  return withExclusiveToolLock("rust", run);
}

async function resolvePowerShellModuleAvailable(moduleName: string): Promise<boolean> {
  const toolRunner = new ToolRunner();
  return (await toolRunner.resolvePowerShellModuleManifest(moduleName)) !== undefined;
}

function withToolRunnerOverride<T extends Awaited<ReturnType<typeof buildEngineContext>>>(
  context: T,
  toolRunner: ToolRunner,
): T & { toolRunner: ToolRunner } {
  return {
    ...context,
    toolRunner,
  };
}

async function createDotNetCompetingSolutionProject(prefix: string): Promise<{
  noiseFile: string;
  root: string;
  solutionFile: string;
  sourceFile: string;
  testFile: string;
}> {
  const project = await createDotNetFixtureProject(prefix);
  const failingProjectDir = path.join(project.root, "other", "Failing.Tests");
  await mkdir(failingProjectDir, { recursive: true });

  await writeFile(
    path.join(failingProjectDir, "Failing.Tests.csproj"),
    [
      '<Project Sdk="Microsoft.NET.Sdk">',
      "  <PropertyGroup>",
      "    <TargetFramework>net10.0</TargetFramework>",
      "    <ImplicitUsings>enable</ImplicitUsings>",
      "    <Nullable>enable</Nullable>",
      "    <IsPackable>false</IsPackable>",
      "  </PropertyGroup>",
      "",
      "  <ItemGroup>",
      '    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.14.1" />',
      '    <PackageReference Include="xunit" Version="2.9.3" />',
      '    <PackageReference Include="xunit.runner.visualstudio" Version="3.1.4" />',
      "  </ItemGroup>",
      "",
      "  <ItemGroup>",
      '    <Using Include="Xunit" />',
      "  </ItemGroup>",
      "</Project>",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(failingProjectDir, "FailingTests.cs"),
    [
      "namespace Failing.Tests;",
      "",
      "public class FailingTests",
      "{",
      "    [Fact]",
      "    public void Always_fails()",
      "    {",
      "        Assert.True(false);",
      "    }",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(project.root, "AOther.slnx"),
    [
      "<Solution>",
      '  <Project Path="other/Failing.Tests/Failing.Tests.csproj" />',
      "</Solution>",
      "",
    ].join("\n"),
    "utf8",
  );

  const noiseDir = path.join(project.root, "unrelated");
  await mkdir(noiseDir, { recursive: true });
  const noiseFile = path.join(noiseDir, "Noise.cs");
  await writeFile(
    noiseFile,
    [
      "namespace Unrelated;",
      "",
      "public static class Noise",
      "{",
      "    public static string? Value => null;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );

  const nestedProjectDir = path.join(project.root, "src", "DotNetFixture", "Nested", "Shadow");
  await mkdir(nestedProjectDir, { recursive: true });
  await writeFile(
    path.join(nestedProjectDir, "Shadow.csproj"),
    [
      '<Project Sdk="Microsoft.NET.Sdk">',
      "  <PropertyGroup>",
      "    <TargetFramework>net10.0</TargetFramework>",
      "    <ImplicitUsings>enable</ImplicitUsings>",
      "    <Nullable>enable</Nullable>",
      "  </PropertyGroup>",
      "</Project>",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(nestedProjectDir, "Shadow.cs"),
    [
      "namespace DotNetFixture.Nested;",
      "",
      "public static class Shadow",
      "{",
      '    public static string Describe() => "shadow";',
      "}",
      "",
    ].join("\n"),
    "utf8",
  );

  return {
    ...project,
    noiseFile,
  };
}

const tempDirs: string[] = [];

async function collectJavaScriptAndTypeScriptFiles(root: string): Promise<string[]> {
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

async function createCustomJavaScriptRunnerProject(options: {
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

async function createCustomJavaScriptE2eProject(options: {
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

async function createCustomPythonRunnerProject(options: {
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

async function withPathedPythonShim<T>(shimDir: string, run: () => Promise<T>): Promise<T> {
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

describe("engine runners", () => {
  it("runs Biome lint and returns structured diagnostics", async () => {
    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [lintFailureFixtureFile],
        id: "test:1:lint",
        stageId: "lint",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.diagnostics[0]).toMatchObject({
      code: "lint/style/noVar",
      file: lintFailureFixtureFile,
      severity: "error",
      source: "biome",
    });
    expect(result.toolRuns[0]).toMatchObject({
      exitCode: 1,
      status: "failed",
      tool: "biome",
    });
  });

  it("respects repository Biome config before linting", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-biome-native-config-"));
    tempDirs.push(tempDir);

    const sourceFile = path.join(tempDir, "index.ts");
    await writeFile(
      path.join(tempDir, "biome.json"),
      `${JSON.stringify({ linter: { rules: { style: { noVar: "off" } } } }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(sourceFile, "var value = 1;\nexport { value };\n", "utf8");

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [sourceFile],
        id: "test:1:lint-biome-native-config",
        stageId: "lint",
      },
      process.cwd(),
    );

    expect(result.status).toBe("passed");
    expect(result.diagnostics).toEqual([]);
    expect(result.notes[0]).toContain(path.join(tempDir, "biome.json"));
    expect(result.toolRuns[0]?.args).toContain(`--config-path=${path.join(tempDir, "biome.json")}`);
  });

  it("does not pass a Biome config when selected files do not share one", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-biome-partial-native-config-"));
    tempDirs.push(tempDir);

    const configuredDir = path.join(tempDir, "configured");
    await mkdir(configuredDir, { recursive: true });
    const configuredFile = path.join(configuredDir, "index.ts");
    const defaultFile = path.join(tempDir, "index.ts");
    await writeFile(
      path.join(configuredDir, "biome.json"),
      `${JSON.stringify({ linter: { rules: { style: { noVar: "off" } } } }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(configuredFile, "export const configured = 1;\n", "utf8");
    await writeFile(defaultFile, "export const fallback = 1;\n", "utf8");

    const result = await runPlannedTask(
      {
        fileCount: 2,
        files: [configuredFile, defaultFile],
        id: "test:1:lint-biome-partial-native-config",
        stageId: "lint",
      },
      process.cwd(),
    );

    expect(result.status).toBe("passed");
    expect(result.diagnostics).toEqual([]);
    expect(result.toolRuns[0]?.args.some((arg) => arg.startsWith("--config-path="))).toBe(false);
  });

  it("runs TypeScript typecheck and parses real compiler diagnostics", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-tsc-runner-"));
    tempDirs.push(tempDir);

    await mkdir(path.join(tempDir, "src"), { recursive: true });
    await writeFile(
      path.join(tempDir, "tsconfig.json"),
      await readFile(fixtureTsconfig, "utf8"),
      "utf8",
    );

    const brokenFile = path.join(tempDir, "src", "index.ts");
    await writeFile(
      brokenFile,
      "const value: string = 42;\nexport const broken = value;\n",
      "utf8",
    );

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [brokenFile],
        id: "test:1:typecheck",
        stageId: "typecheck",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.diagnostics[0]).toMatchObject({
      code: "TS2322",
      file: brokenFile,
      severity: "error",
      source: "tsc",
    });
    expect(result.diagnostics[0]?.range).toMatchObject({
      startColumn: 7,
      startLine: 1,
    });
    expect(result.toolRuns[0]).toMatchObject({
      status: "failed",
      tool: "tsc",
    });
  });

  it("runs Biome format on JSONC files and reports formatting diagnostics", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-jsonc-runner-"));
    tempDirs.push(tempDir);

    const jsoncFile = path.join(tempDir, "config.jsonc");
    await writeFile(jsoncFile, '{"name" :"typescript-fixture" ,"enabled" :true}\n', "utf8");

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [jsoncFile],
        id: "test:1:format",
        stageId: "format",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.diagnostics[0]).toMatchObject({
      file: jsoncFile,
      severity: "error",
      source: "biome",
    });
    expect(result.toolRuns[0]).toMatchObject({
      exitCode: 1,
      status: "failed",
      tool: "biome",
    });
  });

  it("runs HTMLHint lint and returns structured diagnostics for HTML files", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-html-lint-runner-"));
    tempDirs.push(tempDir);

    const badHtmlFile = path.join(tempDir, "bad.html");
    await writeFile(
      badHtmlFile,
      [
        "<!doctype html>",
        '<html lang="en">',
        "  <body>",
        "    <div>",
        "  </body>",
        "</html>",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [badHtmlFile],
        id: "test:1:lint-html",
        stageId: "lint",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.diagnostics[0]).toMatchObject({
      code: "tag-pair",
      file: badHtmlFile,
      severity: "error",
      source: "htmlhint",
    });
    expect(result.toolRuns[0]).toMatchObject({
      exitCode: 1,
      status: "failed",
      tool: "htmlhint",
    });
  });

  it("runs Stylelint lint and returns structured diagnostics for CSS files", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-css-lint-runner-"));
    tempDirs.push(tempDir);

    await writeFile(
      path.join(tempDir, ".stylelintrc.json"),
      `${JSON.stringify({ rules: { "color-named": "never" } }, null, 2)}\n`,
      "utf8",
    );

    const badCssFile = path.join(tempDir, "bad.css");
    await writeFile(badCssFile, "a { color: red; }\n", "utf8");

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [badCssFile],
        id: "test:1:lint-css",
        stageId: "lint",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.diagnostics[0]).toMatchObject({
      code: "color-named",
      file: badCssFile,
      severity: "error",
      source: "stylelint",
    });
    expect(result.diagnostics[0]?.range).toMatchObject({
      startColumn: 12,
      startLine: 1,
    });
    expect(result.toolRuns[0]).toMatchObject({
      exitCode: 1,
      status: "failed",
      tool: "stylelint",
    });
  });

  it("reports missing Stylelint config as a CSS lint setup failure", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-css-lint-runner-no-config-"));
    tempDirs.push(tempDir);

    const cssFile = path.join(tempDir, "plain.css");
    await writeFile(cssFile, "a { color: red; }\n", "utf8");

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [cssFile],
        id: "test:1:lint-css-no-config",
        stageId: "lint",
      },
      process.cwd(),
    );

    expect(JSON.stringify(result)).not.toContain("not_implemented");
    expect(result.status).toBe("failed");
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        file: cssFile,
        severity: "error",
        source: "stylelint",
      }),
    ]);
    expect(result.diagnostics[0]?.message).toContain("Stylelint configuration");
    expect(result.diagnostics[0]?.message).toContain("disable CSS lint");
    expect(result.notes.join(" ")).toContain(
      `No Stylelint configuration was detected for lint in: ${cssFile}.`,
    );
    expect(result.notes.join(" ")).toContain("disable CSS lint");
    expect(result.toolRuns[0]).toMatchObject({
      exitCode: 1,
      status: "failed",
      tool: "stylelint",
    });
  });

  it("reports configured CSS lint diagnostics with missing Stylelint config diagnostics", async () => {
    const configuredDir = await mkdtemp(path.join(os.tmpdir(), "aiq-css-lint-configured-"));
    const unconfiguredDir = await mkdtemp(path.join(os.tmpdir(), "aiq-css-lint-unconfigured-"));
    tempDirs.push(configuredDir, unconfiguredDir);

    await writeFile(
      path.join(configuredDir, ".stylelintrc.json"),
      `${JSON.stringify({ rules: { "color-named": "never" } }, null, 2)}\n`,
      "utf8",
    );

    const badCssFile = path.join(configuredDir, "bad.css");
    const plainCssFile = path.join(unconfiguredDir, "plain.css");
    await writeFile(badCssFile, "a { color: red; }\n", "utf8");
    await writeFile(plainCssFile, "b { color: red; }\n", "utf8");

    const result = await runPlannedTask(
      {
        fileCount: 2,
        files: [badCssFile, plainCssFile],
        id: "test:1:lint-css-mixed-config",
        stageId: "lint",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "color-named", file: badCssFile, source: "stylelint" }),
        expect.objectContaining({ file: plainCssFile, source: "stylelint" }),
      ]),
    );
    expect(JSON.stringify(result)).not.toContain("not_implemented");
    expect(result.notes).toContain("Stylelint reported 2 diagnostics.");
    expect(result.notes.join(" ")).toContain(
      `No Stylelint configuration was detected for lint in: ${plainCssFile}.`,
    );
    expect(result.notes.join(" ")).toContain("disable CSS lint");
    expect(result.toolRuns[0]).toMatchObject({
      exitCode: 1,
      status: "failed",
      tool: "stylelint",
    });
  });

  it("resolves Stylelint config from the engine cwd when the file tree has none", async () => {
    const configDir = await mkdtemp(path.join(os.tmpdir(), "aiq-css-lint-cwd-config-"));
    const fileDir = await mkdtemp(path.join(os.tmpdir(), "aiq-css-lint-cwd-files-"));
    tempDirs.push(configDir, fileDir);

    await writeFile(
      path.join(configDir, ".stylelintrc.json"),
      `${JSON.stringify({ rules: { "color-named": "never" } }, null, 2)}\n`,
      "utf8",
    );

    const badCssFile = path.join(fileDir, "bad.css");
    await writeFile(badCssFile, "a { color: red; }\n", "utf8");

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [badCssFile],
        id: "test:1:lint-css-cwd-config",
        stageId: "lint",
      },
      configDir,
    );

    expect(result.status).toBe("failed");
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "color-named", file: badCssFile, source: "stylelint" }),
      ]),
    );
  });

  it("runs Prettier document format checks for HTML, CSS, and YAML files", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-document-format-runner-"));
    tempDirs.push(tempDir);

    const badHtmlFile = path.join(tempDir, "bad.html");
    const badCssFile = path.join(tempDir, "bad.css");
    const badYamlFile = path.join(tempDir, "bad.yaml");
    await writeFile(badHtmlFile, "<!doctype html><html><body><p>Hi</p></body></html>\n", "utf8");
    await writeFile(badCssFile, "body{color:#333}\n", "utf8");
    await writeFile(badYamlFile, "service:\n    name: api\n    port: 8080\n", "utf8");

    const result = await runPlannedTask(
      {
        fileCount: 3,
        files: [badHtmlFile, badCssFile, badYamlFile],
        id: "test:1:format-documents",
        stageId: "format",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: badHtmlFile, severity: "error", source: "prettier" }),
        expect.objectContaining({ file: badCssFile, severity: "error", source: "prettier" }),
        expect.objectContaining({ file: badYamlFile, severity: "error", source: "prettier" }),
      ]),
    );
    expect(result.toolRuns[0]).toMatchObject({
      exitCode: 1,
      status: "failed",
      tool: "prettier",
    });
  });

  it("runs YAML parse checks and returns structured diagnostics", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-yaml-lint-runner-"));
    tempDirs.push(tempDir);

    const badYamlFile = path.join(tempDir, "bad.yaml");
    await writeFile(badYamlFile, "service:\n  name: api\n   port: 8080\n", "utf8");

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [badYamlFile],
        id: "test:1:lint-yaml",
        stageId: "lint",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.diagnostics[0]).toMatchObject({
      file: badYamlFile,
      severity: "error",
      source: "yaml",
    });
    expect(result.diagnostics[0]?.range).toMatchObject({
      startColumn: 9,
      startLine: 2,
    });
    expect(result.toolRuns[0]).toMatchObject({
      exitCode: 1,
      status: "failed",
      tool: "yaml",
    });
  });

  it("runs SQL parse checks and returns structured diagnostics", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-sql-lint-runner-"));
    tempDirs.push(tempDir);

    const badSqlFile = path.join(tempDir, "bad.sql");
    await writeFile(badSqlFile, "SELECT FROM users;\n", "utf8");

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [badSqlFile],
        id: "test:1:lint-sql",
        stageId: "lint",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.diagnostics[0]).toMatchObject({
      file: badSqlFile,
      severity: "error",
      source: "node-sql-parser",
    });
    expect(result.diagnostics[0]?.message).toContain("Tried SQL dialects");
    expect(result.diagnostics[0]?.range).toMatchObject({
      startColumn: 18,
      startLine: 1,
    });
    expect(result.toolRuns[0]).toMatchObject({
      exitCode: 1,
      status: "failed",
      tool: "node-sql-parser",
    });
  });

  it("runs SQL format checks and reports formatting diagnostics", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-sql-format-runner-"));
    tempDirs.push(tempDir);

    const badSqlFile = path.join(tempDir, "bad.sql");
    await writeFile(badSqlFile, "SELECT id, name FROM users WHERE active = 1;\n", "utf8");

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [badSqlFile],
        id: "test:1:format-sql",
        stageId: "format",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.diagnostics[0]).toMatchObject({
      file: badSqlFile,
      severity: "error",
      source: "sql-formatter",
    });
    expect(result.toolRuns[0]).toMatchObject({
      args: [badSqlFile],
      exitCode: 1,
      status: "failed",
      tool: "sql-formatter",
    });
  });

  it.skipIf(!hasPythonQualityToolchain)(
    "runs Ruff lint and returns structured diagnostics for Python files",
    async () => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-python-lint-runner-"));
      tempDirs.push(tempDir);

      const badPythonFile = path.join(tempDir, "bad.py");
      await writeFile(badPythonFile, "import os\n", "utf8");

      const result = await runPlannedTask(
        {
          fileCount: 1,
          files: [badPythonFile],
          id: "test:1:lint-python",
          stageId: "lint",
        },
        process.cwd(),
      );

      expect(result.status).toBe("failed");
      expect(result.diagnostics[0]).toMatchObject({
        code: "F401",
        file: badPythonFile,
        severity: "error",
        source: "ruff",
      });
      expect(result.toolRuns[0]).toMatchObject({
        exitCode: 1,
        status: "failed",
        tool: "ruff",
      });
    },
  );

  it.skipIf(!hasPythonQualityToolchain)(
    "runs Ruff format on Python files and reports formatting diagnostics",
    async () => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-python-format-runner-"));
      tempDirs.push(tempDir);

      const badPythonFile = path.join(tempDir, "bad.py");
      await writeFile(badPythonFile, "x=1\n", "utf8");

      const result = await runPlannedTask(
        {
          fileCount: 1,
          files: [badPythonFile],
          id: "test:1:format-python",
          stageId: "format",
        },
        process.cwd(),
      );

      expect(result.status).toBe("failed");
      expect(result.diagnostics[0]).toMatchObject({
        file: badPythonFile,
        severity: "error",
        source: "ruff",
      });
      expect(result.toolRuns[0]).toMatchObject({
        exitCode: 1,
        status: "failed",
        tool: "ruff",
      });
    },
  );

  it.skipIf(!hasPythonQualityToolchain)(
    "runs Python typecheck and parses ty GitLab diagnostics",
    async () => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-python-typecheck-runner-"));
      tempDirs.push(tempDir);

      const badPythonFile = path.join(tempDir, "bad.py");
      await writeFile(badPythonFile, "value: str = 42\n", "utf8");

      const result = await runPlannedTask(
        {
          fileCount: 1,
          files: [badPythonFile],
          id: "test:1:typecheck-python",
          stageId: "typecheck",
        },
        process.cwd(),
      );

      expect(result.status).toBe("failed");
      expect(result.diagnostics[0]).toMatchObject({
        file: badPythonFile,
        message: expect.stringContaining("Object of type `Literal[42]` is not assignable to `str`"),
        severity: "error",
        source: "ty",
      });
      expect(result.diagnostics[0]?.range).toMatchObject({
        startColumn: 14,
        startLine: 1,
      });
      expect(result.toolRuns[0]).toMatchObject({
        exitCode: 1,
        status: "failed",
        tool: "ty",
      });
    },
  );

  it("passes the resolved Python interpreter to ty", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-python-typecheck-command-"));
    tempDirs.push(tempDir);

    const pythonFile = path.join(tempDir, "main.py");
    await writeFile(pythonFile, "value: str = 'ok'\n", "utf8");

    const toolRunner = new ToolRunner();
    const runSpy = vi.spyOn(toolRunner, "run").mockResolvedValue({
      durationMs: 5,
      exitCode: 0,
      finishedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      stderr: "",
      stdout: "[]",
    });

    const pythonCommand = process.platform === "win32" ? "python" : "python3";
    const tyCommand = process.platform === "win32" ? "ty.exe" : "ty";

    vi.spyOn(toolRunner, "resolveInstalledBinary").mockImplementation(async (commandName) => {
      if (commandName === pythonCommand) {
        return "/tmp/fake-python";
      }

      if (commandName === tyCommand) {
        return "/tmp/fake-ty";
      }

      return undefined;
    });

    const engineContext = withToolRunnerOverride(
      await buildEngineContext({
        context: "cli",
        manifest: {
          files: [pythonFile],
          source: "direct",
        },
        mode: "check",
        outDir: tempDir,
        stages: ["typecheck"],
      }),
      toolRunner,
    );

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [pythonFile],
        id: "test:1:typecheck-python-command",
        stageId: "typecheck",
      },
      engineContext,
    );

    expect(result.status).toBe("passed");
    expect(runSpy).toHaveBeenCalledWith(
      "/tmp/fake-ty",
      [
        "check",
        "--python",
        "/tmp/fake-python",
        "--output-format",
        "gitlab",
        "--no-progress",
        "--color",
        "never",
        pythonFile,
      ],
      expect.objectContaining({ cwd: tempDir }),
    );
  });

  it("falls back to uv tool run ty when ty is not directly installed", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-python-typecheck-uv-"));
    tempDirs.push(tempDir);

    const pythonFile = path.join(tempDir, "main.py");
    await writeFile(pythonFile, "value: str = 'ok'\n", "utf8");

    const toolRunner = new ToolRunner();
    const pythonCommand = process.platform === "win32" ? "python" : "python3";
    const tyCommand = process.platform === "win32" ? "ty.exe" : "ty";
    const runSpy = vi.spyOn(toolRunner, "run").mockImplementation(async (command, args) => {
      if (command === (process.platform === "win32" ? "where" : "which") && args[0] === tyCommand) {
        return {
          durationMs: 5,
          exitCode: 1,
          finishedAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          stderr: "",
          stdout: "",
        };
      }

      return {
        durationMs: 5,
        exitCode: 0,
        finishedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        stderr: "",
        stdout: "[]",
      };
    });

    vi.spyOn(toolRunner, "resolveInstalledBinary").mockImplementation(async (commandName) => {
      if (commandName === pythonCommand) {
        return "/tmp/fake-python";
      }

      if (commandName === (process.platform === "win32" ? "uv.exe" : "uv")) {
        return "/tmp/fake-uv";
      }

      return undefined;
    });

    const engineContext = withToolRunnerOverride(
      await buildEngineContext({
        context: "cli",
        manifest: {
          files: [pythonFile],
          source: "direct",
        },
        mode: "check",
        outDir: tempDir,
        stages: ["typecheck"],
      }),
      toolRunner,
    );

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [pythonFile],
        id: "test:1:typecheck-python-command-via-uv",
        stageId: "typecheck",
      },
      engineContext,
    );

    expect(result.status).toBe("passed");
    expect(runSpy).toHaveBeenCalledWith(
      "/tmp/fake-uv",
      ["tool", "run", "ty", "--version"],
      expect.objectContaining({ cwd: process.cwd() }),
    );
    expect(runSpy).toHaveBeenCalledWith(
      "/tmp/fake-uv",
      [
        "tool",
        "run",
        "ty",
        "check",
        "--python",
        "/tmp/fake-python",
        "--output-format",
        "gitlab",
        "--no-progress",
        "--color",
        "never",
        pythonFile,
      ],
      expect.objectContaining({ cwd: tempDir }),
    );
  });

  it("runs Vitest unit tests for TypeScript projects", async () => {
    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [fixtureFile],
        id: "test:1:unit",
        stageId: "unit",
      },
      process.cwd(),
    );

    expect(result.status).toBe("passed");
    expect(result.diagnostics).toEqual([]);
    expect(result.notes[0]).toContain("Vitest ran");
    expect(result.toolRuns[0]).toMatchObject({
      exitCode: 0,
      status: "passed",
      tool: "vitest",
    });
  }, 20_000);

  it("runs Jest unit tests for JavaScript projects", async () => {
    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [fixtureJavaScriptFile],
        id: "test:1:unit-js",
        stageId: "unit",
      },
      process.cwd(),
    );

    expect(result.status).toBe("passed");
    expect(result.diagnostics).toEqual([]);
    expect(result.notes[0]).toContain("Jest ran");
    expect(result.toolRuns[0]).toMatchObject({
      exitCode: 0,
      status: "passed",
      tool: "jest",
    });
  });

  it("runs coverage for TypeScript projects through Vitest", async () => {
    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [fixtureFile],
        id: "test:1:coverage",
        stageId: "coverage",
      },
      process.cwd(),
    );

    expect(result.status).toBe("passed");
    expect(result.diagnostics).toEqual([]);
    expect(result.notes[0]).toContain("Vitest coverage lines:");
    expect(result.toolRuns[0]).toMatchObject({
      exitCode: 0,
      status: "passed",
      tool: "vitest",
    });
  });

  it("runs coverage for JavaScript projects through Jest", async () => {
    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [fixtureJavaScriptFile],
        id: "test:1:coverage-js",
        stageId: "coverage",
      },
      process.cwd(),
    );

    expect(result.status).toBe("passed");
    expect(result.diagnostics).toEqual([]);
    expect(result.notes[0]).toContain("Jest coverage lines:");
    expect(result.toolRuns[0]).toMatchObject({
      exitCode: 0,
      status: "passed",
      tool: "jest",
    });
  });

  it("reuses JavaScript coverage execution across unit and coverage in one engine run", async () => {
    const project = await createCustomJavaScriptRunnerProject({
      prefix: "aiq-js-coverage-reuse-",
      runner: "jest",
      runnerScript: [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'const countFile = path.join(__dirname, "invocations.txt");',
        'const outputFileArg = process.argv.find((arg) => arg.startsWith("--outputFile="));',
        'if (!outputFileArg) throw new Error("missing --outputFile");',
        'const isCoverage = process.argv.some((arg) => arg === "--coverage");',
        'const count = Number(fs.existsSync(countFile) ? fs.readFileSync(countFile, "utf8") : "0") + 1;',
        "fs.writeFileSync(countFile, String(count));",
        'fs.writeFileSync(outputFileArg.slice("--outputFile=".length), JSON.stringify({ numFailedTests: 0, numPassedTests: 1, numTotalTests: 1, testResults: [] }));',
        "if (isCoverage) {",
        '  const coverageDirectoryArg = process.argv.find((arg) => arg.startsWith("--coverageDirectory="));',
        '  if (!coverageDirectoryArg) throw new Error("missing --coverageDirectory");',
        '  fs.mkdirSync(coverageDirectoryArg.slice("--coverageDirectory=".length), { recursive: true });',
        '  fs.writeFileSync(path.join(coverageDirectoryArg.slice("--coverageDirectory=".length), "coverage-summary.json"), JSON.stringify({ total: { lines: { total: 10, covered: 10, skipped: 0, pct: 100 } } }));',
        "}",
        "process.exit(0);",
        "",
      ].join("\n"),
    });

    const result = await runEngine({
      context: "cli",
      cwd: project.root,
      manifest: {
        files: [project.sourceFile],
        source: "direct",
      },
      mode: "check",
      outDir: path.join(project.root, ".aiq", "out"),
      stages: ["unit", "coverage"],
      writeArtifacts: false,
    });

    const unitStage = result.stages.find((stage) => stage.stageId === "unit");
    const coverageStage = result.stages.find((stage) => stage.stageId === "coverage");

    expect(result.summary.status).toBe("passed");
    expect(unitStage).toMatchObject({ stageId: "unit", status: "passed" });
    expect(unitStage?.notes[0]).toContain("Jest ran 1 test");
    expect(unitStage?.toolRuns[0]).toMatchObject({
      cacheHit: false,
      exitCode: 0,
      status: "passed",
      tool: "jest",
    });
    expect(coverageStage).toMatchObject({ stageId: "coverage", status: "passed" });
    expect(coverageStage?.notes[0]).toContain("Jest coverage lines: 100.0%");
    expect(coverageStage?.toolRuns[0]).toMatchObject({
      cacheHit: true,
      durationMs: 0,
      exitCode: 0,
      status: "passed",
      tool: "jest",
    });
    expect(await readFile(path.join(project.root, "invocations.txt"), "utf8")).toBe("1");
  });

  it("falls back to a plain JavaScript unit run when combined coverage priming lacks coverage output", async () => {
    const project = await createCustomJavaScriptRunnerProject({
      prefix: "aiq-js-coverage-fallback-",
      runner: "jest",
      runnerScript: [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'const countFile = path.join(__dirname, "invocations.txt");',
        'const outputFileArg = process.argv.find((arg) => arg.startsWith("--outputFile="));',
        'if (!outputFileArg) throw new Error("missing --outputFile");',
        'const count = Number(fs.existsSync(countFile) ? fs.readFileSync(countFile, "utf8") : "0") + 1;',
        "fs.writeFileSync(countFile, String(count));",
        'fs.writeFileSync(outputFileArg.slice("--outputFile=".length), JSON.stringify({ numFailedTests: 0, numPassedTests: 1, numTotalTests: 1, testResults: [] }));',
        "process.exit(0);",
        "",
      ].join("\n"),
    });

    const result = await runEngine({
      context: "cli",
      cwd: project.root,
      manifest: {
        files: [project.sourceFile],
        source: "direct",
      },
      mode: "check",
      outDir: path.join(project.root, ".aiq", "out"),
      stages: ["unit", "coverage"],
      writeArtifacts: false,
    });

    const unitStage = result.stages.find((stage) => stage.stageId === "unit");
    const coverageStage = result.stages.find((stage) => stage.stageId === "coverage");

    expect(result.summary.status).toBe("failed");
    expect(unitStage).toMatchObject({ stageId: "unit", status: "passed" });
    expect(unitStage?.toolRuns[0]).toMatchObject({
      cacheHit: false,
      exitCode: 0,
      status: "passed",
      tool: "jest",
    });
    expect(coverageStage).toMatchObject({ stageId: "coverage", status: "failed" });
    expect(coverageStage?.notes[0]).toContain("Expected coverage summary at");
    expect(coverageStage?.toolRuns).toEqual([]);
    expect(await readFile(path.join(project.root, "invocations.txt"), "utf8")).toBe("3");
  });

  it("falls back to a plain JavaScript unit run when coverage mode exits non-zero but tests themselves pass", async () => {
    const project = await createCustomJavaScriptRunnerProject({
      prefix: "aiq-js-coverage-exit-fallback-",
      runner: "jest",
      runnerScript: [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'const countFile = path.join(__dirname, "invocations.txt");',
        'const outputFileArg = process.argv.find((arg) => arg.startsWith("--outputFile="));',
        'if (!outputFileArg) throw new Error("missing --outputFile");',
        'const isCoverage = process.argv.some((arg) => arg === "--coverage");',
        'const count = Number(fs.existsSync(countFile) ? fs.readFileSync(countFile, "utf8") : "0") + 1;',
        "fs.writeFileSync(countFile, String(count));",
        'fs.writeFileSync(outputFileArg.slice("--outputFile=".length), JSON.stringify({ numFailedTests: 0, numPassedTests: 1, numTotalTests: 1, testResults: [] }));',
        "if (isCoverage) { process.exit(1); }",
        "process.exit(0);",
        "",
      ].join("\n"),
    });

    const result = await runEngine({
      context: "cli",
      cwd: project.root,
      manifest: {
        files: [project.sourceFile],
        source: "direct",
      },
      mode: "check",
      outDir: path.join(project.root, ".aiq", "out"),
      stages: ["unit", "coverage"],
      writeArtifacts: false,
    });

    const unitStage = result.stages.find((stage) => stage.stageId === "unit");
    const coverageStage = result.stages.find((stage) => stage.stageId === "coverage");

    expect(result.summary.status).toBe("failed");
    expect(unitStage).toMatchObject({ stageId: "unit", status: "passed" });
    expect(unitStage?.toolRuns[0]).toMatchObject({
      cacheHit: false,
      exitCode: 0,
      status: "passed",
      tool: "jest",
    });
    expect(coverageStage).toMatchObject({ stageId: "coverage", status: "failed" });
    expect(coverageStage?.toolRuns[0]).toMatchObject({
      cacheHit: false,
      exitCode: 1,
      status: "failed",
      tool: "jest",
    });
    expect(await readFile(path.join(project.root, "invocations.txt"), "utf8")).toBe("3");
  });

  it("does not reuse JavaScript coverage executions across standalone runner calls", async () => {
    const project = await createCustomJavaScriptRunnerProject({
      prefix: "aiq-js-no-cross-run-reuse-",
      runner: "jest",
      runnerScript: [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'const countFile = path.join(__dirname, "invocations.txt");',
        'const outputFileArg = process.argv.find((arg) => arg.startsWith("--outputFile="));',
        'if (!outputFileArg) throw new Error("missing --outputFile");',
        'const isCoverage = process.argv.some((arg) => arg === "--coverage");',
        'const count = Number(fs.existsSync(countFile) ? fs.readFileSync(countFile, "utf8") : "0") + 1;',
        "fs.writeFileSync(countFile, String(count));",
        'fs.writeFileSync(outputFileArg.slice("--outputFile=".length), JSON.stringify({ numFailedTests: 0, numPassedTests: 1, numTotalTests: 1, testResults: [] }));',
        "if (isCoverage) {",
        '  const coverageDirectoryArg = process.argv.find((arg) => arg.startsWith("--coverageDirectory="));',
        '  if (!coverageDirectoryArg) throw new Error("missing --coverageDirectory");',
        '  fs.mkdirSync(coverageDirectoryArg.slice("--coverageDirectory=".length), { recursive: true });',
        '  fs.writeFileSync(path.join(coverageDirectoryArg.slice("--coverageDirectory=".length), "coverage-summary.json"), JSON.stringify({ total: { lines: { total: 4, covered: 4, skipped: 0, pct: 100 } } }));',
        "}",
        "process.exit(0);",
        "",
      ].join("\n"),
    });

    const coverageResult = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:coverage-js-no-cross-run-reuse",
        stageId: "coverage",
      },
      project.root,
    );
    const unitResult = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:unit-js-no-cross-run-reuse",
        stageId: "unit",
      },
      project.root,
    );

    expect(coverageResult.status).toBe("passed");
    expect(coverageResult.toolRuns[0]).toMatchObject({ cacheHit: false, tool: "jest" });
    expect(unitResult.status).toBe("passed");
    expect(unitResult.toolRuns[0]).toMatchObject({ cacheHit: false, tool: "jest" });
    expect(await readFile(path.join(project.root, "invocations.txt"), "utf8")).toBe("2");
  });

  it("resets standalone runner reuse between identical back-to-back engine runs", async () => {
    const project = await createCustomJavaScriptRunnerProject({
      prefix: "aiq-js-engine-run-reset-",
      runner: "jest",
      runnerScript: [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'const countFile = path.join(__dirname, "invocations.txt");',
        'const outputFileArg = process.argv.find((arg) => arg.startsWith("--outputFile="));',
        'if (!outputFileArg) throw new Error("missing --outputFile");',
        'const isCoverage = process.argv.some((arg) => arg === "--coverage");',
        'const count = Number(fs.existsSync(countFile) ? fs.readFileSync(countFile, "utf8") : "0") + 1;',
        "fs.writeFileSync(countFile, String(count));",
        'fs.writeFileSync(outputFileArg.slice("--outputFile=".length), JSON.stringify({ numFailedTests: 0, numPassedTests: 1, numTotalTests: 1, testResults: [] }));',
        "if (isCoverage) {",
        '  const coverageDirectoryArg = process.argv.find((arg) => arg.startsWith("--coverageDirectory="));',
        '  if (!coverageDirectoryArg) throw new Error("missing --coverageDirectory");',
        '  fs.mkdirSync(coverageDirectoryArg.slice("--coverageDirectory=".length), { recursive: true });',
        '  fs.writeFileSync(path.join(coverageDirectoryArg.slice("--coverageDirectory=".length), "coverage-summary.json"), JSON.stringify({ total: { lines: { total: 4, covered: 4, skipped: 0, pct: 100 } } }));',
        "}",
        "process.exit(0);",
        "",
      ].join("\n"),
    });

    const request = {
      context: "cli" as const,
      cwd: project.root,
      manifest: {
        files: [project.sourceFile],
        source: "direct" as const,
      },
      mode: "check" as const,
      outDir: project.root,
      stages: ["unit", "coverage"] as const,
    };

    const first = await runEngine(request);
    const second = await runEngine(request);

    expect(first.summary.status).toBe("passed");
    expect(second.summary.status).toBe("passed");
    expect(first.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stageId: "unit", status: "passed" }),
        expect.objectContaining({ stageId: "coverage", status: "passed" }),
      ]),
    );
    expect(second.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stageId: "unit", status: "passed" }),
        expect.objectContaining({ stageId: "coverage", status: "passed" }),
      ]),
    );
    expect(first.stages.find((stage) => stage.stageId === "unit")?.toolRuns[0]).toMatchObject({
      cacheHit: false,
      tool: "jest",
    });
    expect(second.stages.find((stage) => stage.stageId === "unit")?.toolRuns[0]).toMatchObject({
      cacheHit: false,
      tool: "jest",
    });
    expect(await readFile(path.join(project.root, "invocations.txt"), "utf8")).toBe("2");
  });
  it("keeps stray tsconfig.json selections out of JavaScript unit and coverage fallback routing", async () => {
    const project = await createCustomJavaScriptRunnerProject({
      prefix: "aiq-js-stray-json-selection-",
      runner: "jest",
      runnerScript: "process.exit(0);\n",
    });

    for (const stageId of ["unit", "coverage"] as const) {
      const result = await runPlannedTask(
        {
          fileCount: 1,
          files: [project.tsconfigPath],
          id: `test:1:${stageId}-js-stray-json-selection`,
          stageId,
        },
        process.cwd(),
      );

      expect(result.status).toBe("passed");
      expect(result.diagnostics).toEqual([]);
      expect(result.notes).toEqual([`No supported files were selected for ${stageId}.`]);
      expect(result.toolRuns).toEqual([]);
    }
  });

  it("fails JavaScript unit when the runner exits zero without writing a JSON report", async () => {
    const project = await createCustomJavaScriptRunnerProject({
      prefix: "aiq-js-missing-report-",
      runner: "jest",
      runnerScript: "process.exit(0);\n",
    });

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:unit-js-missing-report",
        stageId: "unit",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.notes[0]).toContain("Expected test report at");
    expect(result.diagnostics[0]).toMatchObject({
      file: project.sourceFile,
      severity: "error",
      source: "test-runner",
    });
    expect(result.toolRuns).toEqual([]);
  });

  it("fails JavaScript unit when the runner writes malformed placeholder test JSON", async () => {
    const project = await createCustomJavaScriptRunnerProject({
      prefix: "aiq-js-malformed-report-",
      runner: "jest",
      runnerScript: [
        'const fs = require("node:fs");',
        'const outputFile = process.argv.find((arg) => arg.startsWith("--outputFile="));',
        'if (!outputFile) throw new Error("missing --outputFile");',
        'fs.writeFileSync(outputFile.slice("--outputFile=".length), JSON.stringify({}));',
        "process.exit(0);",
        "",
      ].join("\n"),
    });

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:unit-js-malformed-report",
        stageId: "unit",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.notes[0]).toContain("Expected test report at");
    expect(result.notes[0]).toContain("test summary fields");
    expect(result.diagnostics[0]).toMatchObject({
      file: project.sourceFile,
      severity: "error",
      source: "test-runner",
    });
    expect(result.toolRuns).toEqual([]);
  });

  it("fails JavaScript unit when testResults contains non-object entries", async () => {
    const project = await createCustomJavaScriptRunnerProject({
      prefix: "aiq-js-invalid-test-results-array-",
      runner: "jest",
      runnerScript: [
        'const fs = require("node:fs");',
        'const outputFile = process.argv.find((arg) => arg.startsWith("--outputFile="));',
        'if (!outputFile) throw new Error("missing --outputFile");',
        'fs.writeFileSync(outputFile.slice("--outputFile=".length), JSON.stringify({ numFailedTests: 0, numPassedTests: 1, numTotalTests: 1, testResults: [1] }));',
        "process.exit(0);",
        "",
      ].join("\n"),
    });

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:unit-js-invalid-test-results-array",
        stageId: "unit",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.notes[0]).toContain("Expected test report at");
    expect(result.notes[0]).toContain("test summary fields");
    expect(result.diagnostics[0]).toMatchObject({
      file: project.sourceFile,
      severity: "error",
      source: "test-runner",
    });
    expect(result.toolRuns).toEqual([]);
  });

  it("passes e2e as noop when no JavaScript or TypeScript project files are selected", async () => {
    const textFile = path.join(await mkdtemp(path.join(os.tmpdir(), "aiq-e2e-no-js-")), "note.txt");
    tempDirs.push(path.dirname(textFile));
    await writeFile(textFile, "notes\n", "utf8");

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [textFile],
        id: "test:1:e2e-no-js",
        stageId: "e2e",
      },
      process.cwd(),
    );

    expect(result.status).toBe("passed");
    expect(result.toolRuns).toEqual([]);
    expect(result.notes[0]).toContain("No supported files were selected for e2e.");
  });

  it("fails e2e when a JavaScript package has no configured e2e runner", async () => {
    const project = await createCustomJavaScriptE2eProject({
      prefix: "aiq-js-e2e-none-",
    });

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:e2e-js-none",
        stageId: "e2e",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.toolRuns).toEqual([]);
    expect(result.notes[0]).toContain("No e2e runner is configured");
    expect(result.diagnostics[0]).toMatchObject({
      file: project.packageJsonPath,
      severity: "error",
      source: "aiq-e2e",
    });
  });

  it("runs e2e through a configured agent-browser audit script", async () => {
    const project = await createCustomJavaScriptE2eProject({
      e2eScript: "node e2e.cjs --agent-browser",
      prefix: "aiq-js-e2e-agent-browser-",
    });
    await writeFile(path.join(project.root, "e2e.cjs"), "process.exit(0);\n", "utf8");

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:e2e-js-agent-browser",
        stageId: "e2e",
      },
      process.cwd(),
    );

    expect(result.status).toBe("passed");
    expect(result.diagnostics).toEqual([]);
    expect(result.notes[0]).toBe("Agent-browser e2e audit passed.");
    expect(result.toolRuns[0]).toMatchObject({
      args: ["run", "aiq:e2e", "--"],
      status: "passed",
      tool: "agent-browser",
    });
  });

  it("runs e2e through a configured Playwright project", async () => {
    const project = await createCustomJavaScriptE2eProject({
      packageJson: {
        devDependencies: {
          "@playwright/test": "1.0.0",
        },
        name: "aiq-js-e2e-playwright",
        private: true,
        scripts: {},
      },
      prefix: "aiq-js-e2e-playwright-",
    });
    const playwrightSummary = {
      suites: [{ specs: [{ tests: [{ results: [{ status: "passed" }] }] }] }],
    };
    await writeFile(
      path.join(project.root, "playwright.config.ts"),
      "export default {};\n",
      "utf8",
    );
    await writeFile(
      path.join(project.root, "playwright.cjs"),
      `console.log(${JSON.stringify(JSON.stringify(playwrightSummary))});\n`,
      "utf8",
    );
    const binDir = path.join(project.root, "node_modules", ".bin");
    await mkdir(binDir, { recursive: true });
    const playwrightBin =
      process.platform === "win32"
        ? path.join(binDir, "playwright.cmd")
        : path.join(binDir, "playwright");
    await writeFile(
      playwrightBin,
      process.platform === "win32"
        ? `@echo off\r\nnode "%~dp0\\..\\..\\playwright.cjs" %*\r\n`
        : `#!/usr/bin/env node\nrequire("../../playwright.cjs");\n`,
      "utf8",
    );
    if (process.platform !== "win32") {
      await chmod(playwrightBin, 0o755);
    }

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:e2e-js-playwright",
        stageId: "e2e",
      },
      process.cwd(),
    );

    expect(result.status).toBe("passed");
    expect(result.diagnostics).toEqual([]);
    expect(result.notes[0]).toBe("Playwright ran 1 e2e test: 1 passed, 0 failed.");
    expect(result.toolRuns[0]).toMatchObject({
      args: [
        "test",
        "--config",
        path.join(project.root, "playwright.config.ts"),
        "--reporter=json",
      ],
      status: "passed",
      tool: "playwright",
    });
  });

  it("runs e2e through an explicit package e2e script", async () => {
    const project = await createCustomJavaScriptE2eProject({
      e2eScript: "node e2e.cjs",
      prefix: "aiq-js-e2e-script-",
    });
    await writeFile(path.join(project.root, "e2e.cjs"), "process.exit(0);\n", "utf8");

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:e2e-js-script",
        stageId: "e2e",
      },
      process.cwd(),
    );

    expect(result.status).toBe("passed");
    expect(result.diagnostics).toEqual([]);
    expect(result.notes[0]).toBe("E2E script passed.");
    expect(result.toolRuns[0]).toMatchObject({
      args: ["run", "aiq:e2e", "--"],
      status: "passed",
      tool: "e2e",
    });
  });

  it("uses an ancestor e2e script to cover nested package projects", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "aiq-js-e2e-workspace-root-"));
    tempDirs.push(root);
    const packageRoot = path.join(root, "packages", "app");
    const sourceFile = path.join(packageRoot, "src", "index.ts");
    await mkdir(path.dirname(sourceFile), { recursive: true });
    await writeFile(
      path.join(root, "package.json"),
      `${JSON.stringify(
        {
          name: "workspace-root",
          private: true,
          scripts: {
            "aiq:e2e": "node e2e.cjs",
          },
          workspaces: ["packages/*"],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(path.join(root, "e2e.cjs"), "process.exit(0);\n", "utf8");
    await writeFile(
      path.join(packageRoot, "package.json"),
      `${JSON.stringify({ name: "workspace-app", private: true }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(sourceFile, "export const value = 1;\n", "utf8");

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [sourceFile],
        id: "test:1:e2e-js-workspace-root",
        stageId: "e2e",
      },
      process.cwd(),
    );

    expect(result.status).toBe("passed");
    expect(result.diagnostics).toEqual([]);
    expect(result.toolRuns).toHaveLength(1);
    expect(result.toolRuns[0]).toMatchObject({
      args: ["run", "aiq:e2e", "--"],
      status: "passed",
      tool: "e2e",
    });
  });

  it("fails JavaScript unit when the runner summary reports failures despite exit code 0", async () => {
    const project = await createCustomJavaScriptRunnerProject({
      prefix: "aiq-js-semantic-failure-report-",
      runner: "jest",
      runnerScript: [
        'const fs = require("node:fs");',
        'const outputFile = process.argv.find((arg) => arg.startsWith("--outputFile="));',
        'if (!outputFile) throw new Error("missing --outputFile");',
        'fs.writeFileSync(outputFile.slice("--outputFile=".length), JSON.stringify({ numFailedTests: 1, numPassedTests: 0, numTotalTests: 1, testResults: [] }));',
        "process.exit(0);",
        "",
      ].join("\n"),
    });

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:unit-js-semantic-failure-report",
        stageId: "unit",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.notes[0]).toContain("1 failed");
    expect(result.diagnostics[0]).toMatchObject({
      file: project.sourceFile,
      message: "Jest reported 1 failing test in its summary.",
      severity: "error",
      source: "jest",
    });
    expect(result.toolRuns).toEqual([
      expect.objectContaining({ exitCode: 0, status: "failed", tool: "jest" }),
    ]);
  });

  it("fails JavaScript unit when the runner writes impossible summary counts", async () => {
    const project = await createCustomJavaScriptRunnerProject({
      prefix: "aiq-js-impossible-summary-counts-",
      runner: "jest",
      runnerScript: [
        'const fs = require("node:fs");',
        'const outputFile = process.argv.find((arg) => arg.startsWith("--outputFile="));',
        'if (!outputFile) throw new Error("missing --outputFile");',
        'fs.writeFileSync(outputFile.slice("--outputFile=".length), JSON.stringify({ numFailedTests: 0, numPassedTests: 2, numTotalTests: 1, testResults: [] }));',
        "process.exit(0);",
        "",
      ].join("\n"),
    });

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:unit-js-impossible-summary-counts",
        stageId: "unit",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.notes[0]).toContain("Expected test report at");
    expect(result.notes[0]).toContain("test summary fields");
    expect(result.diagnostics[0]).toMatchObject({
      file: project.sourceFile,
      severity: "error",
      source: "test-runner",
    });
    expect(result.toolRuns).toEqual([]);
  });

  it("fails JavaScript coverage when the runner exits zero without writing a coverage summary", async () => {
    const project = await createCustomJavaScriptRunnerProject({
      prefix: "aiq-js-missing-coverage-summary-",
      runner: "jest",
      runnerScript: [
        'const fs = require("node:fs");',
        'const outputFile = process.argv.find((arg) => arg.startsWith("--outputFile="));',
        'if (!outputFile) throw new Error("missing --outputFile");',
        'fs.writeFileSync(outputFile.slice("--outputFile=".length), JSON.stringify({ numFailedTests: 0, numPassedTests: 1, numTotalTests: 1, testResults: [] }));',
        "process.exit(0);",
        "",
      ].join("\n"),
    });

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:coverage-js-missing-coverage-summary",
        stageId: "coverage",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.notes[0]).toContain("Expected coverage summary at");
    expect(result.diagnostics[0]).toMatchObject({
      file: project.sourceFile,
      severity: "error",
      source: "test-coverage",
    });
    expect(result.toolRuns).toEqual([]);
  });

  it("fails JavaScript coverage when the runner writes malformed placeholder coverage JSON", async () => {
    const project = await createCustomJavaScriptRunnerProject({
      prefix: "aiq-js-malformed-coverage-summary-",
      runner: "jest",
      runnerScript: [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'const outputFile = process.argv.find((arg) => arg.startsWith("--outputFile="));',
        'const coverageDirectory = process.argv.find((arg) => arg.startsWith("--coverageDirectory="));',
        'if (!outputFile) throw new Error("missing --outputFile");',
        'if (!coverageDirectory) throw new Error("missing --coverageDirectory");',
        'fs.writeFileSync(outputFile.slice("--outputFile=".length), JSON.stringify({ numFailedTests: 0, numPassedTests: 1, numTotalTests: 1, testResults: [] }));',
        'fs.mkdirSync(coverageDirectory.slice("--coverageDirectory=".length), { recursive: true });',
        'fs.writeFileSync(path.join(coverageDirectory.slice("--coverageDirectory=".length), "coverage-summary.json"), JSON.stringify({}));',
        "process.exit(0);",
        "",
      ].join("\n"),
    });

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:coverage-js-malformed-coverage-summary",
        stageId: "coverage",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.notes[0]).toContain("Expected coverage summary at");
    expect(result.notes[0]).toContain("total line coverage");
    expect(result.diagnostics[0]).toMatchObject({
      file: project.sourceFile,
      severity: "error",
      source: "test-coverage",
    });
    expect(result.toolRuns).toEqual([]);
  });

  it("fails JavaScript coverage when the coverage summary only reports pct without totals", async () => {
    const project = await createCustomJavaScriptRunnerProject({
      prefix: "aiq-js-minimal-coverage-summary-",
      runner: "jest",
      runnerScript: [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'const outputFile = process.argv.find((arg) => arg.startsWith("--outputFile="));',
        'const coverageDirectory = process.argv.find((arg) => arg.startsWith("--coverageDirectory="));',
        'if (!outputFile) throw new Error("missing --outputFile");',
        'if (!coverageDirectory) throw new Error("missing --coverageDirectory");',
        'fs.writeFileSync(outputFile.slice("--outputFile=".length), JSON.stringify({ numFailedTests: 0, numPassedTests: 1, numTotalTests: 1, testResults: [] }));',
        'fs.mkdirSync(coverageDirectory.slice("--coverageDirectory=".length), { recursive: true });',
        'fs.writeFileSync(path.join(coverageDirectory.slice("--coverageDirectory=".length), "coverage-summary.json"), JSON.stringify({ total: { lines: { pct: 100 } } }));',
        "process.exit(0);",
        "",
      ].join("\n"),
    });

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:coverage-js-minimal-coverage-summary",
        stageId: "coverage",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.notes[0]).toContain("Expected coverage summary at");
    expect(result.notes[0]).toContain("total line coverage");
    expect(result.diagnostics[0]).toMatchObject({
      file: project.sourceFile,
      severity: "error",
      source: "test-coverage",
    });
    expect(result.toolRuns).toEqual([]);
  });

  it("fails JavaScript coverage when the runner summary reports failures despite exit code 0", async () => {
    const project = await createCustomJavaScriptRunnerProject({
      prefix: "aiq-js-coverage-semantic-failure-report-",
      runner: "jest",
      runnerScript: [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'const outputFile = process.argv.find((arg) => arg.startsWith("--outputFile="));',
        'const coverageDirectory = process.argv.find((arg) => arg.startsWith("--coverageDirectory="));',
        'if (!outputFile) throw new Error("missing --outputFile");',
        'if (!coverageDirectory) throw new Error("missing --coverageDirectory");',
        'fs.writeFileSync(outputFile.slice("--outputFile=".length), JSON.stringify({ numFailedTests: 1, numPassedTests: 0, numTotalTests: 1, testResults: [] }));',
        'fs.mkdirSync(coverageDirectory.slice("--coverageDirectory=".length), { recursive: true });',
        'fs.writeFileSync(path.join(coverageDirectory.slice("--coverageDirectory=".length), "coverage-summary.json"), JSON.stringify({ total: { lines: { total: 10, covered: 9, skipped: 0, pct: 90 } } }));',
        "process.exit(0);",
        "",
      ].join("\n"),
    });

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:coverage-js-semantic-failure-report",
        stageId: "coverage",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.notes[0]).toContain("1 failed");
    expect(result.diagnostics[0]).toMatchObject({
      file: project.sourceFile,
      message: "Jest reported 1 failing test in its summary.",
      severity: "error",
      source: "jest",
    });
    expect(result.toolRuns).toEqual([
      expect.objectContaining({ exitCode: 0, status: "failed", tool: "jest" }),
    ]);
  });

  it("fails JavaScript coverage when the coverage summary carries impossible totals", async () => {
    const project = await createCustomJavaScriptRunnerProject({
      prefix: "aiq-js-impossible-coverage-totals-",
      runner: "jest",
      runnerScript: [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'const outputFile = process.argv.find((arg) => arg.startsWith("--outputFile="));',
        'const coverageDirectory = process.argv.find((arg) => arg.startsWith("--coverageDirectory="));',
        'if (!outputFile) throw new Error("missing --outputFile");',
        'if (!coverageDirectory) throw new Error("missing --coverageDirectory");',
        'fs.writeFileSync(outputFile.slice("--outputFile=".length), JSON.stringify({ numFailedTests: 0, numPassedTests: 1, numTotalTests: 1, testResults: [] }));',
        'fs.mkdirSync(coverageDirectory.slice("--coverageDirectory=".length), { recursive: true });',
        'fs.writeFileSync(path.join(coverageDirectory.slice("--coverageDirectory=".length), "coverage-summary.json"), JSON.stringify({ total: { lines: { total: 10, covered: 9, skipped: 2, pct: 110 } } }));',
        "process.exit(0);",
        "",
      ].join("\n"),
    });

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:coverage-js-impossible-coverage-totals",
        stageId: "coverage",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.notes[0]).toContain("Expected coverage summary at");
    expect(result.notes[0]).toContain("total line coverage");
    expect(result.diagnostics[0]).toMatchObject({
      file: project.sourceFile,
      severity: "error",
      source: "test-coverage",
    });
    expect(result.toolRuns).toEqual([]);
  });

  it("fails JavaScript coverage when the coverage percentage disagrees with the line counts", async () => {
    const project = await createCustomJavaScriptRunnerProject({
      prefix: "aiq-js-coverage-pct-mismatch-",
      runner: "jest",
      runnerScript: [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'const outputFile = process.argv.find((arg) => arg.startsWith("--outputFile="));',
        'const coverageDirectory = process.argv.find((arg) => arg.startsWith("--coverageDirectory="));',
        'if (!outputFile) throw new Error("missing --outputFile");',
        'if (!coverageDirectory) throw new Error("missing --coverageDirectory");',
        'fs.writeFileSync(outputFile.slice("--outputFile=".length), JSON.stringify({ numFailedTests: 0, numPassedTests: 1, numTotalTests: 1, testResults: [] }));',
        'fs.mkdirSync(coverageDirectory.slice("--coverageDirectory=".length), { recursive: true });',
        'fs.writeFileSync(path.join(coverageDirectory.slice("--coverageDirectory=".length), "coverage-summary.json"), JSON.stringify({ total: { lines: { total: 10, covered: 1, skipped: 0, pct: 99 } } }));',
        "process.exit(0);",
        "",
      ].join("\n"),
    });

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:coverage-js-pct-mismatch",
        stageId: "coverage",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.notes[0]).toContain("Expected coverage summary at");
    expect(result.diagnostics[0]).toMatchObject({
      file: project.sourceFile,
      severity: "error",
      source: "test-coverage",
    });
    expect(result.toolRuns).toEqual([]);
  });

  it("fails JavaScript coverage when coverage line counts are fractional", async () => {
    const project = await createCustomJavaScriptRunnerProject({
      prefix: "aiq-js-fractional-coverage-counts-",
      runner: "jest",
      runnerScript: [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'const outputFile = process.argv.find((arg) => arg.startsWith("--outputFile="));',
        'const coverageDirectory = process.argv.find((arg) => arg.startsWith("--coverageDirectory="));',
        'if (!outputFile) throw new Error("missing --outputFile");',
        'if (!coverageDirectory) throw new Error("missing --coverageDirectory");',
        'fs.writeFileSync(outputFile.slice("--outputFile=".length), JSON.stringify({ numFailedTests: 0, numPassedTests: 1, numTotalTests: 1, testResults: [] }));',
        'fs.mkdirSync(coverageDirectory.slice("--coverageDirectory=".length), { recursive: true });',
        'fs.writeFileSync(path.join(coverageDirectory.slice("--coverageDirectory=".length), "coverage-summary.json"), JSON.stringify({ total: { lines: { total: 10.5, covered: 9.5, skipped: 0, pct: 90.4761904762 } } }));',
        "process.exit(0);",
        "",
      ].join("\n"),
    });

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:coverage-js-fractional-counts",
        stageId: "coverage",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.notes[0]).toContain("Expected coverage summary at");
    expect(result.diagnostics[0]).toMatchObject({
      file: project.sourceFile,
      severity: "error",
      source: "test-coverage",
    });
    expect(result.toolRuns).toEqual([]);
  });

  it("accepts JavaScript coverage summaries with legitimately rounded percentages", async () => {
    const project = await createCustomJavaScriptRunnerProject({
      prefix: "aiq-js-rounded-coverage-pct-",
      runner: "jest",
      runnerScript: [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'const outputFile = process.argv.find((arg) => arg.startsWith("--outputFile="));',
        'const coverageDirectory = process.argv.find((arg) => arg.startsWith("--coverageDirectory="));',
        'if (!outputFile) throw new Error("missing --outputFile");',
        'if (!coverageDirectory) throw new Error("missing --coverageDirectory");',
        'fs.writeFileSync(outputFile.slice("--outputFile=".length), JSON.stringify({ numFailedTests: 0, numPassedTests: 1, numTotalTests: 1, testResults: [] }));',
        'fs.mkdirSync(coverageDirectory.slice("--coverageDirectory=".length), { recursive: true });',
        'fs.writeFileSync(path.join(coverageDirectory.slice("--coverageDirectory=".length), "coverage-summary.json"), JSON.stringify({ total: { lines: { total: 3, covered: 1, skipped: 0, pct: 33.33 } } }));',
        "process.exit(0);",
        "",
      ].join("\n"),
    });

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:coverage-js-rounded-coverage-pct",
        stageId: "coverage",
      },
      process.cwd(),
    );

    expect(result.status).toBe("passed");
    expect(result.diagnostics).toEqual([]);
    expect(result.notes[0]).toContain(
      "Jest coverage lines: 33.3% across 1 test: 1 passed, 0 failed.",
    );
    expect(result.toolRuns).toEqual([
      expect.objectContaining({ exitCode: 0, status: "passed", tool: "jest" }),
    ]);
  });

  it("fails JavaScript coverage when the percentage is slightly off without matching normal rounding", async () => {
    const project = await createCustomJavaScriptRunnerProject({
      prefix: "aiq-js-nearby-invalid-coverage-pct-",
      runner: "jest",
      runnerScript: [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'const outputFile = process.argv.find((arg) => arg.startsWith("--outputFile="));',
        'const coverageDirectory = process.argv.find((arg) => arg.startsWith("--coverageDirectory="));',
        'if (!outputFile) throw new Error("missing --outputFile");',
        'if (!coverageDirectory) throw new Error("missing --coverageDirectory");',
        'fs.writeFileSync(outputFile.slice("--outputFile=".length), JSON.stringify({ numFailedTests: 0, numPassedTests: 1, numTotalTests: 1, testResults: [] }));',
        'fs.mkdirSync(coverageDirectory.slice("--coverageDirectory=".length), { recursive: true });',
        'fs.writeFileSync(path.join(coverageDirectory.slice("--coverageDirectory=".length), "coverage-summary.json"), JSON.stringify({ total: { lines: { total: 10, covered: 1, skipped: 0, pct: 10.04 } } }));',
        "process.exit(0);",
        "",
      ].join("\n"),
    });

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:coverage-js-nearby-invalid-coverage-pct",
        stageId: "coverage",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.notes[0]).toContain("Expected coverage summary at");
    expect(result.diagnostics[0]).toMatchObject({
      file: project.sourceFile,
      severity: "error",
      source: "test-coverage",
    });
    expect(result.toolRuns).toEqual([]);
  });

  it("fails JavaScript coverage when the percentage is only a near miss of an allowed rounded value", async () => {
    const project = await createCustomJavaScriptRunnerProject({
      prefix: "aiq-js-near-miss-coverage-pct-",
      runner: "jest",
      runnerScript: [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'const outputFile = process.argv.find((arg) => arg.startsWith("--outputFile="));',
        'const coverageDirectory = process.argv.find((arg) => arg.startsWith("--coverageDirectory="));',
        'if (!outputFile) throw new Error("missing --outputFile");',
        'if (!coverageDirectory) throw new Error("missing --coverageDirectory");',
        'fs.writeFileSync(outputFile.slice("--outputFile=".length), JSON.stringify({ numFailedTests: 0, numPassedTests: 1, numTotalTests: 1, testResults: [] }));',
        'fs.mkdirSync(coverageDirectory.slice("--coverageDirectory=".length), { recursive: true });',
        'fs.writeFileSync(path.join(coverageDirectory.slice("--coverageDirectory=".length), "coverage-summary.json"), JSON.stringify({ total: { lines: { total: 10, covered: 1, skipped: 0, pct: 10.00009 } } }));',
        "process.exit(0);",
        "",
      ].join("\n"),
    });

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:coverage-js-near-miss-coverage-pct",
        stageId: "coverage",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.notes[0]).toContain("Expected coverage summary at");
    expect(result.diagnostics[0]).toMatchObject({
      file: project.sourceFile,
      severity: "error",
      source: "test-coverage",
    });
    expect(result.toolRuns).toEqual([]);
  });

  it("reuses cached JavaScript and TypeScript metrics between sloc, complexity, and maintainability", async () => {
    const sloc = await runPlannedTask(
      {
        fileCount: 2,
        files: [fixtureFile, fixtureJavaScriptFile],
        id: "test:1:sloc-js-ts",
        stageId: "sloc",
      },
      process.cwd(),
    );
    const complexity = await runPlannedTask(
      {
        fileCount: 2,
        files: [fixtureFile, fixtureJavaScriptFile],
        id: "test:1:complexity-js-ts",
        stageId: "complexity",
      },
      process.cwd(),
    );
    const maintainability = await runPlannedTask(
      {
        fileCount: 2,
        files: [fixtureFile, fixtureJavaScriptFile],
        id: "test:1:maintainability-js-ts",
        stageId: "maintainability",
      },
      process.cwd(),
    );
    const slocLizardRuns = sloc.toolRuns.filter(
      (toolRun) =>
        toolRun.cacheHit === false &&
        toolRun.exitCode === 0 &&
        toolRun.status === "passed" &&
        toolRun.tool === "lizard",
    );
    const complexityLizardRuns = complexity.toolRuns.filter(
      (toolRun) =>
        toolRun.cacheHit === true &&
        toolRun.exitCode === 0 &&
        toolRun.status === "passed" &&
        toolRun.tool === "lizard",
    );
    const maintainabilityLizardRuns = maintainability.toolRuns.filter(
      (toolRun) =>
        toolRun.cacheHit === true &&
        toolRun.exitCode === 0 &&
        toolRun.status === "passed" &&
        toolRun.tool === "lizard",
    );

    expect(sloc.status).toBe("passed");
    expect(sloc.notes[0]).toContain("JavaScript/TypeScript SLOC:");
    expect(slocLizardRuns).toHaveLength(2);
    expect(complexity.status).toBe("passed");
    expect(complexity.notes[0]).toContain("Shared metrics observed");
    expect(complexity.notes.join(" ")).toContain("Reused cached JavaScript/TypeScript metrics");
    expect(complexityLizardRuns).toHaveLength(2);
    expect(maintainability.status).toBe("passed");
    expect(maintainability.notes.join(" ")).toContain(
      "Reused cached JavaScript/TypeScript metrics",
    );
    expect(maintainabilityLizardRuns).toHaveLength(2);
  });

  it("invalidates cached JavaScript and TypeScript metrics when lizard config changes", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-js-ts-lizard-config-refresh-"));
    tempDirs.push(tempDir);

    const sourceFile = path.join(tempDir, "index.ts");
    await writeFile(path.join(tempDir, "package.json"), '{"type":"module"}\n', "utf8");
    await writeFile(sourceFile, "export const value = 1;\n", "utf8");

    const firstComplexity = await runPlannedTask(
      {
        fileCount: 1,
        files: [sourceFile],
        id: "test:1:complexity-js-ts-lizard-config:first",
        stageId: "complexity",
      },
      process.cwd(),
    );

    await writeFile(path.join(tempDir, ".lizard"), "", "utf8");

    const secondComplexity = await runPlannedTask(
      {
        fileCount: 1,
        files: [sourceFile],
        id: "test:1:complexity-js-ts-lizard-config:second",
        stageId: "complexity",
      },
      process.cwd(),
    );

    expect(firstComplexity.status).toBe("passed");
    expect(firstComplexity.toolRuns[0]).toMatchObject({
      cacheHit: false,
      exitCode: 0,
      status: "passed",
      tool: "lizard",
    });
    expect(secondComplexity.status).toBe("passed");
    expect(secondComplexity.toolRuns[0]).toMatchObject({
      cacheHit: false,
      exitCode: 0,
      status: "passed",
      tool: "lizard",
    });
  });

  it("keeps configured shared metrics language matrix release-safe", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-shared-metrics-language-matrix-"));
    tempDirs.push(tempDir);

    const neutralFile = path.join(tempDir, "README.txt");
    await writeFile(neutralFile, "plain text\n", "utf8");

    for (const languageId of languageIds) {
      for (const stageId of sharedMetricsStages) {
        const result = await runPlannedTask(
          {
            fileCount: 1,
            files: [neutralFile],
            id: `test:1:${stageId}-${languageId}-configured-metrics`,
            stageId,
          },
          await buildEngineContext({
            context: "cli",
            cwd: tempDir,
            manifest: { files: [neutralFile], source: "direct" },
            mode: "check",
            stageConfigurations: createSingleLanguageStageConfiguration(stageId, languageId),
            stages: [stageId],
            writeArtifacts: false,
          }),
        );

        expect(JSON.stringify(result)).not.toContain("not_implemented");
        expect(result.status).toBe("passed");
        expect(result.toolRuns).toEqual([]);
      }
    }
  });

  it("no-ops shared metrics for unsupported language file types without placeholders", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-unsupported-metrics-matrix-"));
    tempDirs.push(tempDir);

    const unsupportedFiles = [
      {
        contents: 'resource "null_resource" "example" {}\n',
        languageId: "terraform",
        name: "main.tf",
      },
      { contents: "locals { value = 1 }\n", languageId: "hcl", name: "main.hcl" },
      { contents: "echo hi\n", languageId: "bash", name: "script.sh" },
      { contents: "Write-Host 'hi'\n", languageId: "powershell", name: "script.ps1" },
      { contents: "<main>Hello</main>\n", languageId: "html", name: "index.html" },
      { contents: ".button { color: red; }\n", languageId: "css", name: "style.css" },
      { contents: "name: value\n", languageId: "yaml", name: "config.yaml" },
      { contents: "select 1;\n", languageId: "sql", name: "query.sql" },
      { contents: "# Notes\n", languageId: "documents", name: "notes.md" },
    ] as const satisfies readonly Array<{
      contents: string;
      languageId: LanguageId;
      name: string;
    }>;

    for (const fixture of unsupportedFiles) {
      const file = path.join(tempDir, fixture.name);
      await writeFile(file, fixture.contents, "utf8");

      for (const stageId of sharedMetricsStages) {
        const result = await runPlannedTask(
          {
            fileCount: 1,
            files: [file],
            id: `test:1:${stageId}-${fixture.languageId}-unsupported-metrics`,
            stageId,
          },
          await buildEngineContext({
            context: "cli",
            cwd: tempDir,
            manifest: { files: [file], source: "direct" },
            mode: "check",
            stageConfigurations: createSingleLanguageStageConfiguration(
              stageId,
              fixture.languageId,
            ),
            stages: [stageId],
            writeArtifacts: false,
          }),
        );

        expect(JSON.stringify(result)).not.toContain("not_implemented");
        expect(result.status).toBe("passed");
        expect(result.diagnostics).toEqual([]);
        expect(result.toolRuns).toEqual([]);
      }
    }
  });

  it("keeps supported shared metrics runs while reporting mixed unsupported files", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-mixed-shared-metrics-"));
    tempDirs.push(tempDir);

    const cssFile = path.join(tempDir, "style.css");
    await writeFile(cssFile, ".button { color: red; }\n", "utf8");

    for (const stageId of sharedMetricsStages) {
      const result = await runPlannedTask(
        {
          fileCount: 2,
          files: [fixtureFile, cssFile],
          id: `test:1:${stageId}-mixed-unsupported-metrics`,
          stageId,
        },
        process.cwd(),
      );

      expect(JSON.stringify(result)).not.toContain("not_implemented");
      expect(result.status).toBe("failed");
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          file: cssFile,
          severity: "error",
          source: "aiq-shared-metrics",
        }),
      ]);
      expect(result.notes.join(" ")).toContain("Unsupported shared metrics files");
      expect(result.toolRuns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ exitCode: 0, status: "passed", tool: "lizard" }),
        ]),
      );
    }
  });

  it("reports supported-language shared metrics files that cannot resolve a project", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-unresolved-rust-metrics-"));
    tempDirs.push(tempDir);

    const rustFile = path.join(tempDir, "orphan.rs");
    await writeFile(rustFile, "fn main() {}\n", "utf8");

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [rustFile],
        id: "test:1:complexity-rust-unresolved-project",
        stageId: "complexity",
      },
      process.cwd(),
    );

    expect(JSON.stringify(result)).not.toContain("not_implemented");
    expect(result.status).toBe("failed");
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        file: rustFile,
        severity: "error",
        source: "aiq-shared-metrics",
      }),
    ]);
    expect(result.toolRuns).toEqual([]);
  });

  it("expands package.json selections to the actual JavaScript and TypeScript source count", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-js-metrics-package-json-"));
    tempDirs.push(tempDir);
    const projectRoot = path.join(tempDir, "project");
    await cp(path.dirname(fixtureTypeScriptPackageJson), projectRoot, { recursive: true });
    await writeFile(path.join(projectRoot, "src", "extra.ts"), "export const extra = 1;\n", "utf8");
    const expectedScannedFileCount = (await collectJavaScriptAndTypeScriptFiles(projectRoot))
      .length;

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [path.join(projectRoot, "package.json")],
        id: "test:1:sloc-js-ts-package-json-source-count",
        stageId: "sloc",
      },
      process.cwd(),
    );

    expect(result.status).toBe("passed");
    expect(result.diagnostics).toEqual([]);
    expect(expectedScannedFileCount).toBe(5);
    expect(result.notes[0]).toContain(`across ${expectedScannedFileCount} files.`);
    expect(
      result.toolRuns.filter(
        (toolRun) =>
          toolRun.cacheHit === false &&
          toolRun.exitCode === 0 &&
          toolRun.status === "passed" &&
          toolRun.tool === "lizard",
      ),
    ).toHaveLength(1);
  });

  it.skipIf(!hasPythonQualityToolchain)("runs Pytest unit tests for Python projects", async () => {
    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [fixturePythonFile],
        id: "test:1:unit-python",
        stageId: "unit",
      },
      process.cwd(),
    );

    expect(result.status).toBe("passed");
    expect(result.diagnostics).toEqual([]);
    expect(result.notes[0]).toBe("Pytest ran 3 tests: 3 passed, 0 failed.");
    expect(result.toolRuns[0]).toMatchObject({
      exitCode: 0,
      status: "passed",
      tool: "pytest",
    });
  });

  it.skipIf(!hasPythonQualityToolchain)("runs Pytest coverage for Python projects", async () => {
    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [fixturePythonFile],
        id: "test:1:coverage-python",
        stageId: "coverage",
      },
      process.cwd(),
    );

    expect(result.status).toBe("passed");
    expect(result.diagnostics).toEqual([]);
    expect(result.notes[0]).toMatch(/^Pytest coverage lines: \d+\.\d% across 3 tests\.$/u);
    expect(result.toolRuns[0]).toMatchObject({
      exitCode: 0,
      status: "passed",
      tool: "pytest-cov",
    });
  });

  it.skipIf(!hasPythonQualityToolchain)("runs Python lint for config-only selections", async () => {
    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [fixturePythonConfigFile],
        id: "test:1:lint-python-config-only",
        stageId: "lint",
      },
      process.cwd(),
    );

    expect(result.status).toBe("passed");
    expect(result.diagnostics).toEqual([]);
    expect(result.notes).toEqual(["Ruff lint passed."]);
    expect(result.toolRuns[0]).toMatchObject({
      exitCode: 0,
      status: "passed",
      tool: "ruff",
    });
  });

  it.skipIf(!hasPythonQualityToolchain)(
    "runs Pytest unit tests for config-only Python selections",
    async () => {
      const result = await runPlannedTask(
        {
          fileCount: 1,
          files: [fixturePythonConfigFile],
          id: "test:1:unit-python-config-only",
          stageId: "unit",
        },
        process.cwd(),
      );

      expect(result.status).toBe("passed");
      expect(result.diagnostics).toEqual([]);
      expect(result.notes[0]).toBe("Pytest ran 3 tests: 3 passed, 0 failed.");
      expect(result.toolRuns[0]).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "pytest",
      });
    },
  );

  it.skipIf(!hasPythonQualityToolchain)(
    "runs Python metrics for config-only selections",
    async () => {
      const result = await runPlannedTask(
        {
          fileCount: 1,
          files: [fixturePythonConfigFile],
          id: "test:1:complexity-python-config-only",
          stageId: "complexity",
        },
        process.cwd(),
      );

      expect(result.status).toBe("passed");
      expect(result.diagnostics).toEqual([]);
      expect(result.notes[0]).toContain("Python complexity max:");
      expect(result.toolRuns[0]).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "radon",
      });
    },
  );
  it("reuses Python coverage execution across unit and coverage in one engine run", async () => {
    const project = await createCustomPythonRunnerProject({
      prefix: "aiq-python-coverage-reuse-",
      runnerScript: [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        "const args = process.argv.slice(2);",
        'const junitPath = args[args.indexOf("--junitxml") + 1];',
        'const coverageArgIndex = args.indexOf("--cov-report");',
        "const coverageArg = coverageArgIndex >= 0 ? args[coverageArgIndex + 1] : undefined;",
        'const coveragePath = coverageArg && coverageArg.startsWith("json:") ? coverageArg.slice("json:".length) : undefined;',
        'const countFile = path.join(process.cwd(), "invocations.txt");',
        'const count = Number(fs.existsSync(countFile) ? fs.readFileSync(countFile, "utf8") : "0") + 1;',
        "fs.writeFileSync(countFile, String(count));",
        'fs.writeFileSync(junitPath, \'<testsuite tests="1" failures="0" errors="0" skipped="0"></testsuite>\');',
        "if (coveragePath) {",
        "  fs.mkdirSync(path.dirname(coveragePath), { recursive: true });",
        "  fs.writeFileSync(coveragePath, JSON.stringify({ totals: { percent_covered: 100 } }));",
        "}",
        "process.exit(0);",
        "",
      ].join("\n"),
    });

    const result = await withPathedPythonShim(project.shimDir, async () =>
      runEngine({
        context: "cli",
        cwd: project.root,
        manifest: {
          files: [project.sourceFile],
          source: "direct",
        },
        mode: "check",
        outDir: path.join(project.root, ".aiq", "out"),
        stages: ["unit", "coverage"],
        writeArtifacts: false,
      }),
    );

    const unitStage = result.stages.find((stage) => stage.stageId === "unit");
    const coverageStage = result.stages.find((stage) => stage.stageId === "coverage");

    expect(result.summary.status).toBe("passed");
    expect(unitStage).toMatchObject({ stageId: "unit", status: "passed" });
    expect(unitStage?.notes[0]).toContain("Pytest ran 1 test");
    expect(unitStage?.toolRuns[0]).toMatchObject({
      cacheHit: false,
      exitCode: 0,
      status: "passed",
      tool: "pytest-cov",
    });
    expect(coverageStage).toMatchObject({ stageId: "coverage", status: "passed" });
    expect(coverageStage?.notes[0]).toContain("Pytest coverage lines: 100.0%");
    expect(coverageStage?.toolRuns[0]).toMatchObject({
      cacheHit: true,
      durationMs: 0,
      exitCode: 0,
      status: "passed",
      tool: "pytest-cov",
    });
    expect(await readFile(path.join(project.root, "invocations.txt"), "utf8")).toBe("1");
  });

  it("falls back to a plain Python unit run when combined coverage priming lacks coverage output", async () => {
    const project = await createCustomPythonRunnerProject({
      prefix: "aiq-python-coverage-fallback-",
      runnerScript: [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        "const args = process.argv.slice(2);",
        'const junitPath = args[args.indexOf("--junitxml") + 1];',
        'const countFile = path.join(process.cwd(), "invocations.txt");',
        'const count = Number(fs.existsSync(countFile) ? fs.readFileSync(countFile, "utf8") : "0") + 1;',
        "fs.writeFileSync(countFile, String(count));",
        'fs.writeFileSync(junitPath, \'<testsuite tests="1" failures="0" errors="0" skipped="0"></testsuite>\');',
        "process.exit(0);",
        "",
      ].join("\n"),
    });

    const result = await withPathedPythonShim(project.shimDir, async () =>
      runEngine({
        context: "cli",
        cwd: project.root,
        manifest: {
          files: [project.sourceFile],
          source: "direct",
        },
        mode: "check",
        outDir: path.join(project.root, ".aiq", "out"),
        stages: ["unit", "coverage"],
        writeArtifacts: false,
      }),
    );

    const unitStage = result.stages.find((stage) => stage.stageId === "unit");
    const coverageStage = result.stages.find((stage) => stage.stageId === "coverage");

    expect(result.summary.status).toBe("failed");
    expect(unitStage).toMatchObject({ stageId: "unit", status: "passed" });
    expect(unitStage?.toolRuns[0]).toMatchObject({
      cacheHit: false,
      exitCode: 0,
      status: "passed",
      tool: "pytest",
    });
    expect(coverageStage).toMatchObject({ stageId: "coverage", status: "failed" });
    expect(coverageStage?.notes[0]).toContain("Expected coverage summary at");
    expect(coverageStage?.toolRuns).toEqual([]);
    expect(await readFile(path.join(project.root, "invocations.txt"), "utf8")).toBe("3");
  });

  it("falls back to a plain Python unit run when coverage mode exits non-zero but tests themselves pass", async () => {
    const project = await createCustomPythonRunnerProject({
      prefix: "aiq-python-coverage-exit-fallback-",
      runnerScript: [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        "const args = process.argv.slice(2);",
        'const junitPath = args[args.indexOf("--junitxml") + 1];',
        'const countFile = path.join(process.cwd(), "invocations.txt");',
        'const count = Number(fs.existsSync(countFile) ? fs.readFileSync(countFile, "utf8") : "0") + 1;',
        'const coverageArgIndex = args.indexOf("--cov-report");',
        "const isCoverage = coverageArgIndex >= 0;",
        "fs.writeFileSync(countFile, String(count));",
        'fs.writeFileSync(junitPath, \'<testsuite tests="1" failures="0" errors="0" skipped="0"></testsuite>\');',
        "if (isCoverage) { process.exit(1); }",
        "process.exit(0);",
        "",
      ].join("\n"),
    });

    const result = await withPathedPythonShim(project.shimDir, async () =>
      runEngine({
        context: "cli",
        cwd: project.root,
        manifest: {
          files: [project.sourceFile],
          source: "direct",
        },
        mode: "check",
        outDir: path.join(project.root, ".aiq", "out"),
        stages: ["unit", "coverage"],
        writeArtifacts: false,
      }),
    );

    const unitStage = result.stages.find((stage) => stage.stageId === "unit");
    const coverageStage = result.stages.find((stage) => stage.stageId === "coverage");

    expect(result.summary.status).toBe("failed");
    expect(unitStage).toMatchObject({ stageId: "unit", status: "passed" });
    expect(unitStage?.toolRuns[0]).toMatchObject({
      cacheHit: false,
      exitCode: 0,
      status: "passed",
      tool: "pytest",
    });
    expect(coverageStage).toMatchObject({ stageId: "coverage", status: "failed" });
    expect(coverageStage?.toolRuns[0]).toMatchObject({
      cacheHit: false,
      exitCode: 1,
      status: "failed",
      tool: "pytest-cov",
    });
    expect(await readFile(path.join(project.root, "invocations.txt"), "utf8")).toBe("3");
  });

  it("does not reuse Python coverage executions across standalone runner calls", async () => {
    const project = await createCustomPythonRunnerProject({
      prefix: "aiq-python-no-cross-run-reuse-",
      runnerScript: [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        "const args = process.argv.slice(2);",
        'const junitPath = args[args.indexOf("--junitxml") + 1];',
        'const coverageArgIndex = args.indexOf("--cov-report");',
        "const coverageArg = coverageArgIndex >= 0 ? args[coverageArgIndex + 1] : undefined;",
        'const coveragePath = coverageArg && coverageArg.startsWith("json:") ? coverageArg.slice("json:".length) : undefined;',
        'const countFile = path.join(process.cwd(), "invocations.txt");',
        'const count = Number(fs.existsSync(countFile) ? fs.readFileSync(countFile, "utf8") : "0") + 1;',
        "fs.writeFileSync(countFile, String(count));",
        'fs.writeFileSync(junitPath, \'<testsuite tests="1" failures="0" errors="0" skipped="0"></testsuite>\');',
        "if (coveragePath) {",
        "  fs.mkdirSync(path.dirname(coveragePath), { recursive: true });",
        "  fs.writeFileSync(coveragePath, JSON.stringify({ totals: { percent_covered: 100 } }));",
        "}",
        "process.exit(0);",
        "",
      ].join("\n"),
    });

    const [coverageResult, unitResult] = await withPathedPythonShim(project.shimDir, async () => [
      await runPlannedTask(
        {
          fileCount: 1,
          files: [project.sourceFile],
          id: "test:1:coverage-python-no-cross-run-reuse",
          stageId: "coverage",
        },
        project.root,
      ),
      await runPlannedTask(
        {
          fileCount: 1,
          files: [project.sourceFile],
          id: "test:1:unit-python-no-cross-run-reuse",
          stageId: "unit",
        },
        project.root,
      ),
    ]);

    expect(coverageResult.status).toBe("passed");
    expect(coverageResult.toolRuns[0]).toMatchObject({ cacheHit: false, tool: "pytest-cov" });
    expect(unitResult.status).toBe("passed");
    expect(unitResult.toolRuns[0]).toMatchObject({ cacheHit: false, tool: "pytest" });
    expect(await readFile(path.join(project.root, "invocations.txt"), "utf8")).toBe("2");
  });

  it.skipIf(!hasGoToolchain)(
    "runs Go lint and returns structured diagnostics",
    async () => {
      const project = await createGoFixtureProject("aiq-go-lint-runner-");

      await writeFile(
        project.sourceFile,
        [
          "package fixture",
          "",
          'import "fmt"',
          "",
          "func Greet(name string) string {",
          '    fmt.Printf("%d", name)',
          '    return "Hello, " + name + "!"',
          "}",
          "",
          "func Sum(values []int) int {",
          "    total := 0",
          "    for _, value := range values {",
          "        total += value",
          "    }",
          "",
          "    return total",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );

      const result = await runPlannedTask(
        {
          fileCount: 1,
          files: [project.sourceFile],
          id: "test:1:lint-go",
          stageId: "lint",
        },
        process.cwd(),
      );

      expect(result.status).toBe("failed");
      expect(result.diagnostics[0]).toMatchObject({
        code: "printf",
        file: project.sourceFile,
        severity: "error",
        source: "go-vet",
      });
      expect(result.diagnostics[0]?.message).toContain("fmt.Printf format %d has arg name");
      expect(result.toolRuns[0]).toMatchObject({
        status: "failed",
        tool: "go-vet",
      });
    },
    20_000,
  );

  it.skipIf(!hasGoToolchain)(
    "marks Go lint as failed when go vet exits non-zero without parseable diagnostics",
    async () => {
      const project = await createGoFixtureProject("aiq-go-lint-fallback-runner-");

      await writeFile(
        project.sourceFile,
        [
          "package fixture",
          "",
          "func Greet(name string) string {",
          '    return "Hello, " + name + "!"',
          "",
        ].join("\n"),
        "utf8",
      );

      const result = await runPlannedTask(
        {
          fileCount: 1,
          files: [project.sourceFile],
          id: "test:1:lint-go-fallback-diagnostic",
          stageId: "lint",
        },
        process.cwd(),
      );

      expect(result.status).toBe("failed");
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]).toMatchObject({
        file: project.sourceFile,
        severity: "error",
        source: "go-vet",
      });
      expect(result.notes[0]).toContain("reported 1 diagnostic");
      expect(result.notes[0]).not.toContain("passed for");
      expect(result.toolRuns[0]).toMatchObject({
        status: "failed",
        tool: "go-vet",
      });
    },
    20_000,
  );

  it.skipIf(!hasGoToolchain)(
    "runs Go format and reports formatting diagnostics",
    async () => {
      const project = await createGoFixtureProject("aiq-go-format-runner-");

      await writeFile(
        project.sourceFile,
        [
          "package fixture",
          "",
          'import "strings"',
          "",
          "func Greet(name string) string{",
          "trimmedName := strings.TrimSpace(name)",
          'return "Hello, " + trimmedName + "!"',
          "}",
          "",
          "func Sum(values []int) int {",
          "total := 0",
          "for _, value := range values {",
          "total += value",
          "}",
          "return total",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );

      const result = await runPlannedTask(
        {
          fileCount: 1,
          files: [project.sourceFile],
          id: "test:1:format-go",
          stageId: "format",
        },
        process.cwd(),
      );

      expect(result.status).toBe("failed");
      expect(result.diagnostics[0]).toMatchObject({
        file: project.sourceFile,
        severity: "error",
        source: "gofmt",
      });
      expect(result.toolRuns[0]).toMatchObject({
        exitCode: 0,
        status: "failed",
        tool: "gofmt",
      });
    },
    20_000,
  );

  it.skipIf(!hasGoToolchain)(
    "runs Go typecheck and parses compiler diagnostics",
    async () => {
      const project = await createGoFixtureProject("aiq-go-typecheck-runner-");

      await writeFile(
        project.sourceFile,
        [
          "package fixture",
          "",
          'import "strings"',
          "",
          "func Greet(name string) string {",
          "    trimmedName := strings.TrimSpace(name)",
          "    return 42 + len(trimmedName)",
          "}",
          "",
          "func Sum(values []int) int {",
          "    total := 0",
          "    for _, value := range values {",
          "        total += value",
          "    }",
          "",
          "    return total",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );

      const result = await runPlannedTask(
        {
          fileCount: 1,
          files: [project.sourceFile],
          id: "test:1:typecheck-go",
          stageId: "typecheck",
        },
        process.cwd(),
      );

      expect(result.status).toBe("failed");
      expect(result.diagnostics[0]).toMatchObject({
        file: project.sourceFile,
        severity: "error",
        source: "go-build",
      });
      expect(result.diagnostics[0]?.message).toContain("cannot use 42");
      expect(result.toolRuns[0]).toMatchObject({
        status: "failed",
        tool: "go-build",
      });
    },
    20_000,
  );

  it.skipIf(!hasGoToolchain)(
    "runs Go unit tests for Go projects",
    async () => {
      const project = await createGoFixtureProject("aiq-go-unit-runner-");

      const result = await runPlannedTask(
        {
          fileCount: 1,
          files: [project.sourceFile],
          id: "test:1:unit-go",
          stageId: "unit",
        },
        process.cwd(),
      );

      expect(result.status).toBe("passed");
      expect(result.diagnostics).toEqual([]);
      expect(result.notes[0]).toContain("go test ran");
      expect(result.toolRuns[0]).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "go-test",
      });
    },
    20_000,
  );

  it.skipIf(!hasGoToolchain)(
    "runs Go coverage for Go projects",
    async () => {
      const project = await createGoFixtureProject("aiq-go-coverage-runner-");

      const result = await runPlannedTask(
        {
          fileCount: 1,
          files: [project.sourceFile],
          id: "test:1:coverage-go",
          stageId: "coverage",
        },
        process.cwd(),
      );

      expect(result.status).toBe("passed");
      expect(result.diagnostics).toEqual([]);
      expect(result.notes[0]).toContain("go test coverage lines:");
      expect(result.toolRuns[0]).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "go-test-coverage",
      });
    },
    20_000,
  );

  it("reuses cached Go metrics between sloc, complexity, and maintainability", async () => {
    const project = await createGoFixtureProject("aiq-go-metrics-runner-");

    const sloc = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:sloc-go",
        stageId: "sloc",
      },
      process.cwd(),
    );
    const complexity = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:complexity-go",
        stageId: "complexity",
      },
      process.cwd(),
    );
    const maintainability = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:maintainability-go",
        stageId: "maintainability",
      },
      process.cwd(),
    );

    expect(sloc.status).toBe("passed");
    expect(sloc.notes[0]).toContain("Go SLOC:");
    expect(sloc.toolRuns[0]).toMatchObject({
      cacheHit: false,
      exitCode: 0,
      status: "passed",
      tool: "lizard",
    });
    expect(complexity.status).toBe("passed");
    expect(complexity.notes[0]).toContain("Shared metrics observed");
    expect(complexity.notes.join(" ")).toContain("Reused cached Go metrics");
    expect(complexity.toolRuns[0]).toMatchObject({
      cacheHit: true,
      exitCode: 0,
      status: "passed",
      tool: "lizard",
    });
    expect(maintainability.status).toBe("passed");
    expect(maintainability.notes.join(" ")).toContain("Reused cached Go metrics");
    expect(maintainability.toolRuns[0]).toMatchObject({
      cacheHit: true,
      exitCode: 0,
      status: "passed",
      tool: "lizard",
    });
  }, 20_000);

  it("runs the shared security scan for Go inputs", async () => {
    const project = await createGoFixtureProject("aiq-go-security-runner-");

    await writeFile(
      project.sourceFile,
      ["package fixture", "", 'const token = "ghp_123456789012345678901234567890123456"', ""].join(
        "\n",
      ),
      "utf8",
    );

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:security-go",
        stageId: "security",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.diagnostics[0]).toMatchObject({
      file: project.sourceFile,
      severity: "error",
      source: "aiq-security",
    });
    expect(result.toolRuns[0]).toMatchObject({
      exitCode: 1,
      status: "failed",
      tool: "aiq-security",
    });
  });

  it.skipIf(!hasRustToolchain)(
    "runs Rust lint and returns structured diagnostics",
    async () => {
      await withExclusiveRust(async () => {
        const project = await createRustFixtureProject("aiq-rust-lint-runner-");

        await writeFile(
          project.sourceFile,
          [
            "pub fn greet(name: &str) -> String {",
            "    let unused_value = 42;",
            "    let trimmed_name = name.trim();",
            '    format!("Hello, {trimmed_name}!")',
            "}",
            "",
            "pub fn sum(values: &[i32]) -> i32 {",
            "    values.iter().sum()",
            "}",
            "",
          ].join("\n"),
          "utf8",
        );

        const result = await runPlannedTask(
          {
            fileCount: 1,
            files: [project.sourceFile],
            id: "test:1:lint-rust",
            stageId: "lint",
          },
          process.cwd(),
        );

        expect(result.status).toBe("failed");
        expect(result.diagnostics[0]).toMatchObject({
          file: project.sourceFile,
          severity: "error",
          source: "cargo-clippy",
        });
        expect(result.diagnostics[0]?.message).toContain("unused variable");
        expect(result.toolRuns[0]).toMatchObject({
          status: "failed",
          tool: "cargo-clippy",
        });
      });
    },
    20_000,
  );

  it.skipIf(!hasRustToolchain)(
    "runs Rust format and reports formatting diagnostics",
    async () => {
      await withExclusiveRust(async () => {
        const project = await createRustFixtureProject("aiq-rust-format-runner-");

        await writeFile(
          project.sourceFile,
          [
            "pub fn greet(name: &str) -> String{",
            "let trimmed_name = name.trim();",
            'format!("Hello, {trimmed_name}!")',
            "}",
            "",
            "pub fn sum(values: &[i32]) -> i32 {",
            "values.iter().sum()",
            "}",
            "",
          ].join("\n"),
          "utf8",
        );

        const result = await runPlannedTask(
          {
            fileCount: 1,
            files: [project.sourceFile],
            id: "test:1:format-rust",
            stageId: "format",
          },
          process.cwd(),
        );

        expect(result.status).toBe("failed");
        expect(result.diagnostics[0]).toMatchObject({
          file: project.sourceFile,
          severity: "error",
          source: "cargo-fmt",
        });
        expect(result.toolRuns[0]).toMatchObject({
          exitCode: 1,
          status: "failed",
          tool: "cargo-fmt",
        });
      });
    },
    20_000,
  );

  it.skipIf(!hasRustToolchain)(
    "runs Rust typecheck and parses compiler diagnostics",
    async () => {
      await withExclusiveRust(async () => {
        const project = await createRustFixtureProject("aiq-rust-typecheck-runner-");

        await writeFile(
          project.sourceFile,
          [
            "pub fn greet(name: &str) -> String {",
            "    let trimmed_name = name.trim();",
            "    42 + trimmed_name.len()",
            "}",
            "",
            "pub fn sum(values: &[i32]) -> i32 {",
            "    values.iter().sum()",
            "}",
            "",
          ].join("\n"),
          "utf8",
        );

        const result = await runPlannedTask(
          {
            fileCount: 1,
            files: [project.sourceFile],
            id: "test:1:typecheck-rust",
            stageId: "typecheck",
          },
          process.cwd(),
        );

        expect(result.status).toBe("failed");
        expect(result.diagnostics[0]).toMatchObject({
          file: project.sourceFile,
          severity: "error",
          source: "cargo-check",
        });
        expect(result.diagnostics[0]?.message).toContain("mismatched types");
        expect(result.toolRuns[0]).toMatchObject({
          status: "failed",
          tool: "cargo-check",
        });
      });
    },
    20_000,
  );

  it.skipIf(!hasRustToolchain)(
    "runs Rust unit tests for Rust projects",
    async () => {
      await withExclusiveRust(async () => {
        const project = await createRustFixtureProject("aiq-rust-unit-runner-");

        const result = await runPlannedTask(
          {
            fileCount: 1,
            files: [project.sourceFile],
            id: "test:1:unit-rust",
            stageId: "unit",
          },
          process.cwd(),
        );

        expect(result.status).toBe("passed");
        expect(result.diagnostics).toEqual([]);
        expect(result.notes[0]).toContain("cargo test ran");
        expect(result.toolRuns[0]).toMatchObject({
          exitCode: 0,
          status: "passed",
          tool: "cargo-test",
        });
      });
    },
    20_000,
  );

  it.skipIf(!hasRustToolchain)(
    "reports Rust unit test failures",
    async () => {
      await withExclusiveRust(async () => {
        const project = await createRustFixtureProject("aiq-rust-unit-fail-runner-");

        await writeFile(
          project.testFile,
          [
            "use aiq_rust_fixture::{greet, sum};",
            "",
            "#[test]",
            "fn greets_from_integration_tests() {",
            '    assert_eq!(greet("Rust"), "Hello, Rust!");',
            "}",
            "",
            "#[test]",
            "fn sums_from_integration_tests() {",
            "    assert_eq!(sum(&[4, 5]), 10);",
            "}",
            "",
          ].join("\n"),
          "utf8",
        );

        const result = await runPlannedTask(
          {
            fileCount: 1,
            files: [project.sourceFile],
            id: "test:1:unit-rust-fail",
            stageId: "unit",
          },
          process.cwd(),
        );

        expect(result.status).toBe("failed");
        expect(result.diagnostics[0]).toMatchObject({
          file: project.testFile,
          range: {
            startColumn: 5,
            startLine: 10,
          },
          severity: "error",
          source: "cargo-test",
        });
        expect(result.diagnostics[0]?.message).toContain("sums_from_integration_tests");
        expect(result.notes[0]).toBe("cargo test ran 4 tests: 3 passed, 1 failed.");
        expect(result.toolRuns[0]).toMatchObject({
          status: "failed",
          tool: "cargo-test",
        });
      });
    },
    20_000,
  );

  it.skipIf(!hasRustToolchain)(
    "parses Rust compiler diagnostics from cargo test JSON output",
    async () => {
      await withExclusiveRust(async () => {
        const project = await createRustFixtureProject("aiq-rust-unit-compile-fail-runner-");

        await writeFile(
          project.testFile,
          [
            "use aiq_rust_fixture::greet;",
            "",
            "#[test]",
            "fn integration_compile_failure() {",
            '    let message: i32 = greet("Rust");',
            "    assert_eq!(message, 1);",
            "}",
            "",
          ].join("\n"),
          "utf8",
        );

        const result = await runPlannedTask(
          {
            fileCount: 1,
            files: [project.sourceFile],
            id: "test:1:unit-rust-compile-fail",
            stageId: "unit",
          },
          process.cwd(),
        );

        expect(result.status).toBe("failed");
        expect(result.diagnostics).toContainEqual(
          expect.objectContaining({
            file: project.testFile,
            severity: "error",
            source: "cargo-test",
          }),
        );
        expect(
          result.diagnostics.some((diagnostic) => diagnostic.message.includes("mismatched types")),
        ).toBe(true);
        expect(result.toolRuns[0]).toMatchObject({
          status: "failed",
          tool: "cargo-test",
        });
      });
    },
    20_000,
  );

  it.skipIf(!hasRustCoverageToolchain)(
    "runs Rust coverage for Rust projects",
    async () => {
      await withExclusiveRust(async () => {
        const project = await createRustFixtureProject("aiq-rust-coverage-runner-");

        const result = await runPlannedTask(
          {
            fileCount: 1,
            files: [project.sourceFile],
            id: "test:1:coverage-rust",
            stageId: "coverage",
          },
          process.cwd(),
        );

        expect(result.status).toBe("passed");
        expect(result.diagnostics).toEqual([]);
        expect(result.notes[0]).toContain("cargo llvm-cov lines:");
        expect(result.toolRuns[0]).toMatchObject({
          exitCode: 0,
          status: "passed",
          tool: "cargo-llvm-cov",
        });
      });
    },
    60_000,
  );

  it.skipIf(!hasRustToolchain)(
    "reports Rust coverage as not implemented when cargo llvm-cov is unavailable",
    async () => {
      await withExclusiveRust(async () => {
        const project = await createRustFixtureProject("aiq-rust-coverage-missing-tool-runner-");
        const shimRoot = await mkdtemp(path.join(os.tmpdir(), "aiq-rust-coverage-shim-"));
        tempDirs.push(shimRoot);

        const shimBin = path.join(shimRoot, "bin");
        await mkdir(shimBin, { recursive: true });

        const cargoShim = path.join(shimBin, "cargo");
        const cargoDir = path.dirname(resolveCommandPath("cargo"));
        const rustcDir = path.dirname(resolveCommandPath("rustc"));
        await writeFile(
          cargoShim,
          [
            "#!/bin/sh",
            'if [ "$1" = "llvm-cov" ]; then',
            "  printf '%s\\n' 'error: no such command: `llvm-cov`' >&2",
            "  exit 101",
            "fi",
            `exec "${path.join(cargoDir, "cargo")}" "$@"`,
            "",
          ].join("\n"),
          "utf8",
        );
        await chmod(cargoShim, 0o755);

        const toolRunner = new ToolRunner();
        const rustEnv = {
          PATH: [shimBin, cargoDir, rustcDir].join(path.delimiter),
        };

        vi.spyOn(toolRunner, "createRustProcessEnv").mockResolvedValue(rustEnv);
        vi.spyOn(toolRunner, "resolveInstalledBinary").mockImplementation(async (commandName) => {
          if (commandName === "cargo") {
            return cargoShim;
          }

          if (commandName === "rustc") {
            return path.join(rustcDir, "rustc");
          }

          return undefined;
        });

        const engineContext = withToolRunnerOverride(
          await buildEngineContext({
            context: "cli",
            manifest: {
              files: [project.sourceFile],
              source: "direct",
            },
            mode: "check",
            outDir: project.root,
            stages: ["coverage"],
          }),
          toolRunner,
        );

        const result = await runPlannedTask(
          {
            fileCount: 1,
            files: [project.sourceFile],
            id: "test:1:coverage-rust-missing-tool",
            stageId: "coverage",
          },
          engineContext,
        );

        expect(result.status).toBe("not_implemented");
        expect(result.diagnostics).toEqual([]);
        expect(result.notes[0]).toContain("cargo-llvm-cov");
        expect(result.toolRuns[0]).toMatchObject({
          exitCode: 101,
          status: "not_implemented",
          tool: "cargo-llvm-cov",
        });
      });
    },
    60_000,
  );

  it.skipIf(!hasRustToolchain)(
    "reuses cached Rust metrics between sloc, complexity, and maintainability",
    async () => {
      const project = await createRustFixtureProject("aiq-rust-metrics-runner-");

      const sloc = await runPlannedTask(
        {
          fileCount: 1,
          files: [project.sourceFile],
          id: "test:1:sloc-rust",
          stageId: "sloc",
        },
        process.cwd(),
      );
      const complexity = await runPlannedTask(
        {
          fileCount: 1,
          files: [project.sourceFile],
          id: "test:1:complexity-rust",
          stageId: "complexity",
        },
        process.cwd(),
      );
      const maintainability = await runPlannedTask(
        {
          fileCount: 1,
          files: [project.sourceFile],
          id: "test:1:maintainability-rust",
          stageId: "maintainability",
        },
        process.cwd(),
      );

      expect(sloc.status).toBe("passed");
      expect(sloc.notes[0]).toContain("Rust SLOC:");
      expect(sloc.toolRuns[0]).toMatchObject({
        cacheHit: false,
        exitCode: 0,
        status: "passed",
        tool: "lizard",
      });
      expect(complexity.status).toBe("passed");
      expect(complexity.notes[0]).toContain("Shared metrics observed");
      expect(complexity.notes.join(" ")).toContain("Reused cached Rust metrics");
      expect(complexity.toolRuns[0]).toMatchObject({
        cacheHit: true,
        exitCode: 0,
        status: "passed",
        tool: "lizard",
      });
      expect(maintainability.status).toBe("passed");
      expect(maintainability.notes.join(" ")).toContain("Reused cached Rust metrics");
      expect(maintainability.toolRuns[0]).toMatchObject({
        cacheHit: true,
        exitCode: 0,
        status: "passed",
        tool: "lizard",
      });
    },
    20_000,
  );

  it.skipIf(!hasRustToolchain)(
    "combines Go and Rust metrics without downgrading supported mixed selections",
    async () => {
      const goProject = await createGoFixtureProject("aiq-mixed-go-rust-metrics-runner-");
      const rustProject = await createRustFixtureProject("aiq-mixed-go-rust-metrics-runner-");

      const complexity = await runPlannedTask(
        {
          fileCount: 2,
          files: [goProject.sourceFile, rustProject.sourceFile],
          id: "test:1:complexity-mixed-go-rust",
          stageId: "complexity",
        },
        process.cwd(),
      );
      const maintainability = await runPlannedTask(
        {
          fileCount: 2,
          files: [goProject.sourceFile, rustProject.sourceFile],
          id: "test:1:maintainability-mixed-go-rust",
          stageId: "maintainability",
        },
        process.cwd(),
      );

      expect(complexity.status).toBe("passed");
      expect(complexity.toolRuns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ cacheHit: false, status: "passed", tool: "lizard" }),
          expect.objectContaining({ cacheHit: false, status: "passed", tool: "lizard" }),
        ]),
      );
      expect(maintainability.status).toBe("passed");
      expect(maintainability.notes.join(" ")).toContain("Reused cached");
    },
    20_000,
  );

  it("runs the shared security scan for Rust inputs", async () => {
    const project = await createRustFixtureProject("aiq-rust-security-runner-");

    await writeFile(
      project.sourceFile,
      ['pub const TOKEN: &str = "ghp_123456789012345678901234567890123456";', ""].join("\n"),
      "utf8",
    );

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:security-rust",
        stageId: "security",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.diagnostics[0]).toMatchObject({
      file: project.sourceFile,
      severity: "error",
      source: "aiq-security",
    });
    expect(result.toolRuns[0]).toMatchObject({
      exitCode: 1,
      status: "failed",
      tool: "aiq-security",
    });
  });

  it.skipIf(!hasDotNet10Toolchain)(
    "runs dotnet style lint and returns structured diagnostics for C# files",
    async () => {
      const project = await createDotNetFixtureProject("aiq-dotnet-lint-runner-");

      await writeFile(
        project.sourceFile,
        [
          "namespace DotNetFixture;",
          "",
          "public static class Greeter",
          "{",
          "    public static string CreateGreeting(string name)",
          "    {",
          "        string trimmedName = name.Trim();",
          '        return $"Hello, {trimmedName}!";',
          "    }",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );

      const result = await withExclusiveDotNet(async () =>
        runPlannedTask(
          {
            fileCount: 1,
            files: [project.sourceFile],
            id: "test:1:lint-dotnet",
            stageId: "lint",
          },
          process.cwd(),
        ),
      );

      expect(result.status).toBe("failed");
      expect(result.diagnostics[0]).toMatchObject({
        code: "IDE0007",
        file: project.sourceFile,
        severity: "error",
        source: "dotnet-format",
      });
      expect(result.toolRuns[0]).toMatchObject({
        status: "failed",
        tool: "dotnet-format-style",
      });
    },
    90_000,
  );

  it.skipIf(!hasDotNet10Toolchain)(
    "runs dotnet whitespace format and reports formatting diagnostics",
    async () => {
      const project = await createDotNetFixtureProject("aiq-dotnet-format-runner-");

      await writeFile(
        project.sourceFile,
        [
          "namespace DotNetFixture;",
          "",
          "public static class Greeter",
          "{",
          "public static string CreateGreeting(string name){",
          "    var trimmedName = name.Trim();",
          '    return $"Hello, {trimmedName}!";    ',
          "}",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );

      const result = await withExclusiveDotNet(async () =>
        runPlannedTask(
          {
            fileCount: 1,
            files: [project.sourceFile],
            id: "test:1:format-dotnet",
            stageId: "format",
          },
          process.cwd(),
        ),
      );

      expect(result.status).toBe("failed");
      expect(result.diagnostics[0]).toMatchObject({
        code: "WHITESPACE",
        file: project.sourceFile,
        severity: "error",
        source: "dotnet-format",
      });
      expect(result.toolRuns[0]).toMatchObject({
        status: "failed",
        tool: "dotnet-format-whitespace",
      });
    },
    90_000,
  );

  it.skipIf(!hasDotNet10Toolchain)(
    "runs dotnet build typecheck and parses compiler diagnostics",
    async () => {
      const project = await createDotNetFixtureProject("aiq-dotnet-typecheck-runner-");

      await writeFile(
        project.sourceFile,
        [
          "namespace DotNetFixture;",
          "",
          "public static class Greeter",
          "{",
          "    public static string CreateGreeting(string name)",
          "    {",
          "        return 42;",
          "    }",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );

      const result = await withExclusiveDotNet(async () =>
        runPlannedTask(
          {
            fileCount: 1,
            files: [project.sourceFile],
            id: "test:1:typecheck-dotnet",
            stageId: "typecheck",
          },
          process.cwd(),
        ),
      );

      expect(result.status).toBe("failed");
      expect(result.diagnostics[0]).toMatchObject({
        file: project.sourceFile,
        severity: "error",
        source: "dotnet-build",
      });
      expect(result.diagnostics[0]?.message).toContain("Cannot implicitly convert type");
      expect(result.toolRuns[0]).toMatchObject({
        status: "failed",
        tool: "dotnet-build",
      });
    },
    90_000,
  );

  it.skipIf(!hasDotNet10Toolchain)(
    "runs dotnet unit tests for C# projects",
    async () => {
      const project = await createDotNetFixtureProject("aiq-dotnet-unit-runner-");

      const result = await withExclusiveDotNet(async () =>
        runPlannedTask(
          {
            fileCount: 1,
            files: [project.sourceFile],
            id: "test:1:unit-dotnet",
            stageId: "unit",
          },
          process.cwd(),
        ),
      );

      expect(result.status).toBe("passed");
      expect(result.diagnostics).toEqual([]);
      expect(result.notes[0]).toContain("dotnet test ran");
      expect(result.toolRuns[0]).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "dotnet-test",
      });
    },
    90_000,
  );

  it.skipIf(!hasDotNet10Toolchain)(
    "runs dotnet coverage for C# projects",
    async () => {
      const project = await createDotNetFixtureProject("aiq-dotnet-coverage-runner-");

      const result = await withExclusiveDotNet(async () =>
        runPlannedTask(
          {
            fileCount: 1,
            files: [project.sourceFile],
            id: "test:1:coverage-dotnet",
            stageId: "coverage",
          },
          process.cwd(),
        ),
      );

      expect(result.status).toBe("passed");
      expect(result.diagnostics).toEqual([]);
      expect(result.notes[0]).toContain("dotnet test coverage lines:");
      expect(result.toolRuns[0]).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "dotnet-test-coverage",
      });
    },
    90_000,
  );

  it.each(["unit", "coverage"] as const)(
    "reports missing JVM build targets as a setup failure for %s",
    async (stageId) => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-jvm-no-build-"));
      tempDirs.push(tempDir);

      const sourceFile = path.join(tempDir, "Greeting.java");
      await writeFile(
        sourceFile,
        'final class Greeting { static String message() { return "hello"; } }\n',
        "utf8",
      );

      const result = await runPlannedTask(
        {
          fileCount: 1,
          files: [sourceFile],
          id: `test:1:${stageId}-java-no-build`,
          stageId,
        },
        process.cwd(),
      );

      expectJvmSetupFailure(result, sourceFile);
      expect(result.notes[0]).toContain("No JVM build target was detected");
      expect(result.notes[0]).toContain("pom.xml");
      expect(result.notes[0]).toContain(`disable JVM ${stageId}`);
    },
  );

  it.each([
    {
      buildSystem: "Maven",
      createProject: createJavaMavenFixtureProject,
      expectedTool: "maven-test",
      prefix: "aiq-java-maven-missing-command-",
      stageId: "unit" as const,
    },
    {
      buildSystem: "Gradle",
      createProject: createKotlinGradleFixtureProject,
      expectedTool: "gradle-test-coverage",
      prefix: "aiq-kotlin-gradle-missing-command-",
      stageId: "coverage" as const,
    },
  ])(
    "reports missing $buildSystem execution as a JVM setup failure",
    async ({ buildSystem, createProject, expectedTool, prefix, stageId }) => {
      const project = await createProject(prefix);
      const toolRunner = new ToolRunner();
      vi.spyOn(toolRunner, "resolveInstalledBinary").mockResolvedValue(undefined);
      vi.spyOn(toolRunner, "run").mockResolvedValue({
        durationMs: 5,
        exitCode: undefined,
        finishedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        stderr: "",
        stdout: "",
      });

      const engineContext = withToolRunnerOverride(
        await buildEngineContext({
          context: "cli",
          manifest: {
            files: [project.sourceFile],
            source: "direct",
          },
          mode: "check",
          outDir: project.root,
          stages: [stageId],
        }),
        toolRunner,
      );

      const result = await runPlannedTask(
        {
          fileCount: 1,
          files: [project.sourceFile],
          id: `test:1:${stageId}-${buildSystem.toLowerCase()}-missing-command`,
          stageId,
        },
        engineContext,
      );

      expectJvmSetupFailure(result, project.sourceFile, expectedTool);
      expect(result.notes[0]).toContain(`${buildSystem} is required for JVM ${stageId}`);
      expect(result.notes[0]).toContain(`disable JVM ${stageId}`);
    },
  );

  it("preserves supported JVM test runs while reporting unsupported selected JVM files", async () => {
    const project = await createJavaMavenFixtureProject("aiq-java-maven-mixed-unsupported-");
    const unsupportedRoot = await mkdtemp(path.join(os.tmpdir(), "aiq-jvm-mixed-no-build-"));
    tempDirs.push(unsupportedRoot);
    const unsupportedFile = path.join(unsupportedRoot, "Orphan.java");
    await writeFile(unsupportedFile, "final class Orphan {}\n", "utf8");

    const toolRunner = new ToolRunner();
    vi.spyOn(toolRunner, "resolveInstalledBinary").mockResolvedValue("mvn");
    vi.spyOn(toolRunner, "run").mockImplementation(async (_command, _args, options) => {
      const reportsDir = path.join(options.cwd, "target", "surefire-reports");
      await mkdir(reportsDir, { recursive: true });
      await writeFile(
        path.join(reportsDir, "TEST-GreetingTest.xml"),
        '<testsuite tests="1" failures="0" errors="0" skipped="0"></testsuite>',
        "utf8",
      );
      const timestamp = new Date().toISOString();
      return {
        durationMs: 5,
        exitCode: 0,
        finishedAt: timestamp,
        startedAt: timestamp,
        stderr: "",
        stdout: "",
      };
    });

    const engineContext = withToolRunnerOverride(
      await buildEngineContext({
        context: "cli",
        manifest: {
          files: [project.sourceFile, unsupportedFile],
          source: "direct",
        },
        mode: "check",
        outDir: project.root,
        stages: ["unit"],
      }),
      toolRunner,
    );

    const result = await runPlannedTask(
      {
        fileCount: 2,
        files: [project.sourceFile, unsupportedFile],
        id: "test:1:unit-java-mixed-unsupported",
        stageId: "unit",
      },
      engineContext,
    );

    expect(JSON.stringify(result)).not.toContain("not_implemented");
    expect(result.status).toBe("failed");
    expect(result.toolRuns[0]).toMatchObject({ status: "passed", tool: "maven-test" });
    expect(result.diagnostics[0]).toMatchObject({
      file: unsupportedFile,
      severity: "error",
      source: "jvm-unavailable",
    });
    expect(result.notes.join(" ")).toContain("Maven test ran");
    expect(result.notes.join(" ")).toContain("No JVM build target was detected");
  });

  it.skipIf(!hasMavenToolchain)(
    "runs Maven lint for Java projects",
    async () => {
      const project = await createJavaMavenFixtureProject("aiq-java-maven-lint-runner-");

      const result = await runPlannedTask(
        {
          fileCount: 1,
          files: [project.sourceFile],
          id: "test:1:lint-java-maven",
          stageId: "lint",
        },
        process.cwd(),
      );

      expect(result.status).toBe("passed");
      expect(result.diagnostics).toEqual([]);
      expect(result.notes[0]).toContain("Maven Spotless");
      expect(result.toolRuns[0]).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "maven-spotless",
      });
    },
    120_000,
  );

  it.skipIf(!hasMavenToolchain)(
    "runs Maven typecheck and parses compiler diagnostics for Java projects",
    async () => {
      const project = await createJavaMavenFixtureProject("aiq-java-maven-typecheck-runner-");

      await writeFile(
        project.sourceFile,
        [
          "package dev.aiq.fixture;",
          "",
          "public final class Greeting {",
          "  private Greeting() {}",
          "",
          "  public static String message(String name) {",
          "    return 42;",
          "  }",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );

      const result = await runPlannedTask(
        {
          fileCount: 1,
          files: [project.sourceFile],
          id: "test:1:typecheck-java-maven",
          stageId: "typecheck",
        },
        process.cwd(),
      );

      expect(result.status).toBe("failed");
      expect(result.diagnostics[0]).toMatchObject({
        file: project.sourceFile,
        severity: "error",
        source: "maven-build",
      });
      expect(result.diagnostics[0]?.message).toContain("incompatible types");
      expect(result.toolRuns[0]).toMatchObject({
        status: "failed",
        tool: "maven-build",
      });
    },
    120_000,
  );

  it.skipIf(!hasMavenToolchain)(
    "runs Maven unit tests and coverage for Java projects",
    async () => {
      const project = await createJavaMavenFixtureProject("aiq-java-maven-test-runner-");

      const unit = await runPlannedTask(
        {
          fileCount: 1,
          files: [project.sourceFile],
          id: "test:1:unit-java-maven",
          stageId: "unit",
        },
        process.cwd(),
      );
      const coverage = await runPlannedTask(
        {
          fileCount: 1,
          files: [project.sourceFile],
          id: "test:1:coverage-java-maven",
          stageId: "coverage",
        },
        process.cwd(),
      );

      expect(unit.status).toBe("passed");
      expect(unit.notes[0]).toContain("Maven test ran");
      expect(unit.toolRuns[0]).toMatchObject({ exitCode: 0, status: "passed", tool: "maven-test" });
      expect(coverage.status).toBe("passed");
      expect(coverage.notes[0]).toContain("Maven coverage lines:");
      expect(coverage.toolRuns[0]).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "maven-test-coverage",
      });
    },
    120_000,
  );

  it.skipIf(!hasMavenToolchain)(
    "reuses cached JVM metrics between sloc, complexity, and maintainability",
    async () => {
      const project = await createJavaMavenFixtureProject("aiq-java-maven-metrics-runner-");

      const sloc = await runPlannedTask(
        {
          fileCount: 1,
          files: [project.sourceFile],
          id: "test:1:sloc-java-maven",
          stageId: "sloc",
        },
        process.cwd(),
      );
      const complexity = await runPlannedTask(
        {
          fileCount: 1,
          files: [project.sourceFile],
          id: "test:1:complexity-java-maven",
          stageId: "complexity",
        },
        process.cwd(),
      );
      const maintainability = await runPlannedTask(
        {
          fileCount: 1,
          files: [project.sourceFile],
          id: "test:1:maintainability-java-maven",
          stageId: "maintainability",
        },
        process.cwd(),
      );

      expect(sloc.status).toBe("passed");
      expect(sloc.notes[0]).toContain("JVM SLOC:");
      expect(sloc.toolRuns[0]).toMatchObject({
        cacheHit: false,
        exitCode: 0,
        status: "passed",
        tool: "lizard",
      });
      expect(complexity.status).toBe("passed");
      expect(complexity.notes[0]).toContain("Shared metrics observed");
      expect(complexity.notes.join(" ")).toContain("Reused cached JVM metrics");
      expect(complexity.toolRuns[0]).toMatchObject({
        cacheHit: true,
        exitCode: 0,
        status: "passed",
        tool: "lizard",
      });
      expect(maintainability.status).toBe("passed");
      expect(maintainability.notes.join(" ")).toContain("Reused cached JVM metrics");
      expect(maintainability.toolRuns[0]).toMatchObject({
        cacheHit: true,
        exitCode: 0,
        status: "passed",
        tool: "lizard",
      });
    },
    120_000,
  );

  it.skipIf(!hasGradleToolchain)(
    "runs Gradle format and unit stages for Kotlin projects",
    async () => {
      const project = await createKotlinGradleFixtureProject("aiq-kotlin-gradle-runner-");

      const unit = await runPlannedTask(
        {
          fileCount: 1,
          files: [project.sourceFile],
          id: "test:1:unit-kotlin-gradle",
          stageId: "unit",
        },
        process.cwd(),
      );

      await writeFile(
        project.sourceFile,
        [
          "package dev.aiq.fixture",
          "",
          "object Greeting{",
          "    fun message(name: String): String{",
          "        val trimmedName=name.trim()",
          '        return "Hello, $trimmedName!"',
          "    }",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );

      const format = await runPlannedTask(
        {
          fileCount: 1,
          files: [project.sourceFile],
          id: "test:1:format-kotlin-gradle",
          stageId: "format",
        },
        process.cwd(),
      );

      expect(unit.status).toBe("passed");
      expect(unit.notes[0]).toContain("Gradle test ran");
      expect(unit.toolRuns[0]).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "gradle-test",
      });
      expect(format.status).toBe("failed");
      expect(format.diagnostics[0]).toMatchObject({
        file: project.sourceFile,
        severity: "error",
        source: "gradle-spotless",
      });
      expect(format.toolRuns[0]).toMatchObject({
        status: "failed",
        tool: "gradle-spotless",
      });
    },
    180_000,
  );

  it.skipIf(!hasGradleToolchain)(
    "runs Gradle coverage for Kotlin projects",
    async () => {
      const project = await createKotlinGradleFixtureProject("aiq-kotlin-gradle-coverage-runner-");

      const result = await runPlannedTask(
        {
          fileCount: 1,
          files: [project.sourceFile],
          id: "test:1:coverage-kotlin-gradle",
          stageId: "coverage",
        },
        process.cwd(),
      );

      expect(result.status).toBe("passed");
      expect(result.notes[0]).toContain("Gradle coverage lines:");
      expect(result.toolRuns[0]).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "gradle-test-coverage",
      });
    },
    120_000,
  );

  it.skipIf(!hasGradleToolchain)(
    "reuses cached JVM metrics for Kotlin between sloc, complexity, and maintainability",
    async () => {
      const project = await createKotlinGradleFixtureProject("aiq-kotlin-gradle-metrics-runner-");

      const sloc = await runPlannedTask(
        {
          fileCount: 1,
          files: [project.sourceFile],
          id: "test:1:sloc-kotlin-gradle",
          stageId: "sloc",
        },
        process.cwd(),
      );
      const complexity = await runPlannedTask(
        {
          fileCount: 1,
          files: [project.sourceFile],
          id: "test:1:complexity-kotlin-gradle",
          stageId: "complexity",
        },
        process.cwd(),
      );
      const maintainability = await runPlannedTask(
        {
          fileCount: 1,
          files: [project.sourceFile],
          id: "test:1:maintainability-kotlin-gradle",
          stageId: "maintainability",
        },
        process.cwd(),
      );

      expect(sloc.status).toBe("passed");
      expect(sloc.notes[0]).toContain("JVM SLOC:");
      expect(sloc.toolRuns[0]).toMatchObject({
        cacheHit: false,
        exitCode: 0,
        status: "passed",
        tool: "lizard",
      });
      expect(complexity.status).toBe("passed");
      expect(complexity.notes[0]).toContain("Shared metrics observed");
      expect(complexity.notes.join(" ")).toContain("Reused cached JVM metrics");
      expect(complexity.toolRuns[0]).toMatchObject({
        cacheHit: true,
        exitCode: 0,
        status: "passed",
        tool: "lizard",
      });
      expect(maintainability.status).toBe("passed");
      expect(maintainability.notes.join(" ")).toContain("Reused cached JVM metrics");
      expect(maintainability.toolRuns[0]).toMatchObject({
        cacheHit: true,
        exitCode: 0,
        status: "passed",
        tool: "lizard",
      });
    },
    120_000,
  );

  it("reuses cached C# metrics between sloc, complexity, and maintainability", async () => {
    const project = await createDotNetFixtureProject("aiq-dotnet-metrics-runner-");

    const sloc = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:sloc-dotnet",
        stageId: "sloc",
      },
      process.cwd(),
    );
    const complexity = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:complexity-dotnet",
        stageId: "complexity",
      },
      process.cwd(),
    );
    const maintainability = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:maintainability-dotnet",
        stageId: "maintainability",
      },
      process.cwd(),
    );

    expect(sloc.status).toBe("passed");
    expect(sloc.notes[0]).toContain("C# SLOC:");
    expect(sloc.toolRuns[0]).toMatchObject({
      cacheHit: false,
      exitCode: 0,
      status: "passed",
      tool: "aiq-csharp-metrics",
    });
    expect(complexity.status).toBe("passed");
    expect(complexity.notes[0]).toContain("Shared metrics observed");
    expect(complexity.notes.join(" ")).toContain("Reused cached C# metrics");
    expect(complexity.toolRuns[0]).toMatchObject({
      cacheHit: true,
      exitCode: 0,
      status: "passed",
      tool: "aiq-csharp-metrics",
    });
    expect(maintainability.status).toBe("passed");
    expect(maintainability.notes.join(" ")).toContain("Reused cached C# metrics");
    expect(maintainability.toolRuns[0]).toMatchObject({
      cacheHit: true,
      exitCode: 0,
      status: "passed",
      tool: "aiq-csharp-metrics",
    });
  }, 20_000);

  it("invalidates cached C# metrics when the file contents change", async () => {
    const project = await createDotNetFixtureProject("aiq-dotnet-metrics-refresh-");

    await writeFile(
      project.sourceFile,
      [
        "namespace DotNetFixture;",
        "",
        "public static class Greeter",
        "{",
        "    public static int Score(bool flag)",
        "    {",
        "        return flag ? 1 : 0;",
        "    }",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const firstComplexity = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:complexity-dotnet-invalidate:first",
        stageId: "complexity",
      },
      process.cwd(),
    );

    await writeFile(
      project.sourceFile,
      [
        "namespace DotNetFixture;",
        "",
        "public static class Greeter",
        "{",
        "    public static int Score(bool flag, int value)",
        "    {",
        "        if (flag)",
        "        {",
        "            return value > 1 ? value : 1;",
        "        }",
        "",
        "        return 0;",
        "    }",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const secondComplexity = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:complexity-dotnet-invalidate:second",
        stageId: "complexity",
      },
      process.cwd(),
    );

    expect(firstComplexity.status).toBe("passed");
    expect(firstComplexity.notes[0]).toContain("C# complexity max: 2");
    expect(firstComplexity.toolRuns[0]).toMatchObject({
      cacheHit: false,
      exitCode: 0,
      status: "passed",
      tool: "aiq-csharp-metrics",
    });
    expect(secondComplexity.status).toBe("passed");
    expect(secondComplexity.notes[0]).toContain("C# complexity max: 3");
    expect(secondComplexity.toolRuns[0]).toMatchObject({
      cacheHit: false,
      exitCode: 0,
      status: "passed",
      tool: "aiq-csharp-metrics",
    });
  }, 20_000);

  it("does not count nullable annotations as ternary complexity", async () => {
    const project = await createDotNetFixtureProject("aiq-dotnet-nullable-metrics-runner-");

    await writeFile(
      project.sourceFile,
      [
        "namespace DotNetFixture;",
        "",
        "public static class Greeter",
        "{",
        "    public static string CreateGreeting(string? name, int? count)",
        "    {",
        '        var resolved = name is null ? "unknown" : name.Trim();',
        "        return resolved + count?.ToString();",
        "    }",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:complexity-dotnet-nullable-types",
        stageId: "complexity",
      },
      process.cwd(),
    );

    expect(result.status).toBe("passed");
    expect(result.notes[0]).toContain("C# complexity max: 2");
  });

  it("counts compact ternaries without surrounding whitespace", async () => {
    const project = await createDotNetFixtureProject("aiq-dotnet-compact-ternary-runner-");

    await writeFile(
      project.sourceFile,
      [
        "namespace DotNetFixture;",
        "",
        "public static class Greeter",
        "{",
        "    public static int Score(bool flag)",
        "    {",
        "        return flag?1:0;",
        "    }",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:complexity-dotnet-compact-ternary",
        stageId: "complexity",
      },
      process.cwd(),
    );

    expect(result.status).toBe("passed");
    expect(result.notes[0]).toContain("C# complexity max: 2");
  });

  it("counts ternaries with object initializer branches", async () => {
    const project = await createDotNetFixtureProject("aiq-dotnet-object-ternary-runner-");

    await writeFile(
      project.sourceFile,
      [
        "namespace DotNetFixture;",
        "",
        "public sealed class GreetingResult",
        "{",
        "    public string Message { get; init; } = string.Empty;",
        "}",
        "",
        "public static class Greeter",
        "{",
        "    public static GreetingResult Create(bool flag, GreetingResult fallback)",
        "    {",
        '        return flag ? new GreetingResult { Message = "hello" } : fallback;',
        "    }",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:complexity-dotnet-object-ternary",
        stageId: "complexity",
      },
      process.cwd(),
    );

    expect(result.status).toBe("passed");
    expect(result.notes[0]).toContain("C# complexity max: 2");
  });

  it("counts ternaries with switch-expression branches", async () => {
    const project = await createDotNetFixtureProject("aiq-dotnet-switch-ternary-runner-");

    await writeFile(
      project.sourceFile,
      [
        "namespace DotNetFixture;",
        "",
        "public static class Greeter",
        "{",
        "    public static int Score(bool flag, int value)",
        "    {",
        "        return flag ? value switch",
        "        {",
        "            > 0 => 1,",
        "            _ => 0,",
        "        } : 0;",
        "    }",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:complexity-dotnet-switch-ternary",
        stageId: "complexity",
      },
      process.cwd(),
    );

    expect(result.status).toBe("passed");
    expect(result.notes[0]).toContain("C# complexity max: 2");
  });

  it("runs C# metrics when selecting the project file directly", async () => {
    const project = await createDotNetCompetingSolutionProject(
      "aiq-dotnet-metrics-project-runner-",
    );
    const projectFile = path.join(project.root, "src", "DotNetFixture", "DotNetFixture.csproj");

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [projectFile],
        id: "test:1:complexity-dotnet-project",
        stageId: "complexity",
      },
      process.cwd(),
    );

    expect(result.status).toBe("passed");
    expect(result.notes[0]).toContain("Shared metrics observed 9 SLOC.");
    expect(result.toolRuns[0]).toMatchObject({
      exitCode: 0,
      status: "passed",
      tool: "aiq-csharp-metrics",
    });
  });

  it.skipIf(!hasDotNet10Toolchain || !hasPythonQualityToolchain)(
    "combines C# and Python metrics without downgrading supported mixed selections",
    async () => {
      const project = await createDotNetFixtureProject("aiq-mixed-metrics-runner-");

      const result = await runPlannedTask(
        {
          fileCount: 2,
          files: [project.sourceFile, fixturePythonFile],
          id: "test:1:complexity-mixed-dotnet-python",
          stageId: "complexity",
        },
        process.cwd(),
      );

      expect(result.status).toBe("passed");
      expect(result.toolRuns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ status: "passed", tool: "aiq-csharp-metrics" }),
          expect.objectContaining({ status: "passed", tool: "radon" }),
        ]),
      );
    },
  );

  it.skipIf(!hasDotNet10Toolchain)(
    "combines C# and Go metrics without downgrading supported mixed selections",
    async () => {
      const dotNetProject = await createDotNetFixtureProject("aiq-mixed-dotnet-go-metrics-runner-");
      const goProject = await createGoFixtureProject("aiq-mixed-dotnet-go-metrics-runner-");

      const complexity = await runPlannedTask(
        {
          fileCount: 2,
          files: [dotNetProject.sourceFile, goProject.sourceFile],
          id: "test:1:complexity-mixed-dotnet-go",
          stageId: "complexity",
        },
        process.cwd(),
      );
      const maintainability = await runPlannedTask(
        {
          fileCount: 2,
          files: [dotNetProject.sourceFile, goProject.sourceFile],
          id: "test:1:maintainability-mixed-dotnet-go",
          stageId: "maintainability",
        },
        process.cwd(),
      );

      expect(complexity.status).toBe("passed");
      expect(complexity.toolRuns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            cacheHit: false,
            status: "passed",
            tool: "aiq-csharp-metrics",
          }),
          expect.objectContaining({ cacheHit: false, status: "passed", tool: "lizard" }),
        ]),
      );
      expect(maintainability.status).toBe("passed");
      expect(maintainability.toolRuns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ cacheHit: true, status: "passed", tool: "aiq-csharp-metrics" }),
          expect.objectContaining({ cacheHit: true, status: "passed", tool: "lizard" }),
        ]),
      );
    },
    20_000,
  );

  it.skipIf(!hasDotNet10Toolchain)(
    "prefers the owning solution when multiple ancestor solutions exist",
    async () => {
      const project = await createDotNetCompetingSolutionProject(
        "aiq-dotnet-owning-solution-runner-",
      );

      const result = await withExclusiveDotNet(async () =>
        runPlannedTask(
          {
            fileCount: 2,
            files: [project.sourceFile, project.testFile],
            id: "test:1:unit-dotnet-owning-solution",
            stageId: "unit",
          },
          process.cwd(),
        ),
      );

      expect(result.status).toBe("passed");
      expect(result.toolRuns).toHaveLength(1);
      expect(result.toolRuns[0]).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "dotnet-test",
      });
      expect(result.notes[0]).toContain("1 passed, 0 failed");
    },
    90_000,
  );

  it.skipIf(!hasDotNet10Toolchain)(
    "uses graph-backed owning solution selection when a dotnet project file is selected directly",
    async () => {
      const project = await createDotNetFixtureProject("aiq-dotnet-project-file-context-runner-");
      const projectFile = path.join(project.root, "src", "DotNetFixture", "DotNetFixture.csproj");
      const engineContext = await buildEngineContext({
        context: "cli",
        cwd: project.root,
        manifest: {
          files: [projectFile],
          source: "direct",
        },
        mode: "check",
        outDir: path.join(project.root, ".aiq", "out"),
        profile: "fast",
        stages: ["unit"],
        writeArtifacts: false,
      });

      const result = await withExclusiveDotNet(async () =>
        runPlannedTask(
          {
            fileCount: 1,
            files: [projectFile],
            id: "test:1:unit-dotnet-project-file-context",
            stageId: "unit",
          },
          engineContext,
        ),
      );

      expect(result.status).toBe("passed");
      expect(result.notes[0]).toContain("1 passed, 0 failed");
      expect(result.toolRuns[0]).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "dotnet-test",
      });
      expect(result.toolRuns[0]?.args).toContain(project.solutionFile);
    },
    90_000,
  );

  it.skipIf(!hasDotNet10Toolchain)(
    "keeps fallback dotnet resolution passing when solution traversal cannot read an ancestor",
    async () => {
      const project = await createDotNetFixtureProject("aiq-dotnet-resolution-read-fallback-");
      const blockedDirectory = project.root;

      vi.resetModules();
      vi.doMock("node:fs/promises", async () => {
        const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
        type ReadDirectory = typeof actual.readdir;
        const actualReadDirectory = actual.readdir as ReadDirectory;

        return {
          ...actual,
          readdir: (async (...args: Parameters<ReadDirectory>) => {
            const [directoryPath] = args;
            if (
              typeof directoryPath === "string" &&
              path.resolve(directoryPath) === blockedDirectory
            ) {
              const error = new Error("simulated missing directory") as NodeJS.ErrnoException;
              error.code = "ENOENT";
              throw error;
            }

            return actualReadDirectory(...args);
          }) as ReadDirectory,
        };
      });

      try {
        const { runPlannedTask: runPlannedTaskWithMock } = await import("../src/runners.js");
        const result = await runPlannedTaskWithMock(
          {
            fileCount: 1,
            files: [project.sourceFile],
            id: "test:1:complexity-dotnet-resolution-read-fallback",
            stageId: "complexity",
          },
          process.cwd(),
        );

        expect(result.status).toBe("passed");
        expect(result.diagnostics).toEqual([]);
        expect(result.toolRuns[0]).toMatchObject({
          cacheHit: false,
          exitCode: 0,
          status: "passed",
          tool: "aiq-csharp-metrics",
        });
      } finally {
        vi.doUnmock("node:fs/promises");
        vi.resetModules();
      }
    },
    20_000,
  );

  it("limits solution metrics to projects declared in the selected solution", async () => {
    const project = await createDotNetCompetingSolutionProject(
      "aiq-dotnet-solution-metrics-runner-",
    );

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.solutionFile],
        id: "test:1:complexity-dotnet-solution-scope",
        stageId: "complexity",
      },
      process.cwd(),
    );

    expect(result.status).toBe("passed");
    expect(result.notes[0]).toContain("Shared metrics observed 20 SLOC.");
  });

  it("runs the shared security scan for C# inputs", async () => {
    const project = await createDotNetFixtureProject("aiq-dotnet-security-runner-");

    await writeFile(
      project.sourceFile,
      [
        "namespace DotNetFixture;",
        "",
        "public static class Greeter",
        "{",
        '    public const string Token = "ghp_123456789012345678901234567890123456";',
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:security-dotnet",
        stageId: "security",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.diagnostics[0]).toMatchObject({
      file: project.sourceFile,
      severity: "error",
      source: "aiq-security",
    });
    expect(result.toolRuns[0]).toMatchObject({
      exitCode: 1,
      status: "failed",
      tool: "aiq-security",
    });
  });

  it.skipIf(!hasPythonQualityToolchain)(
    "reuses cached Python metrics between sloc, complexity, and maintainability",
    async () => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-python-metrics-runner-"));
      tempDirs.push(tempDir);

      const metricsFile = path.join(tempDir, "metrics.py");
      await writeFile(
        metricsFile,
        [
          "def alpha(value: int) -> int:",
          "    if value > 1:",
          "        return value",
          "    return value + 1",
          "",
        ].join("\n"),
        "utf8",
      );

      const sloc = await runPlannedTask(
        {
          fileCount: 1,
          files: [metricsFile],
          id: "test:1:sloc-python",
          stageId: "sloc",
        },
        process.cwd(),
      );
      const complexity = await runPlannedTask(
        {
          fileCount: 1,
          files: [metricsFile],
          id: "test:1:complexity-python",
          stageId: "complexity",
        },
        process.cwd(),
      );
      const maintainability = await runPlannedTask(
        {
          fileCount: 1,
          files: [metricsFile],
          id: "test:1:maintainability-python",
          stageId: "maintainability",
        },
        process.cwd(),
      );

      expect(sloc.status).toBe("passed");
      expect(sloc.notes[0]).toContain("Python SLOC:");
      expect(sloc.toolRuns[0]).toMatchObject({
        cacheHit: false,
        exitCode: 0,
        status: "passed",
        tool: "radon",
      });
      expect(complexity.status).toBe("passed");
      expect(complexity.notes[0]).toContain("Shared metrics observed");
      expect(complexity.notes.join(" ")).toContain("Reused cached Python metrics");
      expect(complexity.toolRuns[0]).toMatchObject({
        cacheHit: true,
        exitCode: 0,
        status: "passed",
        tool: "radon",
      });
      expect(maintainability.status).toBe("passed");
      expect(maintainability.notes.join(" ")).toContain("Reused cached Python metrics");
      expect(maintainability.toolRuns[0]).toMatchObject({
        cacheHit: true,
        exitCode: 0,
        status: "passed",
        tool: "radon",
      });
    },
  );

  it.skipIf(!hasPythonQualityToolchain)(
    "invalidates cached Python metrics when the file contents change",
    async () => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-python-metrics-refresh-"));
      tempDirs.push(tempDir);

      const metricsFile = path.join(tempDir, "metrics.py");
      await writeFile(metricsFile, "value = 1\n", "utf8");

      const firstComplexity = await runPlannedTask(
        {
          fileCount: 1,
          files: [metricsFile],
          id: "test:1:complexity-python-invalidate:first",
          stageId: "complexity",
        },
        process.cwd(),
      );

      await writeFile(
        metricsFile,
        [
          "def beta(value: int) -> int:",
          "    if value > 2:",
          "        return value",
          "    return value + 2",
          "",
        ].join("\n"),
        "utf8",
      );

      const secondComplexity = await runPlannedTask(
        {
          fileCount: 1,
          files: [metricsFile],
          id: "test:1:complexity-python-invalidate:second",
          stageId: "complexity",
        },
        process.cwd(),
      );

      expect(firstComplexity.status).toBe("passed");
      expect(firstComplexity.notes[0]).toContain("no functions or classes were detected");
      expect(firstComplexity.toolRuns[0]).toMatchObject({
        cacheHit: false,
        exitCode: 0,
        status: "passed",
        tool: "radon",
      });
      expect(secondComplexity.status).toBe("passed");
      expect(secondComplexity.notes[0]).toContain("Python complexity max:");
      expect(secondComplexity.toolRuns[0]).toMatchObject({
        cacheHit: false,
        exitCode: 0,
        status: "passed",
        tool: "radon",
      });
    },
  );

  it.skipIf(!hasPythonQualityToolchain)(
    "invalidates cached Python metrics when Radon-compatible config changes",
    async () => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-python-radon-config-refresh-"));
      tempDirs.push(tempDir);

      const metricsFile = path.join(tempDir, "metrics.py");
      await writeFile(metricsFile, "value = 1\n", "utf8");

      const firstComplexity = await runPlannedTask(
        {
          fileCount: 1,
          files: [metricsFile],
          id: "test:1:complexity-python-radon-config:first",
          stageId: "complexity",
        },
        process.cwd(),
      );

      await writeFile(path.join(tempDir, "pyproject.toml"), "[tool.radon]\n", "utf8");

      const secondComplexity = await runPlannedTask(
        {
          fileCount: 1,
          files: [metricsFile],
          id: "test:1:complexity-python-radon-config:second",
          stageId: "complexity",
        },
        process.cwd(),
      );

      expect(firstComplexity.status).toBe("passed");
      expect(firstComplexity.toolRuns[0]).toMatchObject({
        cacheHit: false,
        exitCode: 0,
        status: "passed",
        tool: "radon",
      });
      expect(secondComplexity.status).toBe("passed");
      expect(secondComplexity.toolRuns[0]).toMatchObject({
        cacheHit: false,
        exitCode: 0,
        status: "passed",
        tool: "radon",
      });
    },
  );

  it.skipIf(!hasPythonQualityToolchain)(
    "combines TypeScript and Python typecheck results in one stage",
    async () => {
      const result = await runPlannedTask(
        {
          fileCount: 2,
          files: [fixtureFile, fixturePythonFile],
          id: "test:1:typecheck-mixed",
          stageId: "typecheck",
        },
        process.cwd(),
      );

      expect(result.status).toBe("passed");
      expect(result.diagnostics).toEqual([]);
      expect(result.toolRuns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ exitCode: 0, status: "passed", tool: "tsc" }),
          expect.objectContaining({ exitCode: 0, status: "passed", tool: "ty" }),
        ]),
      );
    },
  );

  it("detects Vitest projects through common config file variants", async () => {
    const variants = [
      {
        configFileName: "vitest.config.cjs",
        configSource: "module.exports = {};\n",
        tempPrefix: "aiq-vitest-config-cjs-",
      },
      {
        configFileName: "vitest.config.cts",
        configSource: "export default {};\n",
        tempPrefix: "aiq-vitest-config-cts-",
      },
    ];

    for (const variant of variants) {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), variant.tempPrefix));
      tempDirs.push(tempDir);

      await mkdir(path.join(tempDir, "src"), { recursive: true });
      await writeFile(
        path.join(tempDir, "package.json"),
        `${JSON.stringify({ name: variant.tempPrefix, private: true, scripts: { test: "node runner.cjs" } }, null, 2)}\n`,
        "utf8",
      );
      await writeFile(path.join(tempDir, variant.configFileName), variant.configSource, "utf8");
      await writeFile(
        path.join(tempDir, "runner.cjs"),
        [
          'const { spawnSync } = require("node:child_process");',
          `const result = spawnSync(process.execPath, [${JSON.stringify(vitestCliPath)}, ...process.argv.slice(2)], { stdio: "inherit" });`,
          "process.exit(result.status ?? 1);",
          "",
        ].join("\n"),
        "utf8",
      );

      const sourceFile = path.join(tempDir, "src", "index.ts");
      await writeFile(sourceFile, "export const value = 1;\n", "utf8");
      await writeFile(
        path.join(tempDir, "src", "index.test.ts"),
        [
          'import { describe, expect, it } from "vitest";',
          'import { value } from "./index";',
          "",
          'describe("config detection", () => {',
          '  it("passes", () => {',
          "    expect(value).toBe(1);",
          "  });",
          "});",
          "",
        ].join("\n"),
        "utf8",
      );

      const result = await runPlannedTask(
        {
          fileCount: 1,
          files: [sourceFile],
          id: `test:1:unit-${variant.configFileName}`,
          stageId: "unit",
        },
        process.cwd(),
      );

      expect(result.status).toBe("passed");
      expect(result.diagnostics).toEqual([]);
      expect(result.notes[0]).toContain("Vitest ran");
      expect(result.toolRuns[0]).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "vitest",
      });
    }
  });

  it("fails unit when package metadata cannot be parsed", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-invalid-package-json-"));
    tempDirs.push(tempDir);

    await mkdir(path.join(tempDir, "src"), { recursive: true });
    const packageJsonPath = path.join(tempDir, "package.json");
    await writeFile(packageJsonPath, "{\n", "utf8");

    const sourceFile = path.join(tempDir, "src", "index.ts");
    await writeFile(sourceFile, "export const value = 1;\n", "utf8");

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [sourceFile],
        id: "test:1:unit-invalid-package-json",
        stageId: "unit",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.notes[0]).toContain(`Failed to read package metadata at "${packageJsonPath}"`);
    expect(result.diagnostics[0]).toMatchObject({
      file: sourceFile,
      severity: "error",
      source: "test-runner",
    });
  });

  it("fails unit when package metadata cannot be read", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-unreadable-package-json-"));
    tempDirs.push(tempDir);

    await mkdir(path.join(tempDir, "src"), { recursive: true });
    await mkdir(path.join(tempDir, "package.json"), { recursive: true });

    const sourceFile = path.join(tempDir, "src", "index.ts");
    await writeFile(sourceFile, "export const value = 1;\n", "utf8");

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [sourceFile],
        id: "test:1:unit-unreadable-package-json",
        stageId: "unit",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.notes[0]).toContain(
      `Failed to read package metadata at "${path.join(tempDir, "package.json")}"`,
    );
    expect(result.diagnostics[0]).toMatchObject({
      file: sourceFile,
      severity: "error",
      source: "test-runner",
    });
  });

  it("reports unsupported JavaScript or TypeScript test runners as failed setup diagnostics", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-unsupported-runner-"));
    tempDirs.push(tempDir);

    await mkdir(path.join(tempDir, "src"), { recursive: true });
    await writeFile(
      path.join(tempDir, "package.json"),
      `${JSON.stringify({ name: "unsupported-runner", scripts: { test: "node test.js" } }, null, 2)}\n`,
      "utf8",
    );
    const sourceFile = path.join(tempDir, "src", "index.ts");
    await writeFile(sourceFile, "export const value = 1;\n", "utf8");

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [sourceFile],
        id: "test:1:unit-unsupported",
        stageId: "unit",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        file: path.join(tempDir, "package.json"),
        severity: "error",
        source: "aiq-js-test-runner",
      }),
    ]);
    expect(result.diagnostics[0]?.message).toContain(
      "Unsupported JavaScript or TypeScript test runner",
    );
    expect(result.diagnostics[0]?.message).toContain('package script "test" is "node test.js"');
    expect(result.notes.join(" ")).toContain(
      "Unsupported JavaScript/TypeScript test configuration",
    );
    expect(result.notes.join(" ")).toContain('package script "test" is "node test.js"');
    expect(result.toolRuns).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("not_implemented");
  });

  it("reports JavaScript or TypeScript packages with no test runner as setup diagnostics", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-no-runner-"));
    tempDirs.push(tempDir);

    await mkdir(path.join(tempDir, "src"), { recursive: true });
    await writeFile(
      path.join(tempDir, "package.json"),
      `${JSON.stringify({ name: "no-runner" }, null, 2)}\n`,
      "utf8",
    );
    const sourceFile = path.join(tempDir, "src", "index.ts");
    await writeFile(sourceFile, "export const value = 1;\n", "utf8");

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [sourceFile],
        id: "test:1:unit-no-runner",
        stageId: "unit",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        file: path.join(tempDir, "package.json"),
        severity: "error",
        source: "aiq-js-test-runner",
      }),
    ]);
    expect(result.diagnostics[0]?.message).toContain(
      "No JavaScript or TypeScript test runner is configured",
    );
    expect(result.notes.join(" ")).toContain(
      "No JavaScript or TypeScript test runner is configured",
    );
    expect(result.toolRuns).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("not_implemented");
  });

  it("keeps supported test runs while reporting mixed unsupported projects as diagnostics", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-mixed-runner-"));
    tempDirs.push(tempDir);

    await mkdir(path.join(tempDir, "src"), { recursive: true });
    await writeFile(
      path.join(tempDir, "package.json"),
      `${JSON.stringify({ name: "mixed-unsupported", scripts: { test: "node test.js" } }, null, 2)}\n`,
      "utf8",
    );
    const unsupportedFile = path.join(tempDir, "src", "index.ts");
    await writeFile(unsupportedFile, "export const value = 1;\n", "utf8");

    const result = await runPlannedTask(
      {
        fileCount: 2,
        files: [fixtureFile, unsupportedFile],
        id: "test:1:unit-mixed",
        stageId: "unit",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.notes.join(" ")).toContain("Vitest ran");
    expect(result.notes.join(" ")).toContain('package script "test" is "node test.js"');
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        file: path.join(tempDir, "package.json"),
        severity: "error",
        source: "aiq-js-test-runner",
      }),
    ]);
    expect(result.toolRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ exitCode: 0, status: "passed", tool: "vitest" }),
      ]),
    );
    expect(JSON.stringify(result)).not.toContain("not_implemented");
  });

  it("keeps generic script config selections out of Bash and PowerShell unit planning", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-script-config-only-"));
    tempDirs.push(tempDir);

    const configFiles = [
      path.join(tempDir, "requirements.txt"),
      path.join(tempDir, "PSScriptAnalyzerSettings.psd1"),
    ];

    await writeFile(configFiles[0], "pytest\n", "utf8");
    await writeFile(configFiles[1], "@{ IncludeRules = @() }\n", "utf8");

    for (const [index, configFile] of configFiles.entries()) {
      const result = await runPlannedTask(
        {
          fileCount: 1,
          files: [configFile],
          id: `test:1:unit-script-config-only-${index}`,
          stageId: "unit",
        },
        process.cwd(),
      );

      expect(result.status).toBe("passed");
      expect(result.diagnostics).toEqual([]);
      expect(result.notes).toEqual(["No supported files were selected for unit."]);
      expect(result.toolRuns).toEqual([]);
    }
  });

  it.each(["unit", "coverage"] as const)(
    "reports missing Bash tests as a setup failure for %s",
    async (stageId) => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-bash-no-tests-"));
      tempDirs.push(tempDir);

      const bashFile = path.join(tempDir, "example.sh");
      await writeFile(bashFile, "#!/usr/bin/env bash\necho hello\n", "utf8");

      const result = await runPlannedTask(
        {
          fileCount: 1,
          files: [bashFile],
          id: `test:1:${stageId}-bash-no-tests`,
          stageId,
        },
        process.cwd(),
      );

      expectBashSetupFailure(result, "bats", bashFile);
      expect(result.notes[0]).toContain("No Bash test files were detected");
      expect(result.notes[0]).toContain(`disable Bash ${stageId}`);
    },
  );

  it("recognizes mixed-case .BATS files as Bash tests", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-bash-uppercase-bats-"));
    tempDirs.push(tempDir);

    const batsFile = path.join(tempDir, "example.BATS");
    await writeFile(batsFile, ['@test "passes" {', "  [ 1 -eq 1 ]", "}", ""].join("\n"), "utf8");

    vi.spyOn(ToolRunner.prototype, "resolveBinaryIfAvailable").mockResolvedValue(undefined);

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [batsFile],
        id: "test:1:unit-bash-uppercase-bats",
        stageId: "unit",
      },
      process.cwd(),
    );

    expectBashSetupFailure(result, "bats", batsFile);
    expect(result.notes[0]).toContain("Bats is required for Bash unit");
    expect(result.notes[0]).not.toContain("No Bash tests were found");
  });

  it("returns a failed stage result when Bash binary lookup hits an unexpected error", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-bash-lookup-error-"));
    tempDirs.push(tempDir);

    const batsFile = path.join(tempDir, "example.BATS");
    await writeFile(batsFile, ['@test "passes" {', "  [ 1 -eq 1 ]", "}", ""].join("\n"), "utf8");

    vi.spyOn(ToolRunner.prototype, "resolveBinaryIfAvailable").mockRejectedValue(
      new Error("lookup exploded"),
    );

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [batsFile],
        id: "test:1:unit-bash-lookup-error",
        stageId: "unit",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.notes[0]).toContain("lookup exploded");
    expect(result.diagnostics[0]).toMatchObject({
      file: batsFile,
      severity: "error",
      source: "bats",
    });
    expect(result.toolRuns).toEqual([]);
  });

  it("runs Bash unit tests for script projects", async () => {
    const project = await createBashFixtureProject("aiq-bash-unit-");
    const hasBats = commandAvailable("bats");

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:unit-bash",
        stageId: "unit",
      },
      process.cwd(),
    );

    if (!hasBats) {
      expectBashSetupFailure(result, "bats", project.sourceFile);
      expect(result.notes[0]).toContain("Bats is required for Bash unit");
      return;
    }

    expect(result.status).toBe("passed");
    expect(result.notes[0]).toContain("Bats ran");
    expect(result.toolRuns[0]).toMatchObject({ status: "passed", tool: "bats" });
  }, 30_000);

  it("runs Bash coverage for script projects when kcov is available", async () => {
    const project = await createBashFixtureProject("aiq-bash-coverage-");
    const hasBats = commandAvailable("bats");
    const hasKcov = commandAvailable("kcov");

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:coverage-bash",
        stageId: "coverage",
      },
      process.cwd(),
    );

    if (!hasBats || !hasKcov) {
      expectBashSetupFailure(result, hasBats ? "kcov" : "bats", project.sourceFile);
      return;
    }

    expect(result.status).toBe("passed");
    expect(result.notes[0]).toContain("Bash coverage lines:");
    expect(result.toolRuns[0]).toMatchObject({ status: "passed", tool: "kcov" });
  }, 30_000);

  it("reports missing kcov as a Bash coverage setup failure", async () => {
    const project = await createBashFixtureProject("aiq-bash-missing-kcov-");

    vi.spyOn(ToolRunner.prototype, "resolveBinaryIfAvailable").mockImplementation(
      async (commands) => {
        if (commands.some((command) => command.includes("bats"))) {
          return "bats";
        }

        if (commands.some((command) => command.includes("kcov"))) {
          return undefined;
        }

        return undefined;
      },
    );

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:coverage-bash-missing-kcov",
        stageId: "coverage",
      },
      process.cwd(),
    );

    expectBashSetupFailure(result, "kcov", project.sourceFile);
    expect(result.notes[0]).toContain("kcov is required for Bash coverage");
    expect(result.notes[0]).toContain("disable Bash coverage");
  });

  it("returns a failed stage result when PSScriptAnalyzer is missing for PowerShell lint", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-powershell-missing-module-"));
    tempDirs.push(tempDir);

    const powerShellFile = path.join(tempDir, "script.ps1");
    await writeFile(powerShellFile, "Write-Host 'hello'\n", "utf8");

    vi.spyOn(ToolRunner.prototype, "resolveRequiredPowerShellModuleManifest").mockRejectedValue(
      new Error(
        "PSScriptAnalyzer was not detected. Install PSScriptAnalyzer to enable this PowerShell stage.",
      ),
    );

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [powerShellFile],
        id: "test:1:lint-powershell-missing-module",
        stageId: "lint",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.notes[0]).toContain("PSScriptAnalyzer was not detected");
    expect(result.diagnostics[0]).toMatchObject({
      file: powerShellFile,
      severity: "error",
      source: "psscriptanalyzer",
    });
    expect(result.toolRuns).toEqual([]);
  });

  it("runs PowerShell lint successfully across multiple selected files", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-powershell-lint-success-"));
    tempDirs.push(tempDir);

    const firstFile = path.join(tempDir, "first.ps1");
    const secondFile = path.join(tempDir, "second.ps1");
    await Promise.all([
      writeFile(firstFile, "Write-Host 'first'\n", "utf8"),
      writeFile(secondFile, "Write-Host 'second'\n", "utf8"),
    ]);

    const toolRunner = new ToolRunner();
    vi.spyOn(toolRunner, "resolveRequiredPowerShellModuleManifest").mockResolvedValue(
      "/tmp/PSScriptAnalyzer.psd1",
    );
    const runSpy = vi
      .spyOn(toolRunner, "runPowerShellScript")
      .mockImplementation(async (script) => {
        expect(script).toContain("$results = foreach ($path in $paths) {");
        expect(script).toContain("Invoke-ScriptAnalyzer -Path $path");
        expect(script).not.toContain("Invoke-ScriptAnalyzer -Path $paths");
        expect(script).toContain(firstFile);
        expect(script).toContain(secondFile);

        const timestamp = new Date().toISOString();
        return {
          durationMs: 5,
          exitCode: 0,
          finishedAt: timestamp,
          startedAt: timestamp,
          stderr: "",
          stdout: "[]",
        };
      });

    const engineContext = withToolRunnerOverride(
      await buildEngineContext({
        context: "cli",
        manifest: {
          files: [firstFile, secondFile],
          source: "direct",
        },
        mode: "check",
        outDir: tempDir,
        stages: ["lint"],
      }),
      toolRunner,
    );

    const result = await runPlannedTask(
      {
        fileCount: 2,
        files: [firstFile, secondFile],
        id: "test:1:lint-powershell-success-multi-file",
        stageId: "lint",
      },
      engineContext,
    );

    expect(result.status).toBe("passed");
    expect(result.diagnostics).toEqual([]);
    expect(result.notes).toEqual(["PSScriptAnalyzer passed."]);
    expect(runSpy).toHaveBeenCalledOnce();
    expect(result.toolRuns[0]).toMatchObject({
      exitCode: 0,
      status: "passed",
      tool: "psscriptanalyzer",
    });
  });

  it("returns a failed stage result when a later selected PowerShell format file cannot be read", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-powershell-missing-format-file-"));
    tempDirs.push(tempDir);

    const existingFile = path.join(tempDir, "existing.ps1");
    const missingFile = path.join(tempDir, "missing.ps1");
    await writeFile(existingFile, "Write-Host 'hello'\n", "utf8");
    await writeFile(missingFile, "Write-Host 'missing'\n", "utf8");
    await rm(missingFile);

    const result = await runPlannedTask(
      {
        fileCount: 2,
        files: [existingFile, missingFile],
        id: "test:1:format-powershell-missing-file",
        stageId: "format",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.notes[0]).toContain("ENOENT");
    expect(result.diagnostics[0]).toMatchObject({
      file: missingFile,
      severity: "error",
      source: "invoke-formatter",
    });
    expect(result.toolRuns).toEqual([]);
  });

  it.each(["unit", "coverage"] as const)(
    "reports missing PowerShell tests as a setup failure for %s",
    async (stageId) => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-powershell-no-tests-"));
      tempDirs.push(tempDir);

      const sourceFile = path.join(tempDir, "utils.ps1");
      await writeFile(sourceFile, "function Invoke-Greeting { 'hello' }\n", "utf8");

      const result = await runPlannedTask(
        {
          fileCount: 1,
          files: [sourceFile],
          id: `test:1:${stageId}-powershell-no-tests`,
          stageId,
        },
        process.cwd(),
      );

      expectPowerShellSetupFailure(result, sourceFile);
      expect(result.notes[0]).toContain("No PowerShell test files were detected");
      expect(result.notes[0]).toContain(`disable PowerShell ${stageId}`);
    },
  );

  it("reports missing Pester as a PowerShell unit setup failure", async () => {
    const project = await createPowerShellFixtureProject("aiq-powershell-missing-pester-");

    vi.spyOn(ToolRunner.prototype, "resolvePowerShellModuleManifest").mockResolvedValue(undefined);

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:unit-powershell-missing-pester",
        stageId: "unit",
      },
      process.cwd(),
    );

    expectPowerShellSetupFailure(result, project.sourceFile);
    expect(result.notes[0]).toContain("Pester is required for PowerShell unit");
    expect(result.notes[0]).toContain("Install Pester");
  });

  it("reports missing PowerShell coverage sources as a setup failure", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-powershell-no-coverage-"));
    tempDirs.push(tempDir);

    const testFile = path.join(tempDir, "utils.tests.ps1");
    await writeFile(
      testFile,
      "Describe 'utils' { It 'passes' { $true | Should -Be $true } }\n",
      "utf8",
    );

    vi.spyOn(ToolRunner.prototype, "resolvePowerShellModuleManifest").mockResolvedValue(
      "/tmp/Pester.psd1",
    );

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [testFile],
        id: "test:1:coverage-powershell-no-sources",
        stageId: "coverage",
      },
      process.cwd(),
    );

    expectPowerShellSetupFailure(result, testFile);
    expect(result.notes[0]).toContain("No PowerShell source files were detected for coverage");
    expect(result.notes[0]).toContain("disable PowerShell coverage");
  });

  it.skipIf(!hasPowerShellPesterToolchain)(
    "runs PowerShell unit tests for script projects when Pester is available",
    async () => {
      const project = await createPowerShellFixtureProject("aiq-powershell-unit-");
      const result = await runPlannedTask(
        {
          fileCount: 1,
          files: [project.sourceFile],
          id: "test:1:unit-powershell",
          stageId: "unit",
        },
        process.cwd(),
      );

      expect(result.status).toBe("passed");
      expect(result.notes[0]).toContain("Pester ran");
      expect(result.toolRuns[0]).toMatchObject({ status: "passed", tool: "pester" });
    },
    60_000,
  );

  it.skipIf(!hasPowerShellPesterToolchain)(
    "runs PowerShell coverage for script projects when Pester is available",
    async () => {
      const project = await createPowerShellFixtureProject("aiq-powershell-coverage-");
      const result = await runPlannedTask(
        {
          fileCount: 1,
          files: [project.sourceFile],
          id: "test:1:coverage-powershell",
          stageId: "coverage",
        },
        process.cwd(),
      );

      expect(result.status).toBe("passed");
      expect(result.notes[0]).toContain("PowerShell coverage lines:");
      expect(result.toolRuns[0]).toMatchObject({ status: "passed", tool: "pester" });
    },
    60_000,
  );

  it("serializes a summarized Pester unit result instead of the raw object", async () => {
    const project = await createPowerShellFixtureProject("aiq-powershell-unit-summary-");
    const toolRunner = new ToolRunner();
    vi.spyOn(toolRunner, "resolvePowerShellModuleManifest").mockResolvedValue("/tmp/Pester.psd1");
    const runSpy = vi
      .spyOn(toolRunner, "runPowerShellScript")
      .mockImplementation(async (script) => {
        expect(script).toContain("TotalCount = $result.TotalCount");
        expect(script).toContain("PassedCount = $result.PassedCount");
        expect(script).toContain("FailedCount = $result.FailedCount");
        expect(script).not.toContain("$result | ConvertTo-Json -Depth 8 -Compress");

        const junitPath = script.match(/OutputPath = '([^']+junit\.xml)'/)?.[1];
        if (junitPath === undefined) {
          throw new Error(`Expected junit output path in script: ${script}`);
        }

        await writeFile(
          junitPath,
          '<testsuite tests="2" failures="0" errors="0" skipped="0"></testsuite>',
          "utf8",
        );

        const timestamp = new Date().toISOString();
        return {
          durationMs: 5,
          exitCode: 0,
          finishedAt: timestamp,
          startedAt: timestamp,
          stderr: "",
          stdout: '{"TotalCount":2,"PassedCount":2,"FailedCount":0}',
        };
      });

    const engineContext = withToolRunnerOverride(
      await buildEngineContext({
        context: "cli",
        manifest: {
          files: [project.sourceFile],
          source: "direct",
        },
        mode: "check",
        outDir: project.root,
        stages: ["unit"],
      }),
      toolRunner,
    );

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:unit-powershell-summary",
        stageId: "unit",
      },
      engineContext,
    );

    expect(result.status).toBe("passed");
    expect(result.diagnostics).toEqual([]);
    expect(result.notes).toEqual(["Pester ran 2 tests: 2 passed, 0 failed."]);
    expect(runSpy).toHaveBeenCalledOnce();
    expect(result.toolRuns[0]).toMatchObject({
      exitCode: 0,
      status: "passed",
      tool: "pester",
    });
  });

  it("serializes a summarized Pester coverage result instead of the raw object", async () => {
    const project = await createPowerShellFixtureProject("aiq-powershell-coverage-summary-");
    const toolRunner = new ToolRunner();
    vi.spyOn(toolRunner, "resolvePowerShellModuleManifest").mockResolvedValue("/tmp/Pester.psd1");
    const runSpy = vi
      .spyOn(toolRunner, "runPowerShellScript")
      .mockImplementation(async (script) => {
        expect(script).toContain("TotalCount = $result.TotalCount");
        expect(script).toContain("PassedCount = $result.PassedCount");
        expect(script).toContain("FailedCount = $result.FailedCount");
        expect(script).not.toContain("$result | ConvertTo-Json -Depth 8 -Compress");

        const junitPath = script.match(/OutputPath = '([^']+junit\.xml)'/)?.[1];
        const coveragePath = script.match(/OutputPath = '([^']+coverage\.xml)'/)?.[1];
        if (junitPath === undefined || coveragePath === undefined) {
          throw new Error(`Expected junit and coverage output paths in script: ${script}`);
        }

        await Promise.all([
          writeFile(
            junitPath,
            '<testsuite tests="2" failures="0" errors="0" skipped="0"></testsuite>',
            "utf8",
          ),
          writeFile(coveragePath, '<coverage line-rate="1"></coverage>', "utf8"),
        ]);

        const timestamp = new Date().toISOString();
        return {
          durationMs: 5,
          exitCode: 0,
          finishedAt: timestamp,
          startedAt: timestamp,
          stderr: "",
          stdout: '{"TotalCount":2,"PassedCount":2,"FailedCount":0}',
        };
      });

    const engineContext = withToolRunnerOverride(
      await buildEngineContext({
        context: "cli",
        manifest: {
          files: [project.sourceFile],
          source: "direct",
        },
        mode: "check",
        outDir: project.root,
        stages: ["coverage"],
      }),
      toolRunner,
    );

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:coverage-powershell-summary",
        stageId: "coverage",
      },
      engineContext,
    );

    expect(result.status).toBe("passed");
    expect(result.diagnostics).toEqual([]);
    expect(result.notes).toEqual(["PowerShell coverage lines: 100.0% across 2 tests."]);
    expect(runSpy).toHaveBeenCalledOnce();
    expect(result.toolRuns[0]).toMatchObject({
      exitCode: 0,
      status: "passed",
      tool: "pester",
    });
  });

  it("runs the shared security scan across the supported source and config file types", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-security-runner-"));
    tempDirs.push(tempDir);

    const flaggedFiles = [
      {
        content: 'export const token = "ghp_123456789012345678901234567890123456";\n',
        name: "secret.ts",
      },
      {
        content: '{"token":"ghp_123456789012345678901234567890123456"}\n',
        name: "secret.json",
      },
      {
        content: 'token = "ghp_123456789012345678901234567890123456"\n',
        name: "secret.py",
      },
      {
        content: 'token="ghp_123456789012345678901234567890123456"\n',
        name: "secret.sh",
      },
      {
        content: '@test "leaks a token" {\n  token="ghp_123456789012345678901234567890123456"\n}\n',
        name: "secret.bats",
      },
      {
        content: '$Token = "ghp_123456789012345678901234567890123456"\n',
        name: "secret.ps1",
      },
      {
        content: '<meta name="token" content="ghp_123456789012345678901234567890123456">\n',
        name: "secret.html",
      },
      {
        content: 'body { --token: "ghp_123456789012345678901234567890123456"; }\n',
        name: "secret.css",
      },
      {
        content: 'token: "ghp_123456789012345678901234567890123456"\n',
        name: "secret.yaml",
      },
      {
        content: 'token: "ghp_123456789012345678901234567890123456"\n',
        name: "secret.yml",
      },
      {
        content:
          "insert into secrets(token) values ('ghp_123456789012345678901234567890123456');\n",
        name: "secret.sql",
      },
      {
        content: 'variable "token" {\n  default = "ghp_123456789012345678901234567890123456"\n}\n',
        name: "secret.tf",
      },
      {
        content: 'token = "ghp_123456789012345678901234567890123456"\n',
        name: "secret.tfvars",
      },
      {
        content: 'token = "ghp_123456789012345678901234567890123456"\n',
        name: "secret.hcl",
      },
    ] as const;
    const flaggedPaths = await Promise.all(
      flaggedFiles.map(async ({ content, name }) => {
        const filePath = path.join(tempDir, name);
        await writeFile(filePath, content, "utf8");
        return filePath;
      }),
    );

    const result = await runPlannedTask(
      {
        fileCount: flaggedPaths.length,
        files: flaggedPaths,
        id: "test:1:security",
        stageId: "security",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        ...flaggedPaths.map((filePath) =>
          expect.objectContaining({ file: filePath, severity: "error", source: "aiq-security" }),
        ),
      ]),
    );
    expect(result.diagnostics).toHaveLength(flaggedPaths.length);
    expect(result.toolRuns[0]).toMatchObject({
      exitCode: 1,
      status: "failed",
      tool: "aiq-security",
    });
  });

  it("fails the shared security scan when a selected file cannot be read", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-security-missing-file-"));
    tempDirs.push(tempDir);

    const missingFile = path.join(tempDir, "missing.ts");
    await writeFile(
      missingFile,
      'export const token = "ghp_123456789012345678901234567890123456";\n',
      "utf8",
    );
    await rm(missingFile);

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [missingFile],
        id: "test:1:security-missing-file",
        stageId: "security",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.toolRuns).toEqual([]);
    expect(result.notes[0]).toContain("ENOENT");
    expect(result.diagnostics[0]).toMatchObject({
      file: missingFile,
      severity: "error",
      source: "aiq-security",
    });
  });

  it("fails e2e setup when selected TypeScript project has no e2e runner", async () => {
    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [fixtureFile],
        id: "test:1:e2e",
        stageId: "e2e",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.toolRuns).toEqual([]);
    expect(result.notes[0]).toContain("No e2e runner is configured");
    expect(result.diagnostics[0]).toMatchObject({
      severity: "error",
      source: "aiq-e2e",
    });
  });
});
