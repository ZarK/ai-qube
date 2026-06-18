import { describe, expect, it } from "vitest";
import { createCustomJavaScriptRunnerProject, runPlannedTask } from "./runners-test-support.js";
describe("engine runners", () => {
  it("fails JavaScript coverage when the runner summary reports failures despite exit code 0", async () => {
    const project = await createCustomJavaScriptRunnerProject({
      prefix: "aiq-js-coverage-semantic-failure-report-",
      runner: "jest",
      runnerScript: [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'const outputFile = process.argv.find((arg) => arg.startsWith("--outputFile="));',
        'const coverageDirectory = process.argv.find((arg) => arg.startsWith("--coverageDirectory="));',
        'if (!outputFile) throw new Error("missing --outputFile");',
        'if (!coverageDirectory) throw new Error("missing --coverageDirectory");',
        'fs.writeFileSync(outputFile.slice("--outputFile=".length), JSON.stringify({ numFailedTests: 1, numPassedTests: 0, numTotalTests: 1, testResults: [] }));',
        'fs.mkdirSync(coverageDirectory.slice("--coverageDirectory=".length), { recursive: true });',
        'fs.writeFileSync(path.join(coverageDirectory.slice("--coverageDirectory=".length), "coverage-summary.json"), JSON.stringify({ total: { lines: { total: 10, covered: 9, skipped: 0, pct: 90 } } }));',
        "process.exit(0);",
        "",
      ].join("\n"),
    });

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:coverage-js-semantic-failure-report",
        stageId: "coverage",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.notes[0]).toContain("1 failed");
    expect(result.diagnostics[0]).toMatchObject({
      file: project.sourceFile,
      message: "Jest reported 1 failing test in its summary.",
      severity: "error",
      source: "jest",
    });
    expect(result.toolRuns).toEqual([
      expect.objectContaining({ exitCode: 0, status: "failed", tool: "jest" }),
    ]);
  });

  it("fails JavaScript coverage when the coverage summary carries impossible totals", async () => {
    const project = await createCustomJavaScriptRunnerProject({
      prefix: "aiq-js-impossible-coverage-totals-",
      runner: "jest",
      runnerScript: [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'const outputFile = process.argv.find((arg) => arg.startsWith("--outputFile="));',
        'const coverageDirectory = process.argv.find((arg) => arg.startsWith("--coverageDirectory="));',
        'if (!outputFile) throw new Error("missing --outputFile");',
        'if (!coverageDirectory) throw new Error("missing --coverageDirectory");',
        'fs.writeFileSync(outputFile.slice("--outputFile=".length), JSON.stringify({ numFailedTests: 0, numPassedTests: 1, numTotalTests: 1, testResults: [] }));',
        'fs.mkdirSync(coverageDirectory.slice("--coverageDirectory=".length), { recursive: true });',
        'fs.writeFileSync(path.join(coverageDirectory.slice("--coverageDirectory=".length), "coverage-summary.json"), JSON.stringify({ total: { lines: { total: 10, covered: 9, skipped: 2, pct: 110 } } }));',
        "process.exit(0);",
        "",
      ].join("\n"),
    });

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:coverage-js-impossible-coverage-totals",
        stageId: "coverage",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.notes[0]).toContain("Expected coverage summary at");
    expect(result.notes[0]).toContain("total line coverage");
    expect(result.diagnostics[0]).toMatchObject({
      file: project.sourceFile,
      severity: "error",
      source: "test-coverage",
    });
    expect(result.toolRuns).toEqual([]);
  });

  it("fails JavaScript coverage when the coverage percentage disagrees with the line counts", async () => {
    const project = await createCustomJavaScriptRunnerProject({
      prefix: "aiq-js-coverage-pct-mismatch-",
      runner: "jest",
      runnerScript: [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'const outputFile = process.argv.find((arg) => arg.startsWith("--outputFile="));',
        'const coverageDirectory = process.argv.find((arg) => arg.startsWith("--coverageDirectory="));',
        'if (!outputFile) throw new Error("missing --outputFile");',
        'if (!coverageDirectory) throw new Error("missing --coverageDirectory");',
        'fs.writeFileSync(outputFile.slice("--outputFile=".length), JSON.stringify({ numFailedTests: 0, numPassedTests: 1, numTotalTests: 1, testResults: [] }));',
        'fs.mkdirSync(coverageDirectory.slice("--coverageDirectory=".length), { recursive: true });',
        'fs.writeFileSync(path.join(coverageDirectory.slice("--coverageDirectory=".length), "coverage-summary.json"), JSON.stringify({ total: { lines: { total: 10, covered: 1, skipped: 0, pct: 99 } } }));',
        "process.exit(0);",
        "",
      ].join("\n"),
    });

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:coverage-js-pct-mismatch",
        stageId: "coverage",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.notes[0]).toContain("Expected coverage summary at");
    expect(result.diagnostics[0]).toMatchObject({
      file: project.sourceFile,
      severity: "error",
      source: "test-coverage",
    });
    expect(result.toolRuns).toEqual([]);
  });
});
