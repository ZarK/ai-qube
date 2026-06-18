import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Diagnostic, PlannedTask, StageResult, ToolRunResult } from "../contracts.js";
import { createLizardMetricsDiagnostics } from "../metrics-thresholds.js";
import * as parsers from "../parsers/index.js";
import type { LizardMetricsFileMetrics } from "../parsers/lizard.js";
import * as commands from "../tools/command-builders.js";
import { findNearestLizardConfig, readConfigFingerprint } from "../tools/native-config.js";
import type { JavaScriptRunnerRuntime, SharedMetricsMode } from "./contracts.js";
import {
  appendUnsupportedSharedMetricsIssue,
  collectUnsupportedSharedMetricsFiles,
} from "./shared-metrics-support.js";
import type {
  JavaScriptMetricsProject,
  JavaScriptMetricsProjectMetrics,
  JavaScriptProject,
} from "./javascript-projects.js";
import { filterJavaScriptMetricsFiles, isJavaScriptMetricsTaskFile, resolveJavaScriptMetricsFiles, resolveJavaScriptMetricsProjects } from "./javascript-projects.js";
import {
  addCachedMetricDuration,
  addLizardFileMetrics,
  createSharedMetricTotals,
} from "./shared-metrics-accumulator.js";

export async function runJavaScriptMetricsTask(
  task: PlannedTask,
  runtime: JavaScriptRunnerRuntime,
  mode: SharedMetricsMode,
): Promise<StageResult> {
  const files = filterJavaScriptMetricsFiles(task.files);
  if (files.length === 0) {
    return runtime.createNoopStageResult(
      task.stageId,
      `No JavaScript or TypeScript files were selected for ${task.stageId}.`,
    );
  }

  const diagnostics: Diagnostic[] = [];
  const notes: string[] = [];
  const toolRuns = [] as ReturnType<JavaScriptRunnerRuntime["createToolRunResult"]>[];
  const totals = createSharedMetricTotals();
  let unsupportedFiles: string[] = [];

  try {
    const resolvedProjects = await resolveJavaScriptMetricsProjects(runtime.graph, files);
    unsupportedFiles = resolvedProjects.unsupportedFiles
      .filter((file) => !runtime.isSharedMetricsCompanionFile(file))
      .sort((left, right) => left.localeCompare(right));

    const projects = await Promise.all(
      resolvedProjects.projects.map(async (project) => ({
        ...project,
        files: await resolveJavaScriptMetricsFiles(project, runtime),
      })),
    );

    for (const project of projects) {
      if (project.files.length === 0) {
        continue;
      }

      const cachedMetrics = await getJavaScriptMetricsProjectMetrics(project, runtime);
      addCachedMetricDuration(totals, cachedMetrics);
      addLizardFileMetrics(totals, cachedMetrics.metrics.files);
      toolRuns.push(
        runtime.createToolRunResult(
          "lizard",
          cachedMetrics.metrics.args,
          cachedMetrics.cacheHit ? 0 : cachedMetrics.metrics.durationMs,
          cachedMetrics.metrics.exitCode,
          "passed",
          cachedMetrics.metrics.finishedAt,
          cachedMetrics.metrics.startedAt,
          cachedMetrics.cacheHit,
        ),
      );

      diagnostics.push(
        ...createLizardMetricsDiagnostics(cachedMetrics.metrics.files, mode, "lizard"),
      );
    }
  } catch (error) {
    runtime.throwIfAbortError(error);
    return runtime.createExecutionFailureStage(
      task.stageId,
      "lizard",
      files[0] ?? runtime.cwd,
      error,
      totals.totalDurationMs,
      diagnostics,
      toolRuns,
    );
  }

  notes.push(
    runtime.readSharedMetricsNote(
      "JavaScript/TypeScript",
      mode,
      totals.scannedFileCount,
      totals.totalSloc,
      totals.totalBlocks,
      totals.maxComplexity,
      totals.maxRank,
      totals.minMaintainability,
      totals.minMaintainabilityRank,
      "functions",
    ),
  );

  if (toolRuns.some((toolRun) => toolRun.cacheHit)) {
    notes.push("Reused cached JavaScript/TypeScript metrics for this file batch.");
  }

  unsupportedFiles = collectUnsupportedSharedMetricsFiles(unsupportedFiles, task.files, (file) => {
    return isJavaScriptMetricsTaskFile(file) || runtime.isSharedMetricsCompanionFile(file);
  });
  appendUnsupportedSharedMetricsIssue({
    createProcessFailureDiagnostic: runtime.createProcessFailureDiagnostic,
    diagnostics,
    languageLabel: "JavaScript/TypeScript",
    notes,
    stageId: task.stageId,
    supportedFileDescription: "JavaScript or TypeScript files",
    unsupportedFiles,
  });

  return {
    diagnostics,
    durationMs: totals.totalDurationMs,
    notes,
    stageId: task.stageId,
    status: diagnostics.length > 0 ? "failed" : "passed",
    toolRuns,
  };
}

