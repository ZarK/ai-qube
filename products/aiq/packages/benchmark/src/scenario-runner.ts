import { cp, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runEngine } from "@tjalve/aiq/engine";
import type { StageId } from "@tjalve/aiq/model";
import type {
  BenchmarkBudget,
  BenchmarkReportSummary,
  BenchmarkScaleBand,
  BenchmarkScenario,
  BenchmarkScenarioManifest,
  BenchmarkScenarioMetadata,
  BenchmarkScenarioResult,
} from "./types.js";

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

interface BenchmarkWorkspace {
  root: string;
  tempRoot: string;
}

export async function runBenchmarkScenario(
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

export function summarizeBenchmarkReport(
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

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
