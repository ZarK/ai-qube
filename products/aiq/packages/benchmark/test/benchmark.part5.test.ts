import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  hasDotNet10Toolchain,
  hasGoToolchain,
  hasGradleToolchain,
  hasMavenToolchain,
  hasPythonQualityToolchain,
  hasRustToolchain,
} from "../../engine/test/toolchain-capabilities.js";
import {
  createDefaultBenchmarkCorpus,
  filterBenchmarkScenarios,
  formatBenchmarkReportAsJson,
  formatBenchmarkReportAsText,
  runBenchmarkSuite,
  runBenchmarkSuiteAndEnforceBudgets,
} from "../src/index.js";

const lintFailureFixturePath = path.resolve("test-projects/typescript");
const benchmarkTypeScriptLargeFixturePath = path.resolve(
  "test-projects/benchmark-typescript-large",
);
const issue96ScenarioIds = [
  "javascript-lint-single-file-cold",
  "javascript-unit-single-file-warm",
  "javascript-sloc-multi-file-warm",
  "javascript-coverage-sub-folder-warm",
  "typescript-typecheck-single-file-cold",
  "typescript-lint-multi-file-diff",
  "typescript-unit-sub-folder-warm",
  "python-lint-single-file-cold",
  "python-typecheck-multi-file-warm",
  "python-unit-sub-folder-warm",
  "go-lint-single-file-cold",
  "go-unit-multi-file-warm",
  "go-coverage-sub-folder-warm",
  "rust-lint-single-file-cold",
  "rust-typecheck-multi-file-warm",
  "rust-unit-sub-folder-warm",
  "dotnet-lint-single-file-cold",
  "dotnet-typecheck-multi-file-warm",
  "java-lint-single-file-cold",
  "java-unit-multi-file-warm",
  "kotlin-lint-single-file-cold",
  "kotlin-unit-multi-file-warm",
] as const;
const tempDirs: string[] = [];
const hasFullBenchmarkToolchain =
  hasPythonQualityToolchain &&
  hasGoToolchain &&
  hasRustToolchain &&
  hasDotNet10Toolchain &&
  hasMavenToolchain &&
  hasGradleToolchain;
const hasTaggedCiBenchmarkToolchain = hasPythonQualityToolchain && hasGoToolchain;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("benchmark harness", () => {
  it("cleans up temporary benchmark workspaces after a run", async () => {
    const fixtureParent = await mkdtemp(path.join(os.tmpdir(), "aiq-benchmark-parent-"));
    const fixtureRoot = path.join(fixtureParent, "fixture");
    const outDir = await mkdtemp(path.join(os.tmpdir(), "aiq-benchmark-"));
    tempDirs.push(fixtureParent, outDir);

    await mkdir(fixtureRoot, { recursive: true });
    await writeFile(
      path.join(fixtureRoot, "index.js"),
      "export const greet = () => 'hi';\n",
      "utf8",
    );

    await runBenchmarkSuite({
      cwd: process.cwd(),
      outDir,
      scenarios: [
        {
          budget: {
            maxDurationMs: 20_000,
            maxStageDurationMs: { lint: 20_000 },
          },
          description: "Clean up temporary benchmark workspaces after execution.",
          fixturePath: fixtureRoot,
          id: "javascript-temp-cleanup",
          inputs: ["."],
          kind: "cold",
          metadata: {
            languages: ["javascript"],
            scale: "small",
            shape: "full-repo",
            tags: ["cleanup", "javascript"],
          },
          profile: "fast",
          stages: ["lint"],
        },
      ],
    });

    const remainingEntries = await readdir(fixtureParent);
    expect(remainingEntries).toEqual(["fixture"]);
  });

  it("records shared metrics cache reuse for warm multi-file scenarios", async () => {
    const outDir = await mkdtemp(path.join(os.tmpdir(), "aiq-benchmark-"));
    tempDirs.push(outDir);

    const { report } = await runBenchmarkSuite({
      cwd: process.cwd(),
      outDir,
      scenarioIds: ["typescript-metrics-multi-file-warm"],
      scenarios: createDefaultBenchmarkCorpus(path.resolve(process.cwd())),
    });

    expect(report.summary.failedBudgetCount).toBe(0);
    expect(report.scenarios[0]).toMatchObject({
      cacheHitCount: 3,
      cacheMissCount: 0,
      id: "typescript-metrics-multi-file-warm",
      kind: "warm",
      status: "passed",
      withinBudget: true,
    });
    expect(report.scenarios[0]?.manifest).toMatchObject({
      fileCount: 4,
      shape: "multi-file",
    });
    expect(report.scenarios[0]?.stages).toEqual(["sloc", "complexity", "maintainability"]);
  });

  it("keeps benchmark artifacts out of the source fixture tree", async () => {
    const outDir = await mkdtemp(path.join(os.tmpdir(), "aiq-benchmark-"));
    tempDirs.push(outDir);

    await expect(
      access(path.join(benchmarkTypeScriptLargeFixturePath, ".qube")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });

    await runBenchmarkSuite({
      cwd: process.cwd(),
      outDir,
      scenarioIds: ["typescript-metrics-multi-file-warm"],
      scenarios: createDefaultBenchmarkCorpus(path.resolve(process.cwd())),
    });

    await expect(
      access(path.join(benchmarkTypeScriptLargeFixturePath, ".qube")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects invalid benchmark scenario ids before creating artifact paths", async () => {
    const outDir = await mkdtemp(path.join(os.tmpdir(), "aiq-benchmark-"));
    tempDirs.push(outDir);

    await expect(
      runBenchmarkSuite({
        cwd: process.cwd(),
        outDir,
        scenarios: [
          {
            budget: {
              maxDurationMs: 20_000,
              maxStageDurationMs: { lint: 20_000 },
            },
            description: "Invalid scenario id regression test.",
            fixturePath: path.resolve("test-projects/javascript"),
            id: "../escape",
            inputs: ["index.js"],
            kind: "diff-only",
            metadata: {
              languages: ["javascript"],
              scale: "small",
              shape: "single-file",
              tags: ["invalid", "javascript"],
            },
            profile: "fast",
            stages: ["lint"],
          },
        ],
      }),
    ).rejects.toThrowError(
      "Benchmark scenario '../escape' failed: Invalid benchmark scenario id '../escape'.",
    );
  });

  it("rejects unknown scenario filters before running the suite", async () => {
    await expect(
      runBenchmarkSuite({
        scenarioIds: ["missing-scenario"],
        scenarios: createDefaultBenchmarkCorpus(path.resolve(process.cwd())),
        writeArtifact: false,
      }),
    ).rejects.toThrowError("Unknown benchmark scenario id: missing-scenario.");
  });
});
