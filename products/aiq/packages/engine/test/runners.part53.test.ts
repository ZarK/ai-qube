import { describe, expect, it, vi } from "vitest";
import {
  ToolRunner,
  buildEngineContext,
  createPowerShellFixtureProject,
  expectPowerShellSetupFailure,
  mkdtemp,
  os,
  path,
  rm,
  runPlannedTask,
  tempDirs,
  withToolRunnerOverride,
  writeFile,
} from "./runners-test-support.js";
describe("engine runners", () => {
  it("runs PowerShell lint successfully across multiple selected files", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-powershell-lint-success-"));
    tempDirs.push(tempDir);

    const firstFile = path.join(tempDir, "first.ps1");
    const secondFile = path.join(tempDir, "second.ps1");
    await Promise.all([
      writeFile(firstFile, "Write-Host 'first'\n", "utf8"),
      writeFile(secondFile, "Write-Host 'second'\n", "utf8"),
    ]);

    const toolRunner = new ToolRunner();
    vi.spyOn(toolRunner, "resolveRequiredPowerShellModuleManifest").mockResolvedValue(
      "/tmp/PSScriptAnalyzer.psd1",
    );
    const runSpy = vi
      .spyOn(toolRunner, "runPowerShellScript")
      .mockImplementation(async (script) => {
        expect(script).toContain("$results = foreach ($path in $paths) {");
        expect(script).toContain("Invoke-ScriptAnalyzer -Path $path");
        expect(script).not.toContain("Invoke-ScriptAnalyzer -Path $paths");
        expect(script).toContain(firstFile);
        expect(script).toContain(secondFile);

        const timestamp = new Date().toISOString();
        return {
          durationMs: 5,
          exitCode: 0,
          finishedAt: timestamp,
          startedAt: timestamp,
          stderr: "",
          stdout: "[]",
        };
      });

    const engineContext = withToolRunnerOverride(
      await buildEngineContext({
        context: "cli",
        manifest: {
          files: [firstFile, secondFile],
          source: "direct",
        },
        mode: "check",
        outDir: tempDir,
        stages: ["lint"],
      }),
      toolRunner,
    );

    const result = await runPlannedTask(
      {
        fileCount: 2,
        files: [firstFile, secondFile],
        id: "test:1:lint-powershell-success-multi-file",
        stageId: "lint",
      },
      engineContext,
    );

    expect(result.status).toBe("passed");
    expect(result.diagnostics).toEqual([]);
    expect(result.notes).toEqual(["PSScriptAnalyzer passed."]);
    expect(runSpy).toHaveBeenCalledOnce();
    expect(result.toolRuns[0]).toMatchObject({
      exitCode: 0,
      status: "passed",
      tool: "psscriptanalyzer",
    });
  });

  it("returns a failed stage result when a later selected PowerShell format file cannot be read", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-powershell-missing-format-file-"));
    tempDirs.push(tempDir);

    const existingFile = path.join(tempDir, "existing.ps1");
    const missingFile = path.join(tempDir, "missing.ps1");
    await writeFile(existingFile, "Write-Host 'hello'\n", "utf8");
    await writeFile(missingFile, "Write-Host 'missing'\n", "utf8");
    await rm(missingFile);

    const result = await runPlannedTask(
      {
        fileCount: 2,
        files: [existingFile, missingFile],
        id: "test:1:format-powershell-missing-file",
        stageId: "format",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.notes[0]).toContain("ENOENT");
    expect(result.diagnostics[0]).toMatchObject({
      file: missingFile,
      severity: "error",
      source: "invoke-formatter",
    });
    expect(result.toolRuns).toEqual([]);
  });

  it("reports missing Pester as a PowerShell unit setup failure", async () => {
    const project = await createPowerShellFixtureProject("aiq-powershell-missing-pester-");

    vi.spyOn(ToolRunner.prototype, "resolvePowerShellModuleManifest").mockResolvedValue(undefined);

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:unit-powershell-missing-pester",
        stageId: "unit",
      },
      process.cwd(),
    );

    expectPowerShellSetupFailure(result, project.sourceFile);
    expect(result.notes[0]).toContain("Pester is required for PowerShell unit");
    expect(result.notes[0]).toContain("Install Pester");
  });
});
