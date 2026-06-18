import { describe, expect, it } from "vitest";
import {
  commandAvailable,
  createDotNetFixtureProject,
  createGoFixtureProject,
  createRustFixtureProject,
  createTerraformHclFixtureProject,
  expectSuccessfulCanonicalRun,
  fixturePythonFile,
  hasDotNet10Toolchain,
  hasGoToolchain,
  hasPythonQualityToolchain,
  hasRustCoverageToolchain,
  mkdtemp,
  os,
  path,
  readJsonArtifact,
  readMetricsEvents,
  requireCanonicalArtifactPaths,
  runEngine,
  tempDirs,
  withExclusiveRust,
  withExclusiveToolLock,
} from "./engine-test-support.js";

type PlanArtifact = {
  input: { files: string[] };
  stages: string[];
};

type ReportArtifact = {
  stages: Array<{
    notes: string[];
    stageId: string;
    status: string;
    toolRuns: Array<{ cacheHit?: boolean; tool: string }>;
  }>;
  summary: { diagnosticCount: number; status: string };
};

type EngineRunResult = Awaited<ReturnType<typeof runEngine>>;

describe("engine foundation", () => {
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

      expectSuccessfulCanonicalRun(result, 8);
      expectPythonFixtureStages(result);

      const { metricsPath, planPath, reportPath } = requireCanonicalArtifactPaths(result);
      const planJson = await readJsonArtifact<PlanArtifact>(planPath);
      const reportJson = await readJsonArtifact<ReportArtifact>(reportPath);
      const metricsEvents = await readMetricsEvents(metricsPath);

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
});

function expectPythonFixtureStages(result: EngineRunResult): void {
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
  expect(result.stages.find((stage) => stage.stageId === "typecheck")?.toolRuns[0]).toMatchObject({
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
  expect(result.stages.find((stage) => stage.stageId === "complexity")?.toolRuns[0]).toMatchObject({
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
  expect(result.stages.find((stage) => stage.stageId === "security")?.toolRuns[0]).toMatchObject({
    exitCode: 0,
    status: "passed",
    tool: "aiq-security",
  });
}
