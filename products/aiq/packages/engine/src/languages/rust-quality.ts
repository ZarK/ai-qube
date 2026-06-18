import path from "node:path";

import type { Diagnostic, PlannedTask, StageResult, ToolRunResult } from "../contracts.js";
import * as commands from "../tools/command-builders.js";
import type { RustRunnerRuntime } from "./contracts.js";
import {
  isMissingCargoSubcommand,
  parseCargoJsonDiagnostics,
  parseRustFormatDiagnostics,
  resolveRustBinary,
  resolveRustProjectSourceFiles,
} from "./rust-tools.js";
import {
  createRustProjectResolutionDiagnostics,
  createRustProjectResolutionFailureStage,
  createRustProjectResolutionMessage,
  filterRustFiles,
  joinOutputs,
  normalizeDiagnosticsToSelection,
  resolveRustProjects,
  runProjectBatches,
} from "./rust-projects.js";

export async function runRustLintTask(
  task: PlannedTask,
  runtime: RustRunnerRuntime,
): Promise<StageResult> {
  const files = filterRustFiles(task.files);
  if (files.length === 0) {
    return runtime.createNoopStageResult(task.stageId, "No Rust files were selected for lint.");
  }

  const diagnostics: Diagnostic[] = [];
  const notes: string[] = [];
  const toolRuns: ToolRunResult[] = [];
  let totalDurationMs = 0;
  let unsupportedFiles: string[] = [];

  try {
    const resolvedProjects = await resolveRustProjects(runtime.graph, files);
    unsupportedFiles = resolvedProjects.unsupportedFiles;

    if (resolvedProjects.projects.length === 0) {
      return createRustProjectResolutionFailureStage(task.stageId, files);
    }

    const projectResults = await runProjectBatches(resolvedProjects.projects, async (project) => {
      const args = commands.createCargoClippyArgs();
      const outcome = await runtime.runExecutable(
        await resolveRustBinary(runtime),
        args,
        project.projectRoot,
        runtime.signal,
        await runtime.createRustProcessEnv(),
      );
      const parsedDiagnostics = normalizeDiagnosticsToSelection(
        parseCargoJsonDiagnostics(
          joinOutputs(outcome.stdout, outcome.stderr),
          project.projectRoot,
          "cargo-clippy",
        ),
        project.files,
      );
      const status = outcome.exitCode === 0 && parsedDiagnostics.length === 0 ? "passed" : "failed";

      if (status === "failed" && parsedDiagnostics.length === 0) {
        parsedDiagnostics.push(
          runtime.createProcessFailureDiagnostic(
            project.files[0] ?? project.manifestPath,
            "cargo-clippy",
            runtime.readProcessFailureMessage(
              "cargo clippy",
              outcome.stderr,
              outcome.stdout,
              outcome.exitCode,
            ),
          ),
        );
      }

      return {
        diagnostics: parsedDiagnostics,
        durationMs: outcome.durationMs,
        note:
          status === "passed"
            ? `cargo clippy passed for ${path.basename(project.projectRoot)}.`
            : `cargo clippy reported ${parsedDiagnostics.length} diagnostic${parsedDiagnostics.length === 1 ? "" : "s"} for ${path.basename(project.projectRoot)}.`,
        toolRun: runtime.createToolRunResult(
          "cargo-clippy",
          args,
          outcome.durationMs,
          outcome.exitCode,
          status,
          outcome.finishedAt,
          outcome.startedAt,
        ),
      };
    });

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
      "cargo-clippy",
      files[0] ?? runtime.cwd,
      error,
      totalDurationMs,
      diagnostics,
      toolRuns,
    );
  }

  if (unsupportedFiles.length > 0) {
    const message = createRustProjectResolutionMessage(task.stageId, unsupportedFiles);
    diagnostics.push(...createRustProjectResolutionDiagnostics(unsupportedFiles, message));
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

export async function runRustFormatTask(
  task: PlannedTask,
  runtime: RustRunnerRuntime,
): Promise<StageResult> {
  const files = filterRustFiles(task.files);
  if (files.length === 0) {
    return runtime.createNoopStageResult(task.stageId, "No Rust files were selected for format.");
  }

  const diagnostics: Diagnostic[] = [];
  const notes: string[] = [];
  const toolRuns: ToolRunResult[] = [];
  let totalDurationMs = 0;
  let unsupportedFiles: string[] = [];

  try {
    const resolvedProjects = await resolveRustProjects(runtime.graph, files);
    unsupportedFiles = resolvedProjects.unsupportedFiles;

    if (resolvedProjects.projects.length === 0) {
      return createRustProjectResolutionFailureStage(task.stageId, files);
    }

    const projectResults = await runProjectBatches(resolvedProjects.projects, async (project) => {
      const args = commands.createCargoFmtArgs();
      const outcome = await runtime.runExecutable(
        await resolveRustBinary(runtime),
        args,
        project.projectRoot,
        runtime.signal,
        await runtime.createRustProcessEnv(),
      );
      const parsedDiagnostics = normalizeDiagnosticsToSelection(
        parseRustFormatDiagnostics(
          joinOutputs(outcome.stdout, outcome.stderr),
          project.projectRoot,
        ),
        project.files,
      );
      const status = outcome.exitCode === 0 && parsedDiagnostics.length === 0 ? "passed" : "failed";

      if (status === "failed" && parsedDiagnostics.length === 0) {
        parsedDiagnostics.push(
          runtime.createProcessFailureDiagnostic(
            project.files[0] ?? project.manifestPath,
            "cargo-fmt",
            runtime.readProcessFailureMessage(
              "cargo fmt",
              outcome.stderr,
              outcome.stdout,
              outcome.exitCode,
            ),
          ),
        );
      }

      return {
        diagnostics: parsedDiagnostics,
        durationMs: outcome.durationMs,
        note:
          status === "passed"
            ? `cargo fmt passed for ${path.basename(project.projectRoot)}.`
            : `cargo fmt reported ${parsedDiagnostics.length} formatting diagnostic${parsedDiagnostics.length === 1 ? "" : "s"} for ${path.basename(project.projectRoot)}.`,
        toolRun: runtime.createToolRunResult(
          "cargo-fmt",
          args,
          outcome.durationMs,
          outcome.exitCode,
          status,
          outcome.finishedAt,
          outcome.startedAt,
        ),
      };
    });

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
      "cargo-fmt",
      files[0] ?? runtime.cwd,
      error,
      totalDurationMs,
      diagnostics,
      toolRuns,
    );
  }

  if (unsupportedFiles.length > 0) {
    const message = createRustProjectResolutionMessage(task.stageId, unsupportedFiles);
    diagnostics.push(...createRustProjectResolutionDiagnostics(unsupportedFiles, message));
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

export async function runRustTypecheckTask(
  task: PlannedTask,
  runtime: RustRunnerRuntime,
): Promise<StageResult> {
  const files = filterRustFiles(task.files);
  if (files.length === 0) {
    return runtime.createNoopStageResult(
      task.stageId,
      "No Rust files were selected for typecheck.",
    );
  }

  const diagnostics: Diagnostic[] = [];
  const notes: string[] = [];
  const toolRuns: ToolRunResult[] = [];
  let totalDurationMs = 0;
  let unsupportedFiles: string[] = [];

  try {
    const resolvedProjects = await resolveRustProjects(runtime.graph, files);
    unsupportedFiles = resolvedProjects.unsupportedFiles;

    if (resolvedProjects.projects.length === 0) {
      return createRustProjectResolutionFailureStage(task.stageId, files);
    }

    const projectResults = await runProjectBatches(resolvedProjects.projects, async (project) => {
      const args = commands.createCargoCheckArgs();
      const outcome = await runtime.runExecutable(
        await resolveRustBinary(runtime),
        args,
        project.projectRoot,
        runtime.signal,
        await runtime.createRustProcessEnv(),
      );
      const parsedDiagnostics = normalizeDiagnosticsToSelection(
        parseCargoJsonDiagnostics(
          joinOutputs(outcome.stdout, outcome.stderr),
          project.projectRoot,
          "cargo-check",
        ),
        project.files,
      );

      if (outcome.exitCode !== 0 && parsedDiagnostics.length === 0) {
        parsedDiagnostics.push(
          runtime.createProcessFailureDiagnostic(
            project.files[0] ?? project.manifestPath,
            "cargo-check",
            runtime.readProcessFailureMessage(
              "cargo check",
              outcome.stderr,
              outcome.stdout,
              outcome.exitCode,
            ),
          ),
        );
      }

      const status = outcome.exitCode === 0 && parsedDiagnostics.length === 0 ? "passed" : "failed";

      return {
        diagnostics: parsedDiagnostics,
        durationMs: outcome.durationMs,
        note:
          status === "passed"
            ? `cargo check passed for ${path.basename(project.projectRoot)}.`
            : `cargo check reported ${parsedDiagnostics.length} diagnostic${parsedDiagnostics.length === 1 ? "" : "s"} for ${path.basename(project.projectRoot)}.`,
        toolRun: runtime.createToolRunResult(
          "cargo-check",
          args,
          outcome.durationMs,
          outcome.exitCode,
          status,
          outcome.finishedAt,
          outcome.startedAt,
        ),
      };
    });

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
      "cargo-check",
      files[0] ?? runtime.cwd,
      error,
      totalDurationMs,
      diagnostics,
      toolRuns,
    );
  }

  if (unsupportedFiles.length > 0) {
    const message = createRustProjectResolutionMessage(task.stageId, unsupportedFiles);
    diagnostics.push(...createRustProjectResolutionDiagnostics(unsupportedFiles, message));
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
