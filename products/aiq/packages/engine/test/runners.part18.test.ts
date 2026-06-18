import { describe, expect, it } from "vitest";
import {
  createCustomJavaScriptRunnerProject,
  fixtureFile,
  fixtureJavaScriptFile,
  runPlannedTask,
} from "./runners-test-support.js";
describe("engine runners", () => {
  it("fails JavaScript coverage when the percentage is only a near miss of an allowed rounded value", async () => {
    const project = await createCustomJavaScriptRunnerProject({
      prefix: "aiq-js-near-miss-coverage-pct-",
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
        'fs.writeFileSync(path.join(coverageDirectory.slice("--coverageDirectory=".length), "coverage-summary.json"), JSON.stringify({ total: { lines: { total: 10, covered: 1, skipped: 0, pct: 10.00009 } } }));',
        "process.exit(0);",
        "",
      ].join("\n"),
    });

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:coverage-js-near-miss-coverage-pct",
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

  it("reuses cached JavaScript and TypeScript metrics between sloc, complexity, and maintainability", async () => {
    const sloc = await runPlannedTask(
      {
        fileCount: 2,
        files: [fixtureFile, fixtureJavaScriptFile],
        id: "test:1:sloc-js-ts",
        stageId: "sloc",
      },
      process.cwd(),
    );
    const complexity = await runPlannedTask(
      {
        fileCount: 2,
        files: [fixtureFile, fixtureJavaScriptFile],
        id: "test:1:complexity-js-ts",
        stageId: "complexity",
      },
      process.cwd(),
    );
    const maintainability = await runPlannedTask(
      {
        fileCount: 2,
        files: [fixtureFile, fixtureJavaScriptFile],
        id: "test:1:maintainability-js-ts",
        stageId: "maintainability",
      },
      process.cwd(),
    );
    const slocLizardRuns = sloc.toolRuns.filter(
      (toolRun) =>
        toolRun.cacheHit === false &&
        toolRun.exitCode === 0 &&
        toolRun.status === "passed" &&
        toolRun.tool === "lizard",
    );
    const complexityLizardRuns = complexity.toolRuns.filter(
      (toolRun) =>
        toolRun.cacheHit === true &&
        toolRun.exitCode === 0 &&
        toolRun.status === "passed" &&
        toolRun.tool === "lizard",
    );
    const maintainabilityLizardRuns = maintainability.toolRuns.filter(
      (toolRun) =>
        toolRun.cacheHit === true &&
        toolRun.exitCode === 0 &&
        toolRun.status === "passed" &&
        toolRun.tool === "lizard",
    );

    expect(sloc.status).toBe("passed");
    expect(sloc.notes[0]).toContain("JavaScript/TypeScript SLOC:");
    expect(slocLizardRuns).toHaveLength(2);
    expect(complexity.status).toBe("passed");
    expect(complexity.notes[0]).toContain("Shared metrics observed");
    expect(complexity.notes.join(" ")).toContain("Reused cached JavaScript/TypeScript metrics");
    expect(complexityLizardRuns).toHaveLength(2);
    expect(maintainability.status).toBe("passed");
    expect(maintainability.notes.join(" ")).toContain(
      "Reused cached JavaScript/TypeScript metrics",
    );
    expect(maintainabilityLizardRuns).toHaveLength(2);
  });
});
