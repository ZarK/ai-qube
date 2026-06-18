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
    "reuses cached Python metrics between sloc, complexity, and maintainability",
    async () => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-python-metrics-runner-"));
      tempDirs.push(tempDir);

      const metricsFile = path.join(tempDir, "metrics.py");
      await writeFile(
        metricsFile,
        [
          "def alpha(value: int) -> int:",
          "    if value > 1:",
          "        return value",
          "    return value + 1",
          "",
        ].join("\n"),
        "utf8",
      );

      const sloc = await runPlannedTask(
        {
          fileCount: 1,
          files: [metricsFile],
          id: "test:1:sloc-python",
          stageId: "sloc",
        },
        process.cwd(),
      );
      const complexity = await runPlannedTask(
        {
          fileCount: 1,
          files: [metricsFile],
          id: "test:1:complexity-python",
          stageId: "complexity",
        },
        process.cwd(),
      );
      const maintainability = await runPlannedTask(
        {
          fileCount: 1,
          files: [metricsFile],
          id: "test:1:maintainability-python",
          stageId: "maintainability",
        },
        process.cwd(),
      );

      expect(sloc.status).toBe("passed");
      expect(sloc.notes[0]).toContain("Python SLOC:");
      expect(sloc.toolRuns[0]).toMatchObject({
        cacheHit: false,
        exitCode: 0,
        status: "passed",
        tool: "radon",
      });
      expect(complexity.status).toBe("passed");
      expect(complexity.notes[0]).toContain("Shared metrics observed");
      expect(complexity.notes.join(" ")).toContain("Reused cached Python metrics");
      expect(complexity.toolRuns[0]).toMatchObject({
        cacheHit: true,
        exitCode: 0,
        status: "passed",
        tool: "radon",
      });
      expect(maintainability.status).toBe("passed");
      expect(maintainability.notes.join(" ")).toContain("Reused cached Python metrics");
      expect(maintainability.toolRuns[0]).toMatchObject({
        cacheHit: true,
        exitCode: 0,
        status: "passed",
        tool: "radon",
      });
    },
  );
});
