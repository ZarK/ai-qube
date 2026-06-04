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
      access(path.join(benchmarkTypeScriptLargeFixturePath, ".aiq")),
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
      access(path.join(benchmarkTypeScriptLargeFixturePath, ".aiq")),
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
