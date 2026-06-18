import { describe, expect, it } from "vitest";
import {
  fixtureCssFile,
  fixtureHtmlFile,
  fixtureSqlFile,
  fixtureYamlFile,
  mkdtemp,
  os,
  path,
  readFile,
  runEngine,
  tempDirs,
} from "./engine-test-support.js";
describe("engine foundation", () => {
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
});
