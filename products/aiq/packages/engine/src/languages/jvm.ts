import path from "node:path";

import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";

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
import * as parsers from "../parsers/index.js";
import { resolveProjectConcurrencyLimit } from "../runtime-tunables.js";
import { pathExists } from "../utils/path-utils.js";
import type { JvmRunnerRuntime, SharedMetricsMode } from "./contracts.js";
import {
  createUnsupportedJvmRunnerNote,
  findJvmCoverageReport,
  findJvmJunitReports,
  getJvmMetricsProjectMetrics,
  parseJvmCompilerDiagnostics,
  readJacocoLineRate,
  readJvmCoverageNote,
  readJvmUnitNote,
  resolveJvmExecutionCommand,
  resolveJvmLintOrFormatCommand,
  resolveJvmMetricsFiles,
} from "./jvm-tools.js";
import {
  createUnsupportedSharedMetricsDiagnostics,
  readUnsupportedSharedMetricsNotes,
} from "./shared-metrics-support.js";

type JvmProjectDescriptor = ProjectDescriptor & {
  metadata: ProjectMetadata & {
    buildFilePath: string;
    buildSystem: JvmBuildSystem;
    kind: "jvm";
  };
};

export type JvmBuildSystem = "gradle" | "maven";

export type JvmProject = {
  buildFilePath: string;
  buildSystem: JvmBuildSystem;
  files: string[];
  projectRoot: string;
};

const javaSourceExtensions = new Set([".java"]);
const kotlinSourceExtensions = new Set([".kt"]);
export const jvmSourceExtensions = new Set([...javaSourceExtensions, ...kotlinSourceExtensions]);
export const jvmBuildConfigNames = ["build.gradle.kts", "build.gradle", "pom.xml"];
export const jvmSettingsConfigNames = ["settings.gradle.kts", "settings.gradle"];
export const jvmTaskConfigNames = [...jvmBuildConfigNames, ...jvmSettingsConfigNames];

export async function discoverJvmProjects(file: string): Promise<ProjectDescriptor[]> {
  const project = await createJvmProject(file);
  return project === undefined ? [] : [project];
}

export function selectJvmProjects(
  graph: ProjectGraph,
  files: readonly string[],
): { projects: JvmProject[]; unsupportedFiles: string[] } {
  const grouped = selectSingleKindProjects(graph, files, "jvm");

  return {
    projects: grouped.projects.map((project) => ({
      buildFilePath: project.metadata.buildFilePath,
      buildSystem: project.metadata.buildSystem,
      files: project.files,
      projectRoot: project.root,
    })),
    unsupportedFiles: grouped.unsupportedFiles,
  };
}

export function isJvmTaskFile(file: string): boolean {
  const extension = path.extname(file).toLowerCase();
  if (jvmSourceExtensions.has(extension)) {
    return true;
  }

  const baseName = path.basename(file).toLowerCase();
  return [...jvmBuildConfigNames, ...jvmSettingsConfigNames].includes(baseName);
}

export function readJvmBuildSystem(filePath: string): JvmBuildSystem | undefined {
  const baseName = path.basename(filePath).toLowerCase();
  if (baseName === "pom.xml") {
    return "maven";
  }
  if (baseName === "build.gradle" || baseName === "build.gradle.kts") {
    return "gradle";
  }
  return undefined;
}

async function createJvmProject(file: string): Promise<JvmProjectDescriptor | undefined> {
  const resolvedFile = path.resolve(file);
  if (!isJvmTaskFile(resolvedFile)) {
    return undefined;
  }

  const nearestBuildTarget = await findNearestJvmBuildTarget(resolvedFile);
  if (nearestBuildTarget === undefined) {
    return undefined;
  }

  return {
    ecosystem: "jvm",
    id: `jvm:${nearestBuildTarget.buildFilePath}`,
    language: nearestBuildTarget.buildSystem === "maven" ? "java" : "jvm",
    manifestFiles: [nearestBuildTarget.buildFilePath],
    metadata: {
      buildFilePath: nearestBuildTarget.buildFilePath,
      buildSystem: nearestBuildTarget.buildSystem,
      kind: "jvm",
    },
    name: readProjectName(nearestBuildTarget.projectRoot),
    root: nearestBuildTarget.projectRoot,
    sourceFiles: [resolvedFile],
  };
}

function getProjectsForKind(
  graph: ProjectGraph,
  file: string,
  kind: "jvm",
): JvmProjectDescriptor[] {
  const ids = graph.fileToProjectIds[path.resolve(file)] ?? [];
  const projectsById = new Map(graph.projects.map((project) => [project.id, project]));

  return ids
    .map((id) => projectsById.get(id))
    .filter(
      (project): project is JvmProjectDescriptor =>
        project !== undefined && project.metadata.kind === kind,
    );
}

