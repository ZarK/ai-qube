import type { Diagnostic, PlannedTask, StageResult } from "../contracts.js";
import { createPythonMetricsDiagnostics } from "../metrics-thresholds.js";
import type { PythonRunnerRuntime, SharedMetricsMode } from "./contracts.js";
import { getPythonMetricsProjectMetrics } from "./python-tools.js";
import { filterPythonTaskFiles, isPythonTaskFile, resolvePythonProjects, resolvePythonSourceProject } from "./python-projects.js";
import { createUnsupportedSharedMetricsDiagnostics, readUnsupportedSharedMetricsNotes } from "./shared-metrics-support.js";

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

  let unsupportedFiles = task.files.filter((file) => {
    return !isPythonTaskFile(file) && !runtime.isSharedMetricsCompanionFile(file);
  });
  const diagnostics: Diagnostic[] = [];
  const notes: string[] = [];
  const toolRuns: StageResult["toolRuns"] = [];
  let totalDurationMs = 0;
  let totalSloc = 0;
  let totalBlocks = 0;
  let maxComplexity = 0;
  let maxRank = "A";
  let minMaintainability = Number.POSITIVE_INFINITY;
  let minMaintainabilityRank = "A";
  let scannedFileCount = 0;

  try {
    const projects = await resolvePythonProjects(runtime.graph, files);
    for (const project of projects) {
      const cachedMetrics = await getPythonMetricsProjectMetrics(
        await resolvePythonSourceProject(project, runtime),
        runtime,
      );
      totalDurationMs += cachedMetrics.cacheHit ? 0 : cachedMetrics.metrics.durationMs;
      scannedFileCount += Object.keys(cachedMetrics.metrics.files).length;
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

      for (const fileMetrics of Object.values(cachedMetrics.metrics.files)) {
        totalSloc += fileMetrics.raw.sloc;
        totalBlocks += fileMetrics.cc.length;
        for (const block of fileMetrics.cc) {
          if (block.complexity > maxComplexity) {
            maxComplexity = block.complexity;
            maxRank = block.rank;
          }
        }

        if (fileMetrics.mi.score < minMaintainability) {
          minMaintainability = fileMetrics.mi.score;
          minMaintainabilityRank = fileMetrics.mi.rank;
        }
      }
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
      totalDurationMs,
      diagnostics,
      toolRuns,
    );
  }

  notes.push(
    runtime.readSharedMetricsNote(
      "Python",
      mode,
      scannedFileCount,
      totalSloc,
      totalBlocks,
      maxComplexity,
      maxRank,
      minMaintainability,
      minMaintainabilityRank,
      "functions or classes",
    ),
  );

  if (toolRuns.some((toolRun) => toolRun.cacheHit)) {
    notes.push("Reused cached Python metrics for this file batch.");
  }

  unsupportedFiles = task.files.filter((file) => {
    return !isPythonTaskFile(file) && !runtime.isSharedMetricsCompanionFile(file);
  });
  if (unsupportedFiles.length > 0) {
    diagnostics.push(
      ...createUnsupportedSharedMetricsDiagnostics(
        unsupportedFiles,
        task.stageId,
        "Python",
        "Python files",
        runtime.createProcessFailureDiagnostic,
      ),
    );
    notes.push(...readUnsupportedSharedMetricsNotes(unsupportedFiles, task.stageId, "Python"));
  }

  return {
    diagnostics,
    durationMs: totalDurationMs,
    notes,
    stageId: task.stageId,
    status: diagnostics.length > 0 ? "failed" : "passed",
    toolRuns,
  };
}
