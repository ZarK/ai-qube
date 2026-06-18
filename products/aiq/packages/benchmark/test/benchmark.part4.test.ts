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
  it("fails the CI benchmark gate when a scenario exceeds its budget", async () => {
    const outDir = await mkdtemp(path.join(os.tmpdir(), "aiq-benchmark-"));
    tempDirs.push(outDir);

    await expect(
      runBenchmarkSuiteAndEnforceBudgets({
        cwd: process.cwd(),
        outDir,
        scenarios: [
          {
            budget: {
              maxDurationMs: 0,
              maxStageDurationMs: { lint: 0 },
            },
            description: "Budget gate regression test.",
            fixturePath: path.resolve("test-projects/javascript"),
            id: "budget-gate-failure",
            inputs: ["index.js"],
            kind: "diff-only",
            metadata: {
              languages: ["javascript"],
              scale: "small",
              shape: "single-file",
              tags: ["budget", "javascript"],
            },
            stages: ["lint"],
            profile: "fast",
          },
        ],
      }),
    ).rejects.toThrowError("1 benchmark budget(s) failed.");
  });

  it("does not copy generated cache directories into benchmark workspaces", async () => {
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "aiq-benchmark-fixture-"));
    const outDir = await mkdtemp(path.join(os.tmpdir(), "aiq-benchmark-"));
    tempDirs.push(fixtureRoot, outDir);

    await writeFile(
      path.join(fixtureRoot, "index.js"),
      "export const greet = () => 'hi';\n",
      "utf8",
    );
    await mkdir(path.join(fixtureRoot, ".mypy_cache", "nested"), { recursive: true });
    await writeFile(
      path.join(fixtureRoot, ".mypy_cache", "nested", "cache.txt"),
      "stale-cache\n",
      "utf8",
    );

    const { report } = await runBenchmarkSuite({
      cwd: process.cwd(),
      outDir,
      scenarios: [
        {
          budget: {
            maxDurationMs: 20_000,
            maxStageDurationMs: { lint: 20_000 },
          },
          description: "Ignore copied cache directories in benchmark workspaces.",
          fixturePath: fixtureRoot,
          id: "javascript-cache-isolation",
          inputs: ["."],
          kind: "cold",
          metadata: {
            languages: ["javascript"],
            scale: "small",
            shape: "full-repo",
            tags: ["isolation", "javascript"],
          },
          profile: "fast",
          stages: ["lint"],
        },
      ],
    });

    expect(report.scenarios[0]?.manifest.files).toEqual(["index.js"]);
  });

  it("does not copy prebuilt dist directories into benchmark workspaces", async () => {
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "aiq-benchmark-fixture-"));
    const outDir = await mkdtemp(path.join(os.tmpdir(), "aiq-benchmark-"));
    tempDirs.push(fixtureRoot, outDir);

    await writeFile(
      path.join(fixtureRoot, "index.js"),
      "export const greet = () => 'hi';\n",
      "utf8",
    );
    await mkdir(path.join(fixtureRoot, "dist", "nested"), { recursive: true });
    await writeFile(
      path.join(fixtureRoot, "dist", "nested", "bundle.js"),
      "stale-bundle\n",
      "utf8",
    );

    const { report } = await runBenchmarkSuite({
      cwd: process.cwd(),
      outDir,
      scenarios: [
        {
          budget: {
            maxDurationMs: 20_000,
            maxStageDurationMs: { lint: 20_000 },
          },
          description: "Ignore prebuilt dist directories in benchmark workspaces.",
          fixturePath: fixtureRoot,
          id: "javascript-dist-isolation",
          inputs: ["."],
          kind: "cold",
          metadata: {
            languages: ["javascript"],
            scale: "small",
            shape: "full-repo",
            tags: ["dist", "isolation", "javascript"],
          },
          profile: "fast",
          stages: ["lint"],
        },
      ],
    });

    expect(report.scenarios[0]?.manifest.files).toEqual(["index.js"]);
  });
});
