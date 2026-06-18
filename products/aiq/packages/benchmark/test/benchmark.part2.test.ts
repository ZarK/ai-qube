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
  it("includes the issue 96 shape scenarios for targeted languages", () => {
    const corpus = createDefaultBenchmarkCorpus(path.resolve(process.cwd()));
    const scenarioIds = new Set(corpus.map((scenario) => scenario.id));

    expect([...scenarioIds]).toEqual(expect.arrayContaining(Array.from(issue96ScenarioIds)));

    const shapesByLanguage = new Map<string, Set<string>>();
    for (const scenario of corpus) {
      for (const language of scenario.metadata.languages) {
        const shapes = shapesByLanguage.get(language) ?? new Set<string>();
        shapes.add(scenario.metadata.shape);
        shapesByLanguage.set(language, shapes);
      }
    }

    expect(shapesByLanguage.get("javascript")).toEqual(
      new Set(["full-repo", "multi-file", "single-file", "sub-folder"]),
    );
    expect(shapesByLanguage.get("typescript")).toEqual(
      new Set(["full-repo", "multi-file", "single-file", "sub-folder"]),
    );
    expect(shapesByLanguage.get("python")).toEqual(
      new Set(["full-repo", "multi-file", "single-file", "sub-folder"]),
    );
    expect(shapesByLanguage.get("go")).toEqual(
      new Set(["full-repo", "multi-file", "single-file", "sub-folder"]),
    );
    expect(shapesByLanguage.get("rust")).toEqual(
      new Set(["full-repo", "multi-file", "single-file", "sub-folder"]),
    );
    expect(shapesByLanguage.get("dotnet")).toEqual(
      new Set(["full-repo", "multi-file", "single-file"]),
    );
    expect(shapesByLanguage.get("java")).toEqual(
      new Set(["full-repo", "multi-file", "single-file"]),
    );
    expect(shapesByLanguage.get("kotlin")).toEqual(
      new Set(["full-repo", "multi-file", "single-file"]),
    );
  });

  it.skipIf(!hasFullBenchmarkToolchain)(
    "runs the issue 96 benchmark scenarios successfully",
    async () => {
      const outDir = await mkdtemp(path.join(os.tmpdir(), "aiq-benchmark-"));
      tempDirs.push(outDir);

      const { report } = await runBenchmarkSuite({
        cwd: process.cwd(),
        outDir,
        scenarioIds: issue96ScenarioIds,
        scenarios: createDefaultBenchmarkCorpus(path.resolve(process.cwd())),
      });

      expect(report.summary.failedBudgetCount).toBe(0);
      expect(report.summary.scenarioCount).toBe(issue96ScenarioIds.length);
      expect(report.scenarios.every((scenario) => scenario.status === "passed")).toBe(true);
      expect(report.scenarios.every((scenario) => scenario.withinBudget)).toBe(true);
      expect(new Set(report.scenarios.map((scenario) => scenario.id))).toEqual(
        new Set(issue96ScenarioIds),
      );
      expect(
        new Set(
          report.scenarios.find((scenario) => scenario.id === "python-unit-sub-folder-warm")
            ?.manifest.files,
        ),
      ).toEqual(new Set(["tests/test_main.py"]));
      expect(
        report.scenarios.find((scenario) => scenario.id === "javascript-coverage-sub-folder-warm")
          ?.manifest,
      ).toMatchObject({
        inputs: ["src"],
        shape: "sub-folder",
      });
      expect(
        new Set(
          report.scenarios.find((scenario) => scenario.id === "javascript-coverage-sub-folder-warm")
            ?.manifest.files,
        ),
      ).toEqual(new Set(["src/subfolder.js", "src/subfolder.test.js"]));
      expect(
        report.scenarios.find((scenario) => scenario.id === "go-coverage-sub-folder-warm")
          ?.manifest,
      ).toMatchObject({
        inputs: ["pkg"],
        shape: "sub-folder",
      });
      expect(
        new Set(
          report.scenarios.find((scenario) => scenario.id === "go-coverage-sub-folder-warm")
            ?.manifest.files,
        ),
      ).toEqual(new Set(["pkg/fixture/greeter.go", "pkg/fixture/greeter_test.go"]));
    },
    180_000,
  );

  it("filters benchmark scenarios by id, kind, and tag", () => {
    const corpus = createDefaultBenchmarkCorpus(path.resolve(process.cwd()));

    const filtered = filterBenchmarkScenarios(corpus, {
      kinds: ["warm"],
      scenarioIds: ["typescript-metrics-multi-file-warm", "python-quality-full-repo-cold"],
      tags: ["ci"],
    });

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.id).toBe("typescript-metrics-multi-file-warm");
  });
});
