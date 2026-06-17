import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { engineVersion, runEngine } from "@tjalve/aiq/engine";
import type { LanguageId, RunStatus, StageId } from "@tjalve/aiq/model";

export const benchmarkArtifactVersion = 2 as const;

export const defaultBenchmarkOutDir = ".aiq/out/benchmark";

const ignoredWorkspaceDirectories = new Set([
  ".aiq",
  ".git",
  ".gradle",
  ".idea",
  ".mypy_cache",
  ".terraform",
  ".pytest_cache",
  ".ruff_cache",
  ".venv",
  "__pycache__",
  "bin",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "obj",
  "target",
  "venv",
]);

export type BenchmarkScenarioKind = "cold" | "diff-only" | "warm";
export type BenchmarkInputShape = "full-repo" | "multi-file" | "single-file" | "sub-folder";
export type BenchmarkScaleBand = "large" | "medium" | "small";

export interface BenchmarkBudget {
  maxDurationMs: number;
  maxStageDurationMs?: Partial<Record<StageId, number>>;
}

export interface BenchmarkScenarioMetadata {
  languages: readonly LanguageId[];
  scale: BenchmarkScaleBand;
  shape: BenchmarkInputShape;
  tags: readonly string[];
}

export interface BenchmarkScenario {
  budget: BenchmarkBudget;
  description: string;
  fixturePath: string;
  id: string;
  inputs: readonly string[];
  kind: BenchmarkScenarioKind;
  metadata: BenchmarkScenarioMetadata;
  profile?: string;
  stages: readonly StageId[];
  warmupRuns?: number;
}

export interface BenchmarkScenarioManifest {
  fileCount: number;
  fileCountBand: BenchmarkScaleBand;
  files: string[];
  inputs: string[];
  loc: number;
  locBand: BenchmarkScaleBand;
  shape: BenchmarkInputShape;
}

export interface BenchmarkScenarioCache {
  hitCount: number;
  hitRate: number;
  isolation: "fresh-workspace-copy";
  missCount: number;
  primed: boolean;
  warmupRuns: number;
}

export interface BenchmarkPrimaryMetric {
  field: "summary.totalDurationMs";
  goal: "minimize";
  unit: "ms";
  value: number;
}

export interface BenchmarkScenarioResult {
  artifactDir: string;
  budget: BenchmarkBudget;
  budgetFailures: string[];
  cache: BenchmarkScenarioCache;
  cacheHitCount: number;
  cacheHitRate: number;
  cacheMissCount: number;
  description: string;
  diagnosticCount: number;
  durationMs: number;
  engineDurationMs: number;
  fixturePath: string;
  id: string;
  kind: BenchmarkScenarioKind;
  manifest: BenchmarkScenarioManifest;
  metadata: BenchmarkScenarioMetadata;
  metricsPath?: string;
  profile: string;
  reportPath?: string;
  stageDurationsMs: Partial<Record<StageId, number>>;
  stages: StageId[];
  status: RunStatus;
  toolDurationMs: number;
  toolRunCount: number;
  withinBudget: boolean;
}

export interface BenchmarkReportSelection {
  kinds: BenchmarkScenarioKind[];
  matchedScenarioCount: number;
  scenarioIds: string[];
  tags: string[];
}

export interface BenchmarkReportSummary {
  failedBudgetCount: number;
  passedBudgetCount: number;
  scenarioCount: number;
  totalDurationMs: number;
  totalFileCount: number;
  totalLoc: number;
}

export interface BenchmarkReport {
  artifactType: "benchmark";
  artifactVersion: typeof benchmarkArtifactVersion;
  cwd: string;
  engineVersion: string;
  environment: {
    arch: string;
    nodeVersion: string;
    platform: NodeJS.Platform;
  };
  generatedAt: string;
  primaryMetric: BenchmarkPrimaryMetric;
  scenarios: BenchmarkScenarioResult[];
  selection: BenchmarkReportSelection;
  summary: BenchmarkReportSummary;
}

export interface RunBenchmarkSuiteOptions {
  corpusRoot?: string;
  cwd?: string;
  kinds?: readonly BenchmarkScenarioKind[];
  outDir?: string;
  scenarioIds?: readonly string[];
  scenarios?: readonly BenchmarkScenario[];
  tags?: readonly string[];
  writeArtifact?: boolean;
}

export interface RunBenchmarkSuiteResult {
  artifactPath?: string;
  report: BenchmarkReport;
}

interface BenchmarkWorkspace {
  root: string;
  tempRoot: string;
}

