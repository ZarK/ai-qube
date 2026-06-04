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
import { createPythonMetricsDiagnostics } from "../metrics-thresholds.js";
import * as parsers from "../parsers/index.js";
import { resolveProjectConcurrencyLimit } from "../runtime-tunables.js";
import { findNearestAnyConfig, pathExists } from "../utils/path-utils.js";
import type { PythonRunnerRuntime, SharedMetricsMode } from "./contracts.js";
import {
  type PythonProjectExecution,
  executePytestProjectTask,
  getPythonMetricsProjectMetrics,
  runRuffCheckProject,
  runRuffFormatProject,
  runTyCheckProject,
} from "./python-tools.js";

type PythonProjectDescriptor = ProjectDescriptor & {
  metadata: ProjectMetadata & {
    kind: "python";
  };
};

export type PythonProject = {
  files: string[];
  projectRoot: string;
};

export const pythonTaskExtensions = new Set([".py", ".pyi"]);

export const pythonProjectConfigNames = [
  "pyproject.toml",
  "requirements.txt",
  "pytest.ini",
  "tox.ini",
  "setup.cfg",
  "mypy.ini",
  ".mypy.ini",
  "ruff.toml",
  ".ruff.toml",
];

export const pythonTaskConfigNames = pythonProjectConfigNames.filter(
  (configName) => configName !== "requirements.txt",
);

export async function discoverPythonProjects(file: string): Promise<ProjectDescriptor[]> {
  const project = await createPythonProject(file);
  return project === undefined ? [] : [project];
}

export function selectPythonProjects(
  graph: ProjectGraph,
  files: readonly string[],
): PythonProject[] {
  return selectSingleKindProjects(graph, files, "python").projects.map((project) => ({
    files: project.files,
    projectRoot: project.root,
  }));
}

export async function runPythonLintTask(
  task: PlannedTask,
  runtime: PythonRunnerRuntime,
): Promise<StageResult> {
  const files = filterPythonTaskFiles(task.files);
  if (files.length === 0) {
    return runtime.createNoopStageResult(task.stageId, "No Python files were selected for lint.");
  }

  const diagnostics = [] as Awaited<ReturnType<typeof runRuffCheckProject>>["diagnostics"];
  const toolRuns = [] as StageResult["toolRuns"];
  let totalDurationMs = 0;

  try {
    const projects = await resolvePythonProjects(runtime.graph, files);
    const projectResults = await runProjectBatches(projects, async (project) =>
      runRuffCheckProject(await resolvePythonSourceProject(project, runtime), runtime),
    );

    for (const projectResult of projectResults) {
      totalDurationMs += projectResult.durationMs;
      diagnostics.push(...projectResult.diagnostics);
      toolRuns.push(projectResult.toolRun);
    }
  } catch (error) {
    runtime.throwIfAbortError(error);
    return runtime.createExecutionFailureStage(
      task.stageId,
      "ruff",
      files[0] ?? runtime.cwd,
      error,
      totalDurationMs,
      diagnostics,
      toolRuns,
    );
  }

  const status = diagnostics.length === 0 ? "passed" : "failed";

  return {
    diagnostics,
    durationMs: totalDurationMs,
    notes:
      status === "passed"
        ? ["Ruff lint passed."]
        : [`Ruff reported ${diagnostics.length} diagnostic${diagnostics.length === 1 ? "" : "s"}.`],
    stageId: task.stageId,
    status,
    toolRuns,
  };
}

export async function runPythonFormatTask(
  task: PlannedTask,
  runtime: PythonRunnerRuntime,
): Promise<StageResult> {
  const files = filterPythonTaskFiles(task.files);
  if (files.length === 0) {
    return runtime.createNoopStageResult(task.stageId, "No Python files were selected for format.");
  }

  const diagnostics = [] as Awaited<ReturnType<typeof runRuffFormatProject>>["diagnostics"];
  const toolRuns = [] as StageResult["toolRuns"];
  let totalDurationMs = 0;

  try {
    const projects = await resolvePythonProjects(runtime.graph, files);
    const projectResults = await runProjectBatches(projects, async (project) =>
      runRuffFormatProject(await resolvePythonSourceProject(project, runtime), runtime),
    );

    for (const projectResult of projectResults) {
      totalDurationMs += projectResult.durationMs;
      diagnostics.push(...projectResult.diagnostics);
      toolRuns.push(projectResult.toolRun);
    }
  } catch (error) {
    runtime.throwIfAbortError(error);
    return runtime.createExecutionFailureStage(
      task.stageId,
      "ruff",
      files[0] ?? runtime.cwd,
      error,
      totalDurationMs,
      diagnostics,
      toolRuns,
    );
  }

  const status = diagnostics.length === 0 ? "passed" : "failed";

  return {
    diagnostics,
    durationMs: totalDurationMs,
    notes:
      status === "passed"
        ? ["Ruff format passed."]
        : [
            `Ruff reported ${diagnostics.length} formatting diagnostic${diagnostics.length === 1 ? "" : "s"}.`,
          ],
    stageId: task.stageId,
    status,
    toolRuns,
  };
}

