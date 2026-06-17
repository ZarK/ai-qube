import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AiqEngineCancelledError,
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

const fixtureFile = path.resolve("test-projects/typescript/src/index.ts");
const lintFailureFixtureFile = path.resolve("test-projects/typescript/src/lint-failure.ts");
const fixtureJavaScriptFile = path.resolve("test-projects/javascript/index.js");
const fixtureJavaScriptRoot = path.resolve("test-projects/javascript");
const fixtureBashRoot = path.resolve("test-projects/bash");
const fixtureDotNetRoot = path.resolve("test-projects/dotnet");
const fixtureGoRoot = path.resolve("test-projects/go");
const fixtureHclRoot = path.resolve("test-projects/hcl");
const fixtureHtmlFile = path.resolve("test-projects/html-css/index.html");
const fixtureCssFile = path.resolve("test-projects/html-css/styles.css");
const fixtureJavaMavenRoot = path.resolve("test-projects/java-maven");
const fixtureKotlinGradleRoot = path.resolve("test-projects/kotlin-gradle");
const fixturePowerShellRoot = path.resolve("test-projects/powershell");
const fixturePythonFile = path.resolve("test-projects/python/main.py");
const fixtureRustRoot = path.resolve("test-projects/rust");
const fixtureSqlFile = path.resolve("test-projects/sql/query.sql");
const fixtureTerraformRoot = path.resolve("test-projects/terraform");
const fixtureTypeScriptRoot = path.resolve("test-projects/typescript");
const fixtureYamlFile = path.resolve("test-projects/yaml/config.yaml");

async function withExclusiveRust<T>(run: () => Promise<T>): Promise<T> {
  return withExclusiveToolLock("rust", run);
}

