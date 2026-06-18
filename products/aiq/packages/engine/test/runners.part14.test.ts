import { describe, expect, it } from "vitest";
import {
  createCustomJavaScriptRunnerProject,
  mkdir,
  mkdtemp,
  os,
  path,
  runPlannedTask,
  tempDirs,
  writeFile,
} from "./runners-test-support.js";
describe("engine runners", () => {
  it("uses an ancestor e2e script to cover nested package projects", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "aiq-js-e2e-workspace-root-"));
    tempDirs.push(root);
    const packageRoot = path.join(root, "packages", "app");
    const sourceFile = path.join(packageRoot, "src", "index.ts");
    await mkdir(path.dirname(sourceFile), { recursive: true });
    await writeFile(
      path.join(root, "package.json"),
      `${JSON.stringify(
        {
          name: "workspace-root",
          private: true,
          scripts: {
            "aiq:e2e": "node e2e.cjs",
          },
          workspaces: ["packages/*"],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(path.join(root, "e2e.cjs"), "process.exit(0);\n", "utf8");
    await writeFile(
      path.join(packageRoot, "package.json"),
      `${JSON.stringify({ name: "workspace-app", private: true }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(sourceFile, "export const value = 1;\n", "utf8");

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [sourceFile],
        id: "test:1:e2e-js-workspace-root",
        stageId: "e2e",
      },
      process.cwd(),
    );

    expect(result.status).toBe("passed");
    expect(result.diagnostics).toEqual([]);
    expect(result.toolRuns).toHaveLength(1);
    expect(result.toolRuns[0]).toMatchObject({
      args: ["run", "aiq:e2e", "--"],
      status: "passed",
      tool: "e2e",
    });
  });

  it("fails JavaScript unit when the runner summary reports failures despite exit code 0", async () => {
    const project = await createCustomJavaScriptRunnerProject({
      prefix: "aiq-js-semantic-failure-report-",
      runner: "jest",
      runnerScript: [
        'const fs = require("node:fs");',
        'const outputFile = process.argv.find((arg) => arg.startsWith("--outputFile="));',
        'if (!outputFile) throw new Error("missing --outputFile");',
        'fs.writeFileSync(outputFile.slice("--outputFile=".length), JSON.stringify({ numFailedTests: 1, numPassedTests: 0, numTotalTests: 1, testResults: [] }));',
        "process.exit(0);",
        "",
      ].join("\n"),
    });

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:unit-js-semantic-failure-report",
        stageId: "unit",
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

  it("fails JavaScript unit when the runner writes impossible summary counts", async () => {
    const project = await createCustomJavaScriptRunnerProject({
      prefix: "aiq-js-impossible-summary-counts-",
      runner: "jest",
      runnerScript: [
        'const fs = require("node:fs");',
        'const outputFile = process.argv.find((arg) => arg.startsWith("--outputFile="));',
        'if (!outputFile) throw new Error("missing --outputFile");',
        'fs.writeFileSync(outputFile.slice("--outputFile=".length), JSON.stringify({ numFailedTests: 0, numPassedTests: 2, numTotalTests: 1, testResults: [] }));',
        "process.exit(0);",
        "",
      ].join("\n"),
    });

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:unit-js-impossible-summary-counts",
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
