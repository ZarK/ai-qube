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
  it.skipIf(!hasPythonQualityToolchain)(
    "invalidates cached Python metrics when the file contents change",
    async () => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-python-metrics-refresh-"));
      tempDirs.push(tempDir);

      const metricsFile = path.join(tempDir, "metrics.py");
      await writeFile(metricsFile, "value = 1\n", "utf8");

      const firstComplexity = await runPlannedTask(
        {
          fileCount: 1,
          files: [metricsFile],
          id: "test:1:complexity-python-invalidate:first",
          stageId: "complexity",
        },
        process.cwd(),
      );

      await writeFile(
        metricsFile,
        [
          "def beta(value: int) -> int:",
          "    if value > 2:",
          "        return value",
          "    return value + 2",
          "",
        ].join("\n"),
        "utf8",
      );

      const secondComplexity = await runPlannedTask(
        {
          fileCount: 1,
          files: [metricsFile],
          id: "test:1:complexity-python-invalidate:second",
          stageId: "complexity",
        },
        process.cwd(),
      );

      expect(firstComplexity.status).toBe("passed");
      expect(firstComplexity.notes[0]).toContain("no functions or classes were detected");
      expect(firstComplexity.toolRuns[0]).toMatchObject({
        cacheHit: false,
        exitCode: 0,
        status: "passed",
        tool: "radon",
      });
      expect(secondComplexity.status).toBe("passed");
      expect(secondComplexity.notes[0]).toContain("Python complexity max:");
      expect(secondComplexity.toolRuns[0]).toMatchObject({
        cacheHit: false,
        exitCode: 0,
        status: "passed",
        tool: "radon",
      });
    },
  );

  it.skipIf(!hasPythonQualityToolchain)(
    "invalidates cached Python metrics when Radon-compatible config changes",
    async () => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-python-radon-config-refresh-"));
      tempDirs.push(tempDir);

      const metricsFile = path.join(tempDir, "metrics.py");
      await writeFile(metricsFile, "value = 1\n", "utf8");

      const firstComplexity = await runPlannedTask(
        {
          fileCount: 1,
          files: [metricsFile],
          id: "test:1:complexity-python-radon-config:first",
          stageId: "complexity",
        },
        process.cwd(),
      );

      await writeFile(path.join(tempDir, "pyproject.toml"), "[tool.radon]\n", "utf8");

      const secondComplexity = await runPlannedTask(
        {
          fileCount: 1,
          files: [metricsFile],
          id: "test:1:complexity-python-radon-config:second",
          stageId: "complexity",
        },
        process.cwd(),
      );

      expect(firstComplexity.status).toBe("passed");
      expect(firstComplexity.toolRuns[0]).toMatchObject({
        cacheHit: false,
        exitCode: 0,
        status: "passed",
        tool: "radon",
      });
      expect(secondComplexity.status).toBe("passed");
      expect(secondComplexity.toolRuns[0]).toMatchObject({
        cacheHit: false,
        exitCode: 0,
        status: "passed",
        tool: "radon",
      });
    },
  );
});
