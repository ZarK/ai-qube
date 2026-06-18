import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Diagnostic, PlannedTask, StageResult, ToolRunResult } from "../contracts.js";
import { createLizardMetricsDiagnostics } from "../metrics-thresholds.js";
import * as commands from "../tools/command-builders.js";
import { pathExists } from "../utils/path-utils.js";
import type { RustRunnerRuntime, SharedMetricsMode } from "./contracts.js";
import {
  getRustMetricsProjectMetrics,
  isMissingCargoSubcommand,
  parseCargoJsonDiagnostics,
  parseRustTestReport,
  readLcovLineRate,
  readOptionalTextFile,
  readRustCoverageNote,
  readRustUnitNote,
  resolveRustBinary,
  resolveRustProjectSourceFiles,
} from "./rust-tools.js";
import type { RustProject } from "./rust-projects.js";
import {
  createRustProjectResolutionDiagnostics,
  createRustProjectResolutionFailureStage,
  createRustProjectResolutionMessage,
  filterRustFiles,
  isRustTaskFile,
  joinOutputs,
  resolveRustProjects,
  runProjectBatches,
} from "./rust-projects.js";
import {
  appendUnsupportedSharedMetricsIssue,
  collectUnsupportedSharedMetricsFiles,
} from "./shared-metrics-support.js";
import {
  addCachedMetricDuration,
  addLizardFileMetrics,
  createSharedMetricTotals,
} from "./shared-metrics-accumulator.js";

export async function runRustUnitTask(
  task: PlannedTask,
  runtime: RustRunnerRuntime,
): Promise<StageResult> {
  return runRustTestStage(task, runtime, "unit");
}

export async function runRustCoverageTask(
  task: PlannedTask,
  runtime: RustRunnerRuntime,
): Promise<StageResult> {
  return runRustTestStage(task, runtime, "coverage");
}

