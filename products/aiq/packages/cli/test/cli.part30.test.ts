import { describe, expect, it } from "vitest";
import {
  MemoryInput,
  MemoryOutput,
  createDotNetFixtureProject,
  hasDotNet10Toolchain,
  runCli,
  withExclusiveToolLock,
} from "./cli-test-support.js";
describe("CLI foundation", () => {
  it.skipIf(!hasDotNet10Toolchain)(
    "renders passing .NET output as JSON",
    async () => {
      const project = await createDotNetFixtureProject("aiq-cli-check-dotnet-");

      const stdout = new MemoryOutput();
      const stderr = new MemoryOutput();
      const exitCode = await withExclusiveToolLock("dotnet", async () =>
        runCli(
          [
            "node",
            "aiq",
            "check",
            project.filePath,
            "--stage",
            "lint",
            "--stage",
            "format",
            "--stage",
            "typecheck",
            "--stage",
            "unit",
            "--stage",
            "coverage",
            "--stage",
            "complexity",
            "--stage",
            "maintainability",
            "--stage",
            "security",
            "--format",
            "json",
            "--out-dir",
            project.root,
          ],
          {
            cwd: project.root,
            stderr,
            stdin: new MemoryInput(),
            stdout,
          },
        ),
      );

      expect(exitCode).toBe(0);
      expect(stderr.value).toBe("");

      const output = JSON.parse(stdout.value) as {
        stages: Array<{
          notes: string[];
          stageId: string;
          status: string;
          toolRuns: Array<{ cacheHit?: boolean; exitCode?: number; status: string; tool: string }>;
        }>;
        summary: { diagnosticCount: number; notImplementedStageCount: number; status: string };
      };
      expect(output.summary.diagnosticCount).toBe(0);
      expect(output.summary.notImplementedStageCount).toBe(0);
      expect(output.summary.status).toBe("passed");
      expect(output.stages).toHaveLength(8);
      expect(output.stages.find((stage) => stage.stageId === "lint")?.toolRuns[0]).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "dotnet-format-style",
      });
      expect(
        output.stages.find((stage) => stage.stageId === "typecheck")?.toolRuns[0],
      ).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "dotnet-build",
      });
      expect(output.stages.find((stage) => stage.stageId === "unit")?.notes[0]).toContain(
        "dotnet test ran",
      );
      expect(output.stages.find((stage) => stage.stageId === "coverage")?.notes[0]).toContain(
        "dotnet test coverage lines:",
      );
      expect(
        output.stages.find((stage) => stage.stageId === "maintainability")?.notes.join(" "),
      ).toContain("Reused cached C# metrics");
      expect(
        output.stages.find((stage) => stage.stageId === "maintainability")?.toolRuns[0],
      ).toMatchObject({
        cacheHit: true,
        exitCode: 0,
        status: "passed",
        tool: "aiq-csharp-metrics",
      });
    },
    // Real .NET SDK restore/build/test/coverage/security can exceed 20s on cold local agents.
    90_000,
  );
});
