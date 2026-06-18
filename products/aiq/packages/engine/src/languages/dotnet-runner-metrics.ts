import path from "node:path";

import type { Diagnostic, PlannedTask, StageResult, ToolRunResult } from "../contracts.js";
import { createFileMetricDiagnostics } from "../metrics-thresholds.js";
import type { DotNetRunnerRuntime, SharedMetricsMode } from "./contracts.js";
import { getDotNetMetricsProjectMetrics } from "./dotnet-tools.js";
import { createUnsupportedSharedMetricsDiagnostics, readUnsupportedSharedMetricsNotes } from "./shared-metrics-support.js";
import { dotNetExtensions, filterDotNetFiles, resolveDotNetMetricsFiles, resolveDotNetProjects } from "./dotnet-projects.js";

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
  let totalDurationMs = 0;
  let totalSloc = 0;
  let totalBlocks = 0;
  let maxComplexity = 0;
  let maxRank = "A";
  let minMaintainability = Number.POSITIVE_INFINITY;
  let minMaintainabilityRank = "A";
  let scannedFileCount = 0;
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
      totalDurationMs += cachedMetrics.cacheHit ? 0 : cachedMetrics.metrics.durationMs;
      scannedFileCount += Object.keys(cachedMetrics.metrics.files).length;
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

      for (const fileMetrics of Object.values(cachedMetrics.metrics.files)) {
        totalSloc += fileMetrics.raw.sloc;
        totalBlocks += fileMetrics.blockCount;
        if (fileMetrics.maxComplexity.score > maxComplexity) {
          maxComplexity = fileMetrics.maxComplexity.score;
          maxRank = fileMetrics.maxComplexity.rank;
        }
        if (fileMetrics.maintainability.score < minMaintainability) {
          minMaintainability = fileMetrics.maintainability.score;
          minMaintainabilityRank = fileMetrics.maintainability.rank;
        }
      }
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
      totalDurationMs,
      diagnostics,
      toolRuns,
    );
  }

  notes.push(
    runtime.readSharedMetricsNote(
      "C#",
      mode,
      scannedFileCount,
      totalSloc,
      totalBlocks,
      maxComplexity,
      maxRank,
      minMaintainability,
      minMaintainabilityRank,
      "methods",
    ),
  );

  if (toolRuns.some((toolRun) => toolRun.cacheHit)) {
    notes.push("Reused cached C# metrics for this file batch.");
  }

  unsupportedFiles = [
    ...new Set([
      ...unsupportedFiles,
      ...task.files.filter((file) => {
        return (
          !dotNetExtensions.has(path.extname(file).toLowerCase()) &&
          !runtime.isSharedMetricsCompanionFile(file)
        );
      }),
    ]),
  ].sort((left, right) => left.localeCompare(right));
  if (unsupportedFiles.length > 0) {
    diagnostics.push(
      ...createUnsupportedSharedMetricsDiagnostics(
        unsupportedFiles,
        task.stageId,
        "C#",
        "C# project files",
        runtime.createProcessFailureDiagnostic,
      ),
    );
    notes.push(...readUnsupportedSharedMetricsNotes(unsupportedFiles, task.stageId, "C#"));
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