export async function runRustMetricsTask(
  task: PlannedTask,
  runtime: RustRunnerRuntime,
  mode: SharedMetricsMode,
): Promise<StageResult> {
  const files = filterRustFiles(task.files);
  if (files.length === 0) {
    return runtime.createNoopStageResult(
      task.stageId,
      `No Rust files were selected for ${task.stageId}.`,
    );
  }

  const diagnostics: Diagnostic[] = [];
  const notes: string[] = [];
  const toolRuns: ToolRunResult[] = [];
  const totals = createSharedMetricTotals();
  let unsupportedFiles: string[] = [];

  try {
    const resolvedProjects = await resolveRustProjects(runtime.graph, files);
    unsupportedFiles = resolvedProjects.unsupportedFiles;
    const projects = await Promise.all(
      resolvedProjects.projects.map(async (project) => ({
        ...project,
        files: await resolveRustProjectSourceFiles(project, runtime),
      })),
    );

    for (const project of projects) {
      if (project.files.length === 0) {
        continue;
      }

      const cachedMetrics = await getRustMetricsProjectMetrics(project, runtime);
      addCachedMetricDuration(totals, cachedMetrics);
      addLizardFileMetrics(totals, cachedMetrics.metrics.files);
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
      totals.totalDurationMs,
      diagnostics,
      toolRuns,
    );
  }

  notes.push(
    runtime.readSharedMetricsNote(
      "Rust",
      mode,
      totals.scannedFileCount,
      totals.totalSloc,
      totals.totalBlocks,
      totals.maxComplexity,
      totals.maxRank,
      totals.minMaintainability,
      totals.minMaintainabilityRank,
      "functions",
    ),
  );

  if (toolRuns.some((toolRun) => toolRun.cacheHit)) {
    notes.push("Reused cached Rust metrics for this file batch.");
  }

  unsupportedFiles = collectUnsupportedSharedMetricsFiles(unsupportedFiles, task.files, (file) => {
    return isRustTaskFile(file) || runtime.isSharedMetricsCompanionFile(file);
  });
  appendUnsupportedSharedMetricsIssue({
    createProcessFailureDiagnostic: runtime.createProcessFailureDiagnostic,
    diagnostics,
    languageLabel: "Rust",
    notes,
    stageId: task.stageId,
    supportedFileDescription: "Rust files or Cargo project files",
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

async function runRustTestStage(
  task: PlannedTask,
  runtime: RustRunnerRuntime,
  mode: "coverage" | "unit",
): Promise<StageResult> {
  const files = filterRustFiles(task.files);
  if (files.length === 0) {
    return runtime.createNoopStageResult(
      task.stageId,
      `No Rust files were selected for ${task.stageId}.`,
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

    const projectResults = await runProjectBatches(resolvedProjects.projects, async (project) =>
      runRustProjectTestTask(project, mode, runtime),
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
      mode === "coverage" ? "cargo-llvm-cov" : "cargo-test",
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

async function runRustProjectTestTask(
  project: RustProject,
  mode: "coverage" | "unit",
  runtime: RustRunnerRuntime,
): Promise<{
  diagnostics: Diagnostic[];
  durationMs: number;
  notImplemented: boolean;
  note: string;
  toolRun: ToolRunResult;
}> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-rust-runner-"));

  try {
    const lcovPath = path.join(tempDir, "lcov.info");
    const args =
      mode === "coverage"
        ? commands.createCargoLlvmCovArgs({ lcovPath })
        : commands.createCargoTestArgs();
    const tool = mode === "coverage" ? "cargo-llvm-cov" : "cargo-test";
    const outcome = await runtime.runExecutable(
      await resolveRustBinary(runtime),
      args,
      project.projectRoot,
      runtime.signal,
      await runtime.createRustProcessEnv(),
    );
    const report = parseRustTestReport(
      joinOutputs(outcome.stdout, outcome.stderr),
      project.projectRoot,
      tool,
      project.files[0] ?? project.manifestPath,
    );
    if (
      mode === "coverage" &&
      isMissingCargoSubcommand(joinOutputs(outcome.stdout, outcome.stderr), "llvm-cov")
    ) {
      const message =
        "Rust coverage requires the cargo-llvm-cov subcommand. Install it with `cargo install cargo-llvm-cov`, or disable Rust coverage.";
      return {
        diagnostics: [
          runtime.createProcessFailureDiagnostic(
            project.files[0] ?? project.manifestPath,
            tool,
            message,
          ),
        ],
        durationMs: outcome.durationMs,
        notImplemented: false,
        note: message,
        toolRun: runtime.createToolRunResult(
          tool,
          args,
          outcome.durationMs,
          outcome.exitCode,
          "failed",
          outcome.finishedAt,
          outcome.startedAt,
        ),
      };
    }
    let coveragePercent =
      mode === "coverage" ? readLcovLineRate(await readOptionalTextFile(lcovPath)) : undefined;
    let exitCode = outcome.exitCode;

    if (mode === "coverage" && outcome.exitCode === 0 && !(await pathExists(lcovPath))) {
      exitCode = 1;
      coveragePercent = undefined;
      report.diagnostics.push(
        runtime.createProcessFailureDiagnostic(
          project.files[0] ?? project.manifestPath,
          tool,
          `cargo llvm-cov did not produce coverage report at ${lcovPath}.`,
        ),
      );
    }

    const status = exitCode === 0 && report.diagnostics.length === 0 ? "passed" : "failed";

    if (status === "failed" && report.diagnostics.length === 0) {
      report.diagnostics.push(
        runtime.createProcessFailureDiagnostic(
          project.files[0] ?? project.manifestPath,
          tool,
          runtime.readProcessFailureMessage(
            mode === "coverage" ? "cargo llvm-cov" : "cargo test",
            outcome.stderr,
            outcome.stdout,
            outcome.exitCode,
          ),
        ),
      );
    }

    return {
      diagnostics: report.diagnostics,
      durationMs: outcome.durationMs,
      notImplemented: false,
      note:
        mode === "coverage"
          ? readRustCoverageNote(coveragePercent, report.summary)
          : readRustUnitNote(report.summary),
      toolRun: runtime.createToolRunResult(
        tool,
        args,
        outcome.durationMs,
        exitCode,
        status,
        outcome.finishedAt,
        outcome.startedAt,
      ),
    };
  } finally {
    await rm(tempDir, { force: true, recursive: true }).catch(() => undefined);
  }
}
