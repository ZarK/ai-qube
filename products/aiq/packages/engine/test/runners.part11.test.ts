import { describe, expect, it } from "vitest";
import { createCustomJavaScriptRunnerProject, runPlannedTask } from "./runners-test-support.js";
describe("engine runners", () => {
  it("keeps stray tsconfig.json selections out of JavaScript unit and coverage fallback routing", async () => {
    const project = await createCustomJavaScriptRunnerProject({
      prefix: "aiq-js-stray-json-selection-",
      runner: "jest",
      runnerScript: "process.exit(0);\n",
    });

    for (const stageId of ["unit", "coverage"] as const) {
      const result = await runPlannedTask(
        {
          fileCount: 1,
          files: [project.tsconfigPath],
          id: `test:1:${stageId}-js-stray-json-selection`,
          stageId,
        },
        process.cwd(),
      );

      expect(result.status).toBe("passed");
      expect(result.diagnostics).toEqual([]);
      expect(result.notes).toEqual([`No supported files were selected for ${stageId}.`]);
      expect(result.toolRuns).toEqual([]);
    }
  });

  it("fails JavaScript unit when the runner exits zero without writing a JSON report", async () => {
    const project = await createCustomJavaScriptRunnerProject({
      prefix: "aiq-js-missing-report-",
      runner: "jest",
      runnerScript: "process.exit(0);\n",
    });

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:unit-js-missing-report",
        stageId: "unit",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.notes[0]).toContain("Expected test report at");
    expect(result.diagnostics[0]).toMatchObject({
      file: project.sourceFile,
      severity: "error",
      source: "test-runner",
    });
    expect(result.toolRuns).toEqual([]);
  });

  it("fails JavaScript unit when the runner writes malformed placeholder test JSON", async () => {
    const project = await createCustomJavaScriptRunnerProject({
      prefix: "aiq-js-malformed-report-",
      runner: "jest",
      runnerScript: [
        'const fs = require("node:fs");',
        'const outputFile = process.argv.find((arg) => arg.startsWith("--outputFile="));',
        'if (!outputFile) throw new Error("missing --outputFile");',
        'fs.writeFileSync(outputFile.slice("--outputFile=".length), JSON.stringify({}));',
        "process.exit(0);",
        "",
      ].join("\n"),
    });

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:unit-js-malformed-report",
        stageId: "unit",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.notes[0]).toContain("Expected test report at");
    expect(result.notes[0]).toContain("test summary fields");
    expect(result.diagnostics[0]).toMatchObject({
      file: project.sourceFile,
      severity: "error",
      source: "test-runner",
    });
    expect(result.toolRuns).toEqual([]);
  });

  it("fails JavaScript unit when testResults contains non-object entries", async () => {
    const project = await createCustomJavaScriptRunnerProject({
      prefix: "aiq-js-invalid-test-results-array-",
      runner: "jest",
      runnerScript: [
        'const fs = require("node:fs");',
        'const outputFile = process.argv.find((arg) => arg.startsWith("--outputFile="));',
        'if (!outputFile) throw new Error("missing --outputFile");',
        'fs.writeFileSync(outputFile.slice("--outputFile=".length), JSON.stringify({ numFailedTests: 0, numPassedTests: 1, numTotalTests: 1, testResults: [1] }));',
        "process.exit(0);",
        "",
      ].join("\n"),
    });

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:unit-js-invalid-test-results-array",
        stageId: "unit",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.notes[0]).toContain("Expected test report at");
    expect(result.notes[0]).toContain("test summary fields");
    expect(result.diagnostics[0]).toMatchObject({
      file: project.sourceFile,
      severity: "error",
      source: "test-runner",
    });
    expect(result.toolRuns).toEqual([]);
  });
});
