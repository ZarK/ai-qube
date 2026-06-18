import { describe, expect, it } from "vitest";
import {
  createDotNetFixtureProject,
  createKotlinGradleFixtureProject,
  hasGradleToolchain,
  runPlannedTask,
} from "./runners-test-support.js";
describe("engine runners", () => {
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
});
