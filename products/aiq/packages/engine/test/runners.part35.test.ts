import { describe, expect, it, vi } from "vitest";
import {
  ToolRunner,
  buildEngineContext,
  createDotNetFixtureProject,
  createJavaMavenFixtureProject,
  hasDotNet10Toolchain,
  mkdir,
  mkdtemp,
  os,
  path,
  runPlannedTask,
  tempDirs,
  withExclusiveDotNet,
  withToolRunnerOverride,
  writeFile,
} from "./runners-test-support.js";
describe("engine runners", () => {
  it.skipIf(!hasDotNet10Toolchain)(
    "runs dotnet unit tests for C# projects",
    async () => {
      const project = await createDotNetFixtureProject("aiq-dotnet-unit-runner-");

      const result = await withExclusiveDotNet(async () =>
        runPlannedTask(
          {
            fileCount: 1,
            files: [project.sourceFile],
            id: "test:1:unit-dotnet",
            stageId: "unit",
          },
          process.cwd(),
        ),
      );

      expect(result.status).toBe("passed");
      expect(result.diagnostics).toEqual([]);
      expect(result.notes[0]).toContain("dotnet test ran");
      expect(result.toolRuns[0]).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "dotnet-test",
      });
    },
    90_000,
  );

  it.skipIf(!hasDotNet10Toolchain)(
    "runs dotnet coverage for C# projects",
    async () => {
      const project = await createDotNetFixtureProject("aiq-dotnet-coverage-runner-");

      const result = await withExclusiveDotNet(async () =>
        runPlannedTask(
          {
            fileCount: 1,
            files: [project.sourceFile],
            id: "test:1:coverage-dotnet",
            stageId: "coverage",
          },
          process.cwd(),
        ),
      );

      expect(result.status).toBe("passed");
      expect(result.diagnostics).toEqual([]);
      expect(result.notes[0]).toContain("dotnet test coverage lines:");
      expect(result.toolRuns[0]).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "dotnet-test-coverage",
      });
    },
    90_000,
  );

  it("preserves supported JVM test runs while reporting unsupported selected JVM files", async () => {
    const project = await createJavaMavenFixtureProject("aiq-java-maven-mixed-unsupported-");
    const unsupportedRoot = await mkdtemp(path.join(os.tmpdir(), "aiq-jvm-mixed-no-build-"));
    tempDirs.push(unsupportedRoot);
    const unsupportedFile = path.join(unsupportedRoot, "Orphan.java");
    await writeFile(unsupportedFile, "final class Orphan {}\n", "utf8");

    const toolRunner = new ToolRunner();
    vi.spyOn(toolRunner, "resolveInstalledBinary").mockResolvedValue("mvn");
    vi.spyOn(toolRunner, "run").mockImplementation(async (_command, _args, options) => {
      const reportsDir = path.join(options.cwd, "target", "surefire-reports");
      await mkdir(reportsDir, { recursive: true });
      await writeFile(
        path.join(reportsDir, "TEST-GreetingTest.xml"),
        '<testsuite tests="1" failures="0" errors="0" skipped="0"></testsuite>',
        "utf8",
      );
      const timestamp = new Date().toISOString();
      return {
        durationMs: 5,
        exitCode: 0,
        finishedAt: timestamp,
        startedAt: timestamp,
        stderr: "",
        stdout: "",
      };
    });

    const engineContext = withToolRunnerOverride(
      await buildEngineContext({
        context: "cli",
        manifest: {
          files: [project.sourceFile, unsupportedFile],
          source: "direct",
        },
        mode: "check",
        outDir: project.root,
        stages: ["unit"],
      }),
      toolRunner,
    );

    const result = await runPlannedTask(
      {
        fileCount: 2,
        files: [project.sourceFile, unsupportedFile],
        id: "test:1:unit-java-mixed-unsupported",
        stageId: "unit",
      },
      engineContext,
    );

    expect(JSON.stringify(result)).not.toContain("not_implemented");
    expect(result.status).toBe("failed");
    expect(result.toolRuns[0]).toMatchObject({ status: "passed", tool: "maven-test" });
    expect(result.diagnostics[0]).toMatchObject({
      file: unsupportedFile,
      severity: "error",
      source: "jvm-unavailable",
    });
    expect(result.notes.join(" ")).toContain("Maven test ran");
    expect(result.notes.join(" ")).toContain("No JVM build target was detected");
  });
});
