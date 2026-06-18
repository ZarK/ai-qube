import { describe, expect, it, vi } from "vitest";
import {
  ToolRunner,
  createPowerShellFixtureProject,
  expectPowerShellSetupFailure,
  hasPowerShellPesterToolchain,
  mkdtemp,
  os,
  path,
  runPlannedTask,
  tempDirs,
  writeFile,
} from "./runners-test-support.js";
describe("engine runners", () => {
  it("reports missing PowerShell coverage sources as a setup failure", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-powershell-no-coverage-"));
    tempDirs.push(tempDir);

    const testFile = path.join(tempDir, "utils.tests.ps1");
    await writeFile(
      testFile,
      "Describe 'utils' { It 'passes' { $true | Should -Be $true } }\n",
      "utf8",
    );

    vi.spyOn(ToolRunner.prototype, "resolvePowerShellModuleManifest").mockResolvedValue(
      "/tmp/Pester.psd1",
    );

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [testFile],
        id: "test:1:coverage-powershell-no-sources",
        stageId: "coverage",
      },
      process.cwd(),
    );

    expectPowerShellSetupFailure(result, testFile);
    expect(result.notes[0]).toContain("No PowerShell source files were detected for coverage");
    expect(result.notes[0]).toContain("disable PowerShell coverage");
  });

  it.skipIf(!hasPowerShellPesterToolchain)(
    "runs PowerShell unit tests for script projects when Pester is available",
    async () => {
      const project = await createPowerShellFixtureProject("aiq-powershell-unit-");
      const result = await runPlannedTask(
        {
          fileCount: 1,
          files: [project.sourceFile],
          id: "test:1:unit-powershell",
          stageId: "unit",
        },
        process.cwd(),
      );

      expect(result.status).toBe("passed");
      expect(result.notes[0]).toContain("Pester ran");
      expect(result.toolRuns[0]).toMatchObject({ status: "passed", tool: "pester" });
    },
    60_000,
  );

  it.skipIf(!hasPowerShellPesterToolchain)(
    "runs PowerShell coverage for script projects when Pester is available",
    async () => {
      const project = await createPowerShellFixtureProject("aiq-powershell-coverage-");
      const result = await runPlannedTask(
        {
          fileCount: 1,
          files: [project.sourceFile],
          id: "test:1:coverage-powershell",
          stageId: "coverage",
        },
        process.cwd(),
      );

      expect(result.status).toBe("passed");
      expect(result.notes[0]).toContain("PowerShell coverage lines:");
      expect(result.toolRuns[0]).toMatchObject({ status: "passed", tool: "pester" });
    },
    60_000,
  );
});
