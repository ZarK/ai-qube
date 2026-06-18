import { describe, expect, it } from "vitest";
import {
  expectSuccessfulCanonicalRun,
  fixtureFile,
  fixtureJavaScriptFile,
  mkdtemp,
  os,
  path,
  readJsonArtifact,
  readMetricsEvents,
  requireCanonicalArtifactPaths,
  runEngine,
  tempDirs,
} from "./engine-test-support.js";

type PlanArtifact = {
  input: { files: string[] };
  stages: string[];
};

type ReportArtifact = {
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

type EngineRunResult = Awaited<ReturnType<typeof runEngine>>;

describe("engine foundation", () => {
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

    expectSuccessfulCanonicalRun(result, 3);
    expect(result.summary.cacheHitCount).toBe(4);
    expect(result.summary.cacheMissCount).toBe(2);

    expectSharedJavaScriptMetricsStages(result);

    const { metricsPath, planPath, reportPath } = requireCanonicalArtifactPaths(result);
    const planJson = await readJsonArtifact<PlanArtifact>(planPath);
    const reportJson = await readJsonArtifact<ReportArtifact>(reportPath);
    const metricsEvents = await readMetricsEvents(metricsPath);

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
});

function expectSharedJavaScriptMetricsStages(result: EngineRunResult): void {
  const slocStage = result.stages.find((stage) => stage.stageId === "sloc");
  const complexityStage = result.stages.find((stage) => stage.stageId === "complexity");
  const maintainabilityStage = result.stages.find((stage) => stage.stageId === "maintainability");

  expect(slocStage?.notes[0]).toContain("JavaScript/TypeScript SLOC:");
  expect(filterLizardRuns(slocStage, false)).toHaveLength(2);
  expect(complexityStage?.notes[0]).toContain("Shared metrics observed");
  expect(complexityStage?.notes.join(" ")).toContain("Reused cached JavaScript/TypeScript metrics");
  expect(filterLizardRuns(complexityStage, true)).toHaveLength(2);
  expect(maintainabilityStage?.notes.join(" ")).toContain(
    "Reused cached JavaScript/TypeScript metrics",
  );
  expect(filterLizardRuns(maintainabilityStage, true)).toHaveLength(2);
}

function filterLizardRuns(
  stage: EngineRunResult["stages"][number] | undefined,
  cacheHit: boolean,
): EngineRunResult["stages"][number]["toolRuns"] {
  return (
    stage?.toolRuns.filter(
      (toolRun) =>
        toolRun.cacheHit === cacheHit &&
        toolRun.exitCode === 0 &&
        toolRun.status === "passed" &&
        toolRun.tool === "lizard",
    ) ?? []
  );
}
