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
  it("creates a default corpus with rewrite-grade language, stage, kind, and shape coverage", () => {
    const corpus = createDefaultBenchmarkCorpus(path.resolve(process.cwd()));

    expect(corpus).toHaveLength(98);
    expect(new Set(corpus.map((scenario) => scenario.kind))).toEqual(
      new Set(["cold", "diff-only", "warm"]),
    );
    expect(new Set(corpus.map((scenario) => scenario.metadata.shape))).toEqual(
      new Set(["single-file", "multi-file", "sub-folder", "full-repo"]),
    );
    expect(new Set(corpus.flatMap((scenario) => scenario.stages))).toEqual(
      new Set([
        "lint",
        "format",
        "typecheck",
        "unit",
        "sloc",
        "complexity",
        "maintainability",
        "coverage",
        "security",
      ]),
    );
    expect(new Set(corpus.flatMap((scenario) => scenario.metadata.languages))).toEqual(
      new Set([
        "javascript",
        "typescript",
        "python",
        "terraform",
        "hcl",
        "go",
        "rust",
        "dotnet",
        "java",
        "kotlin",
        "bash",
        "powershell",
        "html",
        "css",
        "yaml",
        "sql",
        "documents",
      ]),
    );
  });
});
