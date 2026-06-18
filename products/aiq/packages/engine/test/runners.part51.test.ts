import { describe, expect, it, vi } from "vitest";
import {
  ToolRunner,
  buildEngineContext,
  createDotNetFixtureProject,
  expectBashSetupFailure,
  expectProjectResolutionFailure,
  mkdtemp,
  os,
  path,
  runPlannedTask,
  tempDirs,
  withToolRunnerOverride,
  writeFile,
} from "./runners-test-support.js";
describe("engine runners", () => {
  it("keeps supported .NET typecheck while reporting unsupported selected C# files", async () => {
    const project = await createDotNetFixtureProject("aiq-mixed-dotnet-resolution-");
    const unsupportedRoot = await mkdtemp(path.join(os.tmpdir(), "aiq-dotnet-no-project-"));
    tempDirs.push(unsupportedRoot);
    const unsupportedFile = path.join(unsupportedRoot, "Orphan.cs");
    await writeFile(unsupportedFile, "public static class Orphan {}\n", "utf8");

    const toolRunner = new ToolRunner();
    vi.spyOn(toolRunner, "run").mockResolvedValue({
      durationMs: 5,
      exitCode: 0,
      finishedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      stderr: "",
      stdout: "",
    });

    const engineContext = withToolRunnerOverride(
      await buildEngineContext({
        context: "cli",
        manifest: { files: [project.sourceFile, unsupportedFile], source: "direct" },
        mode: "check",
        outDir: project.root,
        stages: ["typecheck"],
      }),
      toolRunner,
    );

    const result = await runPlannedTask(
      {
        fileCount: 2,
        files: [project.sourceFile, unsupportedFile],
        id: "test:1:typecheck-dotnet-mixed-resolution",
        stageId: "typecheck",
      },
      engineContext,
    );

    expectProjectResolutionFailure(result, {
      artifact: ".csproj",
      file: unsupportedFile,
      source: "dotnet-unavailable",
    });
    expect(result.toolRuns[0]).toMatchObject({ status: "passed", tool: "dotnet-build" });
    expect(result.notes.join(" ")).toContain("dotnet build passed");
  });

  it("keeps generic script config selections out of Bash and PowerShell unit planning", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-script-config-only-"));
    tempDirs.push(tempDir);

    const configFiles = [
      path.join(tempDir, "requirements.txt"),
      path.join(tempDir, "PSScriptAnalyzerSettings.psd1"),
    ];

    await writeFile(configFiles[0], "pytest\n", "utf8");
    await writeFile(configFiles[1], "@{ IncludeRules = @() }\n", "utf8");

    for (const [index, configFile] of configFiles.entries()) {
      const result = await runPlannedTask(
        {
          fileCount: 1,
          files: [configFile],
          id: `test:1:unit-script-config-only-${index}`,
          stageId: "unit",
        },
        process.cwd(),
      );

      expect(result.status).toBe("passed");
      expect(result.diagnostics).toEqual([]);
      expect(result.notes).toEqual(["No supported files were selected for unit."]);
      expect(result.toolRuns).toEqual([]);
    }
  });

  it("recognizes mixed-case .BATS files as Bash tests", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-bash-uppercase-bats-"));
    tempDirs.push(tempDir);

    const batsFile = path.join(tempDir, "example.BATS");
    await writeFile(batsFile, ['@test "passes" {', "  [ 1 -eq 1 ]", "}", ""].join("\n"), "utf8");

    vi.spyOn(ToolRunner.prototype, "resolveBinaryIfAvailable").mockResolvedValue(undefined);

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [batsFile],
        id: "test:1:unit-bash-uppercase-bats",
        stageId: "unit",
      },
      process.cwd(),
    );

    expectBashSetupFailure(result, "bats", batsFile);
    expect(result.notes[0]).toContain("Bats is required for Bash unit");
    expect(result.notes[0]).not.toContain("No Bash tests were found");
  });

  it("returns a failed stage result when Bash binary lookup hits an unexpected error", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-bash-lookup-error-"));
    tempDirs.push(tempDir);

    const batsFile = path.join(tempDir, "example.BATS");
    await writeFile(batsFile, ['@test "passes" {', "  [ 1 -eq 1 ]", "}", ""].join("\n"), "utf8");

    vi.spyOn(ToolRunner.prototype, "resolveBinaryIfAvailable").mockRejectedValue(
      new Error("lookup exploded"),
    );

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [batsFile],
        id: "test:1:unit-bash-lookup-error",
        stageId: "unit",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.notes[0]).toContain("lookup exploded");
    expect(result.diagnostics[0]).toMatchObject({
      file: batsFile,
      severity: "error",
      source: "bats",
    });
    expect(result.toolRuns).toEqual([]);
  });
});