async function getJavaScriptMetricsProjectMetrics(
  project: JavaScriptMetricsProject & { files: string[] },
  runtime: JavaScriptRunnerRuntime,
): Promise<{ cacheHit: boolean; metrics: JavaScriptMetricsProjectMetrics }> {
  const manifestKey = createJavaScriptMetricsManifestKey(project);
  const cacheKey = await createJavaScriptMetricsCacheKey(project, manifestKey);
  const cached = await runtime.getCachedValue("metrics:javascript", manifestKey, cacheKey, () =>
    runJavaScriptMetricsProjectTask(project, runtime),
  );

  return {
    cacheHit: cached.cacheHit,
    metrics: cached.value,
  };
}

export function createJavaScriptProjectExecutionKey(project: JavaScriptProject): string {
  return `${project.runner}:${project.projectRoot}:${[...project.files].sort().join("|")}`;
}

function createJavaScriptMetricsManifestKey(project: {
  files: string[];
  packageJsonPath: string;
}): string {
  return `${project.packageJsonPath}:${[...project.files].sort().join("|")}`;
}

async function createJavaScriptMetricsCacheKey(
  project: { files: string[]; packageJsonPath: string },
  manifestKey = createJavaScriptMetricsManifestKey(project),
): Promise<string> {
  const [configFingerprint, fileEntries] = await Promise.all([
    readJavaScriptMetricsConfigFingerprint(project.files),
    Promise.all(
      [...project.files]
        .sort((left, right) => left.localeCompare(right))
        .map(async (file) => {
          const fileStats = await stat(file);
          return `${file}@${fileStats.size}:${fileStats.mtimeMs}`;
        }),
    ),
  ]);

  return `${manifestKey}:${configFingerprint}:${fileEntries.join("|")}`;
}

async function readJavaScriptMetricsConfigFingerprint(files: readonly string[]): Promise<string> {
  const fingerprints = await Promise.all(
    [...files]
      .sort((left, right) => left.localeCompare(right))
      .map(async (file) => {
        const configPath = await findNearestLizardConfig(file);
        return readConfigFingerprint(configPath);
      }),
  );

  return [...new Set(fingerprints)].join("|");
}

async function runJavaScriptMetricsProjectTask(
  project: JavaScriptMetricsProject & { files: string[] },
  runtime: JavaScriptRunnerRuntime,
): Promise<JavaScriptMetricsProjectMetrics> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-js-metrics-"));

  try {
    const inputFile = path.join(tempDir, "files.txt");
    await writeFile(inputFile, `${project.files.join("\n")}\n`, "utf8");
    const args = commands.createLizardArgs({
      inputFile,
      languages: ["javascript", "typescript", "tsx"],
    });
    const outcome = await runtime.runExecutable(
      runtime.resolveUvxCommand(),
      args,
      project.projectRoot,
      runtime.signal,
    );
    if (outcome.exitCode !== 0) {
      throw new Error(
        runtime.readProcessFailureMessage(
          "lizard",
          outcome.stderr,
          outcome.stdout,
          outcome.exitCode,
        ),
      );
    }

    return {
      args,
      durationMs: outcome.durationMs,
      exitCode: outcome.exitCode,
      files: await parsers.parseLizardMetrics(outcome.stdout, project.projectRoot, project.files),
      finishedAt: outcome.finishedAt,
      startedAt: outcome.startedAt,
    };
  } finally {
    await rm(tempDir, { force: true, recursive: true }).catch(() => undefined);
  }
}
