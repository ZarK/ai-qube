import path from "node:path";

import type { Diagnostic, PlannedTask, StageResult, ToolRunResult } from "../contracts.js";
import { createFileMetricDiagnostics } from "../metrics-thresholds.js";
import type { DotNetRunnerRuntime, SharedMetricsMode } from "./contracts.js";
import { getDotNetMetricsProjectMetrics } from "./dotnet-tools.js";
import {
  appendUnsupportedSharedMetricsIssue,
  collectUnsupportedSharedMetricsFiles,
} from "./shared-metrics-support.js";
import { dotNetExtensions, filterDotNetFiles, resolveDotNetMetricsFiles, resolveDotNetProjects } from "./dotnet-projects.js";
import {
  addCachedMetricDuration,
  addLizardFileMetrics,
  createSharedMetricTotals,
} from "./shared-metrics-accumulator.js";

export async function runDotNetMetricsTask(
  task: PlannedTask,
  runtime: DotNetRunnerRuntime,
  mode: SharedMetricsMode,
): Promise<StageResult> {
  const files = filterDotNetFiles(task.files);
  if (files.length === 0) {
    return runtime.createNoopStageResult(
      task.stageId,
      `No .NET files were selected for ${task.stageId}.`,
    );
  }

  const diagnostics: Diagnostic[] = [];
  const notes: string[] = [];
  const toolRuns: ToolRunResult[] = [];
  const totals = createSharedMetricTotals();
  let unsupportedFiles: string[] = [];

  try {
    const resolvedProjects = await resolveDotNetProjects(runtime.graph, files, "prefer-project");
    unsupportedFiles = resolvedProjects.unsupportedFiles;
    const projects = await Promise.all(
      resolvedProjects.projects.map(async (project) => ({
        ...project,
        files: await resolveDotNetMetricsFiles(project),
      })),
    );

    for (const project of projects) {
      if (project.files.length === 0) {
        continue;
      }

      const cachedMetrics = await getDotNetMetricsProjectMetrics(project, runtime);
      addCachedMetricDuration(totals, cachedMetrics);
      addLizardFileMetrics(totals, cachedMetrics.metrics.files);
      toolRuns.push(
        runtime.createToolRunResult(
          "aiq-csharp-metrics",
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
        ...createFileMetricDiagnostics(cachedMetrics.metrics.files, mode, "aiq-csharp-metrics"),
      );
    }
  } catch (error) {
    runtime.throwIfAbortError(error);
    return runtime.createExecutionFailureStage(
      task.stageId,
      "aiq-csharp-metrics",
      files[0] ?? runtime.cwd,
      error,
      totals.totalDurationMs,
      diagnostics,
      toolRuns,
    );
  }

  notes.push(
    runtime.readSharedMetricsNote(
      "C#",
      mode,
      totals.scannedFileCount,
      totals.totalSloc,
      totals.totalBlocks,
      totals.maxComplexity,
      totals.maxRank,
      totals.minMaintainability,
      totals.minMaintainabilityRank,
      "methods",
    ),
  );

  if (toolRuns.some((toolRun) => toolRun.cacheHit)) {
    notes.push("Reused cached C# metrics for this file batch.");
  }

  unsupportedFiles = collectUnsupportedSharedMetricsFiles(unsupportedFiles, task.files, (file) => {
    return (
      dotNetExtensions.has(path.extname(file).toLowerCase()) ||
      runtime.isSharedMetricsCompanionFile(file)
    );
  });
  appendUnsupportedSharedMetricsIssue({
    createProcessFailureDiagnostic: runtime.createProcessFailureDiagnostic,
    diagnostics,
    languageLabel: "C#",
    notes,
    stageId: task.stageId,
    supportedFileDescription: "C# project files",
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
