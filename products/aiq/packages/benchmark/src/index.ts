import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { engineVersion } from "@tjalve/aiq/engine";
import { benchmarkArtifactVersion, defaultBenchmarkOutDir } from "./constants.js";
import { createDefaultBenchmarkCorpus } from "./default-corpus.js";
import { formatError, runBenchmarkScenario, summarizeBenchmarkReport } from "./scenario-runner.js";
import type {
  BenchmarkBudget,
  BenchmarkInputShape,
  BenchmarkReport,
  BenchmarkReportSummary,
  BenchmarkScaleBand,
  BenchmarkScenario,
  BenchmarkScenarioManifest,
  BenchmarkScenarioMetadata,
  BenchmarkScenarioResult,
  BenchmarkScenarioKind,
  RunBenchmarkSuiteOptions,
  RunBenchmarkSuiteResult,
} from "./types.js";

export { benchmarkArtifactVersion, defaultBenchmarkOutDir } from "./constants.js";
export { createDefaultBenchmarkCorpus } from "./default-corpus.js";
export type {
  BenchmarkBudget,
  BenchmarkInputShape,
  BenchmarkPrimaryMetric,
  BenchmarkReport,
  BenchmarkReportSelection,
  BenchmarkReportSummary,
  BenchmarkScaleBand,
  BenchmarkScenario,
  BenchmarkScenarioCache,
  BenchmarkScenarioKind,
  BenchmarkScenarioManifest,
  BenchmarkScenarioMetadata,
  BenchmarkScenarioResult,
  RunBenchmarkSuiteOptions,
  RunBenchmarkSuiteResult,
} from "./types.js";

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
  const resolvedOptions = resolveBenchmarkSuiteOptions(options);
  const allScenarios = [
    ...(options.scenarios ?? createDefaultBenchmarkCorpus(resolvedOptions.corpusRoot)),
  ];
  const scenarios = filterBenchmarkScenarios(allScenarios, options);
  const scenarioResults = await runBenchmarkScenarios(scenarios, resolvedOptions.outDir);

  const summary = summarizeBenchmarkReport(scenarioResults);
  const report = createBenchmarkReport(resolvedOptions.cwd, scenarioResults, summary, options);

  return writeBenchmarkSuiteResult(report, resolvedOptions.outDir, options);
}

function resolveBenchmarkSuiteOptions(options: RunBenchmarkSuiteOptions): {
  corpusRoot: string;
  cwd: string;
  outDir: string;
} {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  return {
    corpusRoot:
      options.corpusRoot === undefined ? cwd : path.resolve(cwd, options.corpusRoot),
    cwd,
    outDir: path.resolve(cwd, options.outDir ?? defaultBenchmarkOutDir),
  };
}

async function runBenchmarkScenarios(
  scenarios: readonly BenchmarkScenario[],
  outDir: string,
): Promise<BenchmarkScenarioResult[]> {
  const scenarioResults: BenchmarkScenarioResult[] = [];

  for (const scenario of scenarios) {
    scenarioResults.push(await runBenchmarkScenarioWithContext(scenario, outDir));
  }

  return scenarioResults;
}

async function runBenchmarkScenarioWithContext(
  scenario: BenchmarkScenario,
  outDir: string,
): Promise<BenchmarkScenarioResult> {
  try {
    return await runBenchmarkScenario(scenario, outDir);
  } catch (error) {
    throw new Error(`Benchmark scenario '${scenario.id}' failed: ${formatError(error)}`);
  }
}

async function writeBenchmarkSuiteResult(
  report: BenchmarkReport,
  outDir: string,
  options: RunBenchmarkSuiteOptions,
): Promise<RunBenchmarkSuiteResult> {
  if (options.writeArtifact === false) {
    return { report };
  }

  return {
    artifactPath: await writeBenchmarkReportArtifact(report, outDir),
    report,
  };
}

function createBenchmarkReport(
  cwd: string,
  scenarioResults: BenchmarkScenarioResult[],
  summary: BenchmarkReport["summary"],
  options: RunBenchmarkSuiteOptions,
): BenchmarkReport {
  return {
    artifactType: "benchmark",
    artifactVersion: benchmarkArtifactVersion,
    cwd,
    engineVersion,
    environment: createBenchmarkEnvironment(),
    generatedAt: new Date().toISOString(),
    primaryMetric: {
      field: "summary.totalDurationMs",
      goal: "minimize",
      unit: "ms",
      value: summary.totalDurationMs,
    },
    scenarios: scenarioResults,
    selection: createBenchmarkSelection(scenarioResults, options),
    summary,
  };
}

function createBenchmarkEnvironment(): BenchmarkReport["environment"] {
  return {
    arch: os.arch(),
    nodeVersion: process.version,
    platform: process.platform,
  };
}

function createBenchmarkSelection(
  scenarioResults: readonly BenchmarkScenarioResult[],
  options: RunBenchmarkSuiteOptions,
): BenchmarkReport["selection"] {
  return {
    kinds: normalizeKinds(options.kinds),
    matchedScenarioCount: scenarioResults.length,
    scenarioIds: normalizeStrings(options.scenarioIds),
    tags: normalizeStrings(options.tags),
  };
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
