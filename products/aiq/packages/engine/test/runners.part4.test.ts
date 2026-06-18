import { describe, expect, it } from "vitest";
import { mkdtemp, os, path, runPlannedTask, tempDirs, writeFile } from "./runners-test-support.js";
describe("engine runners", () => {
  it("runs Prettier document format checks for HTML, CSS, and YAML files", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-document-format-runner-"));
    tempDirs.push(tempDir);

    const badHtmlFile = path.join(tempDir, "bad.html");
    const badCssFile = path.join(tempDir, "bad.css");
    const badYamlFile = path.join(tempDir, "bad.yaml");
    await writeFile(badHtmlFile, "<!doctype html><html><body><p>Hi</p></body></html>\n", "utf8");
    await writeFile(badCssFile, "body{color:#333}\n", "utf8");
    await writeFile(badYamlFile, "service:\n    name: api\n    port: 8080\n", "utf8");

    const result = await runPlannedTask(
      {
        fileCount: 3,
        files: [badHtmlFile, badCssFile, badYamlFile],
        id: "test:1:format-documents",
        stageId: "format",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: badHtmlFile, severity: "error", source: "prettier" }),
        expect.objectContaining({ file: badCssFile, severity: "error", source: "prettier" }),
        expect.objectContaining({ file: badYamlFile, severity: "error", source: "prettier" }),
      ]),
    );
    expect(result.toolRuns[0]).toMatchObject({
      exitCode: 1,
      status: "failed",
      tool: "prettier",
    });
  });

  it("runs YAML parse checks and returns structured diagnostics", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-yaml-lint-runner-"));
    tempDirs.push(tempDir);

    const badYamlFile = path.join(tempDir, "bad.yaml");
    await writeFile(badYamlFile, "service:\n  name: api\n   port: 8080\n", "utf8");

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [badYamlFile],
        id: "test:1:lint-yaml",
        stageId: "lint",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.diagnostics[0]).toMatchObject({
      file: badYamlFile,
      severity: "error",
      source: "yaml",
    });
    expect(result.diagnostics[0]?.range).toMatchObject({
      startColumn: 9,
      startLine: 2,
    });
    expect(result.toolRuns[0]).toMatchObject({
      exitCode: 1,
      status: "failed",
      tool: "yaml",
    });
  });

  it("runs SQL parse checks and returns structured diagnostics", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-sql-lint-runner-"));
    tempDirs.push(tempDir);

    const badSqlFile = path.join(tempDir, "bad.sql");
    await writeFile(badSqlFile, "SELECT FROM users;\n", "utf8");

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [badSqlFile],
        id: "test:1:lint-sql",
        stageId: "lint",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.diagnostics[0]).toMatchObject({
      file: badSqlFile,
      severity: "error",
      source: "node-sql-parser",
    });
    expect(result.diagnostics[0]?.message).toContain("Tried SQL dialects");
    expect(result.diagnostics[0]?.range).toMatchObject({
      startColumn: 18,
      startLine: 1,
    });
    expect(result.toolRuns[0]).toMatchObject({
      exitCode: 1,
      status: "failed",
      tool: "node-sql-parser",
    });
  });
});