export function createDefaultBenchmarkCorpus(root = process.cwd()): BenchmarkScenario[] {
  const fixture = (relativePath: string): string => path.resolve(root, relativePath);

  return [
    {
      budget: {
        maxDurationMs: 20_000,
        maxStageDurationMs: { lint: 20_000 },
      },
      description: "Cold single-file lint benchmark for the JavaScript fixture.",
      fixturePath: fixture("test-projects/javascript"),
      id: "javascript-lint-single-file-cold",
      inputs: ["index.js"],
      kind: "cold",
      metadata: {
        languages: ["javascript"],
        scale: "small",
        shape: "single-file",
        tags: ["ci", "cold", "javascript", "lint", "single-file", "small"],
      },
      profile: "fast",
      stages: ["lint"],
    },
    {
      budget: {
        maxDurationMs: 20_000,
        maxStageDurationMs: { format: 20_000 },
      },
      description: "Diff-only single-file format benchmark for the JavaScript fixture.",
      fixturePath: fixture("test-projects/javascript"),
      id: "javascript-format-single-file-diff",
      inputs: ["index.js"],
      kind: "diff-only",
      metadata: {
        languages: ["javascript"],
        scale: "small",
        shape: "single-file",
        tags: ["diff-only", "format", "javascript", "single-file", "small"],
      },
      profile: "fast",
      stages: ["format"],
    },
    {
      budget: {
        maxDurationMs: 30_000,
        maxStageDurationMs: { unit: 30_000 },
      },
      description: "Cold single-file unit benchmark for the JavaScript fixture.",
      fixturePath: fixture("test-projects/javascript"),
      id: "javascript-unit-single-file-cold",
      inputs: ["index.test.js"],
      kind: "cold",
      metadata: {
        languages: ["javascript"],
        scale: "small",
        shape: "single-file",
        tags: ["cold", "javascript", "single-file", "small", "unit"],
      },
      profile: "fast",
      stages: ["unit"],
    },
    {
      budget: {
        maxDurationMs: 30_000,
        maxStageDurationMs: { unit: 30_000 },
      },
      description: "Warm single-file unit benchmark for the JavaScript fixture.",
      fixturePath: fixture("test-projects/javascript"),
      id: "javascript-unit-single-file-warm",
      inputs: ["index.test.js"],
      kind: "warm",
      metadata: {
        languages: ["javascript"],
        scale: "small",
        shape: "single-file",
        tags: ["javascript", "single-file", "small", "unit", "warm"],
      },
      profile: "standard",
      stages: ["unit"],
      warmupRuns: 1,
    },
    {
      budget: {
        maxDurationMs: 30_000,
        maxStageDurationMs: { unit: 30_000 },
      },
      description: "Warm full-repo unit benchmark for the JavaScript fixture.",
      fixturePath: fixture("test-projects/javascript"),
      id: "javascript-unit-full-repo-warm",
      inputs: ["."],
      kind: "warm",
      metadata: {
        languages: ["javascript"],
        scale: "small",
        shape: "full-repo",
        tags: ["full-repo", "javascript", "small", "unit", "warm"],
      },
      profile: "standard",
      stages: ["unit"],
      warmupRuns: 1,
    },
    {
      budget: {
        maxDurationMs: 30_000,
        maxStageDurationMs: { unit: 30_000 },
      },
      description: "Cold full-repo unit benchmark for the JavaScript fixture.",
      fixturePath: fixture("test-projects/javascript"),
      id: "javascript-unit-full-repo-cold",
      inputs: ["."],
      kind: "cold",
      metadata: {
        languages: ["javascript"],
        scale: "small",
        shape: "full-repo",
        tags: ["cold", "full-repo", "javascript", "small", "unit"],
      },
      profile: "standard",
      stages: ["unit"],
    },
    {
      budget: {
        maxDurationMs: 45_000,
        maxStageDurationMs: { sloc: 45_000 },
      },
      description: "Diff-only single-file sloc benchmark for the JavaScript fixture.",
      fixturePath: fixture("test-projects/javascript"),
      id: "javascript-sloc-single-file-diff",
      inputs: ["index.js"],
      kind: "diff-only",
      metadata: {
        languages: ["javascript"],
        scale: "small",
        shape: "single-file",
        tags: ["diff-only", "javascript", "single-file", "small", "sloc"],
      },
      profile: "fast",
      stages: ["sloc"],
    },
    {
      budget: {
        maxDurationMs: 45_000,
        maxStageDurationMs: { sloc: 45_000 },
      },
      description: "Warm multi-file sloc benchmark for the JavaScript fixture.",
      fixturePath: fixture("test-projects/javascript"),
      id: "javascript-sloc-multi-file-warm",
      inputs: ["index.js", "index.test.js"],
      kind: "warm",
      metadata: {
        languages: ["javascript"],
        scale: "small",
        shape: "multi-file",
        tags: ["javascript", "multi-file", "small", "sloc", "warm"],
      },
      profile: "standard",
      stages: ["sloc"],
      warmupRuns: 1,
    },
    {
      budget: {
        maxDurationMs: 45_000,
        maxStageDurationMs: { complexity: 45_000 },
      },
      description: "Warm multi-file complexity benchmark for the JavaScript fixture.",
      fixturePath: fixture("test-projects/javascript"),
      id: "javascript-complexity-multi-file-warm",
      inputs: ["index.js", "index.test.js"],
      kind: "warm",
      metadata: {
        languages: ["javascript"],
        scale: "small",
        shape: "multi-file",
        tags: ["complexity", "javascript", "multi-file", "small", "warm"],
      },
      profile: "standard",
      stages: ["complexity"],
      warmupRuns: 1,
    },
    {
      budget: {
        maxDurationMs: 45_000,
        maxStageDurationMs: { maintainability: 45_000 },
      },
      description: "Cold full-repo maintainability benchmark for the JavaScript fixture.",
      fixturePath: fixture("test-projects/javascript"),
      id: "javascript-maintainability-full-repo-cold",
      inputs: ["."],
      kind: "cold",
      metadata: {
        languages: ["javascript"],
        scale: "small",
        shape: "full-repo",
        tags: ["cold", "full-repo", "javascript", "maintainability", "small"],
      },
      profile: "standard",
      stages: ["maintainability"],
    },
    {
      budget: {
        maxDurationMs: 30_000,
        maxStageDurationMs: { coverage: 30_000 },
      },
      description: "Warm full-repo coverage benchmark for the JavaScript fixture.",
      fixturePath: fixture("test-projects/javascript"),
      id: "javascript-coverage-full-repo-warm",
      inputs: ["."],
      kind: "warm",
      metadata: {
        languages: ["javascript"],
        scale: "small",
        shape: "full-repo",
        tags: ["coverage", "full-repo", "javascript", "small", "warm"],
      },
      profile: "standard",
      stages: ["coverage"],
      warmupRuns: 1,
    },
    {
      budget: {
        maxDurationMs: 30_000,
        maxStageDurationMs: { coverage: 30_000 },
      },
      description: "Warm sub-folder coverage benchmark for the JavaScript fixture.",
      fixturePath: fixture("test-projects/javascript"),
      id: "javascript-coverage-sub-folder-warm",
      inputs: ["src"],
      kind: "warm",
      metadata: {
        languages: ["javascript"],
        scale: "small",
        shape: "sub-folder",
        tags: ["coverage", "javascript", "small", "sub-folder", "warm"],
      },
      profile: "standard",
      stages: ["coverage"],
      warmupRuns: 1,
    },
    {
      budget: {
        maxDurationMs: 30_000,
        maxStageDurationMs: { typecheck: 30_000 },
      },
      description: "Warm sub-folder typecheck benchmark for the TypeScript fixture.",
      fixturePath: fixture("test-projects/typescript"),
      id: "typescript-typecheck-sub-folder-warm",
      inputs: ["src"],
      kind: "warm",
      metadata: {
        languages: ["typescript"],
        scale: "small",
        shape: "sub-folder",
        tags: ["sub-folder", "typecheck", "typescript", "warm"],
      },
      profile: "standard",
      stages: ["typecheck"],
      warmupRuns: 1,
    },
    {
      budget: {
        maxDurationMs: 30_000,
        maxStageDurationMs: { typecheck: 30_000 },
      },
      description: "Cold single-file typecheck benchmark for the TypeScript fixture.",
      fixturePath: fixture("test-projects/typescript"),
      id: "typescript-typecheck-single-file-cold",
      inputs: ["src/index.ts"],
      kind: "cold",
      metadata: {
        languages: ["typescript"],
        scale: "small",
        shape: "single-file",
        tags: ["cold", "single-file", "typecheck", "typescript"],
      },
      profile: "standard",
      stages: ["typecheck"],
    },
    {
      budget: {
        maxDurationMs: 45_000,
        maxStageDurationMs: {
          complexity: 45_000,
          maintainability: 45_000,
          sloc: 45_000,
        },
      },
      description: "Warm multi-file shared metrics benchmark for the larger TypeScript fixture.",
      fixturePath: fixture("test-projects/benchmark-typescript-large"),
      id: "typescript-metrics-multi-file-warm",
      inputs: ["src/index.ts", "src/workflow.ts", "src/workflow.test.ts", "src/index.test.ts"],
      kind: "warm",
      metadata: {
        languages: ["typescript"],
        scale: "large",
        shape: "multi-file",
        tags: ["ci", "large", "metrics", "multi-file", "typescript", "warm"],
      },
      profile: "standard",
      stages: ["sloc", "complexity", "maintainability"],
      warmupRuns: 1,
    },
    {
      budget: {
        maxDurationMs: 60_000,
        maxStageDurationMs: {
          coverage: 60_000,
          unit: 60_000,
        },
      },
      description: "Warm full-repo unit and coverage benchmark for the TypeScript fixture.",
      fixturePath: fixture("test-projects/typescript"),
      id: "typescript-unit-coverage-full-repo-warm",
      inputs: ["src", "vitest.config.ts"],
      kind: "warm",
      metadata: {
        languages: ["typescript"],
        scale: "medium",
        shape: "full-repo",
        tags: ["ci", "coverage", "full-repo", "medium", "typescript", "unit", "warm"],
      },
      profile: "standard",
      stages: ["unit", "coverage"],
      warmupRuns: 1,
    },
    {
      budget: {
        maxDurationMs: 30_000,
        maxStageDurationMs: { unit: 30_000 },
      },
      description: "Warm sub-folder unit benchmark for the TypeScript fixture.",
      fixturePath: fixture("test-projects/typescript"),
      id: "typescript-unit-sub-folder-warm",
      inputs: ["src"],
      kind: "warm",
      metadata: {
        languages: ["typescript"],
        scale: "small",
        shape: "sub-folder",
        tags: ["sub-folder", "typescript", "unit", "warm"],
      },
      profile: "standard",
      stages: ["unit"],
      warmupRuns: 1,
    },
    {
      budget: {
        maxDurationMs: 20_000,
        maxStageDurationMs: { lint: 20_000 },
      },
      description: "Cold single-file lint benchmark for the TypeScript fixture.",
      fixturePath: fixture("test-projects/typescript"),
      id: "typescript-lint-single-file-cold",
      inputs: ["src/index.ts"],
      kind: "cold",
      metadata: {
        languages: ["typescript"],
        scale: "small",
        shape: "single-file",
        tags: ["cold", "lint", "single-file", "small", "typescript"],
      },
      profile: "fast",
      stages: ["lint"],
    },
    {
      budget: {
        maxDurationMs: 20_000,
        maxStageDurationMs: { lint: 20_000 },
      },
      description: "Diff-only multi-file lint benchmark for the TypeScript fixture.",
      fixturePath: fixture("test-projects/typescript"),
      id: "typescript-lint-multi-file-diff",
      inputs: ["src/index.ts", "src/index.test.ts"],
      kind: "diff-only",
      metadata: {
        languages: ["typescript"],
        scale: "small",
        shape: "multi-file",
        tags: ["diff-only", "lint", "multi-file", "small", "typescript"],
      },
      profile: "fast",
      stages: ["lint"],
    },
    {
      budget: {
        maxDurationMs: 20_000,
        maxStageDurationMs: { lint: 20_000 },
      },
      description: "Warm full-repo lint benchmark for the TypeScript fixture.",
      fixturePath: fixture("test-projects/typescript"),
      id: "typescript-lint-full-repo-warm",
      inputs: ["."],
      kind: "warm",
      metadata: {
        languages: ["typescript"],
        scale: "small",
        shape: "full-repo",
        tags: ["full-repo", "lint", "small", "typescript", "warm"],
      },
      profile: "standard",
      stages: ["lint"],
      warmupRuns: 1,
    },
    {
      budget: {
        maxDurationMs: 20_000,
        maxStageDurationMs: { lint: 20_000 },
      },
      description: "Cold single-file lint benchmark for the Python fixture.",
      fixturePath: fixture("test-projects/python"),
      id: "python-lint-single-file-cold",
      inputs: ["main.py"],
      kind: "cold",
      metadata: {
        languages: ["python"],
        scale: "medium",
        shape: "single-file",
        tags: ["cold", "lint", "medium", "python", "single-file"],
      },
      profile: "fast",
      stages: ["lint"],
    },
    {
      budget: {
        maxDurationMs: 20_000,
        maxStageDurationMs: { format: 20_000 },
      },
      description: "Cold single-file format benchmark for the TypeScript fixture.",
      fixturePath: fixture("test-projects/typescript"),
      id: "typescript-format-single-file-cold",
      inputs: ["src/index.ts"],
      kind: "cold",
      metadata: {
        languages: ["typescript"],
        scale: "small",
        shape: "single-file",
        tags: ["cold", "format", "single-file", "small", "typescript"],
      },
      profile: "fast",
      stages: ["format"],
    },
    {
      budget: {
        maxDurationMs: 20_000,
        maxStageDurationMs: { format: 20_000 },
      },
      description: "Warm sub-folder format benchmark for the TypeScript fixture.",
      fixturePath: fixture("test-projects/typescript"),
      id: "typescript-format-sub-folder-warm",
      inputs: ["src"],
      kind: "warm",
      metadata: {
        languages: ["typescript"],
        scale: "small",
        shape: "sub-folder",
        tags: ["format", "sub-folder", "small", "typescript", "warm"],
      },
      profile: "standard",
      stages: ["format"],
      warmupRuns: 1,
    },
    {
      budget: {
        maxDurationMs: 20_000,
        maxStageDurationMs: { format: 20_000 },
      },
      description: "Warm full-repo format benchmark for the TypeScript fixture.",
      fixturePath: fixture("test-projects/typescript"),
      id: "typescript-format-full-repo-warm",
      inputs: ["."],
      kind: "warm",
      metadata: {
        languages: ["typescript"],
        scale: "small",
        shape: "full-repo",
        tags: ["format", "full-repo", "small", "typescript", "warm"],
      },
      profile: "standard",
      stages: ["format"],
      warmupRuns: 1,
    },
    {
      budget: {
        maxDurationMs: 45_000,
        maxStageDurationMs: { sloc: 45_000 },
      },
      description: "Warm multi-file sloc benchmark for the TypeScript fixture.",
      fixturePath: fixture("test-projects/typescript"),
      id: "typescript-sloc-multi-file-warm",
      inputs: ["src/index.ts", "src/index.test.ts"],
      kind: "warm",
      metadata: {
        languages: ["typescript"],
        scale: "small",
        shape: "multi-file",
        tags: ["multi-file", "small", "sloc", "typescript", "warm"],
      },
      profile: "standard",
      stages: ["sloc"],
      warmupRuns: 1,
    },
    {
      budget: {
        maxDurationMs: 45_000,
        maxStageDurationMs: { complexity: 45_000 },
      },
      description: "Cold full-repo complexity benchmark for the TypeScript fixture.",
      fixturePath: fixture("test-projects/typescript"),
      id: "typescript-complexity-full-repo-cold",
      inputs: ["."],
      kind: "cold",
      metadata: {
        languages: ["typescript"],
        scale: "small",
        shape: "full-repo",
        tags: ["cold", "complexity", "full-repo", "small", "typescript"],
      },
      profile: "standard",
      stages: ["complexity"],
    },
    {
      budget: {
        maxDurationMs: 45_000,
        maxStageDurationMs: { maintainability: 45_000 },
      },
      description: "Warm full-repo maintainability benchmark for the TypeScript fixture.",
      fixturePath: fixture("test-projects/typescript"),
      id: "typescript-maintainability-full-repo-warm",
      inputs: ["."],
      kind: "warm",
      metadata: {
        languages: ["typescript"],
        scale: "small",
        shape: "full-repo",
        tags: ["full-repo", "maintainability", "small", "typescript", "warm"],
      },
      profile: "standard",
      stages: ["maintainability"],
      warmupRuns: 1,
    },
    {
      budget: {
        maxDurationMs: 20_000,
        maxStageDurationMs: { lint: 20_000 },
      },
      description: "Cold full-repo lint benchmark for the TypeScript fixture.",
      fixturePath: fixture("test-projects/typescript"),
      id: "typescript-lint-full-repo-cold",
      inputs: ["."],
      kind: "cold",
      metadata: {
        languages: ["typescript"],
        scale: "small",
        shape: "full-repo",
        tags: ["cold", "full-repo", "lint", "small", "typescript"],
      },
      profile: "standard",
      stages: ["lint"],
    },
    {
      budget: {
        maxDurationMs: 20_000,
        maxStageDurationMs: { format: 20_000 },
      },
      description: "Diff-only full-repo format benchmark for the TypeScript fixture.",
      fixturePath: fixture("test-projects/typescript"),
      id: "typescript-format-full-repo-diff",
      inputs: ["."],
      kind: "diff-only",
      metadata: {
        languages: ["typescript"],
        scale: "small",
        shape: "full-repo",
        tags: ["ci", "diff-only", "format", "full-repo", "small", "typescript"],
      },
      profile: "fast",
      stages: ["format"],
    },
    {
      budget: {
        maxDurationMs: 90_000,
        maxStageDurationMs: {
          complexity: 90_000,
          coverage: 90_000,
          format: 90_000,
          lint: 90_000,
          maintainability: 90_000,
          security: 90_000,
          typecheck: 90_000,
          unit: 90_000,
        },
      },
      description: "Cold full-repo Python quality benchmark across runnable stages.",
      fixturePath: fixture("test-projects/python"),
      id: "python-quality-full-repo-cold",
      inputs: ["main.py", "tests/test_main.py", "tests"],
      kind: "cold",
      metadata: {
        languages: ["python"],
        scale: "medium",
        shape: "full-repo",
        tags: ["ci", "cold", "full-repo", "medium", "python", "quality", "security"],
      },
      profile: "standard",
      stages: [
        "lint",
        "format",
        "typecheck",
        "unit",
        "coverage",
        "complexity",
        "maintainability",
        "security",
      ],
    },
    {
      budget: {
        maxDurationMs: 20_000,
        maxStageDurationMs: { lint: 20_000 },
      },
      description: "Warm full-repo lint benchmark for the Python fixture.",
      fixturePath: fixture("test-projects/python"),
      id: "python-lint-full-repo-warm",
      inputs: ["."],
      kind: "warm",
      metadata: {
        languages: ["python"],
        scale: "medium",
        shape: "full-repo",
        tags: ["ci", "full-repo", "lint", "medium", "python", "warm"],
      },
      profile: "standard",
      stages: ["lint"],
      warmupRuns: 1,
    },
    {
      budget: {
        maxDurationMs: 20_000,
        maxStageDurationMs: { format: 20_000 },
      },
      description: "Diff-only single-file format benchmark for the Python fixture.",
      fixturePath: fixture("test-projects/python"),
      id: "python-format-single-file-diff",
      inputs: ["main.py"],
      kind: "diff-only",
      metadata: {
        languages: ["python"],
        scale: "medium",
        shape: "single-file",
        tags: ["diff-only", "format", "medium", "python", "single-file"],
      },
      profile: "fast",
      stages: ["format"],
    },
    {
      budget: {
        maxDurationMs: 30_000,
        maxStageDurationMs: { typecheck: 30_000 },
      },
      description: "Warm full-repo typecheck benchmark for the Python fixture.",
      fixturePath: fixture("test-projects/python"),
      id: "python-typecheck-full-repo-warm",
      inputs: ["."],
      kind: "warm",
      metadata: {
        languages: ["python"],
        scale: "medium",
        shape: "full-repo",
        tags: ["full-repo", "medium", "python", "typecheck", "warm"],
      },
      profile: "standard",
      stages: ["typecheck"],
      warmupRuns: 1,
    },
    {
      budget: {
        maxDurationMs: 30_000,
        maxStageDurationMs: { typecheck: 30_000 },
      },
      description: "Warm multi-file typecheck benchmark for the Python fixture.",
      fixturePath: fixture("test-projects/python"),
      id: "python-typecheck-multi-file-warm",
      inputs: ["main.py", "tests/test_main.py"],
      kind: "warm",
      metadata: {
        languages: ["python"],
        scale: "medium",
        shape: "multi-file",
        tags: ["medium", "multi-file", "python", "typecheck", "warm"],
      },
      profile: "standard",
      stages: ["typecheck"],
      warmupRuns: 1,
    },
    {
      budget: {
        maxDurationMs: 30_000,
        maxStageDurationMs: { unit: 30_000 },
      },
      description: "Warm sub-folder unit benchmark for the Python fixture.",
      fixturePath: fixture("test-projects/python"),
      id: "python-unit-sub-folder-warm",
      inputs: ["tests"],
      kind: "warm",
      metadata: {
        languages: ["python"],
        scale: "medium",
        shape: "sub-folder",
        tags: ["medium", "python", "sub-folder", "unit", "warm"],
      },
      profile: "standard",
      stages: ["unit"],
      warmupRuns: 1,
    },
    {
      budget: {
        maxDurationMs: 45_000,
        maxStageDurationMs: {
          format: 45_000,
          lint: 45_000,
          security: 45_000,
          typecheck: 45_000,
        },
      },
      description: "Cold full-repo Terraform and HCL benchmark for infrastructure stages.",
      fixturePath: fixture("test-projects/benchmark-terraform-hcl"),
      id: "terraform-hcl-infra-full-repo-cold",
      inputs: ["."],
      kind: "cold",
      metadata: {
        languages: ["terraform", "hcl"],
        scale: "small",
        shape: "full-repo",
        tags: ["cold", "full-repo", "hcl", "infrastructure", "security", "small", "terraform"],
      },
      profile: "standard",
      stages: ["lint", "format", "typecheck", "security"],
    },
    {
      budget: {
        maxDurationMs: 20_000,
        maxStageDurationMs: { lint: 20_000 },
      },
      description: "Warm full-repo lint benchmark for the Terraform fixture.",
      fixturePath: fixture("test-projects/benchmark-terraform-hcl"),
      id: "terraform-lint-full-repo-warm",
      inputs: ["."],
      kind: "warm",
      metadata: {
        languages: ["terraform", "hcl"],
        scale: "small",
        shape: "full-repo",
        tags: ["full-repo", "hcl", "lint", "small", "terraform", "warm"],
      },
      profile: "standard",
      stages: ["lint"],
      warmupRuns: 1,
    },
    {
      budget: {
        maxDurationMs: 20_000,
        maxStageDurationMs: { format: 20_000 },
      },
      description: "Diff-only single-file format benchmark for the Terraform fixture.",
      fixturePath: fixture("test-projects/benchmark-terraform-hcl"),
      id: "terraform-format-single-file-diff",
      inputs: ["main.tf"],
      kind: "diff-only",
      metadata: {
        languages: ["terraform", "hcl"],
        scale: "small",
        shape: "single-file",
        tags: ["diff-only", "format", "hcl", "single-file", "small", "terraform"],
      },
      profile: "fast",
      stages: ["format"],
    },
    {
      budget: {
        maxDurationMs: 90_000,
        maxStageDurationMs: {
          complexity: 90_000,
          coverage: 90_000,
          format: 90_000,
          lint: 90_000,
          maintainability: 90_000,
          sloc: 90_000,
          typecheck: 90_000,
          unit: 90_000,
        },
      },
      description: "Warm full-repo Go benchmark across build, test, and metrics stages.",
      fixturePath: fixture("test-projects/go"),
      id: "go-quality-full-repo-warm",
      inputs: ["."],
      kind: "warm",
      metadata: {
        languages: ["go"],
        scale: "medium",
        shape: "full-repo",
        tags: ["full-repo", "go", "medium", "quality", "warm"],
      },
      profile: "standard",
      stages: [
        "lint",
        "format",
        "typecheck",
        "unit",
        "coverage",
        "sloc",
        "complexity",
        "maintainability",
      ],
      warmupRuns: 1,
    },
    {
      budget: {
        maxDurationMs: 90_000,
        maxStageDurationMs: {
          complexity: 90_000,
          coverage: 90_000,
          format: 90_000,
          lint: 90_000,
          maintainability: 90_000,
          sloc: 90_000,
          typecheck: 90_000,
          unit: 90_000,
        },
      },
      description: "Warm full-repo Rust benchmark across build, test, and metrics stages.",
      fixturePath: fixture("test-projects/rust"),
      id: "rust-quality-full-repo-warm",
      inputs: ["."],
      kind: "warm",
      metadata: {
        languages: ["rust"],
        scale: "medium",
        shape: "full-repo",
        tags: ["full-repo", "medium", "quality", "rust", "warm"],
      },
      profile: "standard",
      stages: [
        "lint",
        "format",
        "typecheck",
        "unit",
        "coverage",
        "sloc",
        "complexity",
        "maintainability",
      ],
      warmupRuns: 1,
    },
    {
      budget: {
        maxDurationMs: 20_000,
        maxStageDurationMs: { lint: 20_000 },
      },
      description: "Cold full-repo lint benchmark for the Rust fixture.",
      fixturePath: fixture("test-projects/rust"),
      id: "rust-lint-full-repo-cold",
      inputs: ["."],
      kind: "cold",
      metadata: {
        languages: ["rust"],
        scale: "medium",
        shape: "full-repo",
        tags: ["cold", "full-repo", "lint", "medium", "rust"],
      },
      profile: "standard",
      stages: ["lint"],
    },
    {
      budget: {
        maxDurationMs: 20_000,
        maxStageDurationMs: { lint: 20_000 },
      },
      description: "Cold single-file lint benchmark for the Rust fixture.",
      fixturePath: fixture("test-projects/rust"),
      id: "rust-lint-single-file-cold",
      inputs: ["src/lib.rs"],
      kind: "cold",
      metadata: {
        languages: ["rust"],
        scale: "medium",
        shape: "single-file",
        tags: ["cold", "lint", "medium", "rust", "single-file"],
      },
      profile: "fast",
      stages: ["lint"],
    },
    {
      budget: {
        maxDurationMs: 20_000,
        maxStageDurationMs: { format: 20_000 },
      },
      description: "Diff-only single-file format benchmark for the Rust fixture.",
      fixturePath: fixture("test-projects/rust"),
      id: "rust-format-single-file-diff",
      inputs: ["src/main.rs"],
      kind: "diff-only",
      metadata: {
        languages: ["rust"],
        scale: "medium",
        shape: "single-file",
        tags: ["diff-only", "format", "medium", "rust", "single-file"],
      },
      profile: "fast",
      stages: ["format"],
    },
    {
      budget: {
        maxDurationMs: 45_000,
        maxStageDurationMs: { typecheck: 45_000 },
      },
      description: "Warm multi-file typecheck benchmark for the Rust fixture.",
      fixturePath: fixture("test-projects/rust"),
      id: "rust-typecheck-multi-file-warm",
      inputs: ["src/lib.rs", "tests/integration.rs"],
      kind: "warm",
      metadata: {
        languages: ["rust"],
        scale: "medium",
        shape: "multi-file",
        tags: ["medium", "multi-file", "rust", "typecheck", "warm"],
      },
      profile: "standard",
      stages: ["typecheck"],
      warmupRuns: 1,
    },
    {
      budget: {
        maxDurationMs: 45_000,
        maxStageDurationMs: { unit: 45_000 },
      },
      description: "Warm sub-folder unit benchmark for the Rust fixture.",
      fixturePath: fixture("test-projects/rust"),
      id: "rust-unit-sub-folder-warm",
      inputs: ["tests"],
      kind: "warm",
      metadata: {
        languages: ["rust"],
        scale: "medium",
        shape: "sub-folder",
        tags: ["medium", "rust", "sub-folder", "unit", "warm"],
      },
      profile: "standard",
      stages: ["unit"],
      warmupRuns: 1,
    },
    {
      budget: {
        maxDurationMs: 20_000,
        maxStageDurationMs: { lint: 20_000 },
      },
      description: "Cold full-repo lint benchmark for the Go fixture.",
      fixturePath: fixture("test-projects/go"),
      id: "go-lint-full-repo-cold",
      inputs: ["."],
      kind: "cold",
      metadata: {
        languages: ["go"],
        scale: "medium",
        shape: "full-repo",
        tags: ["ci", "cold", "full-repo", "go", "lint", "medium"],
      },
      profile: "standard",
      stages: ["lint"],
    },
    {
      budget: {
        maxDurationMs: 20_000,
        maxStageDurationMs: { lint: 20_000 },
      },
      description: "Cold single-file lint benchmark for the Go fixture.",
      fixturePath: fixture("test-projects/go"),
      id: "go-lint-single-file-cold",
      inputs: ["greeter.go"],
      kind: "cold",
      metadata: {
        languages: ["go"],
        scale: "medium",
        shape: "single-file",
        tags: ["cold", "go", "lint", "medium", "single-file"],
      },
      profile: "fast",
      stages: ["lint"],
    },
    {
      budget: {
        maxDurationMs: 20_000,
        maxStageDurationMs: { format: 20_000 },
      },
      description: "Diff-only single-file format benchmark for the Go fixture.",
      fixturePath: fixture("test-projects/go"),
      id: "go-format-single-file-diff",
      inputs: ["greeter.go"],
      kind: "diff-only",
      metadata: {
        languages: ["go"],
        scale: "medium",
        shape: "single-file",
        tags: ["diff-only", "format", "go", "medium", "single-file"],
      },
      profile: "fast",
      stages: ["format"],
    },
    {
      budget: {
        maxDurationMs: 30_000,
        maxStageDurationMs: { unit: 30_000 },
      },
      description: "Warm multi-file unit benchmark for the Go fixture.",
      fixturePath: fixture("test-projects/go"),
      id: "go-unit-multi-file-warm",
      inputs: ["greeter.go", "greeter_test.go"],
      kind: "warm",
      metadata: {
        languages: ["go"],
        scale: "medium",
        shape: "multi-file",
        tags: ["go", "medium", "multi-file", "unit", "warm"],
      },
      profile: "standard",
      stages: ["unit"],
      warmupRuns: 1,
    },
    {
      budget: {
        maxDurationMs: 45_000,
        maxStageDurationMs: { coverage: 45_000 },
      },
      description: "Warm sub-folder coverage benchmark for the Go fixture.",
      fixturePath: fixture("test-projects/go"),
      id: "go-coverage-sub-folder-warm",
      inputs: ["pkg"],
      kind: "warm",
      metadata: {
        languages: ["go"],
        scale: "medium",
        shape: "sub-folder",
        tags: ["coverage", "go", "medium", "sub-folder", "warm"],
      },
      profile: "standard",
      stages: ["coverage"],
      warmupRuns: 1,
    },
    {
      budget: {
        maxDurationMs: 90_000,
        maxStageDurationMs: {
          complexity: 90_000,
          coverage: 90_000,
          format: 90_000,
          lint: 90_000,
          maintainability: 90_000,
          sloc: 90_000,
          typecheck: 90_000,
          unit: 90_000,
        },
      },
      description:
        "Warm full-repo .NET benchmark across build, test, metrics, and security stages.",
      fixturePath: fixture("test-projects/dotnet"),
      id: "dotnet-quality-full-repo-warm",
      inputs: ["."],
      kind: "warm",
      metadata: {
        languages: ["dotnet"],
        scale: "medium",
        shape: "full-repo",
        tags: ["dotnet", "full-repo", "medium", "quality", "security", "warm"],
      },
      profile: "standard",
      stages: [
        "lint",
        "format",
        "typecheck",
        "unit",
        "coverage",
        "sloc",
        "complexity",
        "maintainability",
        "security",
      ],
      warmupRuns: 1,
    },
    {
      budget: {
        maxDurationMs: 20_000,
        maxStageDurationMs: { lint: 20_000 },
      },
      description: "Cold full-repo lint benchmark for the .NET fixture.",
      fixturePath: fixture("test-projects/dotnet"),
      id: "dotnet-lint-full-repo-cold",
      inputs: ["."],
      kind: "cold",
      metadata: {
        languages: ["dotnet"],
        scale: "medium",
        shape: "full-repo",
        tags: ["cold", "dotnet", "full-repo", "lint", "medium"],
      },
      profile: "standard",
      stages: ["lint"],
    },
    {
      budget: {
        maxDurationMs: 20_000,
        maxStageDurationMs: { lint: 20_000 },
      },
      description: "Cold single-file lint benchmark for the .NET fixture.",
      fixturePath: fixture("test-projects/dotnet"),
      id: "dotnet-lint-single-file-cold",
      inputs: ["src/DotNetFixture/Greeter.cs"],
      kind: "cold",
      metadata: {
        languages: ["dotnet"],
        scale: "medium",
        shape: "single-file",
        tags: ["cold", "dotnet", "lint", "medium", "single-file"],
      },
      profile: "fast",
      stages: ["lint"],
    },
    {
      budget: {
        maxDurationMs: 20_000,
        maxStageDurationMs: { format: 20_000 },
      },
      description: "Diff-only single-file format benchmark for the .NET fixture.",
      fixturePath: fixture("test-projects/dotnet"),
      id: "dotnet-format-single-file-diff",
      inputs: ["src/DotnetProject/Program.cs"],
      kind: "diff-only",
      metadata: {
        languages: ["dotnet"],
        scale: "medium",
        shape: "single-file",
        tags: ["diff-only", "dotnet", "format", "medium", "single-file"],
      },
      profile: "fast",
      stages: ["format"],
    },
    {
      budget: {
        maxDurationMs: 60_000,
        maxStageDurationMs: { typecheck: 60_000 },
      },
      description: "Warm multi-file typecheck benchmark for the .NET fixture.",
      fixturePath: fixture("test-projects/dotnet"),
      id: "dotnet-typecheck-multi-file-warm",
      inputs: ["src/DotNetFixture/Greeter.cs", "tests/DotNetFixture.Tests/GreeterTests.cs"],
      kind: "warm",
      metadata: {
        languages: ["dotnet"],
        scale: "medium",
        shape: "multi-file",
        tags: ["dotnet", "medium", "multi-file", "typecheck", "warm"],
      },
      profile: "standard",
      stages: ["typecheck"],
      warmupRuns: 1,
    },
    {
      budget: {
        maxDurationMs: 90_000,
        maxStageDurationMs: {
          complexity: 90_000,
          coverage: 90_000,
          format: 90_000,
          lint: 90_000,
          maintainability: 90_000,
          sloc: 90_000,
          typecheck: 90_000,
          unit: 90_000,
        },
      },
      description: "Warm full-repo Java benchmark across JVM quality stages.",
      fixturePath: fixture("test-projects/java-maven"),
      id: "java-quality-full-repo-warm",
      inputs: ["."],
      kind: "warm",
      metadata: {
        languages: ["java"],
        scale: "medium",
        shape: "full-repo",
        tags: ["full-repo", "java", "medium", "quality", "warm"],
      },
      profile: "standard",
      stages: [
        "lint",
        "format",
        "typecheck",
        "unit",
        "coverage",
        "sloc",
        "complexity",
        "maintainability",
      ],
      warmupRuns: 1,
    },
    {
      budget: {
        maxDurationMs: 20_000,
        maxStageDurationMs: { lint: 20_000 },
      },
      description: "Cold full-repo lint benchmark for the Java fixture.",
      fixturePath: fixture("test-projects/java-maven"),
      id: "java-lint-full-repo-cold",
      inputs: ["."],
      kind: "cold",
      metadata: {
        languages: ["java"],
        scale: "medium",
        shape: "full-repo",
        tags: ["cold", "full-repo", "java", "lint", "medium"],
      },
      profile: "standard",
      stages: ["lint"],
    },
    {
      budget: {
        maxDurationMs: 20_000,
        maxStageDurationMs: { lint: 20_000 },
      },
      description: "Cold single-file lint benchmark for the Java fixture.",
      fixturePath: fixture("test-projects/java-maven"),
      id: "java-lint-single-file-cold",
      inputs: ["src/main/java/dev/aiq/fixture/Greeting.java"],
      kind: "cold",
      metadata: {
        languages: ["java"],
        scale: "medium",
        shape: "single-file",
        tags: ["cold", "java", "lint", "medium", "single-file"],
      },
      profile: "fast",
      stages: ["lint"],
    },
    {
      budget: {
        maxDurationMs: 60_000,
        maxStageDurationMs: { unit: 60_000 },
      },
      description: "Warm multi-file unit benchmark for the Java fixture.",
      fixturePath: fixture("test-projects/java-maven"),
      id: "java-unit-multi-file-warm",
      inputs: [
        "src/main/java/dev/aiq/fixture/Greeting.java",
        "src/test/java/dev/aiq/fixture/GreetingTest.java",
      ],
      kind: "warm",
      metadata: {
        languages: ["java"],
        scale: "medium",
        shape: "multi-file",
        tags: ["java", "medium", "multi-file", "unit", "warm"],
      },
      profile: "standard",
      stages: ["unit"],
      warmupRuns: 1,
    },
    {
      budget: {
        maxDurationMs: 90_000,
        maxStageDurationMs: {
          complexity: 90_000,
          coverage: 90_000,
          format: 90_000,
          lint: 90_000,
          maintainability: 90_000,
          sloc: 90_000,
          typecheck: 90_000,
          unit: 90_000,
        },
      },
      description: "Warm full-repo Kotlin benchmark across JVM quality stages.",
      fixturePath: fixture("test-projects/kotlin-gradle"),
      id: "kotlin-quality-full-repo-warm",
      inputs: ["."],
      kind: "warm",
      metadata: {
        languages: ["kotlin"],
        scale: "medium",
        shape: "full-repo",
        tags: ["full-repo", "kotlin", "medium", "quality", "warm"],
      },
      profile: "standard",
      stages: [
        "lint",
        "format",
        "typecheck",
        "unit",
        "coverage",
        "sloc",
        "complexity",
        "maintainability",
      ],
      warmupRuns: 1,
    },
    {
      budget: {
        maxDurationMs: 20_000,
        maxStageDurationMs: { lint: 20_000 },
      },
      description: "Cold full-repo lint benchmark for the Kotlin fixture.",
      fixturePath: fixture("test-projects/kotlin-gradle"),
      id: "kotlin-lint-full-repo-cold",
      inputs: ["."],
      kind: "cold",
      metadata: {
        languages: ["kotlin"],
        scale: "medium",
        shape: "full-repo",
        tags: ["cold", "full-repo", "kotlin", "lint", "medium"],
      },
      profile: "standard",
      stages: ["lint"],
    },
    {
      budget: {
        maxDurationMs: 20_000,
        maxStageDurationMs: { lint: 20_000 },
      },
      description: "Cold single-file lint benchmark for the Kotlin fixture.",
      fixturePath: fixture("test-projects/kotlin-gradle"),
      id: "kotlin-lint-single-file-cold",
      inputs: ["src/main/kotlin/dev/aiq/fixture/Greeting.kt"],
      kind: "cold",
      metadata: {
        languages: ["kotlin"],
        scale: "medium",
        shape: "single-file",
        tags: ["cold", "kotlin", "lint", "medium", "single-file"],
      },
      profile: "fast",
      stages: ["lint"],
    },
    {
      budget: {
        maxDurationMs: 60_000,
        maxStageDurationMs: { unit: 60_000 },
      },
      description: "Warm multi-file unit benchmark for the Kotlin fixture.",
      fixturePath: fixture("test-projects/kotlin-gradle"),
      id: "kotlin-unit-multi-file-warm",
      inputs: [
        "src/main/kotlin/dev/aiq/fixture/Greeting.kt",
        "src/test/kotlin/dev/aiq/fixture/GreetingTest.kt",
      ],
      kind: "warm",
      metadata: {
        languages: ["kotlin"],
        scale: "medium",
        shape: "multi-file",
        tags: ["kotlin", "medium", "multi-file", "unit", "warm"],
      },
      profile: "standard",
      stages: ["unit"],
      warmupRuns: 1,
    },
    {
      budget: {
        maxDurationMs: 60_000,
        maxStageDurationMs: { security: 60_000 },
      },
      description: "Cold full-repo security benchmark for the Go fixture.",
      fixturePath: fixture("test-projects/go"),
      id: "go-security-full-repo-cold",
      inputs: ["."],
      kind: "cold",
      metadata: {
        languages: ["go"],
        scale: "medium",
        shape: "full-repo",
        tags: ["cold", "full-repo", "go", "medium", "security"],
      },
      profile: "standard",
      stages: ["security"],
    },
    {
      budget: {
        maxDurationMs: 60_000,
        maxStageDurationMs: { security: 60_000 },
      },
      description: "Warm full-repo security benchmark for the Go fixture.",
      fixturePath: fixture("test-projects/go"),
      id: "go-security-full-repo-warm",
      inputs: ["."],
      kind: "warm",
      metadata: {
        languages: ["go"],
        scale: "medium",
        shape: "full-repo",
        tags: ["full-repo", "go", "medium", "security", "warm"],
      },
      profile: "standard",
      stages: ["security"],
      warmupRuns: 1,
    },
    {
      budget: {
        maxDurationMs: 60_000,
        maxStageDurationMs: { security: 60_000 },
      },
      description: "Cold full-repo security benchmark for the Rust fixture.",
      fixturePath: fixture("test-projects/rust"),
      id: "rust-security-full-repo-cold",
      inputs: ["."],
      kind: "cold",
      metadata: {
        languages: ["rust"],
        scale: "medium",
        shape: "full-repo",
        tags: ["cold", "full-repo", "medium", "rust", "security"],
      },
      profile: "standard",
      stages: ["security"],
    },
    {
      budget: {
        maxDurationMs: 60_000,
        maxStageDurationMs: { security: 60_000 },
      },
      description: "Warm full-repo security benchmark for the Rust fixture.",
      fixturePath: fixture("test-projects/rust"),
      id: "rust-security-full-repo-warm",
      inputs: ["."],
      kind: "warm",
      metadata: {
        languages: ["rust"],
        scale: "medium",
        shape: "full-repo",
        tags: ["full-repo", "medium", "rust", "security", "warm"],
      },
      profile: "standard",
      stages: ["security"],
      warmupRuns: 1,
    },
    {
      budget: {
        maxDurationMs: 60_000,
        maxStageDurationMs: { security: 60_000 },
      },
      description: "Cold full-repo security benchmark for the Java fixture.",
      fixturePath: fixture("test-projects/java-maven"),
      id: "java-security-full-repo-cold",
      inputs: ["."],
      kind: "cold",
      metadata: {
        languages: ["java"],
        scale: "medium",
        shape: "full-repo",
        tags: ["cold", "full-repo", "java", "medium", "security"],
      },
      profile: "standard",
      stages: ["security"],
    },
    {
      budget: {
        maxDurationMs: 60_000,
        maxStageDurationMs: { security: 60_000 },
      },
      description: "Warm full-repo security benchmark for the Java fixture.",
      fixturePath: fixture("test-projects/java-maven"),
      id: "java-security-full-repo-warm",
      inputs: ["."],
      kind: "warm",
      metadata: {
        languages: ["java"],
        scale: "medium",
        shape: "full-repo",
        tags: ["full-repo", "java", "medium", "security", "warm"],
      },
      profile: "standard",
      stages: ["security"],
      warmupRuns: 1,
    },
    {
      budget: {
        maxDurationMs: 60_000,
        maxStageDurationMs: { security: 60_000 },
      },
      description: "Cold full-repo security benchmark for the Kotlin fixture.",
      fixturePath: fixture("test-projects/kotlin-gradle"),
      id: "kotlin-security-full-repo-cold",
      inputs: ["."],
      kind: "cold",
      metadata: {
        languages: ["kotlin"],
        scale: "medium",
        shape: "full-repo",
        tags: ["cold", "full-repo", "kotlin", "medium", "security"],
      },
      profile: "standard",
      stages: ["security"],
    },
    {
      budget: {
        maxDurationMs: 60_000,
        maxStageDurationMs: { security: 60_000 },
      },
      description: "Warm full-repo security benchmark for the Kotlin fixture.",
      fixturePath: fixture("test-projects/kotlin-gradle"),
      id: "kotlin-security-full-repo-warm",
      inputs: ["."],
      kind: "warm",
      metadata: {
        languages: ["kotlin"],
        scale: "medium",
        shape: "full-repo",
        tags: ["full-repo", "kotlin", "medium", "security", "warm"],
      },
      profile: "standard",
      stages: ["security"],
      warmupRuns: 1,
    },
    {
      budget: {
        maxDurationMs: 20_000,
        maxStageDurationMs: { lint: 20_000 },
      },
      description: "Cold single-file lint benchmark for the Bash fixture.",
      fixturePath: fixture("test-projects/bash"),
      id: "bash-lint-single-file-cold",
      inputs: ["example.sh"],
      kind: "cold",
      metadata: {
        languages: ["bash"],
        scale: "small",
        shape: "single-file",
        tags: ["bash", "cold", "lint", "single-file", "small"],
      },
      profile: "fast",
      stages: ["lint"],
    },
    {
      budget: {
        maxDurationMs: 20_000,
        maxStageDurationMs: { lint: 20_000 },
      },
      description: "Warm multi-file lint benchmark for the Bash fixture.",
      fixturePath: fixture("test-projects/bash"),
      id: "bash-lint-multi-file-warm",
      inputs: ["example.sh", "utils.sh"],
      kind: "warm",
      metadata: {
        languages: ["bash"],
        scale: "small",
        shape: "multi-file",
        tags: ["bash", "lint", "multi-file", "small", "warm"],
      },
      profile: "standard",
      stages: ["lint"],
      warmupRuns: 1,
    },
    {
      budget: {
        maxDurationMs: 20_000,
        maxStageDurationMs: { lint: 20_000 },
      },
      description: "Cold full-repo lint benchmark for the Bash fixture.",
      fixturePath: fixture("test-projects/bash"),
      id: "bash-lint-full-repo-cold",
      inputs: ["."],
      kind: "cold",
      metadata: {
        languages: ["bash"],
        scale: "small",
        shape: "full-repo",
        tags: ["bash", "cold", "full-repo", "lint", "small"],
      },
      profile: "standard",
      stages: ["lint"],
    },
    {
      budget: {
        maxDurationMs: 20_000,
        maxStageDurationMs: { format: 20_000 },
      },
      description: "Diff-only single-file format benchmark for the Bash fixture.",
      fixturePath: fixture("test-projects/bash"),
      id: "bash-format-single-file-diff",
      inputs: ["example.sh"],
      kind: "diff-only",
      metadata: {
        languages: ["bash"],
        scale: "small",
        shape: "single-file",
        tags: ["bash", "diff-only", "format", "single-file", "small"],
      },
      profile: "fast",
      stages: ["format"],
    },
    {
      budget: {
        maxDurationMs: 20_000,
        maxStageDurationMs: { format: 20_000 },
      },
      description: "Warm full-repo format benchmark for the Bash fixture.",
      fixturePath: fixture("test-projects/bash"),
      id: "bash-format-full-repo-warm",
      inputs: ["."],
      kind: "warm",
      metadata: {
        languages: ["bash"],
        scale: "small",
        shape: "full-repo",
        tags: ["bash", "format", "full-repo", "small", "warm"],
      },
      profile: "standard",
      stages: ["format"],
      warmupRuns: 1,
    },
    {
      budget: {
        maxDurationMs: 30_000,
        maxStageDurationMs: { unit: 30_000 },
      },
      description: "Warm single-file unit benchmark for the Bash fixture.",
      fixturePath: fixture("test-projects/bash"),
      id: "bash-unit-single-file-warm",
      inputs: ["example_test.bats"],
      kind: "warm",
      metadata: {
        languages: ["bash"],
        scale: "small",
        shape: "single-file",
        tags: ["bash", "single-file", "small", "unit", "warm"],
      },
      profile: "standard",
      stages: ["unit"],
      warmupRuns: 1,
    },
    {
      budget: {
        maxDurationMs: 30_000,
        maxStageDurationMs: { unit: 30_000 },
      },
      description: "Cold full-repo unit benchmark for the Bash fixture.",
      fixturePath: fixture("test-projects/bash"),
      id: "bash-unit-full-repo-cold",
      inputs: ["."],
      kind: "cold",
      metadata: {
        languages: ["bash"],
        scale: "small",
        shape: "full-repo",
        tags: ["bash", "cold", "full-repo", "small", "unit"],
      },
      profile: "standard",
      stages: ["unit"],
    },
    {
      budget: {
        maxDurationMs: 30_000,
        maxStageDurationMs: { coverage: 30_000 },
      },
      description: "Warm full-repo coverage benchmark for the Bash fixture.",
      fixturePath: fixture("test-projects/bash"),
      id: "bash-coverage-full-repo-warm",
      inputs: ["."],
      kind: "warm",
      metadata: {
        languages: ["bash"],
        scale: "small",
        shape: "full-repo",
        tags: ["bash", "coverage", "full-repo", "small", "warm"],
      },
      profile: "standard",
      stages: ["coverage"],
      warmupRuns: 1,
    },
    {
      budget: {
        maxDurationMs: 20_000,
        maxStageDurationMs: { lint: 20_000 },
      },
      description: "Cold single-file lint benchmark for the PowerShell fixture.",
      fixturePath: fixture("test-projects/powershell"),
      id: "powershell-lint-single-file-cold",
      inputs: ["example.ps1"],
      kind: "cold",
      metadata: {
        languages: ["powershell"],
        scale: "small",
        shape: "single-file",
        tags: ["cold", "lint", "powershell", "single-file", "small"],
      },
      profile: "fast",
      stages: ["lint"],
    },
    {
      budget: {
        maxDurationMs: 20_000,
        maxStageDurationMs: { lint: 20_000 },
      },
      description: "Warm multi-file lint benchmark for the PowerShell fixture.",
      fixturePath: fixture("test-projects/powershell"),
      id: "powershell-lint-multi-file-warm",
      inputs: ["example.ps1", "utils.ps1"],
      kind: "warm",
      metadata: {
        languages: ["powershell"],
        scale: "small",
        shape: "multi-file",
        tags: ["lint", "multi-file", "powershell", "small", "warm"],
      },
      profile: "standard",
      stages: ["lint"],
      warmupRuns: 1,
    },
    {
      budget: {
        maxDurationMs: 20_000,
        maxStageDurationMs: { lint: 20_000 },
      },
      description: "Cold full-repo lint benchmark for the PowerShell fixture.",
      fixturePath: fixture("test-projects/powershell"),
      id: "powershell-lint-full-repo-cold",
      inputs: ["."],
      kind: "cold",
      metadata: {
        languages: ["powershell"],
        scale: "small",
        shape: "full-repo",
        tags: ["cold", "full-repo", "lint", "powershell", "small"],
      },
      profile: "standard",
      stages: ["lint"],
    },
    {
      budget: {
        maxDurationMs: 20_000,
        maxStageDurationMs: { format: 20_000 },
      },
      description: "Diff-only single-file format benchmark for the PowerShell fixture.",
      fixturePath: fixture("test-projects/powershell"),
      id: "powershell-format-single-file-diff",
      inputs: ["example.ps1"],
      kind: "diff-only",
      metadata: {
        languages: ["powershell"],
        scale: "small",
        shape: "single-file",
        tags: ["diff-only", "format", "powershell", "single-file", "small"],
      },
      profile: "fast",
      stages: ["format"],
    },
    {
      budget: {
        maxDurationMs: 20_000,
        maxStageDurationMs: { format: 20_000 },
      },
      description: "Warm full-repo format benchmark for the PowerShell fixture.",
      fixturePath: fixture("test-projects/powershell"),
      id: "powershell-format-full-repo-warm",
      inputs: ["."],
      kind: "warm",
      metadata: {
        languages: ["powershell"],
        scale: "small",
        shape: "full-repo",
        tags: ["format", "full-repo", "powershell", "small", "warm"],
      },
      profile: "standard",
      stages: ["format"],
      warmupRuns: 1,
    },
    {
      budget: {
        maxDurationMs: 30_000,
        maxStageDurationMs: { unit: 30_000 },
      },
      description: "Warm single-file unit benchmark for the PowerShell fixture.",
      fixturePath: fixture("test-projects/powershell"),
      id: "powershell-unit-single-file-warm",
      inputs: ["example.tests.ps1"],
      kind: "warm",
      metadata: {
        languages: ["powershell"],
        scale: "small",
        shape: "single-file",
        tags: ["powershell", "single-file", "small", "unit", "warm"],
      },
      profile: "standard",
      stages: ["unit"],
      warmupRuns: 1,
    },
    {
      budget: {
        maxDurationMs: 30_000,
        maxStageDurationMs: { unit: 30_000 },
      },
      description: "Cold full-repo unit benchmark for the PowerShell fixture.",
      fixturePath: fixture("test-projects/powershell"),
      id: "powershell-unit-full-repo-cold",
      inputs: ["."],
      kind: "cold",
      metadata: {
        languages: ["powershell"],
        scale: "small",
        shape: "full-repo",
        tags: ["cold", "full-repo", "powershell", "small", "unit"],
      },
      profile: "standard",
      stages: ["unit"],
    },
    {
      budget: {
        maxDurationMs: 30_000,
        maxStageDurationMs: { coverage: 30_000 },
      },
      description: "Warm full-repo coverage benchmark for the PowerShell fixture.",
      fixturePath: fixture("test-projects/powershell"),
      id: "powershell-coverage-full-repo-warm",
      inputs: ["."],
      kind: "warm",
      metadata: {
        languages: ["powershell"],
        scale: "small",
        shape: "full-repo",
        tags: ["coverage", "full-repo", "powershell", "small", "warm"],
      },
      profile: "standard",
      stages: ["coverage"],
      warmupRuns: 1,
    },
    {
      budget: {
        maxDurationMs: 20_000,
        maxStageDurationMs: { lint: 20_000 },
      },
      description: "Cold single-file lint benchmark for the HTML fixture.",
      fixturePath: fixture("test-projects/html-css"),
      id: "html-lint-single-file-cold",
      inputs: ["index.html"],
      kind: "cold",
      metadata: {
        languages: ["html"],
        scale: "small",
        shape: "single-file",
        tags: ["cold", "html", "lint", "single-file", "small"],
      },
      profile: "fast",
      stages: ["lint"],
    },
    {
      budget: {
        maxDurationMs: 20_000,
        maxStageDurationMs: { lint: 20_000 },
      },
      description: "Warm full-repo lint benchmark for the HTML fixture.",
      fixturePath: fixture("test-projects/html-css"),
      id: "html-lint-full-repo-warm",
      inputs: ["."],
      kind: "warm",
      metadata: {
        languages: ["html"],
        scale: "small",
        shape: "full-repo",
        tags: ["full-repo", "html", "lint", "small", "warm"],
      },
      profile: "standard",
      stages: ["lint"],
      warmupRuns: 1,
    },
    {
      budget: {
        maxDurationMs: 20_000,
        maxStageDurationMs: { lint: 20_000 },
      },
      description: "Cold single-file lint benchmark for the CSS fixture.",
      fixturePath: fixture("test-projects/html-css"),
      id: "css-lint-single-file-cold",
      inputs: ["styles.css"],
      kind: "cold",
      metadata: {
        languages: ["css"],
        scale: "small",
        shape: "single-file",
        tags: ["cold", "css", "lint", "single-file", "small"],
      },
      profile: "fast",
      stages: ["lint"],
    },
    {
      budget: {
        maxDurationMs: 20_000,
        maxStageDurationMs: { lint: 20_000 },
      },
      description: "Warm full-repo lint benchmark for the CSS fixture.",
      fixturePath: fixture("test-projects/html-css"),
      id: "css-lint-full-repo-warm",
      inputs: ["."],
      kind: "warm",
      metadata: {
        languages: ["css"],
        scale: "small",
        shape: "full-repo",
        tags: ["css", "full-repo", "lint", "small", "warm"],
      },
      profile: "standard",
      stages: ["lint"],
      warmupRuns: 1,
    },
    {
      budget: {
        maxDurationMs: 20_000,
        maxStageDurationMs: { lint: 20_000 },
      },
      description: "Diff-only single-file lint benchmark for the YAML fixture.",
      fixturePath: fixture("test-projects/yaml"),
      id: "yaml-lint-single-file-diff",
      inputs: ["config.yaml"],
      kind: "diff-only",
      metadata: {
        languages: ["yaml"],
        scale: "small",
        shape: "single-file",
        tags: ["diff-only", "lint", "single-file", "small", "yaml"],
      },
      profile: "fast",
      stages: ["lint"],
    },
    {
      budget: {
        maxDurationMs: 20_000,
        maxStageDurationMs: { lint: 20_000 },
      },
      description: "Warm full-repo lint benchmark for the YAML fixture.",
      fixturePath: fixture("test-projects/yaml"),
      id: "yaml-lint-full-repo-warm",
      inputs: ["."],
      kind: "warm",
      metadata: {
        languages: ["yaml"],
        scale: "small",
        shape: "full-repo",
        tags: ["full-repo", "lint", "small", "warm", "yaml"],
      },
      profile: "standard",
      stages: ["lint"],
      warmupRuns: 1,
    },
    {
      budget: {
        maxDurationMs: 20_000,
        maxStageDurationMs: { lint: 20_000 },
      },
      description: "Cold single-file lint benchmark for the SQL fixture.",
      fixturePath: fixture("test-projects/sql"),
      id: "sql-lint-single-file-cold",
      inputs: ["query.sql"],
      kind: "cold",
      metadata: {
        languages: ["sql"],
        scale: "small",
        shape: "single-file",
        tags: ["cold", "lint", "single-file", "small", "sql"],
      },
      profile: "fast",
      stages: ["lint"],
    },
    {
      budget: {
        maxDurationMs: 20_000,
        maxStageDurationMs: { format: 20_000 },
      },
      description: "Diff-only single-file format benchmark for the SQL fixture.",
      fixturePath: fixture("test-projects/sql"),
      id: "sql-format-single-file-diff",
      inputs: ["query.sql"],
      kind: "diff-only",
      metadata: {
        languages: ["sql"],
        scale: "small",
        shape: "single-file",
        tags: ["diff-only", "format", "single-file", "small", "sql"],
      },
      profile: "fast",
      stages: ["format"],
    },
    {
      budget: {
        maxDurationMs: 20_000,
        maxStageDurationMs: { format: 20_000 },
      },
      description: "Warm full-repo format benchmark for the SQL fixture.",
      fixturePath: fixture("test-projects/sql"),
      id: "sql-format-full-repo-warm",
      inputs: ["."],
      kind: "warm",
      metadata: {
        languages: ["sql"],
        scale: "small",
        shape: "full-repo",
        tags: ["format", "full-repo", "small", "sql", "warm"],
      },
      profile: "standard",
      stages: ["format"],
      warmupRuns: 1,
    },
    {
      budget: {
        maxDurationMs: 20_000,
        maxStageDurationMs: { format: 20_000 },
      },
      description: "Cold single-file format benchmark for the documents fixture.",
      fixturePath: fixture("test-projects/html-css"),
      id: "documents-format-single-file-cold",
      inputs: ["index.html"],
      kind: "cold",
      metadata: {
        languages: ["documents"],
        scale: "small",
        shape: "single-file",
        tags: ["cold", "documents", "format", "single-file", "small"],
      },
      profile: "fast",
      stages: ["format"],
    },
    {
      budget: {
        maxDurationMs: 20_000,
        maxStageDurationMs: { format: 20_000 },
      },
      description: "Warm full-repo format benchmark for the documents fixture.",
      fixturePath: fixture("test-projects/html-css"),
      id: "documents-format-full-repo-warm",
      inputs: ["."],
      kind: "warm",
      metadata: {
        languages: ["documents"],
        scale: "small",
        shape: "full-repo",
        tags: ["documents", "format", "full-repo", "small", "warm"],
      },
      profile: "standard",
      stages: ["format"],
      warmupRuns: 1,
    },
  ];
}

