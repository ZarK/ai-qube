import { realpathSync } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
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
import { findNearestConfig } from "../utils/path-utils.js";
import type { GoRunnerRuntime, SharedMetricsMode } from "./contracts.js";
import {
  createUnsupportedGoRunnerNote,
  getGoMetricsProjectMetrics,
  parseGoCompilerDiagnostics,
  parseGoCoveragePercent,
  parseGoFormatDiagnostics,
  parseGoTestReport,
  parseGoVetDiagnostics,
  readGoCoverageNote,
  readGoUnitNote,
  resolveGoBinary,
  resolveGoProjectSourceFiles,
} from "./go-tools.js";
import {
  createUnsupportedSharedMetricsDiagnostics,
  readUnsupportedSharedMetricsNotes,
} from "./shared-metrics-support.js";

type GoProjectDescriptor = ProjectDescriptor & {
  metadata: ProjectMetadata & {
    kind: "go";
    moduleFilePath: string;
  };
};

export type GoProject = {
  files: string[];
  moduleFilePath: string;
  projectRoot: string;
};

export const goSourceExtensions = new Set([".go"]);
export const goProjectConfigNames = ["go.mod", "go.sum"];

export async function discoverGoProjects(file: string): Promise<ProjectDescriptor[]> {
  const project = await createGoProject(file);
  return project === undefined ? [] : [project];
}

export function selectGoProjects(
  graph: ProjectGraph,
  files: readonly string[],
): { projects: GoProject[]; unsupportedFiles: string[] } {
  const grouped = selectSingleKindProjects(graph, files, "go");

  return {
    projects: grouped.projects.map((project) => ({
      files: project.files,
      moduleFilePath: project.metadata.moduleFilePath,
      projectRoot: project.root,
    })),
    unsupportedFiles: grouped.unsupportedFiles,
  };
}

export function isGoTaskFile(file: string): boolean {
  const extension = path.extname(file).toLowerCase();
  if (goSourceExtensions.has(extension)) {
    return true;
  }

  const baseName = path.basename(file).toLowerCase();
  return goProjectConfigNames.includes(baseName);
}

async function createGoProject(file: string): Promise<GoProjectDescriptor | undefined> {
  const resolvedFile = path.resolve(file);
  if (!isGoTaskFile(resolvedFile)) {
    return undefined;
  }

  const moduleFilePath =
    path.basename(resolvedFile).toLowerCase() === "go.mod"
      ? resolvedFile
      : await findNearestConfig(resolvedFile, "go.mod");
  if (moduleFilePath === undefined) {
    return undefined;
  }

  return {
    ecosystem: "go",
    id: `go:${moduleFilePath}`,
    language: "go",
    manifestFiles: [moduleFilePath],
    metadata: {
      kind: "go",
      moduleFilePath,
    },
    name: readProjectName(path.dirname(moduleFilePath)),
    root: path.dirname(moduleFilePath),
    sourceFiles: [resolvedFile],
  };
}

function getProjectsForKind(graph: ProjectGraph, file: string, kind: "go"): GoProjectDescriptor[] {
  const ids = graph.fileToProjectIds[path.resolve(file)] ?? [];
  const projectsById = new Map(graph.projects.map((project) => [project.id, project]));

  return ids
    .map((id) => projectsById.get(id))
    .filter(
      (project): project is GoProjectDescriptor =>
        project !== undefined && project.metadata.kind === kind,
    );
}

function selectSingleKindProjects(
  graph: ProjectGraph,
  files: readonly string[],
  kind: "go",
): { projects: Array<GoProjectDescriptor & { files: string[] }>; unsupportedFiles: string[] } {
  const groupedFiles = new Map<string, string[]>();
  const unsupportedFiles = new Set<string>();
  const selectedProjectsById = new Map<string, GoProjectDescriptor>();

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
        (project): project is GoProjectDescriptor & { files: string[] } => project !== undefined,
      )
      .sort((left, right) => left.id.localeCompare(right.id)),
    unsupportedFiles: [...unsupportedFiles].sort((left, right) => left.localeCompare(right)),
  };
}

