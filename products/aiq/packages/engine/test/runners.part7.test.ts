import { describe, expect, it } from "vitest";
import {
  os,
  path,
  fixtureFile,
  mkdtemp,
  runPlannedTask,
  tempDirs,
  writeFile,
} from "./runners-test-support.js";
describe("engine runners", () => {
  it("fails Python typecheck when ty is absent from PATH", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-python-typecheck-missing-"));
    tempDirs.push(tempDir);
    const pythonFile = path.join(tempDir, "main.py");
    await writeFile(pythonFile, "value: str = 'ok'\n", "utf8");
    const previousPath = process.env.PATH;
    process.env.PATH = "";
    try {
      const result = await runPlannedTask(
        {
          fileCount: 1,
          files: [pythonFile],
          id: "typecheck:python",
          stageId: "typecheck",
        },
        tempDir,
      );
      expect(result.status).toBe("failed");
      expect(result.diagnostics[0]?.message).toContain("ty was not detected on PATH");
    } finally {
      if (previousPath === undefined) {
        Reflect.deleteProperty(process.env, "PATH");
      } else {
        process.env.PATH = previousPath;
      }
    }
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
