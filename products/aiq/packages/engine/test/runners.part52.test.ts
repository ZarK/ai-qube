import { describe, expect, it, vi } from "vitest";
import {
  ToolRunner,
  commandAvailable,
  createBashFixtureProject,
  expectBashSetupFailure,
  mkdtemp,
  os,
  path,
  runPlannedTask,
  tempDirs,
  writeFile,
} from "./runners-test-support.js";
describe("engine runners", () => {
  it("runs Bash unit tests for script projects", async () => {
    const project = await createBashFixtureProject("aiq-bash-unit-");
    const hasBats = commandAvailable("bats");

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:unit-bash",
        stageId: "unit",
      },
      process.cwd(),
    );

    if (!hasBats) {
      expectBashSetupFailure(result, "bats", project.sourceFile);
      expect(result.notes[0]).toContain("Bats is required for Bash unit");
      return;
    }

    expect(result.status).toBe("passed");
    expect(result.notes[0]).toContain("Bats ran");
    expect(result.toolRuns[0]).toMatchObject({ status: "passed", tool: "bats" });
  }, 30_000);

  it("runs Bash coverage for script projects when kcov is available", async () => {
    const project = await createBashFixtureProject("aiq-bash-coverage-");
    const hasBats = commandAvailable("bats");
    const hasKcov = commandAvailable("kcov");

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:coverage-bash",
        stageId: "coverage",
      },
      process.cwd(),
    );

    if (!hasBats || !hasKcov) {
      expectBashSetupFailure(result, hasBats ? "kcov" : "bats", project.sourceFile);
      return;
    }

    expect(result.status).toBe("passed");
    expect(result.notes[0]).toContain("Bash coverage lines:");
    expect(result.toolRuns[0]).toMatchObject({ status: "passed", tool: "kcov" });
  }, 30_000);

  it("reports missing kcov as a Bash coverage setup failure", async () => {
    const project = await createBashFixtureProject("aiq-bash-missing-kcov-");

    vi.spyOn(ToolRunner.prototype, "resolveBinaryIfAvailable").mockImplementation(
      async (commands) => {
        if (commands.some((command) => command.includes("bats"))) {
          return "bats";
        }

        if (commands.some((command) => command.includes("kcov"))) {
          return undefined;
        }

        return undefined;
      },
    );

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:coverage-bash-missing-kcov",
        stageId: "coverage",
      },
      process.cwd(),
    );

    expectBashSetupFailure(result, "kcov", project.sourceFile);
    expect(result.notes[0]).toContain("kcov is required for Bash coverage");
    expect(result.notes[0]).toContain("disable Bash coverage");
  });

  it("returns a failed stage result when PSScriptAnalyzer is missing for PowerShell lint", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-powershell-missing-module-"));
    tempDirs.push(tempDir);

    const powerShellFile = path.join(tempDir, "script.ps1");
    await writeFile(powerShellFile, "Write-Host 'hello'\n", "utf8");

    vi.spyOn(ToolRunner.prototype, "resolveRequiredPowerShellModuleManifest").mockRejectedValue(
      new Error(
        "PSScriptAnalyzer was not detected. Install PSScriptAnalyzer to enable this PowerShell stage.",
      ),
    );

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [powerShellFile],
        id: "test:1:lint-powershell-missing-module",
        stageId: "lint",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.notes[0]).toContain("PSScriptAnalyzer was not detected");
    expect(result.diagnostics[0]).toMatchObject({
      file: powerShellFile,
      severity: "error",
      source: "psscriptanalyzer",
    });
    expect(result.toolRuns).toEqual([]);
  });
});
