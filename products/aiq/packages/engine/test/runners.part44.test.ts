import { describe, expect, it, vi } from "vitest";
import {
  createDotNetCompetingSolutionProject,
  createDotNetFixtureProject,
  hasDotNet10Toolchain,
  path,
  readdir,
  runPlannedTask,
  writeFile,
} from "./runners-test-support.js";
describe("engine runners", () => {
  it.skipIf(!hasDotNet10Toolchain)(
    "keeps fallback dotnet resolution passing when solution traversal cannot read an ancestor",
    async () => {
      const project = await createDotNetFixtureProject("aiq-dotnet-resolution-read-fallback-");
      const blockedDirectory = project.root;

      vi.resetModules();
      vi.doMock("node:fs/promises", async () => {
        const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
        type ReadDirectory = typeof actual.readdir;
        const actualReadDirectory = actual.readdir as ReadDirectory;

        return {
          ...actual,
          readdir: (async (...args: Parameters<ReadDirectory>) => {
            const [directoryPath] = args;
            if (
              typeof directoryPath === "string" &&
              path.resolve(directoryPath) === blockedDirectory
            ) {
              const error = new Error("simulated missing directory") as NodeJS.ErrnoException;
              error.code = "ENOENT";
              throw error;
            }

            return actualReadDirectory(...args);
          }) as ReadDirectory,
        };
      });

      try {
        const { runPlannedTask: runPlannedTaskWithMock } = await import("../src/runners.js");
        const result = await runPlannedTaskWithMock(
          {
            fileCount: 1,
            files: [project.sourceFile],
            id: "test:1:complexity-dotnet-resolution-read-fallback",
            stageId: "complexity",
          },
          process.cwd(),
        );

        expect(result.status).toBe("passed");
        expect(result.diagnostics).toEqual([]);
        expect(result.toolRuns[0]).toMatchObject({
          cacheHit: false,
          exitCode: 0,
          status: "passed",
          tool: "aiq-csharp-metrics",
        });
      } finally {
        vi.doUnmock("node:fs/promises");
        vi.resetModules();
      }
    },
    20_000,
  );

  it("limits solution metrics to projects declared in the selected solution", async () => {
    const project = await createDotNetCompetingSolutionProject(
      "aiq-dotnet-solution-metrics-runner-",
    );

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.solutionFile],
        id: "test:1:complexity-dotnet-solution-scope",
        stageId: "complexity",
      },
      process.cwd(),
    );

    expect(result.status).toBe("passed");
    expect(result.notes[0]).toContain("Shared metrics observed 20 SLOC.");
  });

  it("runs the shared security scan for C# inputs", async () => {
    const project = await createDotNetFixtureProject("aiq-dotnet-security-runner-");

    await writeFile(
      project.sourceFile,
      [
        "namespace DotNetFixture;",
        "",
        "public static class Greeter",
        "{",
        '    public const string Token = "ghp_123456789012345678901234567890123456";',
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:security-dotnet",
        stageId: "security",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.diagnostics[0]).toMatchObject({
      file: project.sourceFile,
      severity: "error",
      source: "aiq-security",
    });
    expect(result.toolRuns[0]).toMatchObject({
      exitCode: 1,
      status: "failed",
      tool: "aiq-security",
    });
  });
});
