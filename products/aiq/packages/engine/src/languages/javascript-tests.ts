import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Diagnostic, PlannedTask, StageResult, ToolRunResult } from "../contracts.js";
import * as parsers from "../parsers/index.js";
import { createJavaScriptTestCommand } from "../tools/node.js";
import type { JavaScriptRunnerRuntime } from "./contracts.js";
import type { JavaScriptProject, JavaScriptProjectExecution, UnsupportedJavaScriptTestProject } from "./javascript-projects.js";
import { filterJavaScriptTestFiles, resolveJavaScriptProjects } from "./javascript-projects.js";
import {
  createUnsupportedJavaScriptTestDiagnostics,
  readUnsupportedJavaScriptTestNotes,
} from "./javascript-e2e.js";
import { createJavaScriptProjectExecutionKey } from "./javascript-metrics.js";
import {
  capitalize,
  isValidCoverageSummary,
  isValidJavaScriptTestReport,
  readCoverageNote,
  readJsonFile,
  readTestSummary,
  readUnitNote,
  runProjectBatches,
} from "./javascript-utils.js";

export async function runJavaScriptUnitTask(
  task: PlannedTask,
  runtime: JavaScriptRunnerRuntime,
): Promise<StageResult> {
  return runJavaScriptTestStage(task, runtime, "unit");
}

export async function runJavaScriptCoverageTask(
  task: PlannedTask,
  runtime: JavaScriptRunnerRuntime,
): Promise<StageResult> {
  return runJavaScriptTestStage(task, runtime, "coverage");
}

async function runJavaScriptTestStage(
  task: PlannedTask,
  runtime: JavaScriptRunnerRuntime,
  mode: "coverage" | "unit",
): Promise<StageResult> {
  const files = filterJavaScriptTestFiles(task.files);
  if (files.length === 0) {
    return runtime.createNoopStageResult(
      task.stageId,
      `No JavaScript or TypeScript files were selected for ${task.stageId}.`,
    );
  }

  const diagnostics = [] as ReturnType<JavaScriptRunnerRuntime["createProcessFailureDiagnostic"]>[];
  const toolRuns = [] as ReturnType<JavaScriptRunnerRuntime["createToolRunResult"]>[];
  const notes: string[] = [];
  let totalDurationMs = 0;
  let unsupportedProjects: UnsupportedJavaScriptTestProject[] = [];
  const stageTempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-js-stage-"));

  try {
    const resolvedProjects = await resolveJavaScriptProjects(runtime.graph, files);
    unsupportedProjects = resolvedProjects.unsupportedProjects;

    if (resolvedProjects.projects.length === 0) {
      const unsupportedDiagnostics = createUnsupportedJavaScriptTestDiagnostics(
        unsupportedProjects,
        runtime,
      );
      return {
        diagnostics: unsupportedDiagnostics,
        durationMs: totalDurationMs,
        notes: readUnsupportedJavaScriptTestNotes(unsupportedProjects, task.stageId),
        stageId: task.stageId,
        status: unsupportedDiagnostics.length > 0 ? "failed" : "passed",
        toolRuns,
      };
    }

    const projectResults = await runProjectBatches(
      resolvedProjects.projects,
      async (project, projectIndex) =>
        runJavaScriptProjectTask(project, runtime, mode, stageTempDir, projectIndex),
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
      mode === "coverage" ? "test-coverage" : "test-runner",
      files[0] ?? runtime.cwd,
      error,
      totalDurationMs,
      diagnostics,
      toolRuns,
    );
  } finally {
    await rm(stageTempDir, { force: true, recursive: true }).catch(() => undefined);
  }

  diagnostics.push(...createUnsupportedJavaScriptTestDiagnostics(unsupportedProjects, runtime));
  notes.push(...readUnsupportedJavaScriptTestNotes(unsupportedProjects, task.stageId));

  return {
    diagnostics,
    durationMs: totalDurationMs,
    notes,
    stageId: task.stageId,
    status: diagnostics.length > 0 ? "failed" : "passed",
    toolRuns,
  };
}

async function runJavaScriptProjectTask(
  project: JavaScriptProject,
  runtime: JavaScriptRunnerRuntime,
  mode: "coverage" | "unit",
  stageTempDir: string,
  projectIndex: number,
): Promise<{
  diagnostics: Diagnostic[];
  durationMs: number;
  note: string;
  toolRun: ToolRunResult;
}> {
  const allowCoverageReuse =
    runtime.selectedStages.includes("unit") && runtime.selectedStages.includes("coverage");
  const cacheKey = createJavaScriptProjectExecutionKey(project);
  const cachedExecution = allowCoverageReuse
    ? runtime.getRunScopedValue<JavaScriptProjectExecution>("javascript:test-execution", cacheKey)
    : undefined;
  if (allowCoverageReuse && cachedExecution !== undefined) {
    return materializeJavaScriptProjectStageResult(cachedExecution, mode, true);
  }

  const preferCoverageExecution = allowCoverageReuse && mode === "unit";
  const preferredMode = preferCoverageExecution ? "coverage" : mode;
  const execution = await executeJavaScriptProjectTask(
    project,
    runtime,
    preferredMode,
    stageTempDir,
    projectIndex,
  );

  if (
    allowCoverageReuse &&
    execution.coverageSummaryError === undefined &&
    !isCoverageOnlyFailure(execution) &&
    preferredMode === "coverage"
  ) {
    runtime.setRunScopedValue("javascript:test-execution", cacheKey, execution);
  }

  if (shouldFallbackToPlainUnit(preferCoverageExecution, execution)) {
    return materializeJavaScriptProjectStageResult(
      await executeJavaScriptProjectTask(project, runtime, "unit", stageTempDir, projectIndex),
      "unit",
      false,
    );
  }

  return materializeJavaScriptProjectStageResult(execution, mode, false);
}

