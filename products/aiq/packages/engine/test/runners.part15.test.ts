import { describe, expect, it } from "vitest";
import { createCustomJavaScriptRunnerProject, runPlannedTask } from "./runners-test-support.js";
describe("engine runners", () => {
  it("fails JavaScript coverage when the runner exits zero without writing a coverage summary", async () => {
    const project = await createCustomJavaScriptRunnerProject({
      prefix: "aiq-js-missing-coverage-summary-",
      runner: "jest",
      runnerScript: [
        'const fs = require("node:fs");',
        'const outputFile = process.argv.find((arg) => arg.startsWith("--outputFile="));',
        'if (!outputFile) throw new Error("missing --outputFile");',
        'fs.writeFileSync(outputFile.slice("--outputFile=".length), JSON.stringify({ numFailedTests: 0, numPassedTests: 1, numTotalTests: 1, testResults: [] }));',
        "process.exit(0);",
        "",
      ].join("\n"),
    });

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:coverage-js-missing-coverage-summary",
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

  it("fails JavaScript coverage when the runner writes malformed placeholder coverage JSON", async () => {
    const project = await createCustomJavaScriptRunnerProject({
      prefix: "aiq-js-malformed-coverage-summary-",
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
        'fs.writeFileSync(path.join(coverageDirectory.slice("--coverageDirectory=".length), "coverage-summary.json"), JSON.stringify({}));',
        "process.exit(0);",
        "",
      ].join("\n"),
    });

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:coverage-js-malformed-coverage-summary",
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

  it("fails JavaScript coverage when the coverage summary only reports pct without totals", async () => {
    const project = await createCustomJavaScriptRunnerProject({
      prefix: "aiq-js-minimal-coverage-summary-",
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
        'fs.writeFileSync(path.join(coverageDirectory.slice("--coverageDirectory=".length), "coverage-summary.json"), JSON.stringify({ total: { lines: { pct: 100 } } }));',
        "process.exit(0);",
        "",
      ].join("\n"),
    });

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:coverage-js-minimal-coverage-summary",
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
});
