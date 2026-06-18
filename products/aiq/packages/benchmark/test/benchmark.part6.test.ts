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
  it("surfaces the failing scenario id when a benchmark run aborts", async () => {
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
            description: "Missing file regression test.",
            fixturePath: path.resolve("test-projects/javascript"),
            id: "missing-file",
            inputs: ["missing.js"],
            kind: "cold",
            metadata: {
              languages: ["javascript"],
              scale: "small",
              shape: "single-file",
              tags: ["javascript", "missing"],
            },
            profile: "fast",
            stages: ["lint"],
          },
        ],
      }),
    ).rejects.toThrowError("Benchmark scenario 'missing-file' failed:");
  });

  it("fails fast when the engine returns a non-passing warmup result", async () => {
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
            description: "Failing warmup regression test.",
            fixturePath: lintFailureFixturePath,
            id: "warmup-failure",
            inputs: ["src/lint-failure.ts"],
            kind: "warm",
            metadata: {
              languages: ["typescript"],
              scale: "small",
              shape: "single-file",
              tags: ["lint", "typescript", "warmup"],
            },
            profile: "fast",
            stages: ["lint"],
            warmupRuns: 1,
          },
        ],
      }),
    ).rejects.toThrowError(
      "Benchmark scenario 'warmup-failure' failed: Warmup run 1 finished with status 'failed'.",
    );
  });
});
