import { describe, expect, it } from "vitest";
import {
  createCustomJavaScriptRunnerProject,
  path,
  readFile,
  runEngine,
} from "./runners-test-support.js";
describe("engine runners", () => {
  it("falls back to a plain JavaScript unit run when combined coverage priming lacks coverage output", async () => {
    const project = await createCustomJavaScriptRunnerProject({
      prefix: "aiq-js-coverage-fallback-",
      runner: "jest",
      runnerScript: [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'const countFile = path.join(__dirname, "invocations.txt");',
        'const outputFileArg = process.argv.find((arg) => arg.startsWith("--outputFile="));',
        'if (!outputFileArg) throw new Error("missing --outputFile");',
        'const count = Number(fs.existsSync(countFile) ? fs.readFileSync(countFile, "utf8") : "0") + 1;',
        "fs.writeFileSync(countFile, String(count));",
        'fs.writeFileSync(outputFileArg.slice("--outputFile=".length), JSON.stringify({ numFailedTests: 0, numPassedTests: 1, numTotalTests: 1, testResults: [] }));',
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

    expect(result.summary.status).toBe("failed");
    expect(unitStage).toMatchObject({ stageId: "unit", status: "passed" });
    expect(unitStage?.toolRuns[0]).toMatchObject({
      cacheHit: false,
      exitCode: 0,
      status: "passed",
      tool: "jest",
    });
    expect(coverageStage).toMatchObject({ stageId: "coverage", status: "failed" });
    expect(coverageStage?.notes[0]).toContain("Expected coverage summary at");
    expect(coverageStage?.toolRuns).toEqual([]);
    expect(await readFile(path.join(project.root, "invocations.txt"), "utf8")).toBe("3");
  });

  it("falls back to a plain JavaScript unit run when coverage mode exits non-zero but tests themselves pass", async () => {
    const project = await createCustomJavaScriptRunnerProject({
      prefix: "aiq-js-coverage-exit-fallback-",
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
        "if (isCoverage) { process.exit(1); }",
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

    expect(result.summary.status).toBe("failed");
    expect(unitStage).toMatchObject({ stageId: "unit", status: "passed" });
    expect(unitStage?.toolRuns[0]).toMatchObject({
      cacheHit: false,
      exitCode: 0,
      status: "passed",
      tool: "jest",
    });
    expect(coverageStage).toMatchObject({ stageId: "coverage", status: "failed" });
    expect(coverageStage?.toolRuns[0]).toMatchObject({
      cacheHit: false,
      exitCode: 1,
      status: "failed",
      tool: "jest",
    });
    expect(await readFile(path.join(project.root, "invocations.txt"), "utf8")).toBe("3");
  });
});
