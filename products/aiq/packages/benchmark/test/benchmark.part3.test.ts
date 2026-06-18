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
  it("writes stable JSON benchmark output with a primary metric and manifest metadata", async () => {
    const outDir = await mkdtemp(path.join(os.tmpdir(), "aiq-benchmark-"));
    tempDirs.push(outDir);

    const { artifactPath, report } = await runBenchmarkSuite({
      cwd: process.cwd(),
      outDir,
      scenarios: [
        {
          budget: {
            maxDurationMs: 45_000,
            maxStageDurationMs: { typecheck: 45_000 },
          },
          description: "TypeScript fixture typecheck benchmark.",
          fixturePath: path.resolve("test-projects/typescript"),
          id: "typescript-typecheck",
          inputs: ["src/index.ts"],
          kind: "warm",
          metadata: {
            languages: ["typescript"],
            scale: "small",
            shape: "single-file",
            tags: ["test", "typecheck", "typescript"],
          },
          profile: "standard",
          stages: ["typecheck"],
          warmupRuns: 1,
        },
      ],
    });

    if (artifactPath === undefined) {
      throw new Error("Expected benchmark artifact path.");
    }

    expect(report.artifactType).toBe("benchmark");
    expect(report.artifactVersion).toBe(2);
    expect(report.primaryMetric).toMatchObject({
      field: "summary.totalDurationMs",
      goal: "minimize",
      unit: "ms",
      value: report.summary.totalDurationMs,
    });
    expect(report.summary.scenarioCount).toBe(1);
    expect(report.summary.failedBudgetCount).toBe(0);
    expect(report.scenarios[0]?.manifest).toMatchObject({
      fileCount: 1,
      files: ["src/index.ts"],
      inputs: ["src/index.ts"],
      shape: "single-file",
    });
    expect(report.scenarios[0]?.cache).toMatchObject({
      isolation: "fresh-workspace-copy",
      primed: true,
      warmupRuns: 1,
    });
    expect(report.scenarios[0]?.metricsPath).toBeDefined();
    expect(report.scenarios[0]?.reportPath).toBeDefined();

    const artifactJson = JSON.parse(await readFile(artifactPath, "utf8")) as {
      artifactType: string;
      artifactVersion: number;
      primaryMetric: { field: string; goal: string; unit: string };
      scenarios: Array<{
        id: string;
        manifest: { fileCount: number; shape: string };
        withinBudget: boolean;
      }>;
      summary: { failedBudgetCount: number; scenarioCount: number };
    };
    expect(artifactJson.artifactType).toBe("benchmark");
    expect(artifactJson.artifactVersion).toBe(2);
    expect(artifactJson.primaryMetric).toMatchObject({
      field: "summary.totalDurationMs",
      goal: "minimize",
      unit: "ms",
    });
    expect(artifactJson.summary.scenarioCount).toBe(1);
    expect(artifactJson.summary.failedBudgetCount).toBe(0);
    expect(artifactJson.scenarios[0]).toMatchObject({
      id: "typescript-typecheck",
      manifest: {
        fileCount: 1,
        shape: "single-file",
      },
      withinBudget: true,
    });
    expect(formatBenchmarkReportAsJson(report)).toContain('"primaryMetric"');
    expect(formatBenchmarkReportAsText(report)).toContain(
      "Primary metric: summary.totalDurationMs=",
    );
  });

  it.skipIf(!hasTaggedCiBenchmarkToolchain)(
    "runs the tagged CI benchmark scenarios successfully",
    async () => {
      const outDir = await mkdtemp(path.join(os.tmpdir(), "aiq-benchmark-"));
      tempDirs.push(outDir);

      const { report } = await runBenchmarkSuite({
        cwd: process.cwd(),
        outDir,
        tags: ["ci"],
        scenarios: createDefaultBenchmarkCorpus(path.resolve(process.cwd())),
      });

      expect(report.summary.failedBudgetCount).toBe(0);
      expect(report.scenarios.map((scenario) => scenario.id)).toEqual([
        "javascript-lint-single-file-cold",
        "typescript-metrics-multi-file-warm",
        "typescript-unit-coverage-full-repo-warm",
        "typescript-format-full-repo-diff",
        "python-quality-full-repo-cold",
        "python-lint-full-repo-warm",
        "go-lint-full-repo-cold",
      ]);
      expect(report.scenarios.every((scenario) => scenario.status === "passed")).toBe(true);
      expect(report.selection.tags).toEqual(["ci"]);
      expect(
        report.scenarios.find((scenario) => scenario.id === "python-quality-full-repo-cold")
          ?.manifest.inputs,
      ).toEqual(["main.py", "tests/test_main.py", "tests"]);
      expect(
        new Set(
          report.scenarios.find((scenario) => scenario.id === "python-quality-full-repo-cold")
            ?.manifest.files,
        ),
      ).toEqual(new Set(["main.py", "tests/test_main.py"]));
    },
    20_000,
  );
});
