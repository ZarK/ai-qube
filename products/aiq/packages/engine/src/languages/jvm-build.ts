import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Diagnostic, PlannedTask, StageResult, ToolRunResult } from "../contracts.js";
import * as parsers from "../parsers/index.js";
import type { JvmRunnerRuntime } from "./contracts.js";
import { findJvmCoverageReport, findJvmJunitReports, parseJvmCompilerDiagnostics, readJacocoLineRate, readJvmCoverageNote, readJvmUnitNote, resolveJvmExecutionCommand } from "./jvm-tools.js";
import type { JvmProject } from "./jvm-projects.js";
import { createJvmSetupDiagnostics, createJvmSetupFailureStage, createMissingJvmCommandMessage, createUnsupportedJvmSetupMessage, filterJvmFiles, joinOutputs, readOptionalTextFile, resolveJvmProjects, runProjectBatches } from "./jvm-projects.js";

export async function runJvmTypecheckTask(
  task: PlannedTask,
  runtime: JvmRunnerRuntime,
): Promise<StageResult> {
  const files = filterJvmFiles(task.files);
  if (files.length === 0) {
    return runtime.createNoopStageResult(task.stageId, "No JVM files were selected for typecheck.");
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
      runJvmBuildProjectTask(project, "typecheck", runtime),
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
      "jvm-build",
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

export async function runJvmUnitTask(
  task: PlannedTask,
  runtime: JvmRunnerRuntime,
): Promise<StageResult> {
  return runJvmTestStage(task, runtime, "unit");
}

export async function runJvmCoverageTask(
  task: PlannedTask,
  runtime: JvmRunnerRuntime,
): Promise<StageResult> {
  return runJvmTestStage(task, runtime, "coverage");
}

async function runJvmTestStage(
  task: PlannedTask,
  runtime: JvmRunnerRuntime,
  mode: "coverage" | "unit",
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

    const projectResults = await runProjectBatches(
      resolvedProjects.projects,
      async (project) => runJvmBuildProjectTask(project, mode, runtime),
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
      mode === "coverage" ? "jvm-test-coverage" : "jvm-test",
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

async function runJvmBuildProjectTask(
  project: JvmProject,
  mode: "coverage" | "typecheck" | "unit",
  runtime: JvmRunnerRuntime,
): Promise<{
  diagnostics: Diagnostic[];
  durationMs: number;
  notImplemented: boolean;
  note: string;
  toolRun: ToolRunResult;
}> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-jvm-runner-"));

  try {
    const command = await resolveJvmExecutionCommand(project, mode, tempDir, runtime);
    if (command === undefined) {
      const message = createMissingJvmCommandMessage(project, mode);
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
    if (runtime.isMissingCommandOutcome(outcome.stderr, outcome.stdout, outcome.exitCode)) {
      const message = createMissingJvmCommandMessage(project, mode);
      return {
        diagnostics: [
          runtime.createProcessFailureDiagnostic(
            project.files[0] ?? project.buildFilePath,
            command.tool,
            message,
          ),
        ],
        durationMs: outcome.durationMs,
        notImplemented: false,
        note: message,
        toolRun: runtime.createToolRunResult(
          command.tool,
          command.args,
          outcome.durationMs,
          outcome.exitCode,
          "failed",
          outcome.finishedAt,
          outcome.startedAt,
        ),
      };
    }
    const report =
      mode === "typecheck"
        ? undefined
        : await parsers.parseJvmJunitReports(
            await findJvmJunitReports(project, tempDir, runtime),
            project.files[0] ?? project.buildFilePath,
            readOptionalTextFile,
          );
    const coveragePercent =
      mode === "coverage"
        ? readJacocoLineRate(
            await readOptionalTextFile(await findJvmCoverageReport(project, tempDir, runtime)),
          )
        : undefined;
    const parsedDiagnostics =
      mode === "typecheck"
        ? parseJvmCompilerDiagnostics(
            joinOutputs(outcome.stdout, outcome.stderr),
            project.projectRoot,
            command.tool,
          )
        : (report?.diagnostics ?? []);

    if (outcome.exitCode !== 0 && parsedDiagnostics.length === 0) {
      parsedDiagnostics.push(
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
      );
    }

    return {
      diagnostics: parsedDiagnostics,
      durationMs: outcome.durationMs,
      notImplemented: false,
      note:
        mode === "typecheck"
          ? parsedDiagnostics.length === 0
            ? `${command.label} passed for ${path.basename(project.projectRoot)}.`
            : `${command.label} reported ${parsedDiagnostics.length} diagnostic${parsedDiagnostics.length === 1 ? "" : "s"} for ${path.basename(project.projectRoot)}.`
          : mode === "coverage"
            ? readJvmCoverageNote(
                project.buildSystem,
                report?.summary ?? { failed: 0, passed: 0, total: 0 },
                coveragePercent,
              )
            : readJvmUnitNote(
                project.buildSystem,
                report?.summary ?? { failed: 0, passed: 0, total: 0 },
              ),
      toolRun: runtime.createToolRunResult(
        command.tool,
        command.args,
        outcome.durationMs,
        outcome.exitCode,
        parsedDiagnostics.length === 0 ? "passed" : "failed",
        outcome.finishedAt,
        outcome.startedAt,
      ),
    };
  } finally {
    await rm(tempDir, { force: true, recursive: true }).catch(() => undefined);
  }
}
