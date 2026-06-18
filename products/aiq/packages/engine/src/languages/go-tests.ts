import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Diagnostic, PlannedTask, StageResult, ToolRunResult } from "../contracts.js";
import { createLizardMetricsDiagnostics } from "../metrics-thresholds.js";
import * as commands from "../tools/command-builders.js";
import type { GoRunnerRuntime, SharedMetricsMode } from "./contracts.js";
import {
  getGoMetricsProjectMetrics,
  parseGoCoveragePercent,
  parseGoTestReport,
  readGoCoverageNote,
  readGoUnitNote,
  resolveGoBinary,
  resolveGoProjectSourceFiles,
} from "./go-tools.js";
import type { GoProject } from "./go-projects.js";
import {
  createGoProjectResolutionDiagnostics,
  createGoProjectResolutionFailureStage,
  createGoProjectResolutionMessage,
  filterGoFiles,
  findFileExists,
  isGoTaskFile,
  resolveGoProjects,
  runProjectBatches,
} from "./go-projects.js";
import {
  createUnsupportedSharedMetricsDiagnostics,
  readUnsupportedSharedMetricsNotes,
} from "./shared-metrics-support.js";

export async function runGoUnitTask(
  task: PlannedTask,
  runtime: GoRunnerRuntime,
): Promise<StageResult> {
  return runGoTestStage(task, runtime, "unit");
}

export async function runGoCoverageTask(
  task: PlannedTask,
  runtime: GoRunnerRuntime,
): Promise<StageResult> {
  return runGoTestStage(task, runtime, "coverage");
}

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
    const resolvedProjects = await resolveGoProjects(runtime.graph, files);
    unsupportedFiles = resolvedProjects.unsupportedFiles;
    const projects = await Promise.all(
      resolvedProjects.projects.map(async (project) => ({
        ...project,
        files: await resolveGoProjectSourceFiles(project, runtime),
      })),
    );

    for (const project of projects) {
      if (project.files.length === 0) {
        continue;
      }

      const cachedMetrics = await getGoMetricsProjectMetrics(project, runtime);
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
      "Go",
      mode,
      scannedFileCount,
      totalSloc,
      totalBlocks,
      maxComplexity,
      maxRank,
      minMaintainability,
      minMaintainabilityRank,
      "functions",
    ),
  );

  if (toolRuns.some((toolRun) => toolRun.cacheHit)) {
    notes.push("Reused cached Go metrics for this file batch.");
  }

  unsupportedFiles = [
    ...new Set([
      ...unsupportedFiles,
      ...task.files.filter(
        (file) => !isGoTaskFile(file) && !runtime.isSharedMetricsCompanionFile(file),
      ),
    ]),
  ].sort((left, right) => left.localeCompare(right));
  if (unsupportedFiles.length > 0) {
    diagnostics.push(
      ...createUnsupportedSharedMetricsDiagnostics(
        unsupportedFiles,
        task.stageId,
        "Go",
        "Go files or Go project files",
        runtime.createProcessFailureDiagnostic,
      ),
    );
    notes.push(...readUnsupportedSharedMetricsNotes(unsupportedFiles, task.stageId, "Go"));
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

async function runGoTestStage(
  task: PlannedTask,
  runtime: GoRunnerRuntime,
  mode: "coverage" | "unit",
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
  let totalDurationMs = 0;
  let unsupportedFiles: string[] = [];

  try {
    const resolvedProjects = await resolveGoProjects(runtime.graph, files);
    unsupportedFiles = resolvedProjects.unsupportedFiles;

    if (resolvedProjects.projects.length === 0) {
      return createGoProjectResolutionFailureStage(task.stageId, files);
    }

    const projectResults = await runProjectBatches(resolvedProjects.projects, async (project) =>
      runGoProjectTestTask(project, mode, runtime),
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
      mode === "coverage" ? "go-test-coverage" : "go-test",
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

async function runGoProjectTestTask(
  project: GoProject,
  mode: "coverage" | "unit",
  runtime: GoRunnerRuntime,
): Promise<{
  diagnostics: Diagnostic[];
  durationMs: number;
  note: string;
  toolRun: ToolRunResult;
}> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-go-runner-"));

  try {
    const coveragePath = path.join(tempDir, "coverage.out");
    const args = commands.createGoTestArgs(
      mode === "coverage" ? { coverageProfile: coveragePath } : {},
    );
    const goCommand = await resolveGoBinary("go", runtime);
    const outcome = await runtime.runExecutable(
      goCommand,
      args,
      project.projectRoot,
      runtime.signal,
    );
    const report = parseGoTestReport(
      outcome.stdout,
      project.projectRoot,
      mode === "coverage" ? "go-test-coverage" : "go-test",
      project.files[0] ?? project.moduleFilePath,
    );
    let coveragePercent: number | undefined;
    let durationMs = outcome.durationMs;
    let finishedAt = outcome.finishedAt;
    let exitCode = outcome.exitCode;
    const toolArgs = [...args];

    if (mode === "coverage") {
      if (await findFileExists(coveragePath)) {
        const coverageArgs = commands.createGoCoverageArgs({ func: coveragePath });
        const coverageOutcome = await runtime.runExecutable(
          goCommand,
          coverageArgs,
          project.projectRoot,
          runtime.signal,
        );
        durationMs += coverageOutcome.durationMs;
        finishedAt = coverageOutcome.finishedAt;
        toolArgs.push(...coverageArgs);

        if (coverageOutcome.exitCode === 0) {
          coveragePercent = parseGoCoveragePercent(coverageOutcome.stdout);
        } else {
          exitCode = coverageOutcome.exitCode;
          report.diagnostics.push(
            runtime.createProcessFailureDiagnostic(
              project.files[0] ?? project.moduleFilePath,
              "go-tool-cover",
              runtime.readProcessFailureMessage(
                "go tool cover",
                coverageOutcome.stderr,
                coverageOutcome.stdout,
                coverageOutcome.exitCode,
              ),
            ),
          );
        }
      } else if (outcome.exitCode === 0) {
        exitCode = 1;
        report.diagnostics.push(
          runtime.createProcessFailureDiagnostic(
            project.files[0] ?? project.moduleFilePath,
            "go-test-coverage",
            `go test did not produce coverage profile at ${coveragePath}.`,
          ),
        );
      }
    }

    const status = exitCode === 0 && report.diagnostics.length === 0 ? "passed" : "failed";

    if (status === "failed" && report.diagnostics.length === 0) {
      report.diagnostics.push(
        runtime.createProcessFailureDiagnostic(
          project.files[0] ?? project.moduleFilePath,
          mode === "coverage" ? "go-test-coverage" : "go-test",
          runtime.readProcessFailureMessage(
            "go test",
            outcome.stderr,
            outcome.stdout,
            outcome.exitCode,
          ),
        ),
      );
    }

    return {
      diagnostics: report.diagnostics,
      durationMs,
      note:
        mode === "coverage"
          ? readGoCoverageNote(coveragePercent, report.summary)
          : readGoUnitNote(report.summary),
      toolRun: runtime.createToolRunResult(
        mode === "coverage" ? "go-test-coverage" : "go-test",
        toolArgs,
        durationMs,
        exitCode,
        status,
        finishedAt,
        outcome.startedAt,
      ),
    };
  } finally {
    await rm(tempDir, { force: true, recursive: true }).catch(() => undefined);
  }
}
