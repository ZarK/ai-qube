import path from "node:path";

import type { Diagnostic, PlannedTask, StageResult, ToolRunResult } from "../contracts.js";
import * as commands from "../tools/command-builders.js";
import type { GoRunnerRuntime } from "./contracts.js";
import {
  parseGoCompilerDiagnostics,
  parseGoFormatDiagnostics,
  parseGoVetDiagnostics,
  resolveGoBinary,
  resolveGoProjectSourceFiles,
} from "./go-tools.js";
import {
  createGoProjectResolutionDiagnostics,
  createGoProjectResolutionFailureStage,
  createGoProjectResolutionMessage,
  filterGoFiles,
  joinOutputs,
  normalizeDiagnosticsToSelection,
  resolveGoProjects,
  runProjectBatches,
} from "./go-projects.js";

export async function runGoLintTask(
  task: PlannedTask,
  runtime: GoRunnerRuntime,
): Promise<StageResult> {
  const files = filterGoFiles(task.files);
  if (files.length === 0) {
    return runtime.createNoopStageResult(task.stageId, "No Go files were selected for lint.");
  }

  const diagnostics: Diagnostic[] = [];
  const notes: string[] = [];
  const toolRuns: ToolRunResult[] = [];
  let totalDurationMs = 0;
  let unsupportedFiles: string[] = [];

  try {
    const resolvedProjects = await resolveGoProjects(runtime.graph, files);
    unsupportedFiles = resolvedProjects.unsupportedFiles;

    if (resolvedProjects.projects.length === 0) {
      return createGoProjectResolutionFailureStage(task.stageId, files);
    }

    const projectResults = await runProjectBatches(resolvedProjects.projects, async (project) => {
      const args = commands.createGoVetArgs();
      const outcome = await runtime.runExecutable(
        await resolveGoBinary("go", runtime),
        args,
        project.projectRoot,
        runtime.signal,
      );
      const parsedDiagnostics = normalizeDiagnosticsToSelection(
        parseGoVetDiagnostics(outcome.stderr, outcome.stdout, project.projectRoot),
        project.files,
      );

      if (outcome.exitCode !== 0 && parsedDiagnostics.length === 0) {
        parsedDiagnostics.push(
          runtime.createProcessFailureDiagnostic(
            project.files[0] ?? project.moduleFilePath,
            "go-vet",
            runtime.readProcessFailureMessage(
              "go vet",
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
            ? `go vet passed for ${path.basename(project.projectRoot)}.`
            : `go vet reported ${parsedDiagnostics.length} diagnostic${parsedDiagnostics.length === 1 ? "" : "s"} for ${path.basename(project.projectRoot)}.`,
        toolRun: runtime.createToolRunResult(
          "go-vet",
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
      "go-vet",
      files[0] ?? runtime.cwd,
      error,
      totalDurationMs,
      diagnostics,
      toolRuns,
    );
  }

  if (unsupportedFiles.length > 0) {
    const message = createGoProjectResolutionMessage(task.stageId, unsupportedFiles);
    diagnostics.push(...createGoProjectResolutionDiagnostics(unsupportedFiles, message));
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

export async function runGoFormatTask(
  task: PlannedTask,
  runtime: GoRunnerRuntime,
): Promise<StageResult> {
  const files = filterGoFiles(task.files);
  if (files.length === 0) {
    return runtime.createNoopStageResult(task.stageId, "No Go files were selected for format.");
  }

  const diagnostics: Diagnostic[] = [];
  const notes: string[] = [];
  const toolRuns: ToolRunResult[] = [];
  let totalDurationMs = 0;
  let unsupportedFiles: string[] = [];

  try {
    const resolvedProjects = await resolveGoProjects(runtime.graph, files);
    unsupportedFiles = resolvedProjects.unsupportedFiles;

    if (resolvedProjects.projects.length === 0) {
      return createGoProjectResolutionFailureStage(task.stageId, files);
    }

    const projectResults = await runProjectBatches(resolvedProjects.projects, async (project) => {
      const formatFiles = await resolveGoProjectSourceFiles(project, runtime);
      if (formatFiles.length === 0) {
        return {
          diagnostics: [],
          durationMs: 0,
          note: `No Go source files were detected for ${path.basename(project.projectRoot)}.`,
          toolRun: runtime.createToolRunResult("gofmt", [], 0, 0, "passed"),
        };
      }

      const args = commands.createGofmtArgs({
        files: formatFiles.map((file) => path.relative(project.projectRoot, file)),
      });
      const outcome = await runtime.runExecutable(
        await resolveGoBinary("gofmt", runtime),
        args,
        project.projectRoot,
        runtime.signal,
      );
      const parsedDiagnostics = parseGoFormatDiagnostics(outcome.stdout, project.projectRoot);
      const status = outcome.exitCode === 0 && parsedDiagnostics.length === 0 ? "passed" : "failed";

      if (status === "failed" && parsedDiagnostics.length === 0) {
        parsedDiagnostics.push(
          runtime.createProcessFailureDiagnostic(
            formatFiles[0] ?? project.moduleFilePath,
            "gofmt",
            runtime.readProcessFailureMessage(
              "gofmt",
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
            ? `gofmt passed for ${path.basename(project.projectRoot)}.`
            : `gofmt reported ${parsedDiagnostics.length} formatting diagnostic${parsedDiagnostics.length === 1 ? "" : "s"} for ${path.basename(project.projectRoot)}.`,
        toolRun: runtime.createToolRunResult(
          "gofmt",
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
      "gofmt",
      files[0] ?? runtime.cwd,
      error,
      totalDurationMs,
      diagnostics,
      toolRuns,
    );
  }

  if (unsupportedFiles.length > 0) {
    const message = createGoProjectResolutionMessage(task.stageId, unsupportedFiles);
    diagnostics.push(...createGoProjectResolutionDiagnostics(unsupportedFiles, message));
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

export async function runGoTypecheckTask(
  task: PlannedTask,
  runtime: GoRunnerRuntime,
): Promise<StageResult> {
  const files = filterGoFiles(task.files);
  if (files.length === 0) {
    return runtime.createNoopStageResult(task.stageId, "No Go files were selected for typecheck.");
  }

  const diagnostics: Diagnostic[] = [];
  const notes: string[] = [];
  const toolRuns: ToolRunResult[] = [];
  let totalDurationMs = 0;
  let unsupportedFiles: string[] = [];

  try {
    const resolvedProjects = await resolveGoProjects(runtime.graph, files);
    unsupportedFiles = resolvedProjects.unsupportedFiles;

    if (resolvedProjects.projects.length === 0) {
      return createGoProjectResolutionFailureStage(task.stageId, files);
    }

    const projectResults = await runProjectBatches(resolvedProjects.projects, async (project) => {
      const args = commands.createGoBuildArgs();
      const outcome = await runtime.runExecutable(
        await resolveGoBinary("go", runtime),
        args,
        project.projectRoot,
        runtime.signal,
      );
      const parsedDiagnostics = normalizeDiagnosticsToSelection(
        parseGoCompilerDiagnostics(
          joinOutputs(outcome.stderr, outcome.stdout),
          project.projectRoot,
          "go-build",
        ),
        project.files,
      );

      if (outcome.exitCode !== 0 && parsedDiagnostics.length === 0) {
        parsedDiagnostics.push(
          runtime.createProcessFailureDiagnostic(
            project.files[0] ?? project.moduleFilePath,
            "go-build",
            runtime.readProcessFailureMessage(
              "go build",
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
            ? `go build passed for ${path.basename(project.projectRoot)}.`
            : `go build reported ${parsedDiagnostics.length} diagnostic${parsedDiagnostics.length === 1 ? "" : "s"} for ${path.basename(project.projectRoot)}.`,
        toolRun: runtime.createToolRunResult(
          "go-build",
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
      "go-build",
      files[0] ?? runtime.cwd,
      error,
      totalDurationMs,
      diagnostics,
      toolRuns,
    );
  }

  if (unsupportedFiles.length > 0) {
    const message = createGoProjectResolutionMessage(task.stageId, unsupportedFiles);
    diagnostics.push(...createGoProjectResolutionDiagnostics(unsupportedFiles, message));
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
