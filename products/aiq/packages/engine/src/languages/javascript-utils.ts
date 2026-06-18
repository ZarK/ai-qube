import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveProjectConcurrencyLimit } from "../runtime-tunables.js";
import type { JavaScriptTestRunner } from "../utils/node-utils.js";
import type { JavaScriptE2eRunner } from "./javascript-projects.js";

export function readCoverageMetric(
  summary: Record<string, unknown> | undefined,
  ...keys: string[]
): number | undefined {
  if (summary === undefined) {
    return undefined;
  }

  let current: unknown = summary;
  for (const key of keys) {
    if (typeof current !== "object" || current === null || !(key in current)) {
      return undefined;
    }

    current = (current as Record<string, unknown>)[key];
  }

  return typeof current === "number" && Number.isFinite(current) ? current : undefined;
}

export function isValidJavaScriptTestReport(
  report: Record<string, unknown> | undefined,
): report is Record<string, unknown> {
  if (report === undefined) {
    return false;
  }

  return isRecordArray(report.testResults) && isValidJavaScriptTestCounts(report);
}

export function isValidCoverageSummary(
  coverageSummary: Record<string, unknown> | undefined,
): coverageSummary is Record<string, unknown> {
  const counts = readCoverageLineCounts(coverageSummary);
  return counts !== undefined && isValidCoverageLineCounts(counts);
}

function isValidJavaScriptTestCounts(report: Record<string, unknown>): boolean {
  const failed = readCoverageMetric(report, "numFailedTests");
  const passed = readCoverageMetric(report, "numPassedTests");
  const total = readCoverageMetric(report, "numTotalTests");
  if (failed === undefined || passed === undefined || total === undefined) {
    return false;
  }

  return (
    isNonNegativeInteger(failed) &&
    isNonNegativeInteger(passed) &&
    isNonNegativeInteger(total) &&
    failed <= total &&
    passed <= total &&
    failed + passed <= total
  );
}

function readCoverageLineCounts(
  coverageSummary: Record<string, unknown> | undefined,
): { covered: number; pct: number; skipped: number; total: number } | undefined {
  const total = readCoverageMetric(coverageSummary, "total", "lines", "total");
  const covered = readCoverageMetric(coverageSummary, "total", "lines", "covered");
  const skipped = readCoverageMetric(coverageSummary, "total", "lines", "skipped");
  const pct = readCoverageMetric(coverageSummary, "total", "lines", "pct");
  return total === undefined || covered === undefined || skipped === undefined || pct === undefined
    ? undefined
    : { covered, pct, skipped, total };
}

function isValidCoverageLineCounts(counts: {
  covered: number;
  pct: number;
  skipped: number;
  total: number;
}): boolean {
  return (
    isNonNegativeInteger(counts.total) &&
    isNonNegativeInteger(counts.covered) &&
    isNonNegativeInteger(counts.skipped) &&
    counts.covered <= counts.total &&
    counts.covered + counts.skipped <= counts.total &&
    counts.pct >= 0 &&
    counts.pct <= 100 &&
    isCoveragePctConsistent(counts.total, counts.covered, counts.pct)
  );
}

export function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

export function isCoveragePctConsistent(total: number, covered: number, pct: number): boolean {
  if (total === 0) {
    return pct === 0 || pct === 100;
  }

  const exactPct = (covered / total) * 100;
  const allowedValues = [exactPct, roundToPrecision(exactPct, 1), roundToPrecision(exactPct, 2)];

  return allowedValues.includes(pct);
}

export function roundToPrecision(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function isRecordArray(value: unknown): value is Record<string, unknown>[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "object" && entry !== null)
  );
}

export function readTestSummary(report: Record<string, unknown> | undefined): {
  failed: number;
  passed: number;
  total: number;
} {
  return {
    failed: readCoverageMetric(report, "numFailedTests") ?? 0,
    passed: readCoverageMetric(report, "numPassedTests") ?? 0,
    total: readCoverageMetric(report, "numTotalTests") ?? 0,
  };
}

export function readUnitNote(
  runner: JavaScriptTestRunner,
  summary: { failed: number; passed: number; total: number },
): string {
  if (summary.total === 0) {
    return `${capitalize(runner)} found no tests.`;
  }

  return `${capitalize(runner)} ran ${summary.total} test${summary.total === 1 ? "" : "s"}: ${summary.passed} passed, ${summary.failed} failed.`;
}

export function readCoverageNote(
  runner: JavaScriptTestRunner,
  coverageSummary: Record<string, unknown> | undefined,
  summary: { failed: number; passed: number; total: number },
): string {
  const totalCoverage = readCoverageMetric(coverageSummary, "total", "lines", "pct");
  if (totalCoverage === undefined) {
    return `${capitalize(runner)} coverage completed after ${summary.total} test${summary.total === 1 ? "" : "s"}: ${summary.passed} passed, ${summary.failed} failed.`;
  }

  return `${capitalize(runner)} coverage lines: ${totalCoverage.toFixed(1)}% across ${summary.total} test${summary.total === 1 ? "" : "s"}: ${summary.passed} passed, ${summary.failed} failed.`;
}