export function filterBenchmarkScenarios(
  scenarios: readonly BenchmarkScenario[],
  options: Pick<RunBenchmarkSuiteOptions, "kinds" | "scenarioIds" | "tags"> = {},
): BenchmarkScenario[] {
  const requestedScenarioIds = normalizeStrings(options.scenarioIds);
  const requestedTags = normalizeStrings(options.tags);
  const requestedKinds = normalizeKinds(options.kinds);

  if (requestedScenarioIds.length > 0) {
    const knownScenarioIds = new Set(scenarios.map((scenario) => scenario.id));
    const missingScenarioIds = requestedScenarioIds.filter((id) => !knownScenarioIds.has(id));
    if (missingScenarioIds.length > 0) {
      throw new Error(
        `Unknown benchmark scenario id${missingScenarioIds.length === 1 ? "" : "s"}: ${missingScenarioIds.join(", ")}.`,
      );
    }
  }

  const filtered = scenarios.filter((scenario) => {
    if (requestedScenarioIds.length > 0 && !requestedScenarioIds.includes(scenario.id)) {
      return false;
    }

    if (requestedKinds.length > 0 && !requestedKinds.includes(scenario.kind)) {
      return false;
    }

    if (
      requestedTags.length > 0 &&
      !requestedTags.every((tag) => scenario.metadata.tags.includes(tag))
    ) {
      return false;
    }

    return true;
  });

  if (filtered.length === 0) {
    throw new Error("No benchmark scenarios matched the requested filters.");
  }

  return filtered;
}

