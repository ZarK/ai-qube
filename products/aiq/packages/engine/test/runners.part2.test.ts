import { describe, expect, it } from "vitest";
import { mkdtemp, os, path, runPlannedTask, tempDirs, writeFile } from "./runners-test-support.js";
describe("engine runners", () => {
  it("runs Biome format on JSONC files and reports formatting diagnostics", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-jsonc-runner-"));
    tempDirs.push(tempDir);

    const jsoncFile = path.join(tempDir, "config.jsonc");
    await writeFile(jsoncFile, '{"name" :"typescript-fixture" ,"enabled" :true}\n', "utf8");

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [jsoncFile],
        id: "test:1:format",
        stageId: "format",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.diagnostics[0]).toMatchObject({
      file: jsoncFile,
      severity: "error",
      source: "biome",
    });
    expect(result.toolRuns[0]).toMatchObject({
      exitCode: 1,
      status: "failed",
      tool: "biome",
    });
  });

  it("runs HTMLHint lint and returns structured diagnostics for HTML files", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-html-lint-runner-"));
    tempDirs.push(tempDir);

    const badHtmlFile = path.join(tempDir, "bad.html");
    await writeFile(
      badHtmlFile,
      [
        "<!doctype html>",
        '<html lang="en">',
        "  <body>",
        "    <div>",
        "  </body>",
        "</html>",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [badHtmlFile],
        id: "test:1:lint-html",
        stageId: "lint",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.diagnostics[0]).toMatchObject({
      code: "tag-pair",
      file: badHtmlFile,
      severity: "error",
      source: "htmlhint",
    });
    expect(result.toolRuns[0]).toMatchObject({
      exitCode: 1,
      status: "failed",
      tool: "htmlhint",
    });
  });

  it("runs Stylelint lint and returns structured diagnostics for CSS files", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-css-lint-runner-"));
    tempDirs.push(tempDir);

    await writeFile(
      path.join(tempDir, ".stylelintrc.json"),
      `${JSON.stringify({ rules: { "color-named": "never" } }, null, 2)}\n`,
      "utf8",
    );

    const badCssFile = path.join(tempDir, "bad.css");
    await writeFile(badCssFile, "a { color: red; }\n", "utf8");

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [badCssFile],
        id: "test:1:lint-css",
        stageId: "lint",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.diagnostics[0]).toMatchObject({
      code: "color-named",
      file: badCssFile,
      severity: "error",
      source: "stylelint",
    });
    expect(result.diagnostics[0]?.range).toMatchObject({
      startColumn: 12,
      startLine: 1,
    });
    expect(result.toolRuns[0]).toMatchObject({
      exitCode: 1,
      status: "failed",
      tool: "stylelint",
    });
  });
});