function selectSingleKindProjects(
  graph: ProjectGraph,
  files: readonly string[],
  kind: "jvm",
): {
  projects: Array<JvmProjectDescriptor & { files: string[] }>;
  unsupportedFiles: string[];
} {
  const groupedFiles = new Map<string, string[]>();
  const unsupportedFiles = new Set<string>();
  const selectedProjectsById = new Map<string, JvmProjectDescriptor>();

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
        (project): project is JvmProjectDescriptor & { files: string[] } => project !== undefined,
      )
      .sort((left, right) => left.id.localeCompare(right.id)),
    unsupportedFiles: [...unsupportedFiles].sort((left, right) => left.localeCompare(right)),
  };
}

function readProjectName(projectRoot: string): string {
  const baseName = path.basename(projectRoot);
  return baseName.length > 0 ? baseName : projectRoot;
}

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
  let notImplementedProjectCount = 0;

  try {
    const resolvedProjects = await resolveJvmProjects(runtime.graph, files);
    unsupportedFiles = resolvedProjects.unsupportedFiles;

    if (resolvedProjects.projects.length === 0) {
      return runtime.createNotImplementedStageResult(
        task.stageId,
        createUnsupportedJvmRunnerNote(task.stageId, unsupportedFiles),
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
      notImplementedProjectCount += projectResult.notImplemented ? 1 : 0;
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
    notes.push(createUnsupportedJvmRunnerNote(task.stageId, unsupportedFiles));
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

export async function runJvmMetricsTask(
  task: PlannedTask,
  runtime: JvmRunnerRuntime,
  mode: SharedMetricsMode,
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
  let totalSloc = 0;
  let totalBlocks = 0;
  let maxComplexity = 0;
  let maxRank = "A";
  let minMaintainability = Number.POSITIVE_INFINITY;
  let minMaintainabilityRank = "A";
  let scannedFileCount = 0;
  let unsupportedFiles: string[] = [];

  try {
    const resolvedProjects = await resolveJvmProjects(runtime.graph, files);
    unsupportedFiles = resolvedProjects.unsupportedFiles;
    const projects = await Promise.all(
      resolvedProjects.projects.map(async (project) => ({
        ...project,
        files: await resolveJvmMetricsFiles(project, runtime),
      })),
    );

    for (const project of projects) {
      if (project.files.length === 0) {
        continue;
      }

      const cachedMetrics = await getJvmMetricsProjectMetrics(project, runtime);
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
      "JVM",
      mode,
      scannedFileCount,
      totalSloc,
      totalBlocks,
      maxComplexity,
      maxRank,
      minMaintainability,
      minMaintainabilityRank,
      "methods",
    ),
  );

  if (toolRuns.some((toolRun) => toolRun.cacheHit)) {
    notes.push("Reused cached JVM metrics for this file batch.");
  }

  unsupportedFiles = task.files.filter(
    (file) => !isJvmTaskFile(file) && !runtime.isSharedMetricsCompanionFile(file),
  );
  if (unsupportedFiles.length > 0) {
    diagnostics.push(
      ...createUnsupportedSharedMetricsDiagnostics(
        unsupportedFiles,
        task.stageId,
        "JVM",
        "Java, Kotlin, or JVM project files",
        runtime.createProcessFailureDiagnostic,
      ),
    );
    notes.push(...readUnsupportedSharedMetricsNotes(unsupportedFiles, task.stageId, "JVM"));
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
  let notImplementedProjectCount = 0;

  try {
    const resolvedProjects = await resolveJvmProjects(runtime.graph, files);
    unsupportedFiles = resolvedProjects.unsupportedFiles;

    if (resolvedProjects.projects.length === 0) {
      return runtime.createNotImplementedStageResult(
        task.stageId,
        createUnsupportedJvmRunnerNote(task.stageId, unsupportedFiles),
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
      notImplementedProjectCount += projectResult.notImplemented ? 1 : 0;
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
    notes.push(createUnsupportedJvmRunnerNote(task.stageId, unsupportedFiles));
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
    return {
      diagnostics: [],
      durationMs: 0,
      notImplemented: true,
      note: `No supported JVM ${mode} command was detected for ${project.projectRoot}.`,
      toolRun: runtime.createToolRunResult("jvm-unavailable", [], 0, undefined, "not_implemented"),
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
  let notImplementedProjectCount = 0;

  try {
    const resolvedProjects = await resolveJvmProjects(runtime.graph, files);
    unsupportedFiles = resolvedProjects.unsupportedFiles;

    if (resolvedProjects.projects.length === 0) {
      return runtime.createNotImplementedStageResult(
        task.stageId,
        createUnsupportedJvmRunnerNote(task.stageId, unsupportedFiles),
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
      notImplementedProjectCount += projectResult.notImplemented ? 1 : 0;
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
    notes.push(createUnsupportedJvmRunnerNote(task.stageId, unsupportedFiles));
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
      return {
        diagnostics: [],
        durationMs: 0,
        notImplemented: true,
        note: `No supported JVM ${mode} command was detected for ${project.projectRoot}.`,
        toolRun: runtime.createToolRunResult(
          "jvm-unavailable",
          [],
          0,
          undefined,
          "not_implemented",
        ),
      };
    }

    const outcome = await runtime.runExecutable(
      command.command,
      command.args,
      project.projectRoot,
      runtime.signal,
      command.env,
    );
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

async function resolveJvmProjects(
  graph: ProjectGraph | undefined,
  files: readonly string[],
): Promise<{ projects: JvmProject[]; unsupportedFiles: string[] }> {
  if (graph !== undefined) {
    return selectJvmProjects(graph, files);
  }

  const projectFiles = new Map<string, string[]>();
  const projectMetadata = new Map<
    string,
    { buildFilePath: string; buildSystem: JvmBuildSystem; projectRoot: string }
  >();
  const unsupportedFiles = new Set<string>();

  for (const file of files) {
    const project = await findNearestJvmProject(file);
    if (project === undefined) {
      unsupportedFiles.add(file);
      continue;
    }

    const existingFiles = projectFiles.get(project.buildFilePath);
    if (existingFiles === undefined) {
      projectFiles.set(project.buildFilePath, [file]);
      projectMetadata.set(project.buildFilePath, project);
      continue;
    }

    existingFiles.push(file);
  }

  return {
    projects: [...projectFiles.entries()]
      .map(([buildFilePath, selectedFiles]) => {
        const metadata = projectMetadata.get(buildFilePath);
        if (metadata === undefined) {
          return undefined;
        }

        return {
          buildFilePath,
          buildSystem: metadata.buildSystem,
          files: [...new Set(selectedFiles)].sort((left, right) => left.localeCompare(right)),
          projectRoot: metadata.projectRoot,
        } satisfies JvmProject;
      })
      .filter((project): project is JvmProject => project !== undefined)
      .sort((left, right) => left.buildFilePath.localeCompare(right.buildFilePath)),
    unsupportedFiles: [...unsupportedFiles].sort((left, right) => left.localeCompare(right)),
  };
}

async function findNearestJvmProject(
  filePath: string,
): Promise<
  { buildFilePath: string; buildSystem: JvmBuildSystem; projectRoot: string } | undefined
> {
  return findNearestJvmBuildTarget(filePath);
}

async function findNearestJvmBuildTarget(
  filePath: string,
): Promise<
  { buildFilePath: string; buildSystem: JvmBuildSystem; projectRoot: string } | undefined
> {
  const resolvedPath = path.resolve(filePath);
  const directBuildSystem = readJvmBuildSystem(resolvedPath);
  if (directBuildSystem !== undefined) {
    return {
      buildFilePath: resolvedPath,
      buildSystem: directBuildSystem,
      projectRoot: path.dirname(resolvedPath),
    };
  }

  let current = path.resolve(path.dirname(resolvedPath));
  const root = path.parse(current).root;
  while (true) {
    for (const configName of jvmBuildConfigNames) {
      const candidate = path.join(current, configName);
      if (!(await pathExists(candidate))) {
        continue;
      }

      const buildSystem = readJvmBuildSystem(candidate);
      if (buildSystem === undefined) {
        continue;
      }

      return {
        buildFilePath: candidate,
        buildSystem,
        projectRoot: current,
      };
    }

    if (current === root) {
      return undefined;
    }

    current = path.dirname(current);
  }
}

function filterJvmFiles(files: readonly string[]): string[] {
  return files.filter((file) => isJvmTaskFile(file));
}

function joinOutputs(...values: string[]): string {
  return values.filter((value) => value.length > 0).join("\n");
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

async function readOptionalTextFile(filePath: string | undefined): Promise<string | undefined> {
  if (filePath === undefined || !(await pathExists(filePath))) {
    return undefined;
  }

  return readFile(filePath, "utf8");
}
