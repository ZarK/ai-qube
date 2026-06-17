import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  Diagnostic,
  PlannedTask,
  ProjectDescriptor,
  ProjectGraph,
  ProjectMetadata,
  StageResult,
  ToolRunResult,
} from "../contracts.js";
import { createLizardMetricsDiagnostics } from "../metrics-thresholds.js";
import { resolveProjectConcurrencyLimit } from "../runtime-tunables.js";
import * as commands from "../tools/command-builders.js";
import { findNearestConfig, pathExists } from "../utils/path-utils.js";
import type { RustRunnerRuntime, SharedMetricsMode } from "./contracts.js";
import {
  createUnsupportedRustRunnerNote,
  getRustMetricsProjectMetrics,
  isMissingCargoSubcommand,
  parseCargoJsonDiagnostics,
  parseRustFormatDiagnostics,
  parseRustTestReport,
  readLcovLineRate,
  readOptionalTextFile,
  readRustCoverageNote,
  readRustUnitNote,
  resolveRustBinary,
  resolveRustProjectSourceFiles,
} from "./rust-tools.js";
import {
  createUnsupportedSharedMetricsDiagnostics,
  readUnsupportedSharedMetricsNotes,
} from "./shared-metrics-support.js";

type RustProjectDescriptor = ProjectDescriptor & {
  metadata: ProjectMetadata & {
    kind: "rust";
    manifestPath: string;
  };
};

export type RustProject = {
  files: string[];
  manifestPath: string;
  projectRoot: string;
};

export const rustSourceExtensions = new Set([".rs"]);
export const rustProjectConfigNames = ["Cargo.toml", "Cargo.lock"];

export async function discoverRustProjects(file: string): Promise<ProjectDescriptor[]> {
  const project = await createRustProject(file);
  return project === undefined ? [] : [project];
}

export function selectRustProjects(
  graph: ProjectGraph,
  files: readonly string[],
): { projects: RustProject[]; unsupportedFiles: string[] } {
  const grouped = selectSingleKindProjects(graph, files, "rust");

  return {
    projects: grouped.projects.map((project) => ({
      files: project.files,
      manifestPath: project.metadata.manifestPath,
      projectRoot: project.root,
    })),
    unsupportedFiles: grouped.unsupportedFiles,
  };
}

export function isRustTaskFile(file: string): boolean {
  const extension = path.extname(file).toLowerCase();
  if (rustSourceExtensions.has(extension)) {
    return true;
  }

  const baseName = path.basename(file);
  return rustProjectConfigNames.includes(baseName);
}

async function createRustProject(file: string): Promise<RustProjectDescriptor | undefined> {
  const resolvedFile = path.resolve(file);
  if (!isRustTaskFile(resolvedFile)) {
    return undefined;
  }

  let manifestPath: string | undefined;
  const baseName = path.basename(resolvedFile);
  if (baseName === "Cargo.toml") {
    manifestPath = resolvedFile;
  } else if (baseName === "Cargo.lock") {
    const candidate = path.join(path.dirname(resolvedFile), "Cargo.toml");
    if (await pathExists(candidate)) {
      manifestPath = candidate;
    }
  } else {
    manifestPath = await findNearestConfig(resolvedFile, "Cargo.toml");
  }

  if (manifestPath === undefined) {
    return undefined;
  }

  return {
    ecosystem: "rust",
    id: `rust:${manifestPath}`,
    language: "rust",
    manifestFiles: [manifestPath],
    metadata: {
      kind: "rust",
      manifestPath,
    },
    name: readProjectName(path.dirname(manifestPath)),
    root: path.dirname(manifestPath),
    sourceFiles: [resolvedFile],
  };
}

function getProjectsForKind(
  graph: ProjectGraph,
  file: string,
  kind: "rust",
): RustProjectDescriptor[] {
  const ids = graph.fileToProjectIds[path.resolve(file)] ?? [];
  const projectsById = new Map(graph.projects.map((project) => [project.id, project]));

  return ids
    .map((id) => projectsById.get(id))
    .filter(
      (project): project is RustProjectDescriptor =>
        project !== undefined && project.metadata.kind === kind,
    );
}

