import type { Diagnostic, PlannedTask, StageResult } from "../contracts.js";
import { createPythonMetricsDiagnostics } from "../metrics-thresholds.js";
import type { PythonRunnerRuntime, SharedMetricsMode } from "./contracts.js";
import { getPythonMetricsProjectMetrics } from "./python-tools.js";
import { filterPythonTaskFiles, isPythonTaskFile, resolvePythonProjects, resolvePythonSourceProject } from "./python-projects.js";
import {
  appendUnsupportedSharedMetricsIssue,
  collectUnsupportedSharedMetricsFiles,
} from "./shared-metrics-support.js";
import {
  addCachedMetricDuration,
  addPythonFileMetrics,
  createSharedMetricTotals,
} from "./shared-metrics-accumulator.js";

export async function runPythonComplexityTask(
  task: PlannedTask,
  runtime: PythonRunnerRuntime,
): Promise<StageResult> {
  return runPythonMetricsTask(task, runtime, "complexity");
}

export async function runPythonSlocTask(
  task: PlannedTask,
  runtime: PythonRunnerRuntime,
): Promise<StageResult> {
  return runPythonMetricsTask(task, runtime, "sloc");
}

export async function runPythonMaintainabilityTask(
  task: PlannedTask,
  runtime: PythonRunnerRuntime,
): Promise<StageResult> {
  return runPythonMetricsTask(task, runtime, "maintainability");
}

async function runPythonMetricsTask(
  task: PlannedTask,
  runtime: PythonRunnerRuntime,
  mode: SharedMetricsMode,
): Promise<StageResult> {
  const files = filterPythonTaskFiles(task.files);
  if (files.length === 0) {
    return runtime.createNoopStageResult(
      task.stageId,
      `No Python files were selected for ${task.stageId}.`,
    );
  }

  const unsupportedFiles = collectUnsupportedSharedMetricsFiles([], task.files, (file) => {
    return isPythonTaskFile(file) || runtime.isSharedMetricsCompanionFile(file);
  });
  const diagnostics: Diagnostic[] = [];
  const notes: string[] = [];
  const toolRuns: StageResult["toolRuns"] = [];
  const totals = createSharedMetricTotals();

  try {
    const projects = await resolvePythonProjects(runtime.graph, files);
    for (const project of projects) {
      const cachedMetrics = await getPythonMetricsProjectMetrics(
        await resolvePythonSourceProject(project, runtime),
        runtime,
      );
      addCachedMetricDuration(totals, cachedMetrics);
      addPythonFileMetrics(totals, cachedMetrics.metrics.files);
      toolRuns.push(
        runtime.createToolRunResult(
          "radon",
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
        ...createPythonMetricsDiagnostics(cachedMetrics.metrics.files, mode, "radon"),
      );
    }
  } catch (error) {
    runtime.throwIfAbortError(error);
    return runtime.createExecutionFailureStage(
      task.stageId,
      "radon",
      files[0] ?? runtime.cwd,
      error,
      totals.totalDurationMs,
      diagnostics,
      toolRuns,
    );
  }

  notes.push(
    runtime.readSharedMetricsNote(
      "Python",
      mode,
      totals.scannedFileCount,
      totals.totalSloc,
      totals.totalBlocks,
      totals.maxComplexity,
      totals.maxRank,
      totals.minMaintainability,
      totals.minMaintainabilityRank,
      "functions or classes",
    ),
  );

  if (toolRuns.some((toolRun) => toolRun.cacheHit)) {
    notes.push("Reused cached Python metrics for this file batch.");
  }

  appendUnsupportedSharedMetricsIssue({
    createProcessFailureDiagnostic: runtime.createProcessFailureDiagnostic,
    diagnostics,
    languageLabel: "Python",
    notes,
    stageId: task.stageId,
    supportedFileDescription: "Python files",
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