export async function runBenchmarkSuite(
  options: RunBenchmarkSuiteOptions = {},
): Promise<RunBenchmarkSuiteResult> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const corpusRoot = path.resolve(options.corpusRoot ?? cwd);
  const outDir = path.resolve(cwd, options.outDir ?? defaultBenchmarkOutDir);
  const allScenarios = [...(options.scenarios ?? createDefaultBenchmarkCorpus(corpusRoot))];
  const scenarios = filterBenchmarkScenarios(allScenarios, options);
  const scenarioResults: BenchmarkScenarioResult[] = [];

  for (const scenario of scenarios) {
    try {
      scenarioResults.push(await runBenchmarkScenario(scenario, outDir));
    } catch (error) {
      throw new Error(`Benchmark scenario '${scenario.id}' failed: ${formatError(error)}`);
    }
  }

  const summary = summarizeBenchmarkReport(scenarioResults);
  const report: BenchmarkReport = {
    artifactType: "benchmark",
    artifactVersion: benchmarkArtifactVersion,
    cwd,
    engineVersion,
    environment: {
      arch: os.arch(),
      nodeVersion: process.version,
      platform: process.platform,
    },
    generatedAt: new Date().toISOString(),
    primaryMetric: {
      field: "summary.totalDurationMs",
      goal: "minimize",
      unit: "ms",
      value: summary.totalDurationMs,
    },
    scenarios: scenarioResults,
    selection: {
      kinds: normalizeKinds(options.kinds),
      matchedScenarioCount: scenarioResults.length,
      scenarioIds: normalizeStrings(options.scenarioIds),
      tags: normalizeStrings(options.tags),
    },
    summary,
  };

  if (options.writeArtifact === false) {
    return { report };
  }

  const artifactPath = await writeBenchmarkReportArtifact(report, outDir);
  return { artifactPath, report };
}