export async function runPythonTypecheckTask(
  task: PlannedTask,
  runtime: PythonRunnerRuntime,
): Promise<StageResult> {
  const files = filterPythonTaskFiles(task.files);
  if (files.length === 0) {
    return runtime.createNoopStageResult(
      task.stageId,
      "No Python files were selected for typecheck.",
    );
  }

  const diagnostics = [] as Awaited<ReturnType<typeof runTyCheckProject>>["diagnostics"];
  const toolRuns = [] as StageResult["toolRuns"];
  let totalDurationMs = 0;

  try {
    const projects = await resolvePythonProjects(runtime.graph, files);
    const projectResults = await runProjectBatches(projects, async (project) =>
      runTyCheckProject(await resolvePythonSourceProject(project, runtime), runtime),
    );

    for (const projectResult of projectResults) {
      totalDurationMs += projectResult.durationMs;
      diagnostics.push(...projectResult.diagnostics);
      toolRuns.push(projectResult.toolRun);
    }
  } catch (error) {
    runtime.throwIfAbortError(error);
    return runtime.createExecutionFailureStage(
      task.stageId,
      "ty",
      files[0] ?? runtime.cwd,
      error,
      totalDurationMs,
      diagnostics,
      toolRuns,
    );
  }

  const status = diagnostics.length === 0 ? "passed" : "failed";

  return {
    diagnostics,
    durationMs: totalDurationMs,
    notes:
      status === "passed"
        ? [`ty typecheck passed for ${toolRuns.length} project${toolRuns.length === 1 ? "" : "s"}.`]
        : [`ty reported ${diagnostics.length} diagnostic${diagnostics.length === 1 ? "" : "s"}.`],
    stageId: task.stageId,
    status,
    toolRuns,
  };
}

export async function runPythonUnitTask(
  task: PlannedTask,
  runtime: PythonRunnerRuntime,
): Promise<StageResult> {
  return runPythonTestStage(task, runtime, "unit");
}

export async function runPythonCoverageTask(
  task: PlannedTask,
  runtime: PythonRunnerRuntime,
): Promise<StageResult> {
  return runPythonTestStage(task, runtime, "coverage");
}

export async function runPythonComplexityTask(
  task: PlannedTask,
  runtime: PythonRunnerRuntime,
): Promise<StageResult> {
  return runPythonMetricsTask(task, runtime, "complexity");
}

export async function runPythonSlocTask(
  task: PlannedTask,
  runtime: PythonRunnerRuntime,
): Promise<StageResult> {
  return runPythonMetricsTask(task, runtime, "sloc");
}

export async function runPythonMaintainabilityTask(
  task: PlannedTask,
  runtime: PythonRunnerRuntime,
): Promise<StageResult> {
  return runPythonMetricsTask(task, runtime, "maintainability");
}

async function runPythonTestStage(
  task: PlannedTask,
  runtime: PythonRunnerRuntime,
  mode: "coverage" | "unit",
): Promise<StageResult> {
  const files = filterPythonTaskFiles(task.files);
  if (files.length === 0) {
    return runtime.createNoopStageResult(
      task.stageId,
      `No Python files were selected for ${task.stageId}.`,
    );
  }

  const diagnostics: StageResult["diagnostics"] = [];
  const notes: string[] = [];
  const toolRuns: StageResult["toolRuns"] = [];
  let totalDurationMs = 0;
  const stageTempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-python-stage-"));

  try {
    const projectResults = await runProjectBatches(
      await resolvePythonProjects(runtime.graph, files),
      async (project, projectIndex) =>
        runPythonProjectTestTask(project, runtime, mode, stageTempDir, projectIndex),
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
      mode === "coverage" ? "pytest-cov" : "pytest",
      files[0] ?? runtime.cwd,
      error,
      totalDurationMs,
      diagnostics,
      toolRuns,
    );
  } finally {
    await rm(stageTempDir, { force: true, recursive: true }).catch(() => undefined);
  }

  return {
    diagnostics,
    durationMs: totalDurationMs,
    notes,
    stageId: task.stageId,
    status: diagnostics.length === 0 ? "passed" : "failed",
    toolRuns,
  };
}

