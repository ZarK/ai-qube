import { describe, expect, it } from "vitest";
import {
  collectJavaScriptAndTypeScriptFiles,
  cp,
  fixturePythonConfigFile,
  fixturePythonFile,
  fixtureTypeScriptPackageJson,
  hasPythonQualityToolchain,
  mkdtemp,
  os,
  path,
  runPlannedTask,
  tempDirs,
  writeFile,
} from "./runners-test-support.js";
describe("engine runners", () => {
  it("reports supported-language shared metrics files that cannot resolve a project", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-unresolved-rust-metrics-"));
    tempDirs.push(tempDir);

    const rustFile = path.join(tempDir, "orphan.rs");
    await writeFile(rustFile, "fn main() {}\n", "utf8");

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [rustFile],
        id: "test:1:complexity-rust-unresolved-project",
        stageId: "complexity",
      },
      process.cwd(),
    );

    expect(JSON.stringify(result)).not.toContain("not_implemented");
    expect(result.status).toBe("failed");
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        file: rustFile,
        severity: "error",
        source: "aiq-shared-metrics",
      }),
    ]);
    expect(result.toolRuns).toEqual([]);
  });

  it("expands package.json selections to the actual JavaScript and TypeScript source count", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-js-metrics-package-json-"));
    tempDirs.push(tempDir);
    const projectRoot = path.join(tempDir, "project");
    await cp(path.dirname(fixtureTypeScriptPackageJson), projectRoot, { recursive: true });
    await writeFile(path.join(projectRoot, "src", "extra.ts"), "export const extra = 1;\n", "utf8");
    const expectedScannedFileCount = (await collectJavaScriptAndTypeScriptFiles(projectRoot))
      .length;

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [path.join(projectRoot, "package.json")],
        id: "test:1:sloc-js-ts-package-json-source-count",
        stageId: "sloc",
      },
      process.cwd(),
    );

    expect(result.status).toBe("passed");
    expect(result.diagnostics).toEqual([]);
    expect(expectedScannedFileCount).toBe(5);
    expect(result.notes[0]).toContain(`across ${expectedScannedFileCount} files.`);
    expect(
      result.toolRuns.filter(
        (toolRun) =>
          toolRun.cacheHit === false &&
          toolRun.exitCode === 0 &&
          toolRun.status === "passed" &&
          toolRun.tool === "lizard",
      ),
    ).toHaveLength(1);
  });

  it.skipIf(!hasPythonQualityToolchain)("runs Pytest unit tests for Python projects", async () => {
    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [fixturePythonFile],
        id: "test:1:unit-python",
        stageId: "unit",
      },
      process.cwd(),
    );

    expect(result.status).toBe("passed");
    expect(result.diagnostics).toEqual([]);
    expect(result.notes[0]).toBe("Pytest ran 3 tests: 3 passed, 0 failed.");
    expect(result.toolRuns[0]).toMatchObject({
      exitCode: 0,
      status: "passed",
      tool: "pytest",
    });
  });

  it.skipIf(!hasPythonQualityToolchain)("runs Pytest coverage for Python projects", async () => {
    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [fixturePythonFile],
        id: "test:1:coverage-python",
        stageId: "coverage",
      },
      process.cwd(),
    );

    expect(result.status).toBe("passed");
    expect(result.diagnostics).toEqual([]);
    expect(result.notes[0]).toMatch(/^Pytest coverage lines: \d+\.\d% across 3 tests\.$/u);
    expect(result.toolRuns[0]).toMatchObject({
      exitCode: 0,
      status: "passed",
      tool: "pytest-cov",
    });
  });

  it.skipIf(!hasPythonQualityToolchain)("runs Python lint for config-only selections", async () => {
    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [fixturePythonConfigFile],
        id: "test:1:lint-python-config-only",
        stageId: "lint",
      },
      process.cwd(),
    );

    expect(result.status).toBe("passed");
    expect(result.diagnostics).toEqual([]);
    expect(result.notes).toEqual(["Ruff lint passed."]);
    expect(result.toolRuns[0]).toMatchObject({
      exitCode: 0,
      status: "passed",
      tool: "ruff",
    });
  });
});