export async function runBenchmarkSuiteAndEnforceBudgets(
  options: RunBenchmarkSuiteOptions = {},
): Promise<RunBenchmarkSuiteResult> {
  const result = await runBenchmarkSuite(options);

  if (result.report.summary.failedBudgetCount > 0) {
    throw new Error(`${result.report.summary.failedBudgetCount} benchmark budget(s) failed.`);
  }

  return result;
}

export function formatBenchmarkReportAsJson(report: BenchmarkReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function formatBenchmarkReportAsText(report: BenchmarkReport): string {
  const lines = [
    "AIQ bench",
    `Scenarios: ${report.summary.scenarioCount}`,
    `Primary metric: ${report.primaryMetric.field}=${report.primaryMetric.value}ms (${report.primaryMetric.goal})`,
    `Budgets: ${report.summary.passedBudgetCount} passed, ${report.summary.failedBudgetCount} failed`,
    `Input totals: ${report.summary.totalFileCount} files, ${report.summary.totalLoc} LOC`,
  ];

  for (const scenario of report.scenarios) {
    lines.push(
      `- ${scenario.id}: ${scenario.status}, ${scenario.durationMs}ms, ${scenario.manifest.fileCount} files, ${scenario.manifest.loc} LOC, budget=${scenario.withinBudget ? "passed" : "failed"}`,
    );
    lines.push(
      `  kind=${scenario.kind}; shape=${scenario.manifest.shape}; languages=${scenario.metadata.languages.join(",")}; stages=${scenario.stages.join(",")}`,
    );
    if (scenario.budgetFailures.length > 0) {
      lines.push(`  budget failures: ${scenario.budgetFailures.join("; ")}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export function resolveBenchmarkArtifactPath(
  root: string,
  outDir = defaultBenchmarkOutDir,
): string {
  return path.join(path.resolve(root, outDir), "aiq.benchmark.json");
}

export async function writeBenchmarkReportArtifact(
  report: BenchmarkReport,
  outDir = defaultBenchmarkOutDir,
): Promise<string> {
  const targetDir = path.resolve(report.cwd, outDir);
  const artifactPath = resolveBenchmarkArtifactPath(report.cwd, outDir);
  try {
    await mkdir(targetDir, { recursive: true });
    await writeFile(artifactPath, formatBenchmarkReportAsJson(report), "utf8");
  } catch (error) {
    throw new Error(`Failed to write benchmark artifact at ${artifactPath}: ${formatError(error)}`);
  }

  return artifactPath;
}

async function runBenchmarkScenario(
  scenario: BenchmarkScenario,
  baseOutDir: string,
): Promise<BenchmarkScenarioResult> {
  validateBenchmarkScenario(scenario);

  const fixturePath = path.resolve(scenario.fixturePath);
  const scenarioOutDir = resolveScenarioOutDir(baseOutDir, scenario.id);
  await rm(scenarioOutDir, { force: true, recursive: true });
  const workspace = await createScenarioWorkspace(fixturePath, scenario.id);
  try {
    const manifest = await resolveScenarioManifest(scenario, workspace.root);
    const warmupRuns = scenario.warmupRuns ?? (scenario.kind === "warm" ? 1 : 0);

    for (let index = 0; index < warmupRuns; index += 1) {
      const warmupResult = await runEngine({
        context: "cli",
        cwd: workspace.root,
        manifest: { files: manifest.absoluteFiles, source: "direct" },
        mode: "check",
        ...(scenario.profile === undefined ? {} : { profile: scenario.profile }),
        stages: scenario.stages,
        writeArtifacts: false,
      });
      if (warmupResult.summary.status !== "passed") {
        throw new Error(
          `Warmup run ${index + 1} finished with status '${warmupResult.summary.status}'.`,
        );
      }
    }

    const startedAt = process.hrtime.bigint();
    const result = await runEngine({
      context: "cli",
      cwd: workspace.root,
      manifest: { files: manifest.absoluteFiles, source: "direct" },
      mode: "check",
      outDir: scenarioOutDir,
      ...(scenario.profile === undefined ? {} : { profile: scenario.profile }),
      stages: scenario.stages,
      writeArtifacts: true,
    });
    if (result.summary.status !== "passed") {
      throw new Error(`Engine run finished with status '${result.summary.status}'.`);
    }
    const durationMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
    const stageDurationsMs = Object.fromEntries(
      result.stages.map((stage) => [stage.stageId, stage.durationMs]),
    ) as Partial<Record<StageId, number>>;
    const budgetFailures = evaluateBudget(durationMs, stageDurationsMs, scenario.budget);

    return {
      artifactDir: scenarioOutDir,
      budget: cloneBudget(scenario.budget),
      budgetFailures,
      cache: {
        hitCount: result.summary.cacheHitCount,
        hitRate: result.summary.cacheHitRate,
        isolation: "fresh-workspace-copy",
        missCount: result.summary.cacheMissCount,
        primed: warmupRuns > 0,
        warmupRuns,
      },
      cacheHitCount: result.summary.cacheHitCount,
      cacheHitRate: result.summary.cacheHitRate,
      cacheMissCount: result.summary.cacheMissCount,
      description: scenario.description,
      diagnosticCount: result.summary.diagnosticCount,
      durationMs,
      engineDurationMs: result.summary.durationMs,
      fixturePath,
      id: scenario.id,
      kind: scenario.kind,
      manifest: {
        fileCount: manifest.relativeFiles.length,
        fileCountBand: computeFileCountBand(manifest.relativeFiles.length),
        files: manifest.relativeFiles,
        inputs: [...scenario.inputs],
        loc: manifest.loc,
        locBand: computeLocBand(manifest.loc),
        shape: scenario.metadata.shape,
      },
      metadata: cloneMetadata(scenario.metadata),
      ...(result.artifacts.metricsPath === undefined
        ? {}
        : { metricsPath: result.artifacts.metricsPath }),
      profile: result.request.selection.profile,
      ...(result.artifacts.reportPath === undefined
        ? {}
        : { reportPath: result.artifacts.reportPath }),
      stageDurationsMs,
      stages: [...scenario.stages],
      status: result.summary.status,
      toolDurationMs: result.summary.toolDurationMs,
      toolRunCount: result.summary.toolRunCount,
      withinBudget: budgetFailures.length === 0,
    };
  } finally {
    await rm(workspace.tempRoot, { force: true, recursive: true });
  }
}

function validateBenchmarkScenario(scenario: BenchmarkScenario): void {
  if (scenario.inputs.length === 0) {
    throw new Error(`Benchmark scenario '${scenario.id}' requires at least one input path.`);
  }

  if (scenario.metadata.languages.length === 0) {
    throw new Error(`Benchmark scenario '${scenario.id}' requires at least one language.`);
  }

  if (scenario.metadata.tags.length === 0) {
    throw new Error(`Benchmark scenario '${scenario.id}' requires at least one tag.`);
  }
}

async function createScenarioWorkspace(
  fixturePath: string,
  scenarioId: string,
): Promise<BenchmarkWorkspace> {
  const parentDir = path.resolve(fixturePath, "..");
  const tempRoot = await mkdtemp(path.join(parentDir, `.aiq-benchmark-${scenarioId}-`));
  const workspaceRoot = path.join(tempRoot, "workspace");
  await cp(fixturePath, workspaceRoot, {
    filter: (source) => shouldCopyWorkspaceEntry(source),
    recursive: true,
  });
  return {
    root: workspaceRoot,
    tempRoot,
  };
}

function shouldCopyWorkspaceEntry(source: string): boolean {
  return !path
    .normalize(source)
    .split(path.sep)
    .some((segment) => ignoredWorkspaceDirectories.has(segment));
}

interface ResolvedScenarioManifest {
  absoluteFiles: string[];
  loc: number;
  relativeFiles: string[];
}

async function resolveScenarioManifest(
  scenario: BenchmarkScenario,
  workspaceRoot: string,
): Promise<ResolvedScenarioManifest> {
  const discoveredFiles = new Set<string>();

  for (const input of scenario.inputs) {
    const inputPath = path.resolve(workspaceRoot, input);
    const inputStats = await stat(inputPath).catch((error: unknown) => {
      throw new Error(
        `Input '${input}' does not exist in benchmark fixture: ${formatError(error)}`,
      );
    });

    if (inputStats.isDirectory()) {
      for (const file of await walkScenarioDirectory(inputPath)) {
        discoveredFiles.add(file);
      }
      continue;
    }

    if (!inputStats.isFile()) {
      throw new Error(`Input '${input}' is not a regular file or directory.`);
    }

    discoveredFiles.add(inputPath);
  }

  const absoluteFiles = [...discoveredFiles].sort((left, right) => left.localeCompare(right));
  if (absoluteFiles.length === 0) {
    throw new Error(`Scenario '${scenario.id}' resolved no files from the configured inputs.`);
  }

  const locByFile = await Promise.all(
    absoluteFiles.map(async (file) => ({
      file,
      loc: countLines(await readFile(file, "utf8")),
    })),
  );

  return {
    absoluteFiles,
    loc: locByFile.reduce((total, entry) => total + entry.loc, 0),
    relativeFiles: absoluteFiles.map((file) => toPortableRelativePath(workspaceRoot, file)),
  };
}

async function walkScenarioDirectory(root: string): Promise<string[]> {
  const discoveredFiles: string[] = [];
  const queue = [root];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      continue;
    }

    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredWorkspaceDirectories.has(entry.name)) {
          queue.push(entryPath);
        }
        continue;
      }

      if (entry.isFile()) {
        discoveredFiles.push(entryPath);
      }
    }
  }

  return discoveredFiles;
}

function countLines(source: string): number {
  const normalized = source.replace(/\r\n/gu, "\n");
  if (normalized.length === 0) {
    return 0;
  }

  const lines = normalized.split("\n");
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

function toPortableRelativePath(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join(path.posix.sep);
}

function cloneBudget(budget: BenchmarkBudget): BenchmarkBudget {
  return {
    maxDurationMs: budget.maxDurationMs,
    ...(budget.maxStageDurationMs === undefined
      ? {}
      : { maxStageDurationMs: { ...budget.maxStageDurationMs } }),
  };
}

function cloneMetadata(metadata: BenchmarkScenarioMetadata): BenchmarkScenarioMetadata {
  return {
    languages: [...metadata.languages],
    scale: metadata.scale,
    shape: metadata.shape,
    tags: [...metadata.tags],
  };
}

function evaluateBudget(
  durationMs: number,
  stageDurationsMs: Partial<Record<StageId, number>>,
  budget: BenchmarkBudget,
): string[] {
  const failures: string[] = [];

  if (durationMs > budget.maxDurationMs) {
    failures.push(`total duration ${durationMs}ms exceeded budget ${budget.maxDurationMs}ms`);
  }

  const stageBudget = budget.maxStageDurationMs;
  if (stageBudget !== undefined) {
    for (const [stageId, maxDurationMs] of Object.entries(stageBudget) as Array<
      [StageId, number]
    >) {
      const duration = stageDurationsMs[stageId];
      if (duration !== undefined && duration > maxDurationMs) {
        failures.push(`${stageId} duration ${duration}ms exceeded budget ${maxDurationMs}ms`);
      }
    }
  }

  return failures;
}

function summarizeBenchmarkReport(
  scenarios: readonly BenchmarkScenarioResult[],
): BenchmarkReportSummary {
  const failedBudgetCount = scenarios.filter((scenario) => !scenario.withinBudget).length;

  return {
    failedBudgetCount,
    passedBudgetCount: scenarios.length - failedBudgetCount,
    scenarioCount: scenarios.length,
    totalDurationMs: scenarios.reduce((total, scenario) => total + scenario.durationMs, 0),
    totalFileCount: scenarios.reduce((total, scenario) => total + scenario.manifest.fileCount, 0),
    totalLoc: scenarios.reduce((total, scenario) => total + scenario.manifest.loc, 0),
  };
}

function computeFileCountBand(fileCount: number): BenchmarkScaleBand {
  if (fileCount <= 3) {
    return "small";
  }

  if (fileCount <= 15) {
    return "medium";
  }

  return "large";
}

function computeLocBand(loc: number): BenchmarkScaleBand {
  if (loc <= 120) {
    return "small";
  }

  if (loc <= 600) {
    return "medium";
  }

  return "large";
}

function normalizeStrings(values: readonly string[] | undefined): string[] {
  return [
    ...new Set((values ?? []).map((value) => value.trim()).filter((value) => value.length > 0)),
  ].sort((left, right) => left.localeCompare(right));
}

function normalizeKinds(
  values: readonly BenchmarkScenarioKind[] | undefined,
): BenchmarkScenarioKind[] {
  return [...new Set(values ?? [])].sort((left, right) => left.localeCompare(right));
}

function resolveScenarioOutDir(baseOutDir: string, scenarioId: string): string {
  if (
    scenarioId.trim().length === 0 ||
    scenarioId === "." ||
    scenarioId === ".." ||
    scenarioId.includes(path.posix.sep) ||
    scenarioId.includes(path.win32.sep)
  ) {
    throw new Error(
      `Invalid benchmark scenario id '${scenarioId}'. Scenario ids must not be empty or contain path separators.`,
    );
  }

  const resolvedBaseOutDir = path.resolve(baseOutDir);
  const scenarioOutDir = path.resolve(resolvedBaseOutDir, scenarioId);
  const relativeScenarioOutDir = path.relative(resolvedBaseOutDir, scenarioOutDir);
  if (
    relativeScenarioOutDir.length === 0 ||
    relativeScenarioOutDir === "." ||
    relativeScenarioOutDir === ".." ||
    relativeScenarioOutDir.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeScenarioOutDir)
  ) {
    throw new Error(`Invalid benchmark scenario id '${scenarioId}'.`);
  }

  return scenarioOutDir;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