async function createDotNetFixtureProject(
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

async function createGoFixtureProject(
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

async function createBashFixtureProject(
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

async function createJavaScriptFixtureProject(
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

async function createRustFixtureProject(
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

async function createPowerShellFixtureProject(
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

async function resolvePowerShellModuleAvailable(moduleName: string): Promise<boolean> {
  const toolRunner = new ToolRunner();
  return (await toolRunner.resolvePowerShellModuleManifest(moduleName)) !== undefined;
}

async function createJavaMavenFixtureProject(
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

async function createKotlinGradleFixtureProject(
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

async function createTypeScriptFixtureProject(
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

function createToolRunOutcome(overrides: Partial<ToolRunOutcome> = {}): ToolRunOutcome {
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

function createLargeJavaScriptModule(index: number): string {
  return Array.from(
    { length: 2_000 },
    (_, offset) =>
      `export function generated${index}_${offset}(value) { return value + ${offset}; }`,
  ).join("\n");
}

function createTypeScriptWorkloadModule(index: number): string {
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

function createAbortError(): Error {
  const error = new Error("simulated abort");
  error.name = "AbortError";
  return error;
}

async function createTerraformHclFixtureProject(
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

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("engine foundation", () => {
  it.skipIf(!hasPythonPytestToolchain)(
    "keeps marker-only Python e2e placeholders out of default pytest collection",
    () => {
      const output = execFileSync(
        resolvePythonCommand(),
        ["-m", "pytest", "--collect-only", "-q"],
        {
          cwd: path.resolve("test-projects/python"),
          encoding: "utf8",
          env: { ...process.env, PYTEST_DISABLE_PLUGIN_AUTOLOAD: "1" },
        },
      );

      expect(output).not.toContain("tests/e2e");
      expect(output).toContain("tests/test_main.py::test_greet");
      expect(output).toContain("tests/test_main.py::test_calculate_sum");
      expect(output).toContain("tests/test_main.py::test_main_execution");
      expect(output).toContain("3 tests collected");
    },
  );

  it("normalizes and de-duplicates manifest paths", async () => {
    const manifest = await normalizeFileManifest(
      {
        files: ["test-projects/typescript/src/index.ts", fixtureFile],
        source: "mixed",
      },
      process.cwd(),
    );

    expect(manifest.entries).toEqual([
      {
        extension: ".ts",
        path: fixtureFile,
      },
    ]);
    expect(manifest.files).toEqual([fixtureFile]);
    expect(manifest.source).toBe("mixed");
    expect(manifest.summary.fileCount).toBe(1);
  });

  it("resolves adapter-agnostic run requests", async () => {
    const request = await resolveRunRequest({
      context: "cli",
      cwd: ".",
      manifest: {
        files: [fixtureFile],
        source: "direct",
      },
      mode: "check",
      stages: ["lint"],
      profile: "fast",
    });

    expect(request.context).toBe("cli");
    expect(request.cwd).toBe(process.cwd());
    expect(request.manifest.root).toBe(process.cwd());
    expect(request.manifest.summary.fileCount).toBe(1);
    expect(request.outDir).toBe(path.resolve(process.cwd(), ".aiq/out"));
    expect(request.selection).toEqual({
      stages: ["lint"],
      profile: "fast",
    });
  });

  it("defaults unresolved run requests to the serve context", async () => {
    const request = await resolveRunRequest({
      cwd: ".",
      manifest: {
        files: [fixtureFile],
        source: "direct",
      },
      mode: "check",
      stages: ["lint"],
    });

    expect(request.context).toBe("serve");
  });

  it("preserves stage configurations on resolved run requests", async () => {
    const request = await resolveRunRequest({
      context: "cli",
      cwd: ".",
      manifest: {
        files: [fixtureFile],
        source: "direct",
      },
      mode: "check",
      stages: ["lint"],
      stageConfigurations: {
        lint: {
          languages: {
            typescript: {
              toolId: "biome",
            },
          },
        },
      },
      profile: "fast",
    });

    expect(request.selection.stageConfigurations).toEqual({
      lint: {
        languages: {
          typescript: {
            toolId: "biome",
          },
        },
      },
    });
  });

  it("creates a versioned plan with requested stages", async () => {
    const plan = await createRunPlan({
      context: "cli",
      manifest: {
        files: [fixtureFile],
        source: "direct",
      },
      mode: "plan",
      stages: ["lint"],
      profile: "fast",
    });

    expect(plan.artifactType).toBe("plan");
    expect(plan.artifactVersion).toBe(1);
    expect(plan.artifacts.outDir).toBe(path.resolve(process.cwd(), ".aiq/out"));
    expect(plan.context).toBe("cli");
    expect(plan.engineVersion).toBe("0.0.0");
    expect(plan.input.files).toEqual([fixtureFile]);
    expect(plan.input.summary.fileCount).toBe(1);
    expect(plan.stages).toEqual(["lint"]);
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0]).toMatchObject({
      fileCount: 1,
      stageId: "lint",
    });
    expect(plan.summary).toEqual({
      fileCount: 1,
      stageCount: 1,
      taskCount: 1,
    });
  });

  it("writes canonical plan and report artifacts", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-engine-"));
    tempDirs.push(tempDir);

    const result = await runEngine({
      context: "cli",
      manifest: {
        files: [lintFailureFixtureFile],
        source: "direct",
      },
      mode: "check",
      outDir: tempDir,
      stages: ["lint"],
    });

    expect(result.artifactType).toBe("report");
    expect(result.artifactVersion).toBe(1);
    expect(result.context).toBe("cli");
    expect(result.engineVersion).toBe("0.0.0");
    expect(result.runId).toBe(result.plan.runId);
    expect(result.artifacts.metricsPath).toBeDefined();
    expect(result.artifacts.planPath).toBeDefined();
    expect(result.artifacts.reportPath).toBeDefined();
    expect(result.artifacts.outDir).toBe(tempDir);
    expect(result.plan.artifacts.outDir).toBe(tempDir);
    expect(result.request.context).toBe("cli");
    expect(result.request.outDir).toBe(tempDir);
    expect(result.request).not.toHaveProperty("graph");
    expect(result.request).not.toHaveProperty("cache");
    expect(result.ok).toBe(false);
    expect(result.summary.diagnosticCount).toBeGreaterThan(0);
    expect(result.summary.fileCount).toBe(1);
    expect(result.summary.notImplementedStageCount).toBe(0);
    expect(result.summary.status).toBe("failed");
    expect(result.summary.taskCount).toBe(1);
    expect(result.stages[0]).toMatchObject({
      stageId: "lint",
      status: "failed",
    });
    expect(result.stages[0]?.diagnostics[0]).toMatchObject({
      file: lintFailureFixtureFile,
      severity: "error",
      source: "biome",
    });
    expect(result.stages[0]?.toolRuns[0]).toMatchObject({
      exitCode: 1,
      finishedAt: expect.any(String),
      startedAt: expect.any(String),
      status: "failed",
      tool: "biome",
    });

    const { metricsPath, planPath, reportPath } = result.artifacts;
    if (planPath === undefined || reportPath === undefined || metricsPath === undefined) {
      throw new Error("Expected plan, report, and metrics artifacts to be written.");
    }

    const planJson = JSON.parse(await readFile(planPath, "utf8")) as {
      artifactType: string;
      artifactVersion: number;
      artifacts: { outDir: string };
      context: string;
      engineVersion: string;
      stages: string[];
      summary: { taskCount: number };
    };
    const reportJson = JSON.parse(await readFile(reportPath, "utf8")) as {
      artifactType: string;
      artifactVersion: number;
      artifacts: { outDir: string; reportPath: string };
      context: string;
      request: { context: string; outDir: string };
      summary: { fileCount: number; status: string };
    };
    const metricsEvents = (await readFile(metricsPath, "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            artifact?: string;
            artifactPath?: string;
            event: string;
            timestamp?: string;
          },
      );

    expect(planJson.artifactType).toBe("plan");
    expect(planJson.artifactVersion).toBe(1);
    expect(planJson.artifacts.outDir).toBe(tempDir);
    expect(planJson.context).toBe("cli");
    expect(planJson.engineVersion).toBe("0.0.0");
    expect(planJson.stages).toEqual(["lint"]);
    expect(planJson.summary.taskCount).toBe(1);
    expect(reportJson.artifactType).toBe("report");
    expect(reportJson.artifactVersion).toBe(1);
    expect(reportJson.artifacts.outDir).toBe(tempDir);
    expect(reportJson.artifacts.reportPath).toBe(reportPath);
    expect(reportJson.context).toBe("cli");
    expect(reportJson.request.context).toBe("cli");
    expect(reportJson.request.outDir).toBe(tempDir);
    expect(reportJson.request).not.toHaveProperty("graph");
    expect(reportJson.request).not.toHaveProperty("cache");
    expect(reportJson.summary.fileCount).toBe(1);
    expect(reportJson.summary.status).toBe("failed");
    expect(
      metricsEvents
        .filter((event) => event.event === "artifact.written")
        .map((event) => event.artifact),
    ).toEqual(["plan", "report", "metrics"]);
    expect(metricsEvents[metricsEvents.length - 1]).toMatchObject({
      artifact: "metrics",
      artifactPath: metricsPath,
      event: "artifact.written",
    });
    expect(metricsEvents.find((event) => event.event === "tool.finished")?.timestamp).toBe(
      result.stages[0]?.toolRuns[0]?.finishedAt,
    );
    expect(
      metricsEvents.findIndex(
        (event) => event.event === "artifact.written" && event.artifact === "plan",
      ),
    ).toBeLessThan(metricsEvents.findIndex((event) => event.event === "run.finished"));
    expect(
      metricsEvents.findIndex(
        (event) => event.event === "artifact.written" && event.artifact === "report",
      ),
    ).toBeLessThan(
      metricsEvents.findIndex(
        (event) => event.event === "artifact.written" && event.artifact === "metrics",
      ),
    );
  });

  it("writes report artifacts to the requested outDir even if the result carries another path", async () => {
    const outDir = await mkdtemp(path.join(os.tmpdir(), "aiq-engine-"));
    const overrideDir = await mkdtemp(path.join(os.tmpdir(), "aiq-engine-override-"));
    tempDirs.push(outDir, overrideDir);

    const result = await runEngine({
      context: "cli",
      manifest: {
        files: [lintFailureFixtureFile],
        source: "direct",
      },
      mode: "check",
      outDir,
      stages: ["lint"],
      writeArtifacts: false,
    });

    const overridePath = path.join(overrideDir, "override.report.json");
    const writtenPath = await writeReportArtifact(
      {
        ...result,
        artifacts: {
          ...result.artifacts,
          reportPath: overridePath,
        },
      },
      outDir,
    );

    expect(writtenPath).toBe(path.join(outDir, "aiq.report.json"));
    const reportJson = JSON.parse(await readFile(writtenPath, "utf8")) as {
      artifacts: { reportPath: string };
    };
    expect(reportJson.artifacts.reportPath).toBe(writtenPath);
    await expect(readFile(overridePath, "utf8")).rejects.toThrow();
  });

  it("runs TypeScript typecheck against the fixture project", async () => {
    const result = await runEngine({
      context: "cli",
      manifest: {
        files: [fixtureFile],
        source: "direct",
      },
      mode: "check",
      stages: ["typecheck"],
      writeArtifacts: false,
    });

    expect(result.ok).toBe(true);
    expect(result.summary.diagnosticCount).toBe(0);
    expect(result.summary.notImplementedStageCount).toBe(0);
    expect(result.summary.status).toBe("passed");
    expect(result.stages).toHaveLength(1);
    expect(result.stages[0]).toMatchObject({
      stageId: "typecheck",
      status: "passed",
    });
    expect(result.stages[0]?.toolRuns[0]).toMatchObject({
      exitCode: 0,
      status: "passed",
      tool: "tsc",
    });
  });

  it("reports missing bundled TypeScript runner as setup guidance", async () => {
    const { root, sourceFile } = await createTypeScriptFixtureProject(
      "aiq-engine-ts-missing-runner-",
    );
    vi.spyOn(ToolRunner.prototype, "runNodeTool").mockResolvedValueOnce(
      createToolRunOutcome({ exitCode: undefined }),
    );

    const result = await runEngine({
      context: "cli",
      cwd: root,
      manifest: {
        files: [sourceFile],
        source: "direct",
      },
      mode: "check",
      stages: ["typecheck"],
      writeArtifacts: false,
    });

    const diagnostic = result.stages[0]?.diagnostics[0];

    expect(result.ok).toBe(false);
    expect(result.stages[0]).toMatchObject({
      stageId: "typecheck",
      status: "failed",
    });
    expect(diagnostic).toMatchObject({
      source: "tsc",
      message: expect.stringContaining("Run aiq setup"),
    });
    expect(diagnostic?.message).not.toContain("spawn");
  });

  it("runs lint, format, unit, coverage, and security against JavaScript and TypeScript fixtures", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-engine-jsonc-"));
    tempDirs.push(tempDir);
    const jsoncFile = path.join(tempDir, "config.jsonc");
    await writeFile(jsoncFile, '{"name" :"typescript-fixture" ,"enabled" :true}\n', "utf8");

    const result = await runEngine({
      context: "cli",
      manifest: {
        files: [fixtureFile, fixtureJavaScriptFile, jsoncFile],
        source: "mixed",
      },
      mode: "check",
      stages: ["format", "unit", "coverage", "security"],
      writeArtifacts: false,
    });

    expect(result.ok).toBe(false);
    expect(result.summary.notImplementedStageCount).toBe(0);
    expect(result.summary.status).toBe("failed");
    expect(result.stages).toHaveLength(4);
    expect(result.stages.find((stage) => stage.stageId === "format")).toMatchObject({
      stageId: "format",
      status: "failed",
    });
    expect(result.stages.find((stage) => stage.stageId === "unit")).toMatchObject({
      stageId: "unit",
      status: "passed",
    });
    const unitStage = result.stages.find((stage) => stage.stageId === "unit");
    expect(unitStage?.toolRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "passed", tool: "vitest" }),
        expect.objectContaining({ status: "passed", tool: "jest" }),
      ]),
    );

    const coverageStage = result.stages.find((stage) => stage.stageId === "coverage");
    expect(coverageStage).toMatchObject({
      stageId: "coverage",
      status: "passed",
    });
    expect(coverageStage?.toolRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "passed", tool: "vitest" }),
        expect.objectContaining({ status: "passed", tool: "jest" }),
      ]),
    );
    expect(result.stages.find((stage) => stage.stageId === "security")).toMatchObject({
      stageId: "security",
      status: "passed",
    });
  });

  it("uses configured stage language selections to limit shared JavaScript runners", async () => {
    const result = await runEngine({
      context: "cli",
      manifest: {
        files: [fixtureFile, fixtureJavaScriptFile],
        source: "mixed",
      },
      mode: "check",
      stages: ["unit"],
      stageConfigurations: {
        unit: {
          languages: {
            typescript: {
              toolId: "javascript",
            },
          },
        },
      },
      writeArtifacts: false,
    });

    const unitStage = result.stages.find((stage) => stage.stageId === "unit");

    expect(result.ok).toBe(true);
    expect(unitStage).toMatchObject({ stageId: "unit", status: "passed" });
    expect(unitStage?.toolRuns).toEqual([
      expect.objectContaining({ exitCode: 0, status: "passed", tool: "vitest" }),
    ]);
    expect(unitStage?.notes.join(" ")).toContain("Vitest ran");
    expect(unitStage?.notes.join(" ")).not.toContain("Jest ran");
  });

  it("reports missing project-managed JavaScript runner as setup guidance", async () => {
    const { root, sourceFile } = await createJavaScriptFixtureProject(
      "aiq-engine-js-missing-runner-",
    );
    vi.spyOn(ToolRunner.prototype, "run").mockResolvedValueOnce(
      createToolRunOutcome({ exitCode: undefined }),
    );

    const result = await runEngine({
      context: "cli",
      cwd: root,
      manifest: {
        files: [sourceFile],
        source: "direct",
      },
      mode: "check",
      stages: ["unit"],
      writeArtifacts: false,
    });

    const diagnostic = result.stages[0]?.diagnostics[0];

    expect(result.ok).toBe(false);
    expect(result.stages[0]).toMatchObject({
      stageId: "unit",
      status: "failed",
    });
    expect(diagnostic).toMatchObject({
      source: "jest",
      message: expect.stringContaining("Run aiq setup"),
    });
    expect(diagnostic?.message).not.toContain("spawn");
  });

  it("keeps configured Biome language selections while including shared JSON inputs", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-engine-biome-configured-"));
    tempDirs.push(tempDir);
    const javaScriptFile = path.join(tempDir, "bad.js");
    const jsoncFile = path.join(tempDir, "config.jsonc");
    await writeFile(javaScriptFile, "var value = 1;\n", "utf8");
    await writeFile(jsoncFile, '{"name":"typescript-fixture"}\n', "utf8");

    const result = await runEngine({
      context: "cli",
      manifest: {
        files: [fixtureFile, fixtureJavaScriptFile, javaScriptFile, jsoncFile],
        source: "mixed",
      },
      mode: "check",
      stages: ["lint"],
      stageConfigurations: {
        lint: {
          languages: {
            typescript: {
              toolId: "biome",
            },
          },
        },
      },
      writeArtifacts: false,
    });

    const lintStage = result.stages.find((stage) => stage.stageId === "lint");

    expect(lintStage).toMatchObject({ stageId: "lint" });
    expect(lintStage?.diagnostics.map((diagnostic) => diagnostic.file)).not.toContain(
      javaScriptFile,
    );
    expect(lintStage?.toolRuns[0]?.args).toContain(fixtureFile);
    expect(lintStage?.toolRuns[0]?.args).toContain(jsoncFile);
    expect(lintStage?.toolRuns[0]?.args).not.toContain(fixtureJavaScriptFile);
    expect(lintStage?.toolRuns[0]?.args).not.toContain(javaScriptFile);
  });

  it("treats configured stages with no enabled languages as a noop instead of not implemented", async () => {
    const result = await runEngine({
      context: "cli",
      manifest: {
        files: [fixtureFile],
        source: "direct",
      },
      mode: "check",
      stages: ["lint"],
      stageConfigurations: {
        lint: {
          languages: {},
        },
      },
      writeArtifacts: false,
    });

    expect(result.ok).toBe(true);
    expect(result.summary.notImplementedStageCount).toBe(0);
    expect(result.summary.status).toBe("passed");
    expect(result.stages).toEqual([
      expect.objectContaining({
        diagnostics: [],
        stageId: "lint",
        status: "passed",
        toolRuns: [],
      }),
    ]);
    expect(result.stages[0]?.notes).toEqual(["No supported files were selected for lint."]);
  });

  it("preserves package.json selections for configured TypeScript JavaScript runners", async () => {
    const result = await runEngine({
      context: "cli",
      cwd: fixtureTypeScriptRoot,
      manifest: {
        files: [path.join(fixtureTypeScriptRoot, "package.json")],
        source: "direct",
      },
      mode: "check",
      stages: ["unit"],
      stageConfigurations: {
        unit: {
          languages: {
            typescript: {
              toolId: "javascript",
            },
          },
        },
      },
      writeArtifacts: false,
    });

    const unitStage = result.stages.find((stage) => stage.stageId === "unit");

    expect(result.ok).toBe(true);
    expect(unitStage).toMatchObject({ stageId: "unit", status: "passed" });
    expect(unitStage?.toolRuns).toEqual([
      expect.objectContaining({ exitCode: 0, status: "passed", tool: "vitest" }),
    ]);
    expect(unitStage?.notes.join(" ")).toContain("Vitest ran");
  });

  it.skipIf(!hasGradleToolchain)(
    "preserves JVM settings files for configured Kotlin runners",
    async () => {
      const project = await createKotlinGradleFixtureProject(
        "aiq-engine-kotlin-settings-selection-",
      );

      const result = await runEngine({
        context: "cli",
        cwd: project.root,
        manifest: {
          files: [path.join(project.root, "settings.gradle.kts")],
          source: "direct",
        },
        mode: "check",
        stages: ["unit"],
        stageConfigurations: {
          unit: {
            languages: {
              kotlin: {
                toolId: "jvm",
              },
            },
          },
        },
        writeArtifacts: false,
      });

      const unitStage = result.stages.find((stage) => stage.stageId === "unit");

      expect(result.ok).toBe(true);
      expect(unitStage).toMatchObject({ stageId: "unit", status: "passed" });
      expect(unitStage?.toolRuns).toEqual([
        expect.objectContaining({ exitCode: 0, status: "passed", tool: "gradle-test" }),
      ]);
      expect(unitStage?.notes.join(" ")).toContain("Gradle test ran");
    },
    120_000,
  );

  it("runs document stages against fixture projects and writes canonical artifacts", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-engine-documents-"));
    tempDirs.push(tempDir);

    const fixtureFiles = [fixtureHtmlFile, fixtureCssFile, fixtureYamlFile, fixtureSqlFile];
    const result = await runEngine({
      context: "cli",
      manifest: {
        files: fixtureFiles,
        source: "mixed",
      },
      mode: "check",
      outDir: tempDir,
      stages: ["lint", "format", "security"],
    });

    expect(result.ok).toBe(true);
    expect(result.artifacts.metricsPath).toBeDefined();
    expect(result.artifacts.planPath).toBeDefined();
    expect(result.artifacts.reportPath).toBeDefined();
    expect(result.summary.diagnosticCount).toBe(0);
    expect(result.summary.notImplementedStageCount).toBe(0);
    expect(result.summary.status).toBe("passed");
    expect(result.stages).toHaveLength(3);

    const lintStage = result.stages.find((stage) => stage.stageId === "lint");
    const formatStage = result.stages.find((stage) => stage.stageId === "format");
    const securityStage = result.stages.find((stage) => stage.stageId === "security");

    expect(lintStage).toMatchObject({ stageId: "lint", status: "passed" });
    expect(lintStage?.toolRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ exitCode: 0, status: "passed", tool: "htmlhint" }),
        expect.objectContaining({ exitCode: 0, status: "passed", tool: "stylelint" }),
        expect.objectContaining({ exitCode: 0, status: "passed", tool: "yaml" }),
        expect.objectContaining({ exitCode: 0, status: "passed", tool: "node-sql-parser" }),
      ]),
    );

    expect(formatStage).toMatchObject({ stageId: "format", status: "passed" });
    expect(formatStage?.toolRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ exitCode: 0, status: "passed", tool: "prettier" }),
        expect.objectContaining({ exitCode: 0, status: "passed", tool: "sql-formatter" }),
      ]),
    );
    expect(formatStage?.toolRuns.find((toolRun) => toolRun.tool === "sql-formatter")).toMatchObject(
      {
        args: [fixtureSqlFile],
        exitCode: 0,
        status: "passed",
        tool: "sql-formatter",
      },
    );

    expect(securityStage).toMatchObject({ stageId: "security", status: "passed" });
    expect(securityStage?.toolRuns[0]).toMatchObject({
      exitCode: 0,
      status: "passed",
      tool: "aiq-security",
    });

    const { metricsPath, planPath, reportPath } = result.artifacts;
    if (planPath === undefined || reportPath === undefined || metricsPath === undefined) {
      throw new Error("Expected plan, report, and metrics artifacts to be written.");
    }

    const planJson = JSON.parse(await readFile(planPath, "utf8")) as {
      input: { files: string[] };
      stages: string[];
    };
    const reportJson = JSON.parse(await readFile(reportPath, "utf8")) as {
      stages: Array<{
        stageId: string;
        status: string;
        toolRuns: Array<{ status: string; tool: string }>;
      }>;
      summary: { diagnosticCount: number; notImplementedStageCount: number; status: string };
    };
    const metricsEvents = (await readFile(metricsPath, "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            event: string;
            stageId?: string;
            tool?: string;
          },
      );

    expect(planJson.input.files).toEqual([...fixtureFiles].sort());
    expect(planJson.stages).toEqual(["lint", "format", "security"]);
    expect(reportJson.summary.diagnosticCount).toBe(0);
    expect(reportJson.summary.notImplementedStageCount).toBe(0);
    expect(reportJson.summary.status).toBe("passed");
    expect(reportJson.stages.find((stage) => stage.stageId === "format")?.toolRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "passed", tool: "prettier" }),
        expect.objectContaining({ status: "passed", tool: "sql-formatter" }),
      ]),
    );
    expect(metricsEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "tool.finished", stageId: "lint", tool: "htmlhint" }),
        expect.objectContaining({ event: "tool.finished", stageId: "lint", tool: "stylelint" }),
        expect.objectContaining({ event: "tool.finished", stageId: "lint", tool: "yaml" }),
        expect.objectContaining({
          event: "tool.finished",
          stageId: "lint",
          tool: "node-sql-parser",
        }),
        expect.objectContaining({ event: "tool.finished", stageId: "format", tool: "prettier" }),
        expect.objectContaining({
          event: "tool.finished",
          stageId: "format",
          tool: "sql-formatter",
        }),
      ]),
    );
  });

  it("runs shared metrics stages against JavaScript and TypeScript fixtures", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-engine-js-metrics-"));
    tempDirs.push(tempDir);

    const result = await runEngine({
      context: "cli",
      manifest: {
        files: [fixtureFile, fixtureJavaScriptFile],
        source: "mixed",
      },
      mode: "check",
      outDir: tempDir,
      stages: ["sloc", "complexity", "maintainability"],
    });

    expect(result.ok).toBe(true);
    expect(result.summary.cacheHitCount).toBe(4);
    expect(result.summary.cacheMissCount).toBe(2);
    expect(result.summary.diagnosticCount).toBe(0);
    expect(result.summary.notImplementedStageCount).toBe(0);
    expect(result.summary.status).toBe("passed");
    expect(result.stages).toHaveLength(3);

    const slocStage = result.stages.find((stage) => stage.stageId === "sloc");
    const complexityStage = result.stages.find((stage) => stage.stageId === "complexity");
    const maintainabilityStage = result.stages.find((stage) => stage.stageId === "maintainability");
    const slocLizardRuns =
      slocStage?.toolRuns.filter(
        (toolRun) =>
          toolRun.cacheHit === false &&
          toolRun.exitCode === 0 &&
          toolRun.status === "passed" &&
          toolRun.tool === "lizard",
      ) ?? [];
    const complexityLizardRuns =
      complexityStage?.toolRuns.filter(
        (toolRun) =>
          toolRun.cacheHit === true &&
          toolRun.exitCode === 0 &&
          toolRun.status === "passed" &&
          toolRun.tool === "lizard",
      ) ?? [];
    const maintainabilityLizardRuns =
      maintainabilityStage?.toolRuns.filter(
        (toolRun) =>
          toolRun.cacheHit === true &&
          toolRun.exitCode === 0 &&
          toolRun.status === "passed" &&
          toolRun.tool === "lizard",
      ) ?? [];

    expect(slocStage?.notes[0]).toContain("JavaScript/TypeScript SLOC:");
    expect(slocLizardRuns).toHaveLength(2);
    expect(complexityStage?.notes[0]).toContain("Shared metrics observed");
    expect(complexityStage?.notes.join(" ")).toContain(
      "Reused cached JavaScript/TypeScript metrics",
    );
    expect(complexityLizardRuns).toHaveLength(2);
    expect(maintainabilityStage?.notes.join(" ")).toContain(
      "Reused cached JavaScript/TypeScript metrics",
    );
    expect(maintainabilityLizardRuns).toHaveLength(2);

    const { metricsPath, planPath, reportPath } = result.artifacts;
    if (planPath === undefined || reportPath === undefined || metricsPath === undefined) {
      throw new Error("Expected plan, report, and metrics artifacts to be written.");
    }

    const planJson = JSON.parse(await readFile(planPath, "utf8")) as {
      input: { files: string[] };
      stages: string[];
    };
    const reportJson = JSON.parse(await readFile(reportPath, "utf8")) as {
      stages: Array<{
        notes: string[];
        stageId: string;
        toolRuns: Array<{ cacheHit?: boolean; tool: string }>;
      }>;
      summary: {
        cacheHitCount: number;
        cacheMissCount: number;
        diagnosticCount: number;
        status: string;
      };
    };
    const metricsEvents = (await readFile(metricsPath, "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            cacheHit?: boolean;
            event: string;
            stageId?: string;
            tool?: string;
          },
      );

    expect(planJson.input.files).toEqual([fixtureJavaScriptFile, fixtureFile]);
    expect(planJson.stages).toEqual(["sloc", "complexity", "maintainability"]);
    expect(reportJson.summary.cacheHitCount).toBe(4);
    expect(reportJson.summary.cacheMissCount).toBe(2);
    expect(reportJson.summary.diagnosticCount).toBe(0);
    expect(reportJson.summary.status).toBe("passed");
    expect(
      reportJson.stages.find((stage) => stage.stageId === "maintainability")?.notes.join(" "),
    ).toContain("Reused cached JavaScript/TypeScript metrics");
    expect(metricsEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cacheHit: true,
          event: "cache.hit",
          stageId: "complexity",
          tool: "lizard",
        }),
        expect.objectContaining({
          cacheHit: true,
          event: "cache.hit",
          stageId: "maintainability",
          tool: "lizard",
        }),
      ]),
    );
  });

  it("runs Terraform and HCL stages against fixture projects and writes canonical artifacts", async () => {
    const project = await createTerraformHclFixtureProject("aiq-engine-terraform-hcl-");
    const hasTerraform = commandAvailable("terraform");
    const outDir = path.join(project.root, ".aiq-out");

    const result = await runEngine({
      context: "cli",
      manifest: {
        files: [project.terraformFile, project.hclFile],
        source: "mixed",
      },
      mode: "check",
      outDir,
      stages: ["lint", "format", "typecheck", "security"],
    });

    expect(result.artifacts.metricsPath).toBeDefined();
    expect(result.artifacts.planPath).toBeDefined();
    expect(result.artifacts.reportPath).toBeDefined();
    expect(result.summary.diagnosticCount).toBe(0);
    expect(result.stages).toHaveLength(4);

    const lintStage = result.stages.find((stage) => stage.stageId === "lint");
    const formatStage = result.stages.find((stage) => stage.stageId === "format");
    const typecheckStage = result.stages.find((stage) => stage.stageId === "typecheck");
    const securityStage = result.stages.find((stage) => stage.stageId === "security");

    if (hasTerraform) {
      expect(result.ok).toBe(true);
      expect(result.summary.notImplementedStageCount).toBe(0);
      expect(result.summary.status).toBe("passed");
      expect(lintStage?.status).toBe("passed");
      expect(lintStage?.toolRuns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ cacheHit: false, status: "passed", tool: "terraform-init" }),
          expect.objectContaining({
            cacheHit: false,
            status: "passed",
            tool: "terraform-validate",
          }),
          expect.objectContaining({
            cacheHit: false,
            status: "passed",
            tool: "terraform-hcl-lint",
          }),
        ]),
      );
      expect(formatStage?.status).toBe("passed");
      expect(formatStage?.toolRuns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ status: "passed", tool: "terraform-fmt" }),
          expect.objectContaining({ status: "passed", tool: "terraform-hcl-format" }),
        ]),
      );
      expect(typecheckStage?.status).toBe("passed");
      expect(typecheckStage?.notes.join(" ")).toContain("Reused cached Terraform validation");
      expect(typecheckStage?.toolRuns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ cacheHit: true, status: "passed", tool: "terraform-init" }),
          expect.objectContaining({
            cacheHit: true,
            status: "passed",
            tool: "terraform-validate",
          }),
        ]),
      );
      expect(securityStage?.toolRuns[0]).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "aiq-security",
      });
    } else {
      expect(result.ok).toBe(false);
      expect(result.summary.notImplementedStageCount).toBe(3);
      expect(result.summary.status).toBe("not_implemented");
      expect(lintStage?.status).toBe("not_implemented");
      expect(formatStage?.status).toBe("not_implemented");
      expect(typecheckStage?.status).toBe("not_implemented");
      expect(securityStage?.status).toBe("passed");
    }

    const { metricsPath, planPath, reportPath } = result.artifacts;
    if (planPath === undefined || reportPath === undefined || metricsPath === undefined) {
      throw new Error("Expected plan, report, and metrics artifacts to be written.");
    }

    const planJson = JSON.parse(await readFile(planPath, "utf8")) as {
      input: { files: string[] };
      stages: string[];
    };
    const reportJson = JSON.parse(await readFile(reportPath, "utf8")) as {
      stages: Array<{
        notes: string[];
        stageId: string;
        status: string;
        toolRuns: Array<{ cacheHit?: boolean; tool: string }>;
      }>;
      summary: { diagnosticCount: number; notImplementedStageCount: number; status: string };
    };
    const metricsEvents = (await readFile(metricsPath, "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            cacheHit?: boolean;
            event: string;
            stageId?: string;
            tool?: string;
          },
      );

    expect(planJson.input.files).toEqual([project.hclFile, project.terraformFile]);
    expect(planJson.stages).toEqual(["lint", "format", "typecheck", "security"]);

    if (hasTerraform) {
      expect(reportJson.summary.diagnosticCount).toBe(0);
      expect(reportJson.summary.notImplementedStageCount).toBe(0);
      expect(reportJson.summary.status).toBe("passed");
      expect(
        reportJson.stages.find((stage) => stage.stageId === "typecheck")?.notes.join(" "),
      ).toContain("Reused cached Terraform validation");
      expect(metricsEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            cacheHit: true,
            event: "cache.hit",
            stageId: "typecheck",
            tool: "terraform-validate",
          }),
        ]),
      );
    } else {
      expect(reportJson.summary.notImplementedStageCount).toBe(3);
      expect(reportJson.summary.status).toBe("not_implemented");
    }
  }, 20_000);

  it.skipIf(!hasPythonQualityToolchain)(
    "runs Python stages against the fixture project and writes canonical artifacts",
    async () => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-engine-python-"));
      tempDirs.push(tempDir);

      const result = await runEngine({
        context: "cli",
        manifest: {
          files: [fixturePythonFile],
          source: "direct",
        },
        mode: "check",
        outDir: tempDir,
        stages: [
          "lint",
          "format",
          "typecheck",
          "unit",
          "coverage",
          "complexity",
          "maintainability",
          "security",
        ],
      });

      expect(result.ok).toBe(true);
      expect(result.artifacts.metricsPath).toBeDefined();
      expect(result.artifacts.planPath).toBeDefined();
      expect(result.artifacts.reportPath).toBeDefined();
      expect(result.summary.diagnosticCount).toBe(0);
      expect(result.summary.notImplementedStageCount).toBe(0);
      expect(result.summary.status).toBe("passed");
      expect(result.stages).toHaveLength(8);
      expect(result.stages.find((stage) => stage.stageId === "lint")?.toolRuns[0]).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "ruff",
      });
      expect(result.stages.find((stage) => stage.stageId === "format")?.toolRuns[0]).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "ruff",
      });
      expect(
        result.stages.find((stage) => stage.stageId === "typecheck")?.toolRuns[0],
      ).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "ty",
      });
      expect(result.stages.find((stage) => stage.stageId === "unit")?.notes[0]).toBe(
        "Pytest ran 3 tests: 3 passed, 0 failed.",
      );
      expect(result.stages.find((stage) => stage.stageId === "coverage")?.notes[0]).toMatch(
        /^Pytest coverage lines: \d+\.\d% across 3 tests\.$/u,
      );
      expect(
        result.stages.find((stage) => stage.stageId === "complexity")?.toolRuns[0],
      ).toMatchObject({
        cacheHit: false,
        exitCode: 0,
        status: "passed",
        tool: "radon",
      });
      expect(
        result.stages.find((stage) => stage.stageId === "maintainability")?.toolRuns[0],
      ).toMatchObject({
        cacheHit: true,
        exitCode: 0,
        status: "passed",
        tool: "radon",
      });
      expect(
        result.stages.find((stage) => stage.stageId === "maintainability")?.notes.join(" "),
      ).toContain("Reused cached Python metrics");
      expect(
        result.stages.find((stage) => stage.stageId === "security")?.toolRuns[0],
      ).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "aiq-security",
      });

      const { metricsPath, planPath, reportPath } = result.artifacts;
      if (planPath === undefined || reportPath === undefined || metricsPath === undefined) {
        throw new Error("Expected plan, report, and metrics artifacts to be written.");
      }

      const planJson = JSON.parse(await readFile(planPath, "utf8")) as {
        input: { files: string[] };
        stages: string[];
      };
      const reportJson = JSON.parse(await readFile(reportPath, "utf8")) as {
        stages: Array<{
          notes: string[];
          stageId: string;
          status: string;
          toolRuns: Array<{ cacheHit?: boolean; tool: string }>;
        }>;
        summary: { diagnosticCount: number; status: string };
      };
      const metricsEvents = (await readFile(metricsPath, "utf8"))
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              cacheHit?: boolean;
              event: string;
              stageId?: string;
              tool?: string;
            },
        );

      expect(planJson.input.files).toEqual([fixturePythonFile]);
      expect(planJson.stages).toEqual([
        "lint",
        "format",
        "typecheck",
        "unit",
        "coverage",
        "complexity",
        "maintainability",
        "security",
      ]);
      expect(reportJson.summary.diagnosticCount).toBe(0);
      expect(reportJson.summary.status).toBe("passed");
      expect(
        reportJson.stages.find((stage) => stage.stageId === "coverage")?.toolRuns[0],
      ).toMatchObject({
        tool: "pytest-cov",
      });
      expect(
        reportJson.stages.find((stage) => stage.stageId === "maintainability")?.notes.join(" "),
      ).toContain("Reused cached Python metrics");
      expect(metricsEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            cacheHit: true,
            event: "cache.hit",
            stageId: "maintainability",
            tool: "radon",
          }),
        ]),
      );
    },
  );

  it.skipIf(!hasDotNet10Toolchain)(
    "runs .NET stages against the fixture project and writes canonical artifacts",
    async () => {
      const project = await createDotNetFixtureProject("aiq-engine-dotnet-");

      const result = await withExclusiveToolLock("dotnet", async () =>
        runEngine({
          context: "cli",
          manifest: {
            files: [project.sourceFile],
            source: "direct",
          },
          mode: "check",
          outDir: project.root,
          stages: [
            "lint",
            "format",
            "typecheck",
            "unit",
            "coverage",
            "complexity",
            "maintainability",
            "security",
          ],
        }),
      );

      expect(result.ok).toBe(true);
      expect(result.artifacts.metricsPath).toBeDefined();
      expect(result.artifacts.planPath).toBeDefined();
      expect(result.artifacts.reportPath).toBeDefined();
      expect(result.summary.diagnosticCount).toBe(0);
      expect(result.summary.notImplementedStageCount).toBe(0);
      expect(result.summary.status).toBe("passed");
      expect(result.stages).toHaveLength(8);
      expect(result.stages.find((stage) => stage.stageId === "lint")?.toolRuns[0]).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "dotnet-format-style",
      });
      expect(result.stages.find((stage) => stage.stageId === "format")?.toolRuns[0]).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "dotnet-format-whitespace",
      });
      expect(
        result.stages.find((stage) => stage.stageId === "typecheck")?.toolRuns[0],
      ).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "dotnet-build",
      });
      expect(result.stages.find((stage) => stage.stageId === "unit")?.notes[0]).toContain(
        "dotnet test ran",
      );
      expect(result.stages.find((stage) => stage.stageId === "coverage")?.notes[0]).toContain(
        "dotnet test coverage lines:",
      );
      expect(
        result.stages.find((stage) => stage.stageId === "complexity")?.toolRuns[0],
      ).toMatchObject({
        cacheHit: false,
        exitCode: 0,
        status: "passed",
        tool: "aiq-csharp-metrics",
      });
      expect(
        result.stages.find((stage) => stage.stageId === "maintainability")?.toolRuns[0],
      ).toMatchObject({
        cacheHit: true,
        exitCode: 0,
        status: "passed",
        tool: "aiq-csharp-metrics",
      });
      expect(
        result.stages.find((stage) => stage.stageId === "maintainability")?.notes.join(" "),
      ).toContain("Reused cached C# metrics");
      expect(
        result.stages.find((stage) => stage.stageId === "security")?.toolRuns[0],
      ).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "aiq-security",
      });

      const { metricsPath, planPath, reportPath } = result.artifacts;
      if (planPath === undefined || reportPath === undefined || metricsPath === undefined) {
        throw new Error("Expected plan, report, and metrics artifacts to be written.");
      }

      const planJson = JSON.parse(await readFile(planPath, "utf8")) as {
        input: { files: string[] };
        stages: string[];
      };
      const reportJson = JSON.parse(await readFile(reportPath, "utf8")) as {
        stages: Array<{
          notes: string[];
          stageId: string;
          toolRuns: Array<{ cacheHit?: boolean; tool: string }>;
        }>;
        summary: { diagnosticCount: number; status: string };
      };
      const metricsEvents = (await readFile(metricsPath, "utf8"))
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              cacheHit?: boolean;
              event: string;
              stageId?: string;
              tool?: string;
            },
        );

      expect(planJson.input.files).toEqual([project.sourceFile]);
      expect(planJson.stages).toEqual([
        "lint",
        "format",
        "typecheck",
        "unit",
        "coverage",
        "complexity",
        "maintainability",
        "security",
      ]);
      expect(reportJson.summary.diagnosticCount).toBe(0);
      expect(reportJson.summary.status).toBe("passed");
      expect(
        reportJson.stages.find((stage) => stage.stageId === "coverage")?.toolRuns[0],
      ).toMatchObject({
        tool: "dotnet-test-coverage",
      });
      expect(
        reportJson.stages.find((stage) => stage.stageId === "maintainability")?.notes.join(" "),
      ).toContain("Reused cached C# metrics");
      expect(metricsEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            cacheHit: true,
            event: "cache.hit",
            stageId: "maintainability",
            tool: "aiq-csharp-metrics",
          }),
        ]),
      );
    },
    90_000,
  );

  it.skipIf(!hasGoToolchain)(
    "runs Go stages against the fixture project and writes canonical artifacts",
    async () => {
      const project = await createGoFixtureProject("aiq-engine-go-");

      const result = await runEngine({
        context: "cli",
        manifest: {
          files: [project.sourceFile],
          source: "direct",
        },
        mode: "check",
        outDir: project.root,
        stages: [
          "lint",
          "format",
          "typecheck",
          "unit",
          "coverage",
          "complexity",
          "maintainability",
          "security",
        ],
      });

      expect(result.ok).toBe(true);
      expect(result.artifacts.metricsPath).toBeDefined();
      expect(result.artifacts.planPath).toBeDefined();
      expect(result.artifacts.reportPath).toBeDefined();
      expect(result.summary.diagnosticCount).toBe(0);
      expect(result.summary.notImplementedStageCount).toBe(0);
      expect(result.summary.status).toBe("passed");
      expect(result.stages).toHaveLength(8);
      expect(result.stages.find((stage) => stage.stageId === "lint")?.toolRuns[0]).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "go-vet",
      });
      expect(result.stages.find((stage) => stage.stageId === "format")?.toolRuns[0]).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "gofmt",
      });
      expect(
        result.stages.find((stage) => stage.stageId === "typecheck")?.toolRuns[0],
      ).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "go-build",
      });
      expect(result.stages.find((stage) => stage.stageId === "unit")?.notes[0]).toContain(
        "go test ran",
      );
      expect(result.stages.find((stage) => stage.stageId === "coverage")?.notes[0]).toContain(
        "go test coverage lines:",
      );
      expect(
        result.stages.find((stage) => stage.stageId === "complexity")?.toolRuns[0],
      ).toMatchObject({
        cacheHit: false,
        exitCode: 0,
        status: "passed",
        tool: "lizard",
      });
      expect(
        result.stages.find((stage) => stage.stageId === "maintainability")?.toolRuns[0],
      ).toMatchObject({
        cacheHit: true,
        exitCode: 0,
        status: "passed",
        tool: "lizard",
      });
      expect(
        result.stages.find((stage) => stage.stageId === "maintainability")?.notes.join(" "),
      ).toContain("Reused cached Go metrics");
      expect(
        result.stages.find((stage) => stage.stageId === "security")?.toolRuns[0],
      ).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "aiq-security",
      });

      const { metricsPath, planPath, reportPath } = result.artifacts;
      if (planPath === undefined || reportPath === undefined || metricsPath === undefined) {
        throw new Error("Expected plan, report, and metrics artifacts to be written.");
      }

      const planJson = JSON.parse(await readFile(planPath, "utf8")) as {
        input: { files: string[] };
        stages: string[];
      };
      const reportJson = JSON.parse(await readFile(reportPath, "utf8")) as {
        stages: Array<{
          notes: string[];
          stageId: string;
          toolRuns: Array<{ cacheHit?: boolean; tool: string }>;
        }>;
        summary: { diagnosticCount: number; status: string };
      };
      const metricsEvents = (await readFile(metricsPath, "utf8"))
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              cacheHit?: boolean;
              event: string;
              stageId?: string;
              tool?: string;
            },
        );

      expect(planJson.input.files).toEqual([project.sourceFile]);
      expect(planJson.stages).toEqual([
        "lint",
        "format",
        "typecheck",
        "unit",
        "coverage",
        "complexity",
        "maintainability",
        "security",
      ]);
      expect(reportJson.summary.diagnosticCount).toBe(0);
      expect(reportJson.summary.status).toBe("passed");
      expect(
        reportJson.stages.find((stage) => stage.stageId === "coverage")?.toolRuns[0],
      ).toMatchObject({
        tool: "go-test-coverage",
      });
      expect(
        reportJson.stages.find((stage) => stage.stageId === "maintainability")?.notes.join(" "),
      ).toContain("Reused cached Go metrics");
      expect(metricsEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            cacheHit: true,
            event: "cache.hit",
            stageId: "maintainability",
            tool: "lizard",
          }),
        ]),
      );
    },
    20_000,
  );

  it.skipIf(!hasRustCoverageToolchain)(
    "runs Rust stages against the fixture project and writes canonical artifacts",
    async () => {
      const project = await createRustFixtureProject("aiq-engine-rust-");

      const result = await withExclusiveRust(async () =>
        runEngine({
          context: "cli",
          manifest: {
            files: [project.sourceFile],
            source: "direct",
          },
          mode: "check",
          outDir: project.root,
          stages: [
            "lint",
            "format",
            "typecheck",
            "unit",
            "coverage",
            "complexity",
            "maintainability",
            "security",
          ],
        }),
      );

      expect(result.ok).toBe(true);
      expect(result.artifacts.metricsPath).toBeDefined();
      expect(result.artifacts.planPath).toBeDefined();
      expect(result.artifacts.reportPath).toBeDefined();
      expect(result.summary.diagnosticCount).toBe(0);
      expect(result.summary.notImplementedStageCount).toBe(0);
      expect(result.summary.status).toBe("passed");
      expect(result.stages).toHaveLength(8);
      expect(result.stages.find((stage) => stage.stageId === "lint")?.toolRuns[0]).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "cargo-clippy",
      });
      expect(result.stages.find((stage) => stage.stageId === "format")?.toolRuns[0]).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "cargo-fmt",
      });
      expect(
        result.stages.find((stage) => stage.stageId === "typecheck")?.toolRuns[0],
      ).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "cargo-check",
      });
      expect(result.stages.find((stage) => stage.stageId === "unit")?.notes[0]).toContain(
        "cargo test ran",
      );
      expect(result.stages.find((stage) => stage.stageId === "coverage")?.notes[0]).toContain(
        "cargo llvm-cov lines:",
      );
      expect(
        result.stages.find((stage) => stage.stageId === "complexity")?.toolRuns[0],
      ).toMatchObject({
        cacheHit: false,
        exitCode: 0,
        status: "passed",
        tool: "lizard",
      });
      expect(
        result.stages.find((stage) => stage.stageId === "maintainability")?.toolRuns[0],
      ).toMatchObject({
        cacheHit: true,
        exitCode: 0,
        status: "passed",
        tool: "lizard",
      });
      expect(
        result.stages.find((stage) => stage.stageId === "maintainability")?.notes.join(" "),
      ).toContain("Reused cached Rust metrics");
      expect(
        result.stages.find((stage) => stage.stageId === "security")?.toolRuns[0],
      ).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "aiq-security",
      });

      const { metricsPath, planPath, reportPath } = result.artifacts;
      if (planPath === undefined || reportPath === undefined || metricsPath === undefined) {
        throw new Error("Expected plan, report, and metrics artifacts to be written.");
      }

      const planJson = JSON.parse(await readFile(planPath, "utf8")) as {
        input: { files: string[] };
        stages: string[];
      };
      const reportJson = JSON.parse(await readFile(reportPath, "utf8")) as {
        stages: Array<{
          notes: string[];
          stageId: string;
          toolRuns: Array<{ cacheHit?: boolean; tool: string }>;
        }>;
        summary: { diagnosticCount: number; status: string };
      };
      const metricsEvents = (await readFile(metricsPath, "utf8"))
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              cacheHit?: boolean;
              event: string;
              stageId?: string;
              tool?: string;
            },
        );

      expect(planJson.input.files).toEqual([project.sourceFile]);
      expect(planJson.stages).toEqual([
        "lint",
        "format",
        "typecheck",
        "unit",
        "coverage",
        "complexity",
        "maintainability",
        "security",
      ]);
      expect(reportJson.summary.diagnosticCount).toBe(0);
      expect(reportJson.summary.status).toBe("passed");
      expect(
        reportJson.stages.find((stage) => stage.stageId === "coverage")?.toolRuns[0],
      ).toMatchObject({
        tool: "cargo-llvm-cov",
      });
      expect(
        reportJson.stages.find((stage) => stage.stageId === "maintainability")?.notes.join(" "),
      ).toContain("Reused cached Rust metrics");
      expect(metricsEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            cacheHit: true,
            event: "cache.hit",
            stageId: "maintainability",
            tool: "lizard",
          }),
        ]),
      );
    },
    60_000,
  );

  it("runs Bash stages against the fixture project and writes canonical artifacts", async () => {
    const project = await createBashFixtureProject("aiq-engine-bash-");
    const hasShellcheck = commandAvailable("shellcheck");
    const hasShfmt = commandAvailable("shfmt");
    const hasBats = commandAvailable("bats");
    const hasKcov = commandAvailable("kcov");

    const result = await runEngine({
      context: "cli",
      manifest: {
        files: [project.sourceFile],
        source: "direct",
      },
      mode: "check",
      outDir: project.root,
      stages: ["lint", "format", "unit", "coverage", "security"],
    });

    expect(result.artifacts.metricsPath).toBeDefined();
    expect(result.artifacts.planPath).toBeDefined();
    expect(result.artifacts.reportPath).toBeDefined();
    expect(result.stages).toHaveLength(5);
    expect(result.stages.find((stage) => stage.stageId === "security")?.toolRuns[0]).toMatchObject({
      exitCode: 0,
      status: "passed",
      tool: "aiq-security",
    });

    const lintStage = result.stages.find((stage) => stage.stageId === "lint");
    const formatStage = result.stages.find((stage) => stage.stageId === "format");
    const unitStage = result.stages.find((stage) => stage.stageId === "unit");
    const coverageStage = result.stages.find((stage) => stage.stageId === "coverage");

    if (hasShellcheck) {
      expect(lintStage?.status).toBe("passed");
      expect(lintStage?.toolRuns[0]).toMatchObject({ status: "passed", tool: "shellcheck" });
    } else {
      expect(lintStage?.status).toBe("failed");
    }

    if (hasShfmt) {
      expect(formatStage?.status).toBe("passed");
      expect(formatStage?.toolRuns[0]).toMatchObject({ status: "passed", tool: "shfmt" });
    } else {
      expect(formatStage?.status).toBe("failed");
    }

    if (hasBats) {
      expect(unitStage?.status).toBe("passed");
      expect(unitStage?.toolRuns[0]).toMatchObject({ status: "passed", tool: "bats" });
      expect(unitStage?.notes[0]).toContain("Bats ran");
    } else {
      expect(unitStage?.status).toBe("not_implemented");
    }

    if (hasBats && hasKcov) {
      expect(coverageStage?.status).toBe("passed");
      expect(coverageStage?.toolRuns[0]).toMatchObject({ status: "passed", tool: "kcov" });
      expect(coverageStage?.notes[0]).toContain("Bash coverage lines:");
    } else {
      expect(coverageStage?.status).toBe("not_implemented");
    }
  }, 60_000);

  it.skipIf(!hasPowerShellPesterToolchain)(
    "runs PowerShell stages against the fixture project and writes canonical artifacts",
    async () => {
      const project = await createPowerShellFixtureProject("aiq-engine-powershell-");
      const hasPester = await resolvePowerShellModuleAvailable("Pester");
      const hasAnalyzer = await resolvePowerShellModuleAvailable("PSScriptAnalyzer");

      const result = await runEngine({
        context: "cli",
        manifest: {
          files: [project.sourceFile],
          source: "direct",
        },
        mode: "check",
        outDir: project.root,
        stages: ["lint", "format", "unit", "coverage", "security"],
      });

      expect(result.artifacts.metricsPath).toBeDefined();
      expect(result.artifacts.planPath).toBeDefined();
      expect(result.artifacts.reportPath).toBeDefined();
      expect(result.stages).toHaveLength(5);
      expect(
        result.stages.find((stage) => stage.stageId === "security")?.toolRuns[0],
      ).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "aiq-security",
      });

      const lintStage = result.stages.find((stage) => stage.stageId === "lint");
      const formatStage = result.stages.find((stage) => stage.stageId === "format");
      const unitStage = result.stages.find((stage) => stage.stageId === "unit");
      const coverageStage = result.stages.find((stage) => stage.stageId === "coverage");

      if (hasAnalyzer) {
        expect(lintStage?.status).toBe("passed");
        expect(lintStage?.toolRuns[0]).toMatchObject({
          status: "passed",
          tool: "psscriptanalyzer",
        });
        expect(formatStage?.status).toBe("passed");
        expect(formatStage?.toolRuns[0]).toMatchObject({
          status: "passed",
          tool: "invoke-formatter",
        });
      } else {
        expect(lintStage?.status).toBe("failed");
        expect(formatStage?.status).toBe("failed");
      }

      if (hasPester) {
        expect(unitStage?.status).toBe("passed");
        expect(unitStage?.toolRuns[0]).toMatchObject({ status: "passed", tool: "pester" });
        expect(unitStage?.notes[0]).toContain("Pester ran");

        expect(coverageStage?.status).toBe("passed");
        expect(coverageStage?.toolRuns[0]).toMatchObject({ status: "passed", tool: "pester" });
        expect(coverageStage?.notes[0]).toContain("PowerShell coverage lines:");
      } else {
        expect(unitStage?.status).toBe("not_implemented");
        expect(coverageStage?.status).toBe("not_implemented");
      }
    },
    60_000,
  );

  it.skipIf(!hasMavenToolchain)(
    "runs Java Maven stages against the fixture project and writes canonical artifacts",
    async () => {
      const project = await createJavaMavenFixtureProject("aiq-engine-java-maven-");

      const result = await runEngine({
        context: "cli",
        manifest: {
          files: [project.sourceFile],
          source: "direct",
        },
        mode: "check",
        outDir: project.root,
        stages: [
          "lint",
          "format",
          "typecheck",
          "unit",
          "coverage",
          "complexity",
          "maintainability",
          "security",
        ],
      });

      expect(result.ok).toBe(true);
      expect(result.summary.diagnosticCount).toBe(0);
      expect(result.summary.notImplementedStageCount).toBe(0);
      expect(result.summary.status).toBe("passed");
      expect(result.stages.find((stage) => stage.stageId === "lint")?.toolRuns[0]).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "maven-spotless",
      });
      expect(result.stages.find((stage) => stage.stageId === "format")?.toolRuns[0]).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "maven-spotless",
      });
      expect(
        result.stages.find((stage) => stage.stageId === "typecheck")?.toolRuns[0],
      ).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "maven-build",
      });
      expect(
        result.stages.find((stage) => stage.stageId === "coverage")?.toolRuns[0],
      ).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "maven-test-coverage",
      });
      expect(
        result.stages.find((stage) => stage.stageId === "maintainability")?.notes.join(" "),
      ).toContain("Reused cached JVM metrics");

      const { metricsPath, planPath, reportPath } = result.artifacts;
      if (planPath === undefined || reportPath === undefined || metricsPath === undefined) {
        throw new Error("Expected plan, report, and metrics artifacts to be written.");
      }

      const planJson = JSON.parse(await readFile(planPath, "utf8")) as {
        input: { files: string[] };
        stages: string[];
      };
      const reportJson = JSON.parse(await readFile(reportPath, "utf8")) as {
        stages: Array<{
          notes: string[];
          stageId: string;
          toolRuns: Array<{ cacheHit?: boolean; tool: string }>;
        }>;
        summary: { diagnosticCount: number; status: string };
      };
      const metricsEvents = (await readFile(metricsPath, "utf8"))
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              cacheHit?: boolean;
              event: string;
              stageId?: string;
              tool?: string;
            },
        );

      expect(planJson.input.files).toEqual([project.sourceFile]);
      expect(planJson.stages).toEqual([
        "lint",
        "format",
        "typecheck",
        "unit",
        "coverage",
        "complexity",
        "maintainability",
        "security",
      ]);
      expect(reportJson.summary.diagnosticCount).toBe(0);
      expect(reportJson.summary.status).toBe("passed");
      expect(
        reportJson.stages.find((stage) => stage.stageId === "coverage")?.toolRuns[0],
      ).toMatchObject({
        tool: "maven-test-coverage",
      });
      expect(
        reportJson.stages.find((stage) => stage.stageId === "maintainability")?.notes.join(" "),
      ).toContain("Reused cached JVM metrics");
      expect(metricsEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            cacheHit: true,
            event: "cache.hit",
            stageId: "maintainability",
            tool: "lizard",
          }),
        ]),
      );
    },
    120_000,
  );

  it.skipIf(!hasGradleToolchain)(
    "runs Kotlin Gradle stages against the fixture project and writes canonical artifacts",
    async () => {
      const project = await createKotlinGradleFixtureProject("aiq-engine-kotlin-gradle-");

      const result = await runEngine({
        context: "cli",
        manifest: {
          files: [project.sourceFile],
          source: "direct",
        },
        mode: "check",
        outDir: project.root,
        stages: [
          "lint",
          "format",
          "typecheck",
          "unit",
          "coverage",
          "complexity",
          "maintainability",
          "security",
        ],
      });

      expect(result.ok).toBe(true);
      expect(result.summary.diagnosticCount).toBe(0);
      expect(result.summary.notImplementedStageCount).toBe(0);
      expect(result.summary.status).toBe("passed");
      expect(result.stages.find((stage) => stage.stageId === "lint")?.toolRuns[0]).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "gradle-spotless",
      });
      expect(
        result.stages.find((stage) => stage.stageId === "typecheck")?.toolRuns[0],
      ).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "gradle-build",
      });
      expect(
        result.stages.find((stage) => stage.stageId === "coverage")?.toolRuns[0],
      ).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "gradle-test-coverage",
      });
      expect(
        result.stages.find((stage) => stage.stageId === "maintainability")?.notes.join(" "),
      ).toContain("Reused cached JVM metrics");
    },
    120_000,
  );

  it("rejects cancelled runs before task execution starts", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      runEngine({
        context: "cli",
        manifest: {
          files: [fixtureFile],
          source: "direct",
        },
        mode: "check",
        stages: ["lint"],
        signal: controller.signal,
        writeArtifacts: false,
      }),
    ).rejects.toBeInstanceOf(AiqEngineCancelledError);
  });

  it("rejects cancelled runs before request resolution runs", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      runEngine({
        context: "cli",
        manifest: {
          files: ["missing-before-resolution.ts"],
          source: "direct",
        },
        mode: "check",
        stages: ["lint"],
        signal: controller.signal,
        writeArtifacts: false,
      }),
    ).rejects.toBeInstanceOf(AiqEngineCancelledError);
  });

  it("propagates cancellation during extracted TypeScript typecheck", async () => {
    const { root, sourceFile } = await createTypeScriptFixtureProject("aiq-engine-ts-cancel-");
    const generatedDir = path.join(root, "src", "generated");
    await mkdir(generatedDir, { recursive: true });

    await Promise.all(
      Array.from({ length: 400 }, (_, index) =>
        writeFile(
          path.join(generatedDir, `generated-${index}.ts`),
          createTypeScriptWorkloadModule(index),
          "utf8",
        ),
      ),
    );

    const controller = new AbortController();
    const runNodeToolSpy = vi
      .spyOn(ToolRunner.prototype, "runNodeTool")
      .mockImplementationOnce(async () => {
        controller.abort();
        throw createAbortError();
      });

    await expect(
      runEngine({
        context: "cli",
        cwd: root,
        manifest: {
          files: [sourceFile],
          source: "direct",
        },
        mode: "check",
        stages: ["typecheck"],
        signal: controller.signal,
        writeArtifacts: false,
      }),
    ).rejects.toBeInstanceOf(AiqEngineCancelledError);

    expect(runNodeToolSpy).toHaveBeenCalledOnce();
  }, 120_000);

  it("propagates cancellation during extracted JavaScript unit runs", async () => {
    const { root, sourceFile, testFile } = await createJavaScriptFixtureProject(
      "aiq-engine-js-unit-cancel-",
    );
    await writeFile(
      testFile,
      [
        'const { greet } = require("./index.js");',
        "",
        'describe("greet", () => {',
        '  test("waits for cancellation", async () => {',
        "    await new Promise((resolve) => setTimeout(resolve, 10_000));",
        '    expect(greet("Alice")).toBe("Hello, Alice!");',
        "  });",
        "});",
        "",
      ].join("\n"),
      "utf8",
    );

    const controller = new AbortController();
    const runSpy = vi.spyOn(ToolRunner.prototype, "run").mockImplementationOnce(async () => {
      controller.abort();
      throw createAbortError();
    });

    await expect(
      runEngine({
        context: "cli",
        cwd: root,
        manifest: {
          files: [sourceFile],
          source: "direct",
        },
        mode: "check",
        stages: ["unit"],
        signal: controller.signal,
        writeArtifacts: false,
      }),
    ).rejects.toBeInstanceOf(AiqEngineCancelledError);

    expect(runSpy).toHaveBeenCalledOnce();
  }, 120_000);

  it("propagates cancellation during extracted JavaScript metrics runs", async () => {
    const { root, sourceFile } = await createJavaScriptFixtureProject(
      "aiq-engine-js-metrics-cancel-",
    );
    const generatedDir = path.join(root, "generated");
    await mkdir(generatedDir, { recursive: true });

    const generatedFiles = await Promise.all(
      Array.from({ length: 20 }, (_, index) => {
        const filePath = path.join(generatedDir, `generated-${index}.js`);
        return writeFile(filePath, createLargeJavaScriptModule(index), "utf8").then(() => filePath);
      }),
    );

    const controller = new AbortController();
    const runSpy = vi.spyOn(ToolRunner.prototype, "run").mockImplementationOnce(async () => {
      controller.abort();
      throw createAbortError();
    });

    await expect(
      runEngine({
        context: "cli",
        cwd: root,
        manifest: {
          files: [sourceFile, ...generatedFiles],
          source: "direct",
        },
        mode: "check",
        stages: ["complexity"],
        signal: controller.signal,
        writeArtifacts: false,
      }),
    ).rejects.toBeInstanceOf(AiqEngineCancelledError);

    expect(runSpy).toHaveBeenCalledOnce();
  }, 120_000);
});