function selectSingleKindProjects(
  graph: ProjectGraph,
  files: readonly string[],
  kind: "rust",
): { projects: Array<RustProjectDescriptor & { files: string[] }>; unsupportedFiles: string[] } {
  const groupedFiles = new Map<string, string[]>();
  const unsupportedFiles = new Set<string>();
  const selectedProjectsById = new Map<string, RustProjectDescriptor>();

  for (const file of files) {
    const project = getProjectsForKind(graph, file, kind)[0];
    if (project === undefined) {
      unsupportedFiles.add(file);
      continue;
    }

    const existingFiles = groupedFiles.get(project.id);
    if (existingFiles === undefined) {
      groupedFiles.set(project.id, [file]);
      selectedProjectsById.set(project.id, project);
      continue;
    }

    existingFiles.push(file);
  }

  return {
    projects: [...groupedFiles.entries()]
      .map(([projectId, selectedFiles]) => {
        const project = selectedProjectsById.get(projectId);
        if (project === undefined) {
          return undefined;
        }

        return {
          ...project,
          files: [...new Set(selectedFiles)].sort((left, right) => left.localeCompare(right)),
        };
      })
      .filter(
        (project): project is RustProjectDescriptor & { files: string[] } => project !== undefined,
      )
      .sort((left, right) => left.id.localeCompare(right.id)),
    unsupportedFiles: [...unsupportedFiles].sort((left, right) => left.localeCompare(right)),
  };
}

