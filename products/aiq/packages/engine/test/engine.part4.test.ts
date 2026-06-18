import { describe, expect, it } from "vitest";
import {
  lintFailureFixtureFile,
  mkdtemp,
  os,
  path,
  readFile,
  runEngine,
  tempDirs,
} from "./engine-test-support.js";
describe("engine foundation", () => {
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
});
