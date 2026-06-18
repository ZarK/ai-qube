import { describe, expect, it } from "vitest";
import {
  createCustomPythonRunnerProject,
  fixturePythonConfigFile,
  hasPythonQualityToolchain,
  path,
  readFile,
  runEngine,
  runPlannedTask,
  withPathedPythonShim,
} from "./runners-test-support.js";
describe("engine runners", () => {
  it.skipIf(!hasPythonQualityToolchain)(
    "runs Pytest unit tests for config-only Python selections",
    async () => {
      const result = await runPlannedTask(
        {
          fileCount: 1,
          files: [fixturePythonConfigFile],
          id: "test:1:unit-python-config-only",
          stageId: "unit",
        },
        process.cwd(),
      );

      expect(result.status).toBe("passed");
      expect(result.diagnostics).toEqual([]);
      expect(result.notes[0]).toBe("Pytest ran 3 tests: 3 passed, 0 failed.");
      expect(result.toolRuns[0]).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "pytest",
      });
    },
  );

  it.skipIf(!hasPythonQualityToolchain)(
    "runs Python metrics for config-only selections",
    async () => {
      const result = await runPlannedTask(
        {
          fileCount: 1,
          files: [fixturePythonConfigFile],
          id: "test:1:complexity-python-config-only",
          stageId: "complexity",
        },
        process.cwd(),
      );

      expect(result.status).toBe("passed");
      expect(result.diagnostics).toEqual([]);
      expect(result.notes[0]).toContain("Python complexity max:");
      expect(result.toolRuns[0]).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "radon",
      });
    },
  );

  it("reuses Python coverage execution across unit and coverage in one engine run", async () => {
    const project = await createCustomPythonRunnerProject({
      prefix: "aiq-python-coverage-reuse-",
      runnerScript: [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        "const args = process.argv.slice(2);",
        'const junitPath = args[args.indexOf("--junitxml") + 1];',
        'const coverageArgIndex = args.indexOf("--cov-report");',
        "const coverageArg = coverageArgIndex >= 0 ? args[coverageArgIndex + 1] : undefined;",
        'const coveragePath = coverageArg && coverageArg.startsWith("json:") ? coverageArg.slice("json:".length) : undefined;',
        'const countFile = path.join(process.cwd(), "invocations.txt");',
        'const count = Number(fs.existsSync(countFile) ? fs.readFileSync(countFile, "utf8") : "0") + 1;',
        "fs.writeFileSync(countFile, String(count));",
        'fs.writeFileSync(junitPath, \'<testsuite tests="1" failures="0" errors="0" skipped="0"></testsuite>\');',
        "if (coveragePath) {",
        "  fs.mkdirSync(path.dirname(coveragePath), { recursive: true });",
        "  fs.writeFileSync(coveragePath, JSON.stringify({ totals: { percent_covered: 100 } }));",
        "}",
        "process.exit(0);",
        "",
      ].join("\n"),
    });

    const result = await withPathedPythonShim(project.shimDir, async () =>
      runEngine({
        context: "cli",
        cwd: project.root,
        manifest: {
          files: [project.sourceFile],
          source: "direct",
        },
        mode: "check",
        outDir: path.join(project.root, ".aiq", "out"),
        stages: ["unit", "coverage"],
        writeArtifacts: false,
      }),
    );

    const unitStage = result.stages.find((stage) => stage.stageId === "unit");
    const coverageStage = result.stages.find((stage) => stage.stageId === "coverage");

    expect(result.summary.status).toBe("passed");
    expect(unitStage).toMatchObject({ stageId: "unit", status: "passed" });
    expect(unitStage?.notes[0]).toContain("Pytest ran 1 test");
    expect(unitStage?.toolRuns[0]).toMatchObject({
      cacheHit: false,
      exitCode: 0,
      status: "passed",
      tool: "pytest-cov",
    });
    expect(coverageStage).toMatchObject({ stageId: "coverage", status: "passed" });
    expect(coverageStage?.notes[0]).toContain("Pytest coverage lines: 100.0%");
    expect(coverageStage?.toolRuns[0]).toMatchObject({
      cacheHit: true,
      durationMs: 0,
      exitCode: 0,
      status: "passed",
      tool: "pytest-cov",
    });
    expect(await readFile(path.join(project.root, "invocations.txt"), "utf8")).toBe("1");
  });
});
