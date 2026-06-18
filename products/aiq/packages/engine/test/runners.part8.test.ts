import { describe, expect, it } from "vitest";
import {
  createCustomJavaScriptRunnerProject,
  fixtureFile,
  fixtureJavaScriptFile,
  path,
  readFile,
  runEngine,
  runPlannedTask,
} from "./runners-test-support.js";
describe("engine runners", () => {
  it("runs Jest unit tests for JavaScript projects", async () => {
    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [fixtureJavaScriptFile],
        id: "test:1:unit-js",
        stageId: "unit",
      },
      process.cwd(),
    );

    expect(result.status).toBe("passed");
    expect(result.diagnostics).toEqual([]);
    expect(result.notes[0]).toContain("Jest ran");
    expect(result.toolRuns[0]).toMatchObject({
      exitCode: 0,
      status: "passed",
      tool: "jest",
    });
  });

  it("runs coverage for TypeScript projects through Vitest", async () => {
    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [fixtureFile],
        id: "test:1:coverage",
        stageId: "coverage",
      },
      process.cwd(),
    );

    expect(result.status).toBe("passed");
    expect(result.diagnostics).toEqual([]);
    expect(result.notes[0]).toContain("Vitest coverage lines:");
    expect(result.toolRuns[0]).toMatchObject({
      exitCode: 0,
      status: "passed",
      tool: "vitest",
    });
  });

  it("runs coverage for JavaScript projects through Jest", async () => {
    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [fixtureJavaScriptFile],
        id: "test:1:coverage-js",
        stageId: "coverage",
      },
      process.cwd(),
    );

    expect(result.status).toBe("passed");
    expect(result.diagnostics).toEqual([]);
    expect(result.notes[0]).toContain("Jest coverage lines:");
    expect(result.toolRuns[0]).toMatchObject({
      exitCode: 0,
      status: "passed",
      tool: "jest",
    });
  });

  it("reuses JavaScript coverage execution across unit and coverage in one engine run", async () => {
    const project = await createCustomJavaScriptRunnerProject({
      prefix: "aiq-js-coverage-reuse-",
      runner: "jest",
      runnerScript: [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'const countFile = path.join(__dirname, "invocations.txt");',
        'const outputFileArg = process.argv.find((arg) => arg.startsWith("--outputFile="));',
        'if (!outputFileArg) throw new Error("missing --outputFile");',
        'const isCoverage = process.argv.some((arg) => arg === "--coverage");',
        'const count = Number(fs.existsSync(countFile) ? fs.readFileSync(countFile, "utf8") : "0") + 1;',
        "fs.writeFileSync(countFile, String(count));",
        'fs.writeFileSync(outputFileArg.slice("--outputFile=".length), JSON.stringify({ numFailedTests: 0, numPassedTests: 1, numTotalTests: 1, testResults: [] }));',
        "if (isCoverage) {",
        '  const coverageDirectoryArg = process.argv.find((arg) => arg.startsWith("--coverageDirectory="));',
        '  if (!coverageDirectoryArg) throw new Error("missing --coverageDirectory");',
        '  fs.mkdirSync(coverageDirectoryArg.slice("--coverageDirectory=".length), { recursive: true });',
        '  fs.writeFileSync(path.join(coverageDirectoryArg.slice("--coverageDirectory=".length), "coverage-summary.json"), JSON.stringify({ total: { lines: { total: 10, covered: 10, skipped: 0, pct: 100 } } }));',
        "}",
        "process.exit(0);",
        "",
      ].join("\n"),
    });

    const result = await runEngine({
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
    });

    const unitStage = result.stages.find((stage) => stage.stageId === "unit");
    const coverageStage = result.stages.find((stage) => stage.stageId === "coverage");

    expect(result.summary.status).toBe("passed");
    expect(unitStage).toMatchObject({ stageId: "unit", status: "passed" });
    expect(unitStage?.notes[0]).toContain("Jest ran 1 test");
    expect(unitStage?.toolRuns[0]).toMatchObject({
      cacheHit: false,
      exitCode: 0,
      status: "passed",
      tool: "jest",
    });
    expect(coverageStage).toMatchObject({ stageId: "coverage", status: "passed" });
    expect(coverageStage?.notes[0]).toContain("Jest coverage lines: 100.0%");
    expect(coverageStage?.toolRuns[0]).toMatchObject({
      cacheHit: true,
      durationMs: 0,
      exitCode: 0,
      status: "passed",
      tool: "jest",
    });
    expect(await readFile(path.join(project.root, "invocations.txt"), "utf8")).toBe("1");
  });
});
