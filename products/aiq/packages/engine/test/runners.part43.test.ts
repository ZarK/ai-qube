import { describe, expect, it } from "vitest";
import {
  buildEngineContext,
  createDotNetCompetingSolutionProject,
  createDotNetFixtureProject,
  hasDotNet10Toolchain,
  path,
  runPlannedTask,
  withExclusiveDotNet,
} from "./runners-test-support.js";
describe("engine runners", () => {
  it.skipIf(!hasDotNet10Toolchain)(
    "prefers the owning solution when multiple ancestor solutions exist",
    async () => {
      const project = await createDotNetCompetingSolutionProject(
        "aiq-dotnet-owning-solution-runner-",
      );

      const result = await withExclusiveDotNet(async () =>
        runPlannedTask(
          {
            fileCount: 2,
            files: [project.sourceFile, project.testFile],
            id: "test:1:unit-dotnet-owning-solution",
            stageId: "unit",
          },
          process.cwd(),
        ),
      );

      expect(result.status).toBe("passed");
      expect(result.toolRuns).toHaveLength(1);
      expect(result.toolRuns[0]).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "dotnet-test",
      });
      expect(result.notes[0]).toContain("1 passed, 0 failed");
    },
    90_000,
  );

  it.skipIf(!hasDotNet10Toolchain)(
    "uses graph-backed owning solution selection when a dotnet project file is selected directly",
    async () => {
      const project = await createDotNetFixtureProject("aiq-dotnet-project-file-context-runner-");
      const projectFile = path.join(project.root, "src", "DotNetFixture", "DotNetFixture.csproj");
      const engineContext = await buildEngineContext({
        context: "cli",
        cwd: project.root,
        manifest: {
          files: [projectFile],
          source: "direct",
        },
        mode: "check",
        outDir: path.join(project.root, ".aiq", "out"),
        profile: "fast",
        stages: ["unit"],
        writeArtifacts: false,
      });

      const result = await withExclusiveDotNet(async () =>
        runPlannedTask(
          {
            fileCount: 1,
            files: [projectFile],
            id: "test:1:unit-dotnet-project-file-context",
            stageId: "unit",
          },
          engineContext,
        ),
      );

      expect(result.status).toBe("passed");
      expect(result.notes[0]).toContain("1 passed, 0 failed");
      expect(result.toolRuns[0]).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "dotnet-test",
      });
      expect(result.toolRuns[0]?.args).toContain(project.solutionFile);
    },
    90_000,
  );
});
