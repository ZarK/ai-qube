import { describe, expect, it } from "vitest";
import {
  fixtureFile,
  mkdir,
  mkdtemp,
  os,
  path,
  runPlannedTask,
  tempDirs,
  writeFile,
} from "./runners-test-support.js";
describe("engine runners", () => {
  it("reports JavaScript or TypeScript packages with no test runner as setup diagnostics", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-no-runner-"));
    tempDirs.push(tempDir);

    await mkdir(path.join(tempDir, "src"), { recursive: true });
    await writeFile(
      path.join(tempDir, "package.json"),
      `${JSON.stringify({ name: "no-runner" }, null, 2)}\n`,
      "utf8",
    );
    const sourceFile = path.join(tempDir, "src", "index.ts");
    await writeFile(sourceFile, "export const value = 1;\n", "utf8");

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [sourceFile],
        id: "test:1:unit-no-runner",
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
      "No JavaScript or TypeScript test runner is configured",
    );
    expect(result.notes.join(" ")).toContain(
      "No JavaScript or TypeScript test runner is configured",
    );
    expect(result.toolRuns).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("not_implemented");
  });

  it("keeps supported test runs while reporting mixed unsupported projects as diagnostics", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-mixed-runner-"));
    tempDirs.push(tempDir);

    await mkdir(path.join(tempDir, "src"), { recursive: true });
    await writeFile(
      path.join(tempDir, "package.json"),
      `${JSON.stringify({ name: "mixed-unsupported", scripts: { test: "node test.js" } }, null, 2)}\n`,
      "utf8",
    );
    const unsupportedFile = path.join(tempDir, "src", "index.ts");
    await writeFile(unsupportedFile, "export const value = 1;\n", "utf8");

    const result = await runPlannedTask(
      {
        fileCount: 2,
        files: [fixtureFile, unsupportedFile],
        id: "test:1:unit-mixed",
        stageId: "unit",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.notes.join(" ")).toContain("Vitest ran");
    expect(result.notes.join(" ")).toContain('package script "test" is "node test.js"');
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        file: path.join(tempDir, "package.json"),
        severity: "error",
        source: "aiq-js-test-runner",
      }),
    ]);
    expect(result.toolRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ exitCode: 0, status: "passed", tool: "vitest" }),
      ]),
    );
    expect(JSON.stringify(result)).not.toContain("not_implemented");
  });
});
