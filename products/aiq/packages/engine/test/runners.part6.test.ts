import { describe, expect, it, vi } from "vitest";
import * as hostTools from "../src/tools/host-tools.js";
import {
  os,
  path,
  ToolRunner,
  buildEngineContext,
  hasPythonQualityToolchain,
  mkdtemp,
  runPlannedTask,
  tempDirs,
  withToolRunnerOverride,
  writeFile,
} from "./runners-test-support.js";
describe("engine runners", () => {
  it.skipIf(!hasPythonQualityToolchain)(
    "runs Python typecheck and parses ty GitLab diagnostics",
    async () => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-python-typecheck-runner-"));
      tempDirs.push(tempDir);

      const badPythonFile = path.join(tempDir, "bad.py");
      await writeFile(badPythonFile, "value: str = 42\n", "utf8");

      const result = await runPlannedTask(
        {
          fileCount: 1,
          files: [badPythonFile],
          id: "test:1:typecheck-python",
          stageId: "typecheck",
        },
        process.cwd(),
      );

      expect(result.status).toBe("failed");
      expect(result.diagnostics[0]).toMatchObject({
        file: badPythonFile,
        message: expect.stringContaining("Object of type `Literal[42]` is not assignable to `str`"),
        severity: "error",
        source: "ty",
      });
      expect(result.diagnostics[0]?.range).toMatchObject({
        startColumn: 14,
        startLine: 1,
      });
      expect(result.toolRuns[0]).toMatchObject({
        exitCode: 1,
        status: "failed",
        tool: "ty",
      });
    },
  );

  it("passes the resolved Python interpreter to ty", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-python-typecheck-command-"));
    tempDirs.push(tempDir);

    const pythonFile = path.join(tempDir, "main.py");
    await writeFile(pythonFile, "value: str = 'ok'\n", "utf8");

    const toolRunner = new ToolRunner();
    const runSpy = vi.spyOn(toolRunner, "run").mockResolvedValue({
      durationMs: 5,
      exitCode: 0,
      finishedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      stderr: "",
      stdout: "[]",
    });

    vi.spyOn(hostTools, "requirePathCommand").mockResolvedValue("/tmp/fake-ty");
    vi.spyOn(hostTools, "resolvePythonInterpreter").mockResolvedValue("/tmp/fake-python");

    const engineContext = withToolRunnerOverride(
      await buildEngineContext({
        context: "cli",
        manifest: {
          files: [pythonFile],
          source: "direct",
        },
        mode: "check",
        outDir: tempDir,
        stages: ["typecheck"],
      }),
      toolRunner,
    );

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [pythonFile],
        id: "test:1:typecheck-python-command",
        stageId: "typecheck",
      },
      engineContext,
    );

    expect(result.status).toBe("passed");
    expect(runSpy).toHaveBeenCalledWith(
      "/tmp/fake-ty",
      [
        "check",
        "--python",
        "/tmp/fake-python",
        "--output-format",
        "gitlab",
        "--no-progress",
        "--color",
        "never",
        pythonFile,
      ],
      expect.objectContaining({ cwd: tempDir }),
    );
  });
});
