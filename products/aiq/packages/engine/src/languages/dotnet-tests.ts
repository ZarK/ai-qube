import type { Diagnostic, PlannedTask, StageResult, ToolRunResult } from "../contracts.js";
import type { DotNetRunnerRuntime } from "./contracts.js";
import { runDotNetProjectTestTask } from "./dotnet-tools.js";
import {
  createDotNetProjectResolutionDiagnostics,
  createDotNetProjectResolutionFailureStage,
  createDotNetProjectResolutionMessage,
  filterDotNetFiles,
  resolveDotNetProjects,
  runProjectBatches,
} from "./dotnet-projects.js";

export async function runDotNetUnitTask(
  task: PlannedTask,
  runtime: DotNetRunnerRuntime,
): Promise<StageResult> {
  return runDotNetTestStage(task, runtime, "unit");
}

export async function runDotNetCoverageTask(
  task: PlannedTask,
  runtime: DotNetRunnerRuntime,
): Promise<StageResult> {
  return runDotNetTestStage(task, runtime, "coverage");
}

async function runDotNetTestStage(
  task: PlannedTask,
  runtime: DotNetRunnerRuntime,
  mode: "coverage" | "unit",
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
  let unsupportedFiles: string[] = [];

  try {
    const resolvedProjects = await resolveDotNetProjects(runtime.graph, files, "prefer-solution");
    unsupportedFiles = resolvedProjects.unsupportedFiles;

    if (resolvedProjects.projects.length === 0) {
      return createDotNetProjectResolutionFailureStage(task.stageId, files);
    }

    const projectResults = await runProjectBatches(
      resolvedProjects.projects,
      async (project) => runDotNetProjectTestTask(project, mode, runtime),
      1,
    );

    for (const projectResult of projectResults) {
      totalDurationMs += projectResult.durationMs;
      diagnostics.push(...projectResult.diagnostics);
      notes.push(projectResult.note);
      toolRuns.push(projectResult.toolRun);
    }
  } catch (error) {
    runtime.throwIfAbortError(error);
    return runtime.createExecutionFailureStage(
      task.stageId,
      mode === "coverage" ? "dotnet-test-coverage" : "dotnet-test",
      files[0] ?? runtime.cwd,
      error,
      totalDurationMs,
      diagnostics,
      toolRuns,
    );
  }

  if (unsupportedFiles.length > 0) {
    const message = createDotNetProjectResolutionMessage(task.stageId, unsupportedFiles);
    diagnostics.push(...createDotNetProjectResolutionDiagnostics(unsupportedFiles, message));
    notes.push(message);
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
