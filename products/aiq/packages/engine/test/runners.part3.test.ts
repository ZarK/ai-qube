import { describe, expect, it } from "vitest";
import { mkdtemp, os, path, runPlannedTask, tempDirs, writeFile } from "./runners-test-support.js";
describe("engine runners", () => {
  it("reports missing Stylelint config as a CSS lint setup failure", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-css-lint-runner-no-config-"));
    tempDirs.push(tempDir);

    const cssFile = path.join(tempDir, "plain.css");
    await writeFile(cssFile, "a { color: red; }\n", "utf8");

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [cssFile],
        id: "test:1:lint-css-no-config",
        stageId: "lint",
      },
      process.cwd(),
    );

    expect(JSON.stringify(result)).not.toContain("not_implemented");
    expect(result.status).toBe("failed");
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        file: cssFile,
        severity: "error",
        source: "stylelint",
      }),
    ]);
    expect(result.diagnostics[0]?.message).toContain("Stylelint configuration");
    expect(result.diagnostics[0]?.message).toContain("disable CSS lint");
    expect(result.notes.join(" ")).toContain(
      `No Stylelint configuration was detected for lint in: ${cssFile}.`,
    );
    expect(result.notes.join(" ")).toContain("disable CSS lint");
    expect(result.toolRuns[0]).toMatchObject({
      exitCode: 1,
      status: "failed",
      tool: "stylelint",
    });
  });

  it("reports configured CSS lint diagnostics with missing Stylelint config diagnostics", async () => {
    const configuredDir = await mkdtemp(path.join(os.tmpdir(), "aiq-css-lint-configured-"));
    const unconfiguredDir = await mkdtemp(path.join(os.tmpdir(), "aiq-css-lint-unconfigured-"));
    tempDirs.push(configuredDir, unconfiguredDir);

    await writeFile(
      path.join(configuredDir, ".stylelintrc.json"),
      `${JSON.stringify({ rules: { "color-named": "never" } }, null, 2)}\n`,
      "utf8",
    );

    const badCssFile = path.join(configuredDir, "bad.css");
    const plainCssFile = path.join(unconfiguredDir, "plain.css");
    await writeFile(badCssFile, "a { color: red; }\n", "utf8");
    await writeFile(plainCssFile, "b { color: red; }\n", "utf8");

    const result = await runPlannedTask(
      {
        fileCount: 2,
        files: [badCssFile, plainCssFile],
        id: "test:1:lint-css-mixed-config",
        stageId: "lint",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "color-named", file: badCssFile, source: "stylelint" }),
        expect.objectContaining({ file: plainCssFile, source: "stylelint" }),
      ]),
    );
    expect(JSON.stringify(result)).not.toContain("not_implemented");
    expect(result.notes).toContain("Stylelint reported 2 diagnostics.");
    expect(result.notes.join(" ")).toContain(
      `No Stylelint configuration was detected for lint in: ${plainCssFile}.`,
    );
    expect(result.notes.join(" ")).toContain("disable CSS lint");
    expect(result.toolRuns[0]).toMatchObject({
      exitCode: 1,
      status: "failed",
      tool: "stylelint",
    });
  });

  it("resolves Stylelint config from the engine cwd when the file tree has none", async () => {
    const configDir = await mkdtemp(path.join(os.tmpdir(), "aiq-css-lint-cwd-config-"));
    const fileDir = await mkdtemp(path.join(os.tmpdir(), "aiq-css-lint-cwd-files-"));
    tempDirs.push(configDir, fileDir);

    await writeFile(
      path.join(configDir, ".stylelintrc.json"),
      `${JSON.stringify({ rules: { "color-named": "never" } }, null, 2)}\n`,
      "utf8",
    );

    const badCssFile = path.join(fileDir, "bad.css");
    await writeFile(badCssFile, "a { color: red; }\n", "utf8");

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [badCssFile],
        id: "test:1:lint-css-cwd-config",
        stageId: "lint",
      },
      configDir,
    );

    expect(result.status).toBe("failed");
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "color-named", file: badCssFile, source: "stylelint" }),
      ]),
    );
  });
});
