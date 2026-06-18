import type { Diagnostic, PlannedTask, StageResult, ToolRunResult } from "../contracts.js";
import { createLizardMetricsDiagnostics } from "../metrics-thresholds.js";
import type { JvmRunnerRuntime, SharedMetricsMode } from "./contracts.js";
import { getJvmMetricsProjectMetrics, resolveJvmMetricsFiles } from "./jvm-tools.js";
import { createUnsupportedSharedMetricsDiagnostics, readUnsupportedSharedMetricsNotes } from "./shared-metrics-support.js";
import { filterJvmFiles, isJvmTaskFile, resolveJvmProjects } from "./jvm-projects.js";

export async function runJvmMetricsTask(
  task: PlannedTask,
  runtime: JvmRunnerRuntime,
  mode: SharedMetricsMode,
): Promise<StageResult> {
  const files = filterJvmFiles(task.files);
  if (files.length === 0) {
    return runtime.createNoopStageResult(
      task.stageId,
      `No JVM files were selected for ${task.stageId}.`,
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
    const resolvedProjects = await resolveJvmProjects(runtime.graph, files);
    unsupportedFiles = resolvedProjects.unsupportedFiles;
    const projects = await Promise.all(
      resolvedProjects.projects.map(async (project) => ({
        ...project,
        files: await resolveJvmMetricsFiles(project, runtime),
      })),
    );

    for (const project of projects) {
      if (project.files.length === 0) {
        continue;
      }

      const cachedMetrics = await getJvmMetricsProjectMetrics(project, runtime);
      totalDurationMs += cachedMetrics.cacheHit ? 0 : cachedMetrics.metrics.durationMs;
      scannedFileCount += Object.keys(cachedMetrics.metrics.files).length;
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
      totalDurationMs,
      diagnostics,
      toolRuns,
    );
  }

  notes.push(
    runtime.readSharedMetricsNote(
      "JVM",
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
    notes.push("Reused cached JVM metrics for this file batch.");
  }

  unsupportedFiles = [
    ...new Set([
      ...unsupportedFiles,
      ...task.files.filter(
        (file) => !isJvmTaskFile(file) && !runtime.isSharedMetricsCompanionFile(file),
      ),
    ]),
  ].sort((left, right) => left.localeCompare(right));
  if (unsupportedFiles.length > 0) {
    diagnostics.push(
      ...createUnsupportedSharedMetricsDiagnostics(
        unsupportedFiles,
        task.stageId,
        "JVM",
        "Java, Kotlin, or JVM project files",
        runtime.createProcessFailureDiagnostic,
      ),
    );
    notes.push(...readUnsupportedSharedMetricsNotes(unsupportedFiles, task.stageId, "JVM"));
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