async function runPythonProjectTestTask(
  project: PythonProject,
  runtime: PythonRunnerRuntime,
  mode: "coverage" | "unit",
  stageTempDir: string,
  projectIndex: number,
): Promise<{
  diagnostics: StageResult["diagnostics"];
  durationMs: number;
  note: string;
  toolRun: ToolRunResult;
}> {
  const allowCoverageReuse =
    runtime.selectedStages.includes("unit") && runtime.selectedStages.includes("coverage");
  const cacheKey = createPythonProjectExecutionKey(project);
  const cachedExecution = allowCoverageReuse
    ? runtime.getRunScopedValue<PythonProjectExecution>("python:test-execution", cacheKey)
    : undefined;
  if (allowCoverageReuse && cachedExecution !== undefined) {
    return materializePythonProjectStageResult(cachedExecution, mode, true);
  }

  const preferCoverageExecution = allowCoverageReuse && mode === "unit";
  const preferredMode = preferCoverageExecution ? "coverage" : mode;
  const execution = await executePytestProjectTask(
    project,
    runtime,
    preferredMode,
    stageTempDir,
    projectIndex,
  );

  if (
    allowCoverageReuse &&
    execution.coverageSummaryError === undefined &&
    !isPythonCoverageOnlyFailure(execution) &&
    preferredMode === "coverage"
  ) {
    runtime.setRunScopedValue("python:test-execution", cacheKey, execution);
  }

  if (shouldFallbackToPlainPythonUnit(preferCoverageExecution, execution)) {
    return materializePythonProjectStageResult(
      await executePytestProjectTask(project, runtime, "unit", stageTempDir, projectIndex),
      "unit",
      false,
    );
  }

  return materializePythonProjectStageResult(execution, mode, false);
}

function materializePythonProjectStageResult(
  execution: PythonProjectExecution,
  mode: "coverage" | "unit",
  cacheHit: boolean,
): {
  diagnostics: StageResult["diagnostics"];
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
        ? readPythonCoverageNote(execution.coverageSummary, execution.summary)
        : readPythonUnitNote(execution.summary),
    toolRun: parsers.cloneToolRunResult(execution.toolRun, cacheHit),
  };
}

function shouldFallbackToPlainPythonUnit(
  preferCoverageExecution: boolean,
  execution: PythonProjectExecution,
): boolean {
  return (
    preferCoverageExecution &&
    (execution.coverageSummaryError !== undefined || isPythonCoverageOnlyFailure(execution))
  );
}

function isPythonCoverageOnlyFailure(execution: PythonProjectExecution): boolean {
  return execution.toolRun.status === "failed" && execution.summary.failed === 0;
}