function readProjectName(projectRoot: string): string {
  const baseName = path.basename(projectRoot);
  return baseName.length > 0 ? baseName : projectRoot;
}

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

async function resolveGoProjects(
  graph: ProjectGraph | undefined,
  files: readonly string[],
): Promise<{ projects: GoProject[]; unsupportedFiles: string[] }> {
  if (graph !== undefined) {
    return selectGoProjects(graph, files);
  }

  const projectFiles = new Map<string, string[]>();
  const projectRoots = new Map<string, string>();
  const unsupportedFiles = new Set<string>();

  for (const file of files) {
    const project = await findNearestGoProject(file);
    if (project === undefined) {
      unsupportedFiles.add(file);
      continue;
    }

    const existingFiles = projectFiles.get(project.moduleFilePath);
    if (existingFiles === undefined) {
      projectFiles.set(project.moduleFilePath, [file]);
      projectRoots.set(project.moduleFilePath, project.projectRoot);
      continue;
    }

    existingFiles.push(file);
  }

  return {
    projects: [...projectFiles.entries()]
      .map(([moduleFilePath, selectedFiles]) => ({
        files: [...new Set(selectedFiles)].sort((left, right) => left.localeCompare(right)),
        moduleFilePath,
        projectRoot: projectRoots.get(moduleFilePath) ?? path.dirname(moduleFilePath),
      }))
      .sort((left, right) => left.moduleFilePath.localeCompare(right.moduleFilePath)),
    unsupportedFiles: [...unsupportedFiles].sort((left, right) => left.localeCompare(right)),
  };
}

function createGoProjectResolutionFailureStage(
  stageId: StageResult["stageId"],
  files: readonly string[],
): StageResult {
  const message = createGoProjectResolutionMessage(stageId, files);
  return {
    diagnostics: createGoProjectResolutionDiagnostics(files, message),
    durationMs: 0,
    notes: [message],
    stageId,
    status: "failed",
    toolRuns: [
      { args: [], cacheHit: false, durationMs: 0, status: "failed", tool: "go-unavailable" },
    ],
  };
}

function createGoProjectResolutionDiagnostics(
  files: readonly string[],
  message: string,
): Diagnostic[] {
  return files.map((file) => ({
    file,
    message,
    severity: "error",
    source: "go-unavailable",
  }));
}

function createGoProjectResolutionMessage(
  stageId: StageResult["stageId"],
  files: readonly string[],
): string {
  const baseMessage = createUnsupportedGoRunnerNote(stageId, files);
  return `${baseMessage} Add a go.mod file for the selected Go source, select files inside an existing Go module, or disable Go ${stageId}.`;
}

async function findNearestGoProject(filePath: string): Promise<GoProject | undefined> {
  const resolvedPath = path.resolve(filePath);
  const baseName = path.basename(resolvedPath).toLowerCase();
  if (baseName === "go.mod") {
    return {
      files: [resolvedPath],
      moduleFilePath: resolvedPath,
      projectRoot: path.dirname(resolvedPath),
    };
  }

  if (!isGoTaskFile(resolvedPath)) {
    return undefined;
  }

  const moduleFilePath = await findNearestConfig(resolvedPath, "go.mod");
  if (moduleFilePath === undefined) {
    return undefined;
  }

  return {
    files: [resolvedPath],
    moduleFilePath,
    projectRoot: path.dirname(moduleFilePath),
  };
}

function filterGoFiles(files: readonly string[]): string[] {
  return files.filter((file) => isGoTaskFile(file));
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
      (entry) =>
        entry.normalized === normalized ||
        (entry.realPath !== undefined && entry.realPath === diagnosticRealPath),
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

async function findFileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
