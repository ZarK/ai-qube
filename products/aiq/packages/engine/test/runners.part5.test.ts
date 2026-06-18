import { describe, expect, it } from "vitest";
import {
  hasPythonQualityToolchain,
  mkdtemp,
  os,
  path,
  runPlannedTask,
  tempDirs,
  writeFile,
} from "./runners-test-support.js";
describe("engine runners", () => {
  it("runs SQL format checks and reports formatting diagnostics", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-sql-format-runner-"));
    tempDirs.push(tempDir);

    const badSqlFile = path.join(tempDir, "bad.sql");
    await writeFile(badSqlFile, "SELECT id, name FROM users WHERE active = 1;\n", "utf8");

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [badSqlFile],
        id: "test:1:format-sql",
        stageId: "format",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.diagnostics[0]).toMatchObject({
      file: badSqlFile,
      severity: "error",
      source: "sql-formatter",
    });
    expect(result.toolRuns[0]).toMatchObject({
      args: [badSqlFile],
      exitCode: 1,
      status: "failed",
      tool: "sql-formatter",
    });
  });

  it.skipIf(!hasPythonQualityToolchain)(
    "runs Ruff lint and returns structured diagnostics for Python files",
    async () => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-python-lint-runner-"));
      tempDirs.push(tempDir);

      const badPythonFile = path.join(tempDir, "bad.py");
      await writeFile(badPythonFile, "import os\n", "utf8");

      const result = await runPlannedTask(
        {
          fileCount: 1,
          files: [badPythonFile],
          id: "test:1:lint-python",
          stageId: "lint",
        },
        process.cwd(),
      );

      expect(result.status).toBe("failed");
      expect(result.diagnostics[0]).toMatchObject({
        code: "F401",
        file: badPythonFile,
        severity: "error",
        source: "ruff",
      });
      expect(result.toolRuns[0]).toMatchObject({
        exitCode: 1,
        status: "failed",
        tool: "ruff",
      });
    },
  );

  it.skipIf(!hasPythonQualityToolchain)(
    "runs Ruff format on Python files and reports formatting diagnostics",
    async () => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-python-format-runner-"));
      tempDirs.push(tempDir);

      const badPythonFile = path.join(tempDir, "bad.py");
      await writeFile(badPythonFile, "x=1\n", "utf8");

      const result = await runPlannedTask(
        {
          fileCount: 1,
          files: [badPythonFile],
          id: "test:1:format-python",
          stageId: "format",
        },
        process.cwd(),
      );

      expect(result.status).toBe("failed");
      expect(result.diagnostics[0]).toMatchObject({
        file: badPythonFile,
        severity: "error",
        source: "ruff",
      });
      expect(result.toolRuns[0]).toMatchObject({
        exitCode: 1,
        status: "failed",
        tool: "ruff",
      });
    },
  );
});
