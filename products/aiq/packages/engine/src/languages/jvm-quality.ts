import path from "node:path";

import type { Diagnostic, PlannedTask, StageResult, ToolRunResult } from "../contracts.js";
import type { JvmRunnerRuntime } from "./contracts.js";
import { resolveJvmLintOrFormatCommand } from "./jvm-tools.js";
import type { JvmProject } from "./jvm-projects.js";
import { createJvmSetupDiagnostics, createJvmSetupFailureStage, createUnsupportedJvmCommandMessage, createUnsupportedJvmSetupMessage, filterJvmFiles, resolveJvmProjects, runProjectBatches } from "./jvm-projects.js";

export async function runJvmLintTask(
  task: PlannedTask,
  runtime: JvmRunnerRuntime,
): Promise<StageResult> {
  return runJvmStageTask(task, runtime, "lint");
}

export async function runJvmFormatTask(
  task: PlannedTask,
  runtime: JvmRunnerRuntime,
): Promise<StageResult> {
  return runJvmStageTask(task, runtime, "format");
}

async function runJvmStageTask(
  task: PlannedTask,
  runtime: JvmRunnerRuntime,
  mode: "format" | "lint",
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
  let unsupportedFiles: string[] = [];

  try {
    const resolvedProjects = await resolveJvmProjects(runtime.graph, files);
    unsupportedFiles = resolvedProjects.unsupportedFiles;

    if (resolvedProjects.projects.length === 0) {
      return createJvmSetupFailureStage(
        task.stageId,
        files,
        createUnsupportedJvmSetupMessage(task.stageId, unsupportedFiles),
        runtime,
      );
    }

    const projectResults = await runProjectBatches(resolvedProjects.projects, async (project) =>
      runJvmLintOrFormatProjectTask(project, mode, runtime),
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
      mode === "format" ? "jvm-format" : "jvm-lint",
      files[0] ?? runtime.cwd,
      error,
      totalDurationMs,
      diagnostics,
      toolRuns,
    );
  }

  if (unsupportedFiles.length > 0) {
    const message = createUnsupportedJvmSetupMessage(task.stageId, unsupportedFiles);
    diagnostics.push(...createJvmSetupDiagnostics(unsupportedFiles, message));
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

async function runJvmLintOrFormatProjectTask(
  project: JvmProject,
  mode: "format" | "lint",
  runtime: JvmRunnerRuntime,
): Promise<{
  diagnostics: Diagnostic[];
  durationMs: number;
  notImplemented: boolean;
  note: string;
  toolRun: ToolRunResult;
}> {
  const command = await resolveJvmLintOrFormatCommand(project, mode, runtime);
  if (command === undefined) {
    const message = createUnsupportedJvmCommandMessage(project, mode);
    return {
      diagnostics: [
        runtime.createProcessFailureDiagnostic(
          project.files[0] ?? project.buildFilePath,
          "jvm-unavailable",
          message,
        ),
      ],
      durationMs: 0,
      notImplemented: false,
      note: message,
      toolRun: runtime.createToolRunResult("jvm-unavailable", [], 0, undefined, "failed"),
    };
  }

  const outcome = await runtime.runExecutable(
    command.command,
    command.args,
    project.projectRoot,
    runtime.signal,
    command.env,
  );
  const diagnostics =
    outcome.exitCode === 0
      ? []
      : [
          runtime.createProcessFailureDiagnostic(
            project.files[0] ?? project.buildFilePath,
            command.tool,
            runtime.readProcessFailureMessage(
              command.label,
              outcome.stderr,
              outcome.stdout,
              outcome.exitCode,
            ),
          ),
        ];

  return {
    diagnostics,
    durationMs: outcome.durationMs,
    notImplemented: false,
    note:
      diagnostics.length === 0
        ? `${command.label} passed for ${path.basename(project.projectRoot)}.`
        : `${command.label} reported ${diagnostics.length} diagnostic${diagnostics.length === 1 ? "" : "s"} for ${path.basename(project.projectRoot)}.`,
    toolRun: runtime.createToolRunResult(
      command.tool,
      command.args,
      outcome.durationMs,
      outcome.exitCode,
      diagnostics.length === 0 ? "passed" : "failed",
      outcome.finishedAt,
      outcome.startedAt,
    ),
  };
}
