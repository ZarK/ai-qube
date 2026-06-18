import type { Diagnostic, PlannedTask, StageResult, ToolRunResult } from "../contracts.js";
import type { DotNetRunnerRuntime } from "./contracts.js";
import { runDotNetFormatProject, runDotNetTypecheckProject } from "./dotnet-tools.js";
import {
  createDotNetProjectResolutionDiagnostics,
  createDotNetProjectResolutionFailureStage,
  createDotNetProjectResolutionMessage,
  filterDotNetFiles,
  resolveDotNetProjects,
  runProjectBatches,
} from "./dotnet-projects.js";

export async function runDotNetLintTask(
  task: PlannedTask,
  runtime: DotNetRunnerRuntime,
): Promise<StageResult> {
  return runDotNetFormatSubcommandTask(task, runtime, {
    failureLabel: "dotnet format style",
    noopNote: "No .NET files were selected for lint.",
    noteLabel: "dotnet format style",
    subcommand: "style",
    tool: "dotnet-format-style",
  });
}

export async function runDotNetFormatTask(
  task: PlannedTask,
  runtime: DotNetRunnerRuntime,
): Promise<StageResult> {
  return runDotNetFormatSubcommandTask(task, runtime, {
    failureLabel: "dotnet format whitespace",
    noopNote: "No .NET files were selected for format.",
    noteLabel: "dotnet format whitespace",
    subcommand: "whitespace",
    tool: "dotnet-format-whitespace",
  });
}

export async function runDotNetTypecheckTask(
  task: PlannedTask,
  runtime: DotNetRunnerRuntime,
): Promise<StageResult> {
  const files = filterDotNetFiles(task.files);
  if (files.length === 0) {
    return runtime.createNoopStageResult(
      task.stageId,
      "No .NET files were selected for typecheck.",
    );
  }

  const diagnostics: Diagnostic[] = [];
  const notes: string[] = [];
  const toolRuns: ToolRunResult[] = [];
  let totalDurationMs = 0;
  let unsupportedFiles: string[] = [];

  try {
    const resolvedProjects = await resolveDotNetProjects(runtime.graph, files, "prefer-project");
    unsupportedFiles = resolvedProjects.unsupportedFiles;

    if (resolvedProjects.projects.length === 0) {
      return createDotNetProjectResolutionFailureStage(task.stageId, files);
    }

    const projectResults = await runProjectBatches(
      resolvedProjects.projects,
      async (project) => runDotNetTypecheckProject(project, runtime),
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
      "dotnet-build",
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

async function runDotNetFormatSubcommandTask(
  task: PlannedTask,
  runtime: DotNetRunnerRuntime,
  options: {
    failureLabel: string;
    noopNote: string;
    noteLabel: string;
    subcommand: "style" | "whitespace";
    tool: string;
  },
): Promise<StageResult> {
  const files = filterDotNetFiles(task.files);
  if (files.length === 0) {
    return runtime.createNoopStageResult(task.stageId, options.noopNote);
  }

  const diagnostics: Diagnostic[] = [];
  const notes: string[] = [];
  const toolRuns: ToolRunResult[] = [];
  let totalDurationMs = 0;
  let unsupportedFiles: string[] = [];

  try {
    const resolvedProjects = await resolveDotNetProjects(runtime.graph, files, "prefer-project");
    unsupportedFiles = resolvedProjects.unsupportedFiles;

    if (resolvedProjects.projects.length === 0) {
      return createDotNetProjectResolutionFailureStage(task.stageId, files);
    }

    const projectResults = await runProjectBatches(
      resolvedProjects.projects,
      async (project) => runDotNetFormatProject(project, runtime, options),
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
      options.tool,
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
