import { describe, expect, it, vi } from "vitest";
import {
  ToolRunner,
  buildEngineContext,
  fixtureFile,
  mkdtemp,
  os,
  path,
  runPlannedTask,
  tempDirs,
  withToolRunnerOverride,
  writeFile,
} from "./runners-test-support.js";
describe("engine runners", () => {
  it("falls back to uv tool run ty when ty is not directly installed", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-python-typecheck-uv-"));
    tempDirs.push(tempDir);

    const pythonFile = path.join(tempDir, "main.py");
    await writeFile(pythonFile, "value: str = 'ok'\n", "utf8");

    const toolRunner = new ToolRunner();
    const pythonCommand = process.platform === "win32" ? "python" : "python3";
    const tyCommand = process.platform === "win32" ? "ty.exe" : "ty";
    const runSpy = vi.spyOn(toolRunner, "run").mockImplementation(async (command, args) => {
      if (command === (process.platform === "win32" ? "where" : "which") && args[0] === tyCommand) {
        return {
          durationMs: 5,
          exitCode: 1,
          finishedAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          stderr: "",
          stdout: "",
        };
      }

      return {
        durationMs: 5,
        exitCode: 0,
        finishedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        stderr: "",
        stdout: "[]",
      };
    });

    vi.spyOn(toolRunner, "resolveInstalledBinary").mockImplementation(async (commandName) => {
      if (commandName === pythonCommand) {
        return "/tmp/fake-python";
      }

      if (commandName === (process.platform === "win32" ? "uv.exe" : "uv")) {
        return "/tmp/fake-uv";
      }

      return undefined;
    });

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
        id: "test:1:typecheck-python-command-via-uv",
        stageId: "typecheck",
      },
      engineContext,
    );

    expect(result.status).toBe("passed");
    expect(runSpy).toHaveBeenCalledWith(
      "/tmp/fake-uv",
      ["tool", "run", "ty", "--version"],
      expect.objectContaining({ cwd: process.cwd() }),
    );
    expect(runSpy).toHaveBeenCalledWith(
      "/tmp/fake-uv",
      [
        "tool",
        "run",
        "ty",
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

  it("runs Vitest unit tests for TypeScript projects", async () => {
    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [fixtureFile],
        id: "test:1:unit",
        stageId: "unit",
      },
      process.cwd(),
    );

    expect(result.status).toBe("passed");
    expect(result.diagnostics).toEqual([]);
    expect(result.notes[0]).toContain("Vitest ran");
    expect(result.toolRuns[0]).toMatchObject({
      exitCode: 0,
      status: "passed",
      tool: "vitest",
    });
  }, 20_000);
});
