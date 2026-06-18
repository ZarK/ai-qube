import type { LanguageId, RunStatus, StageId } from "@tjalve/aiq/model";

import type { benchmarkArtifactVersion } from "./constants.js";

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
