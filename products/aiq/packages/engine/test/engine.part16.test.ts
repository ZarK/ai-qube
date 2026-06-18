import { describe, expect, it } from "vitest";
import {
  fixtureFile,
  fixtureJavaScriptFile,
  mkdtemp,
  os,
  path,
  readFile,
  runEngine,
  tempDirs,
} from "./engine-test-support.js";
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
});