async function executeJavaScriptProjectTask(
  project: JavaScriptProject,
  runtime: JavaScriptRunnerRuntime,
  mode: "coverage" | "unit",
  stageTempDir: string,
  projectIndex: number,
): Promise<JavaScriptProjectExecution> {
  const tempDir = await prepareJavaScriptProjectTempDir(stageTempDir, projectIndex, mode);

  const reportPath = path.join(tempDir, "test-results.json");
  const coverageDirectory = path.join(tempDir, "coverage");
  const command = createJavaScriptTestCommand({
    coverageDirectory,
    executionMode: project.executionMode,
    mode,
    reportPath,
    runner: project.runner,
  });
  const outcome = await runtime.runExecutable(
    command.command,
    command.args,
    project.projectRoot,
    runtime.signal,
  );
  const report = await readJsonFile(reportPath);
  if (outcome.exitCode === 0 && !isValidJavaScriptTestReport(report)) {
    throw new Error(
      `Expected test report at "${reportPath}" for ${project.runner} ${mode} with test summary fields.`,
    );
  }
  const coverageSummary =
    mode === "coverage"
      ? await readJsonFile(path.join(coverageDirectory, "coverage-summary.json"))
      : undefined;
  const diagnostics = parsers.parseTestRunnerDiagnostics(
    report,
    runtime.cwd,
    project.projectRoot,
    project.runner,
  );
  const summary = readTestSummary(report);
  const status =
    outcome.exitCode === 0 && diagnostics.length === 0 && summary.failed === 0
      ? "passed"
      : "failed";

  if (status === "failed" && diagnostics.length === 0) {
    diagnostics.push(
      runtime.createProcessFailureDiagnostic(
        project.files[0] ?? project.projectRoot,
        project.runner,
        summary.failed > 0
          ? `${capitalize(project.runner)} reported ${summary.failed} failing test${summary.failed === 1 ? "" : "s"} in its summary.`
          : runtime.readProcessFailureMessage(
              mode === "coverage" ? `${project.runner} coverage` : `${project.runner} tests`,
              outcome.stderr,
              outcome.stdout,
              outcome.exitCode,
            ),
      ),
    );
  }

  return {
    coverageSummary,
    coverageSummaryError:
      mode === "coverage" && outcome.exitCode === 0 && !isValidCoverageSummary(coverageSummary)
        ? `Expected coverage summary at "${path.join(coverageDirectory, "coverage-summary.json")}" for ${project.runner} coverage with total line coverage.`
        : undefined,
    diagnostics,
    runner: project.runner,
    summary,
    toolRun: runtime.createToolRunResult(
      project.runner,
      command.args,
      outcome.durationMs,
      outcome.exitCode,
      status,
      outcome.finishedAt,
      outcome.startedAt,
    ),
  };
}

async function prepareJavaScriptProjectTempDir(
  stageTempDir: string,
  projectIndex: number,
  mode: "coverage" | "unit",
): Promise<string> {
  const tempDir = path.join(stageTempDir, `project-${projectIndex}-${mode}`);
  await rm(tempDir, { force: true, recursive: true });
  await mkdir(tempDir, { recursive: true });
  return tempDir;
}

function materializeJavaScriptProjectStageResult(
  execution: JavaScriptProjectExecution,
  mode: "coverage" | "unit",
  cacheHit: boolean,
): {
  diagnostics: Diagnostic[];
  durationMs: number;
  note: string;
  toolRun: ToolRunResult;
} {
  if (mode === "coverage" && execution.coverageSummaryError !== undefined) {
    throw new Error(execution.coverageSummaryError);
  }

  return {
    diagnostics: [...execution.diagnostics],
    durationMs: cacheHit ? 0 : execution.toolRun.durationMs,
    note:
      mode === "coverage"
        ? readCoverageNote(execution.runner, execution.coverageSummary, execution.summary)
        : readUnitNote(execution.runner, execution.summary),
    toolRun: parsers.cloneToolRunResult(execution.toolRun, cacheHit),
  };
}

function shouldFallbackToPlainUnit(
  preferCoverageExecution: boolean,
  execution: JavaScriptProjectExecution,
): boolean {
  return (
    preferCoverageExecution &&
    (execution.coverageSummaryError !== undefined || isCoverageOnlyFailure(execution))
  );
}

function isCoverageOnlyFailure(execution: JavaScriptProjectExecution): boolean {
  return execution.toolRun.status === "failed" && execution.summary.failed === 0;
}
