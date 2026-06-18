import { describe, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  os,
  path,
  runPlannedTask,
  tempDirs,
  writeFile,
} from "./runners-test-support.js";
describe("engine runners", () => {
  it("fails unit when package metadata cannot be parsed", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-invalid-package-json-"));
    tempDirs.push(tempDir);

    await mkdir(path.join(tempDir, "src"), { recursive: true });
    const packageJsonPath = path.join(tempDir, "package.json");
    await writeFile(packageJsonPath, "{\n", "utf8");

    const sourceFile = path.join(tempDir, "src", "index.ts");
    await writeFile(sourceFile, "export const value = 1;\n", "utf8");

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [sourceFile],
        id: "test:1:unit-invalid-package-json",
        stageId: "unit",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.notes[0]).toContain(`Failed to read package metadata at "${packageJsonPath}"`);
    expect(result.diagnostics[0]).toMatchObject({
      file: sourceFile,
      severity: "error",
      source: "test-runner",
    });
  });

  it("fails unit when package metadata cannot be read", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-unreadable-package-json-"));
    tempDirs.push(tempDir);

    await mkdir(path.join(tempDir, "src"), { recursive: true });
    await mkdir(path.join(tempDir, "package.json"), { recursive: true });

    const sourceFile = path.join(tempDir, "src", "index.ts");
    await writeFile(sourceFile, "export const value = 1;\n", "utf8");

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [sourceFile],
        id: "test:1:unit-unreadable-package-json",
        stageId: "unit",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.notes[0]).toContain(
      `Failed to read package metadata at "${path.join(tempDir, "package.json")}"`,
    );
    expect(result.diagnostics[0]).toMatchObject({
      file: sourceFile,
      severity: "error",
      source: "test-runner",
    });
  });

  it("reports unsupported JavaScript or TypeScript test runners as failed setup diagnostics", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-unsupported-runner-"));
    tempDirs.push(tempDir);

    await mkdir(path.join(tempDir, "src"), { recursive: true });
    await writeFile(
      path.join(tempDir, "package.json"),
      `${JSON.stringify({ name: "unsupported-runner", scripts: { test: "node test.js" } }, null, 2)}\n`,
      "utf8",
    );
    const sourceFile = path.join(tempDir, "src", "index.ts");
    await writeFile(sourceFile, "export const value = 1;\n", "utf8");

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [sourceFile],
        id: "test:1:unit-unsupported",
        stageId: "unit",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        file: path.join(tempDir, "package.json"),
        severity: "error",
        source: "aiq-js-test-runner",
      }),
    ]);
    expect(result.diagnostics[0]?.message).toContain(
      "Unsupported JavaScript or TypeScript test runner",
    );
    expect(result.diagnostics[0]?.message).toContain('package script "test" is "node test.js"');
    expect(result.notes.join(" ")).toContain(
      "Unsupported JavaScript/TypeScript test configuration",
    );
    expect(result.notes.join(" ")).toContain('package script "test" is "node test.js"');
    expect(result.toolRuns).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("not_implemented");
  });
});