async function runPythonMetricsTask(
  task: PlannedTask,
  runtime: PythonRunnerRuntime,
  mode: SharedMetricsMode,
): Promise<StageResult> {
  const files = filterPythonTaskFiles(task.files);
  if (files.length === 0) {
    if (task.files.some((file) => runtime.isSharedMetricsCompanionFile(file))) {
      return runtime.createNoopStageResult(
        task.stageId,
        `No Python files were selected for ${task.stageId}.`,
      );
    }

    return runtime.createNotImplementedStageResult(
      task.stageId,
      runtime.createSharedMetricsNotImplementedNote(task.stageId),
    );
  }

  const unsupportedFiles = task.files.filter((file) => {
    return !isPythonTaskFile(file) && !runtime.isSharedMetricsCompanionFile(file);
  });
  const diagnostics: Diagnostic[] = [];
  const notes: string[] = [];
  const toolRuns: StageResult["toolRuns"] = [];
  let totalDurationMs = 0;
  let totalSloc = 0;
  let totalBlocks = 0;
  let maxComplexity = 0;
  let maxRank = "A";
  let minMaintainability = Number.POSITIVE_INFINITY;
  let minMaintainabilityRank = "A";
  let scannedFileCount = 0;

  try {
    const projects = await resolvePythonProjects(runtime.graph, files);
    for (const project of projects) {
      const cachedMetrics = await getPythonMetricsProjectMetrics(
        await resolvePythonSourceProject(project, runtime),
        runtime,
      );
      totalDurationMs += cachedMetrics.cacheHit ? 0 : cachedMetrics.metrics.durationMs;
      scannedFileCount += Object.keys(cachedMetrics.metrics.files).length;
      toolRuns.push(
        runtime.createToolRunResult(
          "radon",
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
        totalBlocks += fileMetrics.cc.length;
        for (const block of fileMetrics.cc) {
          if (block.complexity > maxComplexity) {
            maxComplexity = block.complexity;
            maxRank = block.rank;
          }
        }

        if (fileMetrics.mi.score < minMaintainability) {
          minMaintainability = fileMetrics.mi.score;
          minMaintainabilityRank = fileMetrics.mi.rank;
        }
      }
      diagnostics.push(
        ...createPythonMetricsDiagnostics(cachedMetrics.metrics.files, mode, "radon"),
      );
    }
  } catch (error) {
    runtime.throwIfAbortError(error);
    return runtime.createExecutionFailureStage(
      task.stageId,
      "radon",
      files[0] ?? runtime.cwd,
      error,
      totalDurationMs,
      diagnostics,
      toolRuns,
    );
  }

  notes.push(
    runtime.readSharedMetricsNote(
      "Python",
      mode,
      scannedFileCount,
      totalSloc,
      totalBlocks,
      maxComplexity,
      maxRank,
      minMaintainability,
      minMaintainabilityRank,
      "functions or classes",
    ),
  );

  if (toolRuns.some((toolRun) => toolRun.cacheHit)) {
    notes.push("Reused cached Python metrics for this file batch.");
  }

  if (unsupportedFiles.length > 0) {
    notes.push(
      `Stage '${task.stageId}' is not implemented yet for non-Python files in this selection: ${unsupportedFiles.join(", ")}.`,
    );
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

async function createPythonProject(file: string): Promise<PythonProjectDescriptor | undefined> {
  const resolvedFile = path.resolve(file);
  if (!isPythonTaskFile(resolvedFile)) {
    return undefined;
  }

  const configPath = await resolvePythonProjectConfigPath(resolvedFile);
  const projectRoot =
    configPath === undefined ? path.dirname(resolvedFile) : path.dirname(configPath);

  return {
    ecosystem: "python",
    id: `python:${projectRoot}`,
    language: "python",
    manifestFiles: configPath === undefined ? [] : [configPath],
    metadata: {
      kind: "python",
    },
    name: readProjectName(projectRoot),
    root: projectRoot,
    sourceFiles: isPythonSourceFile(resolvedFile) ? [resolvedFile] : [],
  };
}

async function resolvePythonProjects(
  graph: ProjectGraph | undefined,
  files: readonly string[],
): Promise<PythonProject[]> {
  if (graph !== undefined) {
    return selectPythonProjects(graph, files);
  }

  const projectFiles = new Map<string, string[]>();

  for (const file of files) {
    const resolvedFile = path.resolve(file);
    const configPath = await resolvePythonProjectConfigPath(resolvedFile);
    const projectRoot =
      configPath === undefined ? path.dirname(resolvedFile) : path.dirname(configPath);
    const existingFiles = projectFiles.get(projectRoot);
    if (existingFiles === undefined) {
      projectFiles.set(projectRoot, [resolvedFile]);
      continue;
    }

    existingFiles.push(resolvedFile);
  }

  return [...projectFiles.entries()]
    .map(([projectRoot, projectRootFiles]) => ({
      files: [...projectRootFiles].sort((left, right) => left.localeCompare(right)),
      projectRoot,
    }))
    .sort((left, right) => left.projectRoot.localeCompare(right.projectRoot));
}

function filterPythonTaskFiles(files: readonly string[]): string[] {
  return files.filter((file) => isPythonTaskFile(file));
}

async function resolvePythonSourceProject(
  project: PythonProject,
  runtime: PythonRunnerRuntime,
): Promise<PythonProject> {
  const selectedSourceFiles = project.files.filter((file) => isPythonSourceFile(file));
  if (selectedSourceFiles.length > 0) {
    return {
      files: [...new Set(selectedSourceFiles)].sort((left, right) => left.localeCompare(right)),
      projectRoot: project.projectRoot,
    };
  }

  const discoveredSourceFiles = await runtime.findMatchingFiles(
    project.projectRoot,
    (filePath) => isPythonSourceFile(filePath),
    runtime.shouldSkipProjectDirectory,
  );

  return {
    files: discoveredSourceFiles,
    projectRoot: project.projectRoot,
  };
}

function isPythonConfigFile(file: string): boolean {
  return pythonTaskConfigNames.includes(path.basename(file).toLowerCase());
}

function isPythonSourceFile(file: string): boolean {
  return pythonTaskExtensions.has(path.extname(file).toLowerCase());
}

function isPythonTaskFile(file: string): boolean {
  return isPythonSourceFile(file) || isPythonConfigFile(file);
}

async function resolvePythonProjectConfigPath(file: string): Promise<string | undefined> {
  if (isPythonConfigFile(file)) {
    return file;
  }

  const configDirectory = await findNearestAnyConfig(file, pythonProjectConfigNames);
  if (configDirectory === undefined) {
    return undefined;
  }

  for (const configName of pythonProjectConfigNames) {
    const configPath = path.join(configDirectory, configName);
    if (await pathExists(configPath)) {
      return configPath;
    }
  }

  return undefined;
}

function createPythonProjectExecutionKey(project: PythonProject): string {
  return `${project.projectRoot}:${[...project.files].sort().join("|")}`;
}

function readPythonUnitNote(summary: { failed: number; passed: number; total: number }): string {
  if (summary.total === 0) {
    return "Pytest found no tests.";
  }

  return `Pytest ran ${summary.total} test${summary.total === 1 ? "" : "s"}: ${summary.passed} passed, ${summary.failed} failed.`;
}

function readPythonCoverageNote(
  coverageSummary: Record<string, unknown> | undefined,
  summary: { failed: number; passed: number; total: number },
): string {
  if (summary.total === 0) {
    return "Pytest found no tests.";
  }

  const totalCoverage = readCoverageMetric(coverageSummary, "totals", "percent_covered");
  if (totalCoverage === undefined) {
    return `Pytest coverage completed after ${summary.total} test${summary.total === 1 ? "" : "s"}.`;
  }

  return `Pytest coverage lines: ${totalCoverage.toFixed(1)}% across ${summary.total} test${summary.total === 1 ? "" : "s"}.`;
}

function readCoverageMetric(
  summary: Record<string, unknown> | undefined,
  ...keys: string[]
): number | undefined {
  if (summary === undefined) {
    return undefined;
  }

  const value = parsers.readNestedValue(summary, keys);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getProjectsForKind(
  graph: ProjectGraph,
  file: string,
  kind: "python",
): PythonProjectDescriptor[] {
  const ids = graph.fileToProjectIds[path.resolve(file)] ?? [];
  const projectsById = new Map(graph.projects.map((project) => [project.id, project]));

  return ids
    .map((id) => projectsById.get(id))
    .filter(
      (project): project is PythonProjectDescriptor =>
        project !== undefined && project.metadata.kind === kind,
    );
}

function selectSingleKindProjects(
  graph: ProjectGraph,
  files: readonly string[],
  kind: "python",
): {
  projects: Array<PythonProjectDescriptor & { files: string[] }>;
  unsupportedFiles: string[];
} {
  const groupedFiles = new Map<string, string[]>();
  const unsupportedFiles = new Set<string>();
  const selectedProjectsById = new Map<string, PythonProjectDescriptor>();

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
        (project): project is PythonProjectDescriptor & { files: string[] } =>
          project !== undefined,
      )
      .sort((left, right) => left.id.localeCompare(right.id)),
    unsupportedFiles: [...unsupportedFiles].sort((left, right) => left.localeCompare(right)),
  };
}

async function runProjectBatches<TProject, TResult>(
  projects: readonly TProject[],
  runProject: (project: TProject, index: number) => Promise<TResult>,
  concurrencyLimit = resolveProjectConcurrencyLimit(),
): Promise<TResult[]> {
  const results: TResult[] = [];

  for (let index = 0; index < projects.length; index += concurrencyLimit) {
    const projectBatch = projects.slice(index, index + concurrencyLimit);
    results.push(
      ...(await Promise.all(
        projectBatch.map((project, batchIndex) => runProject(project, index + batchIndex)),
      )),
    );
  }

  return results;
}

function readProjectName(projectRoot: string): string {
  const baseName = path.basename(projectRoot);
  return baseName.length > 0 ? baseName : projectRoot;
}
