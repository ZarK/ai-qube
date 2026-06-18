import { describe, expect, it } from "vitest";
import {
  commandAvailable,
  createDotNetFixtureProject,
  createGoFixtureProject,
  createRustFixtureProject,
  createTerraformHclFixtureProject,
  fixturePythonFile,
  hasDotNet10Toolchain,
  hasGoToolchain,
  hasPythonQualityToolchain,
  hasRustCoverageToolchain,
  mkdtemp,
  os,
  path,
  readFile,
  runEngine,
  tempDirs,
  withExclusiveRust,
  withExclusiveToolLock,
} from "./engine-test-support.js";
describe("engine foundation", () => {
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
});
