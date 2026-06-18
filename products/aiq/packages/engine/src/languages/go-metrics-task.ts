import type { Diagnostic, PlannedTask, StageResult, ToolRunResult } from "../contracts.js";
import { createLizardMetricsDiagnostics } from "../metrics-thresholds.js";
import type { GoRunnerRuntime, SharedMetricsMode } from "./contracts.js";
import {
  createGoProjectResolutionFailureStage,
  filterGoFiles,
  isGoTaskFile,
  resolveGoProjects,
  runProjectBatches,
} from "./go-projects.js";
import { getGoMetricsProjectMetrics, resolveGoProjectSourceFiles } from "./go-tools.js";
import {
  addCachedMetricDuration,
  addLizardFileMetrics,
  createSharedMetricTotals,
} from "./shared-metrics-accumulator.js";
import {
  appendUnsupportedSharedMetricsIssue,
  collectUnsupportedSharedMetricsFiles,
} from "./shared-metrics-support.js";

export async function runGoMetricsTask(
  task: PlannedTask,
  runtime: GoRunnerRuntime,
  mode: SharedMetricsMode,
): Promise<StageResult> {
  const files = filterGoFiles(task.files);
  if (files.length === 0) {
    return runtime.createNoopStageResult(
      task.stageId,
      `No Go files were selected for ${task.stageId}.`,
    );
  }

  const diagnostics: Diagnostic[] = [];
  const notes: string[] = [];
  const toolRuns: ToolRunResult[] = [];
  const totals = createSharedMetricTotals();
  let unsupportedFiles: string[] = [];

  try {
    const resolvedProjects = await resolveGoProjects(runtime.graph, files);
    unsupportedFiles = resolvedProjects.unsupportedFiles;
    if (resolvedProjects.projects.length === 0) {
      return createGoProjectResolutionFailureStage(task.stageId, files);
    }

    await processGoMetricsProjects({
      diagnostics,
      mode,
      projects: resolvedProjects.projects,
      runtime,
      toolRuns,
      totals,
    });
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

  notes.push(readGoMetricsNote(runtime, mode, totals));
  if (toolRuns.some((toolRun) => toolRun.cacheHit)) {
    notes.push("Reused cached Go metrics for this file batch.");
  }

  unsupportedFiles = collectUnsupportedSharedMetricsFiles(unsupportedFiles, task.files, (file) => {
    return isGoTaskFile(file) || runtime.isSharedMetricsCompanionFile(file);
  });
  appendUnsupportedSharedMetricsIssue({
    createProcessFailureDiagnostic: runtime.createProcessFailureDiagnostic,
    diagnostics,
    languageLabel: "Go",
    notes,
    stageId: task.stageId,
    supportedFileDescription: "Go files or Go project files",
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

async function processGoMetricsProjects(options: {
  diagnostics: Diagnostic[];
  mode: SharedMetricsMode;
  projects: Awaited<ReturnType<typeof resolveGoProjects>>["projects"];
  runtime: GoRunnerRuntime;
  toolRuns: ToolRunResult[];
  totals: ReturnType<typeof createSharedMetricTotals>;
}): Promise<void> {
  const projects = await runProjectBatches(options.projects, async (project) => ({
    ...project,
    files: await resolveGoProjectSourceFiles(project, options.runtime),
  }));

  for (const project of projects) {
    if (project.files.length > 0) {
      await appendGoProjectMetrics(project, options);
    }
  }
}

async function appendGoProjectMetrics(
  project: Awaited<ReturnType<typeof resolveGoProjects>>["projects"][number],
  options: {
    diagnostics: Diagnostic[];
    mode: SharedMetricsMode;
    runtime: GoRunnerRuntime;
    toolRuns: ToolRunResult[];
    totals: ReturnType<typeof createSharedMetricTotals>;
  },
): Promise<void> {
  const cachedMetrics = await getGoMetricsProjectMetrics(project, options.runtime);
  addCachedMetricDuration(options.totals, cachedMetrics);
  addLizardFileMetrics(options.totals, cachedMetrics.metrics.files);
  options.toolRuns.push(
    options.runtime.createToolRunResult(
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
  options.diagnostics.push(
    ...createLizardMetricsDiagnostics(cachedMetrics.metrics.files, options.mode, "lizard"),
  );
}

function readGoMetricsNote(
  runtime: GoRunnerRuntime,
  mode: SharedMetricsMode,
  totals: ReturnType<typeof createSharedMetricTotals>,
): string {
  return runtime.readSharedMetricsNote(
    "Go",
    mode,
    totals.scannedFileCount,
    totals.totalSloc,
    totals.totalBlocks,
    totals.maxComplexity,
    totals.maxRank,
    totals.minMaintainability,
    totals.minMaintainabilityRank,
    "functions",
  );
}
