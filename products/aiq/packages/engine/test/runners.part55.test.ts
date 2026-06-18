import { describe, expect, it, vi } from "vitest";
import {
  ToolRunner,
  buildEngineContext,
  createPowerShellFixtureProject,
  runPlannedTask,
  withToolRunnerOverride,
  writeFile,
} from "./runners-test-support.js";
describe("engine runners", () => {
  it("serializes a summarized Pester unit result instead of the raw object", async () => {
    const project = await createPowerShellFixtureProject("aiq-powershell-unit-summary-");
    const toolRunner = new ToolRunner();
    vi.spyOn(toolRunner, "resolvePowerShellModuleManifest").mockResolvedValue("/tmp/Pester.psd1");
    const runSpy = vi
      .spyOn(toolRunner, "runPowerShellScript")
      .mockImplementation(async (script) => {
        expect(script).toContain("TotalCount = $result.TotalCount");
        expect(script).toContain("PassedCount = $result.PassedCount");
        expect(script).toContain("FailedCount = $result.FailedCount");
        expect(script).not.toContain("$result | ConvertTo-Json -Depth 8 -Compress");

        const junitPath = script.match(/OutputPath = '([^']+junit\.xml)'/)?.[1];
        if (junitPath === undefined) {
          throw new Error(`Expected junit output path in script: ${script}`);
        }

        await writeFile(
          junitPath,
          '<testsuite tests="2" failures="0" errors="0" skipped="0"></testsuite>',
          "utf8",
        );

        const timestamp = new Date().toISOString();
        return {
          durationMs: 5,
          exitCode: 0,
          finishedAt: timestamp,
          startedAt: timestamp,
          stderr: "",
          stdout: '{"TotalCount":2,"PassedCount":2,"FailedCount":0}',
        };
      });

    const engineContext = withToolRunnerOverride(
      await buildEngineContext({
        context: "cli",
        manifest: {
          files: [project.sourceFile],
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
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:unit-powershell-summary",
        stageId: "unit",
      },
      engineContext,
    );

    expect(result.status).toBe("passed");
    expect(result.diagnostics).toEqual([]);
    expect(result.notes).toEqual(["Pester ran 2 tests: 2 passed, 0 failed."]);
    expect(runSpy).toHaveBeenCalledOnce();
    expect(result.toolRuns[0]).toMatchObject({
      exitCode: 0,
      status: "passed",
      tool: "pester",
    });
  });
});
