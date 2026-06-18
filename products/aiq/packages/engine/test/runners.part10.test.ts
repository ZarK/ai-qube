import { describe, expect, it } from "vitest";
import {
  createCustomJavaScriptRunnerProject,
  path,
  readFile,
  runEngine,
  runPlannedTask,
} from "./runners-test-support.js";
describe("engine runners", () => {
  it("does not reuse JavaScript coverage executions across standalone runner calls", async () => {
    const project = await createCustomJavaScriptRunnerProject({
      prefix: "aiq-js-no-cross-run-reuse-",
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
        '  fs.writeFileSync(path.join(coverageDirectoryArg.slice("--coverageDirectory=".length), "coverage-summary.json"), JSON.stringify({ total: { lines: { total: 4, covered: 4, skipped: 0, pct: 100 } } }));',
        "}",
        "process.exit(0);",
        "",
      ].join("\n"),
    });

    const coverageResult = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:coverage-js-no-cross-run-reuse",
        stageId: "coverage",
      },
      project.root,
    );
    const unitResult = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:unit-js-no-cross-run-reuse",
        stageId: "unit",
      },
      project.root,
    );

    expect(coverageResult.status).toBe("passed");
    expect(coverageResult.toolRuns[0]).toMatchObject({ cacheHit: false, tool: "jest" });
    expect(unitResult.status).toBe("passed");
    expect(unitResult.toolRuns[0]).toMatchObject({ cacheHit: false, tool: "jest" });
    expect(await readFile(path.join(project.root, "invocations.txt"), "utf8")).toBe("2");
  });

  it("resets standalone runner reuse between identical back-to-back engine runs", async () => {
    const project = await createCustomJavaScriptRunnerProject({
      prefix: "aiq-js-engine-run-reset-",
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
        '  fs.writeFileSync(path.join(coverageDirectoryArg.slice("--coverageDirectory=".length), "coverage-summary.json"), JSON.stringify({ total: { lines: { total: 4, covered: 4, skipped: 0, pct: 100 } } }));',
        "}",
        "process.exit(0);",
        "",
      ].join("\n"),
    });

    const request = {
      context: "cli" as const,
      cwd: project.root,
      manifest: {
        files: [project.sourceFile],
        source: "direct" as const,
      },
      mode: "check" as const,
      outDir: project.root,
      stages: ["unit", "coverage"] as const,
    };

    const first = await runEngine(request);
    const second = await runEngine(request);

    expect(first.summary.status).toBe("passed");
    expect(second.summary.status).toBe("passed");
    expect(first.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stageId: "unit", status: "passed" }),
        expect.objectContaining({ stageId: "coverage", status: "passed" }),
      ]),
    );
    expect(second.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stageId: "unit", status: "passed" }),
        expect.objectContaining({ stageId: "coverage", status: "passed" }),
      ]),
    );
    expect(first.stages.find((stage) => stage.stageId === "unit")?.toolRuns[0]).toMatchObject({
      cacheHit: false,
      tool: "jest",
    });
    expect(second.stages.find((stage) => stage.stageId === "unit")?.toolRuns[0]).toMatchObject({
      cacheHit: false,
      tool: "jest",
    });
    expect(await readFile(path.join(project.root, "invocations.txt"), "utf8")).toBe("2");
  });
});