export function readE2eNote(
  runner: JavaScriptE2eRunner,
  stdout: string,
  status: "failed" | "passed",
): string {
  if (runner.kind === "agent-browser") {
    return `Agent-browser e2e audit ${status}.`;
  }

  if (runner.kind === "script") {
    return `E2E script ${status}.`;
  }

  const summary = readPlaywrightSummary(stdout);
  if (summary === undefined) {
    return `Playwright e2e ${status}.`;
  }

  return `Playwright ran ${summary.total} e2e test${summary.total === 1 ? "" : "s"}: ${summary.passed} passed, ${summary.failed} failed.`;
}

export function readPlaywrightSummary(
  stdout: string,
): { failed: number; passed: number; total: number } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return undefined;
  }

  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const suites = Array.isArray((value as Record<string, unknown>).suites)
    ? ((value as Record<string, unknown>).suites as unknown[])
    : [];
  const counts = countPlaywrightTests(suites);
  return counts.total === 0 ? undefined : counts;
}

export function countPlaywrightTests(entries: readonly unknown[]): {
  failed: number;
  passed: number;
  total: number;
} {
  let failed = 0;
  let passed = 0;
  let total = 0;

  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }

    const record = entry as Record<string, unknown>;
    if (Array.isArray(record.specs)) {
      for (const spec of record.specs) {
        const specCounts = countPlaywrightSpecTests(spec);
        failed += specCounts.failed;
        passed += specCounts.passed;
        total += specCounts.total;
      }
    }

    if (Array.isArray(record.suites)) {
      const suiteCounts = countPlaywrightTests(record.suites);
      failed += suiteCounts.failed;
      passed += suiteCounts.passed;
      total += suiteCounts.total;
    }
  }

  return { failed, passed, total };
}

export function countPlaywrightSpecTests(spec: unknown): {
  failed: number;
  passed: number;
  total: number;
} {
  if (typeof spec !== "object" || spec === null) {
    return { failed: 0, passed: 0, total: 0 };
  }

  const tests = Array.isArray((spec as Record<string, unknown>).tests)
    ? ((spec as Record<string, unknown>).tests as unknown[])
    : [];
  let failed = 0;
  let passed = 0;
  for (const test of tests) {
    const outcome = readPlaywrightTestOutcome(test);
    if (outcome === "passed") {
      passed += 1;
    } else if (outcome === "failed") {
      failed += 1;
    }
  }

  return { failed, passed, total: tests.length };
}

export function readPlaywrightTestOutcome(test: unknown): "failed" | "passed" | undefined {
  if (typeof test !== "object" || test === null) {
    return undefined;
  }

  const results = Array.isArray((test as Record<string, unknown>).results)
    ? ((test as Record<string, unknown>).results as unknown[])
    : [];
  if (
    results.some(
      (result) =>
        typeof result === "object" &&
        result !== null &&
        (result as Record<string, unknown>).status !== "passed",
    )
  ) {
    return "failed";
  }

  return results.length > 0 ? "passed" : undefined;
}

export function readPackageScripts(packageJson: Record<string, unknown>): Map<string, string> {
  const scripts = packageJson.scripts;
  if (typeof scripts !== "object" || scripts === null) {
    return new Map();
  }

  return new Map(
    Object.entries(scripts)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([name, script]) => [name, script]),
  );
}

export function readPackageScript(
  packageJson: Record<string, unknown>,
  name: string,
): string | undefined {
  return readPackageScripts(packageJson).get(name);
}

export async function readJsonFile(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export async function runProjectBatches<TProject, TResult>(
  projects: readonly TProject[],
  runProject: (project: TProject, index: number) => Promise<TResult>,
): Promise<TResult[]> {
  const results: TResult[] = [];
  const concurrencyLimit = readProjectConcurrencyLimit();

  for (let index = 0; index < projects.length; index += concurrencyLimit) {
    const projectBatch = projects.slice(index, index + concurrencyLimit);
    results.push(
      ...(await Promise.all(
        projectBatch.map((project, batchIndex) => runProject(project, index + batchIndex)),
      )),
    );
  }

  return results;
}

export function readProjectConcurrencyLimit(): number {
  return resolveProjectConcurrencyLimit();
}

export function capitalize(value: string): string {
  return value.length === 0 ? value : `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

export function readProjectName(projectRoot: string): string {
  const baseName = path.basename(projectRoot);
  return baseName.length > 0 ? baseName : projectRoot;
}