function readProjectName(projectRoot: string): string {
  const baseName = path.basename(projectRoot);
  return baseName.length > 0 ? baseName : projectRoot;
}

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
      return runtime.createNotImplementedStageResult(
        task.stageId,
        createUnsupportedRustRunnerNote(task.stageId, unsupportedFiles),
      );
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
    notes.push(createUnsupportedRustRunnerNote(task.stageId, unsupportedFiles));
  }

  return {
    diagnostics,
    durationMs: totalDurationMs,
    notes,
    stageId: task.stageId,
    status:
      diagnostics.length > 0
        ? "failed"
        : unsupportedFiles.length > 0
          ? "not_implemented"
          : "passed",
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
      return runtime.createNotImplementedStageResult(
        task.stageId,
        createUnsupportedRustRunnerNote(task.stageId, unsupportedFiles),
      );
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
    notes.push(createUnsupportedRustRunnerNote(task.stageId, unsupportedFiles));
  }

  return {
    diagnostics,
    durationMs: totalDurationMs,
    notes,
    stageId: task.stageId,
    status:
      diagnostics.length > 0
        ? "failed"
        : unsupportedFiles.length > 0
          ? "not_implemented"
          : "passed",
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
      return runtime.createNotImplementedStageResult(
        task.stageId,
        createUnsupportedRustRunnerNote(task.stageId, unsupportedFiles),
      );
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
    notes.push(createUnsupportedRustRunnerNote(task.stageId, unsupportedFiles));
  }

  return {
    diagnostics,
    durationMs: totalDurationMs,
    notes,
    stageId: task.stageId,
    status:
      diagnostics.length > 0
        ? "failed"
        : unsupportedFiles.length > 0
          ? "not_implemented"
          : "passed",
    toolRuns,
  };
}

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
      "Rust",
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
    notes.push("Reused cached Rust metrics for this file batch.");
  }

  unsupportedFiles = [
    ...new Set([
      ...unsupportedFiles,
      ...task.files.filter(
        (file) => !isRustTaskFile(file) && !runtime.isSharedMetricsCompanionFile(file),
      ),
    ]),
  ].sort((left, right) => left.localeCompare(right));
  if (unsupportedFiles.length > 0) {
    diagnostics.push(
      ...createUnsupportedSharedMetricsDiagnostics(
        unsupportedFiles,
        task.stageId,
        "Rust",
        "Rust files or Cargo project files",
        runtime.createProcessFailureDiagnostic,
      ),
    );
    notes.push(...readUnsupportedSharedMetricsNotes(unsupportedFiles, task.stageId, "Rust"));
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
  let notImplementedProjectCount = 0;
  let unsupportedFiles: string[] = [];

  try {
    const resolvedProjects = await resolveRustProjects(runtime.graph, files);
    unsupportedFiles = resolvedProjects.unsupportedFiles;

    if (resolvedProjects.projects.length === 0) {
      return runtime.createNotImplementedStageResult(
        task.stageId,
        createUnsupportedRustRunnerNote(task.stageId, unsupportedFiles),
      );
    }

    const projectResults = await runProjectBatches(resolvedProjects.projects, async (project) =>
      runRustProjectTestTask(project, mode, runtime),
    );

    for (const projectResult of projectResults) {
      totalDurationMs += projectResult.durationMs;
      diagnostics.push(...projectResult.diagnostics);
      notes.push(projectResult.note);
      toolRuns.push(projectResult.toolRun);
      notImplementedProjectCount += projectResult.notImplemented ? 1 : 0;
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
    notes.push(createUnsupportedRustRunnerNote(task.stageId, unsupportedFiles));
  }

  return {
    diagnostics,
    durationMs: totalDurationMs,
    notes,
    stageId: task.stageId,
    status:
      diagnostics.length > 0
        ? "failed"
        : unsupportedFiles.length > 0 || notImplementedProjectCount > 0
          ? "not_implemented"
          : "passed",
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
      return {
        diagnostics: [],
        durationMs: outcome.durationMs,
        notImplemented: true,
        note: "Rust coverage requires the cargo-llvm-cov subcommand. Install it with `cargo install cargo-llvm-cov` to enable stage 8.",
        toolRun: runtime.createToolRunResult(
          tool,
          args,
          outcome.durationMs,
          outcome.exitCode,
          "not_implemented",
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

async function resolveRustProjects(
  graph: ProjectGraph | undefined,
  files: readonly string[],
): Promise<{ projects: RustProject[]; unsupportedFiles: string[] }> {
  if (graph !== undefined) {
    return selectRustProjects(graph, files);
  }

  const projectFiles = new Map<string, string[]>();
  const projectRoots = new Map<string, string>();
  const unsupportedFiles = new Set<string>();

  for (const file of files) {
    const project = await findNearestRustProject(file);
    if (project === undefined) {
      unsupportedFiles.add(file);
      continue;
    }

    const existingFiles = projectFiles.get(project.manifestPath);
    if (existingFiles === undefined) {
      projectFiles.set(project.manifestPath, [file]);
      projectRoots.set(project.manifestPath, project.projectRoot);
      continue;
    }

    existingFiles.push(file);
  }

  return {
    projects: [...projectFiles.entries()]
      .map(([manifestPath, selectedFiles]) => ({
        files: [...new Set(selectedFiles)].sort((left, right) => left.localeCompare(right)),
        manifestPath,
        projectRoot: projectRoots.get(manifestPath) ?? path.dirname(manifestPath),
      }))
      .sort((left, right) => left.manifestPath.localeCompare(right.manifestPath)),
    unsupportedFiles: [...unsupportedFiles].sort((left, right) => left.localeCompare(right)),
  };
}

async function findNearestRustProject(filePath: string): Promise<RustProject | undefined> {
  const resolvedPath = path.resolve(filePath);
  const baseName = path.basename(resolvedPath);
  if (baseName === "Cargo.toml") {
    return {
      files: [resolvedPath],
      manifestPath: resolvedPath,
      projectRoot: path.dirname(resolvedPath),
    };
  }

  if (baseName === "Cargo.lock") {
    const manifestPath = path.join(path.dirname(resolvedPath), "Cargo.toml");
    if (!(await pathExists(manifestPath))) {
      return undefined;
    }

    return {
      files: [resolvedPath],
      manifestPath,
      projectRoot: path.dirname(manifestPath),
    };
  }

  if (!isRustTaskFile(resolvedPath)) {
    return undefined;
  }

  const manifestPath = await findNearestConfig(resolvedPath, "Cargo.toml");
  if (manifestPath === undefined) {
    return undefined;
  }

  return {
    files: [resolvedPath],
    manifestPath,
    projectRoot: path.dirname(manifestPath),
  };
}

function filterRustFiles(files: readonly string[]): string[] {
  return files.filter((file) => isRustTaskFile(file));
}

async function runProjectBatches<TProject, TResult>(
  projects: readonly TProject[],
  runProject: (project: TProject) => Promise<TResult>,
  concurrencyLimit = resolveProjectConcurrencyLimit(),
): Promise<TResult[]> {
  const results: TResult[] = [];

  for (let index = 0; index < projects.length; index += concurrencyLimit) {
    const projectBatch = projects.slice(index, index + concurrencyLimit);
    results.push(...(await Promise.all(projectBatch.map((project) => runProject(project)))));
  }

  return results;
}

function normalizeDiagnosticsToSelection(
  diagnostics: readonly Diagnostic[],
  selectedFiles: readonly string[],
): Diagnostic[] {
  if (diagnostics.length === 0 || selectedFiles.length === 0) {
    return [...diagnostics];
  }

  const selectedPaths = selectedFiles.map((file) => ({
    file,
    normalized: path.normalize(file),
    realPath: tryRealpath(file),
  }));

  return diagnostics.map((diagnostic) => {
    const normalized = path.normalize(diagnostic.file);
    const diagnosticRealPath = tryRealpath(diagnostic.file);
    const directMatch = selectedPaths.find(
      (entry) => entry.normalized === normalized || entry.realPath === diagnosticRealPath,
    );
    if (directMatch === undefined || directMatch.file === diagnostic.file) {
      return diagnostic;
    }

    return { ...diagnostic, file: directMatch.file };
  });
}

function tryRealpath(filePath: string): string | undefined {
  try {
    return realpathSync.native(filePath);
  } catch {
    return undefined;
  }
}

function joinOutputs(...values: string[]): string {
  return values.filter((value) => value.length > 0).join("\n");
}
