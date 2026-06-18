import { describe, expect, it } from "vitest";
import {
  createDotNetCompetingSolutionProject,
  createDotNetFixtureProject,
  createGoFixtureProject,
  fixturePythonFile,
  hasDotNet10Toolchain,
  hasPythonQualityToolchain,
  path,
  runPlannedTask,
} from "./runners-test-support.js";
describe("engine runners", () => {
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
});
