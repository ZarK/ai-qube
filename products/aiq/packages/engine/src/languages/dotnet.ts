import { readFile, readdir } from "node:fs/promises";
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
import { createFileMetricDiagnostics } from "../metrics-thresholds.js";
import { resolveProjectConcurrencyLimit } from "../runtime-tunables.js";
import { pathExists } from "../utils/path-utils.js";
import type { DotNetRunnerRuntime, SharedMetricsMode } from "./contracts.js";
import {
  createUnsupportedDotNetRunnerNote,
  getDotNetMetricsProjectMetrics,
  runDotNetFormatProject,
  runDotNetProjectTestTask,
  runDotNetTypecheckProject,
} from "./dotnet-tools.js";
import {
  createUnsupportedSharedMetricsDiagnostics,
  readUnsupportedSharedMetricsNotes,
} from "./shared-metrics-support.js";

type DotNetProjectDescriptor = ProjectDescriptor & {
  metadata: ProjectMetadata & {
    kind: "dotnet-project-target" | "dotnet-solution-target";
    targetPath: string;
    targetType: "project" | "solution";
  };
};

export type DotNetTargetPreference = "prefer-project" | "prefer-solution";

export type DotNetProject = {
  files: string[];
  projectRoot: string;
  targetPath: string;
};

export const dotNetSourceExtensions = new Set([".cs"]);
export const dotNetProjectExtensions = new Set([".csproj", ".sln", ".slnx"]);
export const dotNetExtensions = new Set([...dotNetSourceExtensions, ...dotNetProjectExtensions]);

export async function discoverDotNetProjects(file: string): Promise<ProjectDescriptor[]> {
  return createDotNetProjects(file);
}

export function selectDotNetProjects(
  graph: ProjectGraph,
  files: readonly string[],
  targetPreference: DotNetTargetPreference,
): { projects: DotNetProject[]; unsupportedFiles: string[] } {
  const projectFiles = new Map<string, string[]>();
  const projectRoots = new Map<string, string>();
  const unsupportedFiles = new Set<string>();

  for (const file of files) {
    const candidates = getProjectsForKinds(graph, file, [
      "dotnet-project-target",
      "dotnet-solution-target",
    ]);
    const preferred =
      targetPreference === "prefer-project"
        ? (getDotNetProjectTarget(candidates) ?? getDotNetSolutionTarget(candidates))
        : (getDotNetSolutionTarget(candidates) ?? getDotNetProjectTarget(candidates));
    if (preferred === undefined) {
      unsupportedFiles.add(file);
      continue;
    }

    const projectRootFiles = projectFiles.get(preferred.metadata.targetPath);
    if (projectRootFiles === undefined) {
      projectFiles.set(preferred.metadata.targetPath, [file]);
      projectRoots.set(preferred.metadata.targetPath, preferred.root);
      continue;
    }

    projectRootFiles.push(file);
  }

  return {
    projects: [...projectFiles.entries()]
      .map(([targetPath, selectedFiles]) => ({
        files: [...new Set(selectedFiles)].sort((left, right) => left.localeCompare(right)),
        projectRoot: projectRoots.get(targetPath) ?? path.dirname(targetPath),
        targetPath,
      }))
      .sort((left, right) => left.targetPath.localeCompare(right.targetPath)),
    unsupportedFiles: [...unsupportedFiles].sort((left, right) => left.localeCompare(right)),
  };
}

async function createDotNetProjects(file: string): Promise<ProjectDescriptor[]> {
  const resolvedFile = path.resolve(file);
  const extension = path.extname(resolvedFile).toLowerCase();
  if (!dotNetExtensions.has(extension)) {
    return [];
  }

  let projectPath: string | undefined;
  let solutionPath: string | undefined;

  if (extension === ".sln" || extension === ".slnx") {
    solutionPath = resolvedFile;
  } else if (extension === ".csproj") {
    projectPath = resolvedFile;
    solutionPath = await findNearestDotNetOwningSolution(resolvedFile);
  } else if (extension === ".cs") {
    projectPath = await findNearestMatchingEntry(resolvedFile, (entryName) =>
      entryName.endsWith(".csproj"),
    );
    if (projectPath !== undefined) {
      solutionPath = await findNearestDotNetOwningSolution(projectPath);
    }
  }

  const projects: DotNetProjectDescriptor[] = [];

  if (projectPath !== undefined) {
    projects.push({
      ecosystem: "dotnet",
      id: `dotnet-project:${projectPath}`,
      language: "csharp",
      manifestFiles: [projectPath],
      metadata: {
        kind: "dotnet-project-target",
        targetPath: projectPath,
        targetType: "project",
      },
      name: readProjectName(path.dirname(projectPath)),
      root: path.dirname(projectPath),
      sourceFiles: [resolvedFile],
    });
  }

  if (solutionPath !== undefined) {
    projects.push({
      ecosystem: "dotnet",
      id: `dotnet-solution:${solutionPath}`,
      language: "csharp",
      manifestFiles: [solutionPath],
      metadata: {
        kind: "dotnet-solution-target",
        targetPath: solutionPath,
        targetType: "solution",
      },
      name: readProjectName(path.dirname(solutionPath)),
      root: path.dirname(solutionPath),
      sourceFiles: [resolvedFile],
    });
  }

  return projects;
}

function getDotNetProjectTarget(
  projects: DotNetProjectDescriptor[],
): DotNetProjectDescriptor | undefined {
  return projects.find((project) => project.metadata.kind === "dotnet-project-target");
}

function getDotNetSolutionTarget(
  projects: DotNetProjectDescriptor[],
): DotNetProjectDescriptor | undefined {
  return projects.find((project) => project.metadata.kind === "dotnet-solution-target");
}

function getProjectsForKinds(
  graph: ProjectGraph,
  file: string,
  kinds: readonly DotNetProjectDescriptor["metadata"]["kind"][],
): DotNetProjectDescriptor[] {
  const ids = graph.fileToProjectIds[path.resolve(file)] ?? [];
  const projectsById = new Map(graph.projects.map((project) => [project.id, project]));

  return ids
    .map((id) => projectsById.get(id))
    .filter(
      (project): project is DotNetProjectDescriptor =>
        project !== undefined &&
        (project.metadata.kind === "dotnet-project-target" ||
          project.metadata.kind === "dotnet-solution-target") &&
        kinds.includes(project.metadata.kind),
    );
}

async function findNearestDotNetOwningSolution(projectPath: string): Promise<string | undefined> {
  let current = path.resolve(path.dirname(projectPath));
  const root = path.parse(current).root;
  const normalizedProjectPath = path.normalize(path.resolve(projectPath));

  while (true) {
    const entries = await readDirectoryEntries(current);
    if (entries === undefined) {
      return undefined;
    }

    const candidates = entries
      .filter(
        (entry) => entry.isFile() && (entry.name.endsWith(".sln") || entry.name.endsWith(".slnx")),
      )
      .map((entry) => path.join(current, entry.name))
      .sort((left, right) => compareDotNetTargetPaths(left, right));
    for (const candidate of candidates) {
      const solutionProjectPaths = await readDotNetSolutionProjectPaths(candidate);
      if (
        solutionProjectPaths.some(
          (solutionProjectPath) =>
            path.normalize(path.resolve(solutionProjectPath)) === normalizedProjectPath,
        )
      ) {
        return candidate;
      }
    }

    if (current === root) {
      return undefined;
    }

    current = path.dirname(current);
  }
}

async function findNearestMatchingEntry(
  filePath: string,
  predicate: (entryName: string) => boolean,
): Promise<string | undefined> {
  let current = path.resolve(path.dirname(filePath));
  const root = path.parse(current).root;

  while (true) {
    const entries = await readDirectoryEntries(current);
    if (entries === undefined) {
      return undefined;
    }

    const candidates = entries
      .filter((entry) => entry.isFile() && predicate(entry.name))
      .map((entry) => path.join(current, entry.name))
      .sort((left, right) => compareDotNetTargetPaths(left, right));
    if (candidates[0] !== undefined) {
      return candidates[0];
    }

    if (current === root) {
      return undefined;
    }

    current = path.dirname(current);
  }
}

function compareDotNetTargetPaths(left: string, right: string): number {
  const leftRank = path.extname(left).toLowerCase() === ".slnx" ? 0 : 1;
  const rightRank = path.extname(right).toLowerCase() === ".slnx" ? 0 : 1;
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }

  return left.localeCompare(right);
}

async function readDirectoryEntries(directory: string) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch {
    return undefined;
  }
}

async function readDotNetSolutionProjectPaths(solutionPath: string): Promise<string[]> {
  const contents = await readOptionalTextFile(solutionPath);
  if (contents === undefined) {
    return [];
  }

  const solutionRoot = path.dirname(solutionPath);
  const extension = path.extname(solutionPath).toLowerCase();
  const matches =
    extension === ".slnx"
      ? [...contents.matchAll(/<Project\b[^>]*\bPath="([^"]+\.csproj)"/gu)].flatMap((match) =>
          typeof match[1] === "string" ? [match[1]] : [],
        )
      : [...contents.matchAll(/Project\([^)]*\)\s*=\s*"[^"]*",\s*"([^"]+\.csproj)"/gu)].flatMap(
          (match) => (typeof match[1] === "string" ? [match[1]] : []),
        );

  return [
    ...new Set(matches.map((match) => path.resolve(solutionRoot, match.replace(/\\/gu, path.sep)))),
  ].sort((left, right) => left.localeCompare(right));
}

async function readOptionalTextFile(filePath: string | undefined): Promise<string | undefined> {
  if (filePath === undefined || !(await pathExists(filePath))) {
    return undefined;
  }

  return readFile(filePath, "utf8");
}

function readProjectName(projectRoot: string): string {
  const baseName = path.basename(projectRoot);
  return baseName.length > 0 ? baseName : projectRoot;
}

export async function runDotNetLintTask(
  task: PlannedTask,
  runtime: DotNetRunnerRuntime,
): Promise<StageResult> {
  return runDotNetFormatSubcommandTask(task, runtime, {
    failureLabel: "dotnet format style",
    noopNote: "No .NET files were selected for lint.",
    noteLabel: "dotnet format style",
    subcommand: "style",
    tool: "dotnet-format-style",
  });
}

export async function runDotNetFormatTask(
  task: PlannedTask,
  runtime: DotNetRunnerRuntime,
): Promise<StageResult> {
  return runDotNetFormatSubcommandTask(task, runtime, {
    failureLabel: "dotnet format whitespace",
    noopNote: "No .NET files were selected for format.",
    noteLabel: "dotnet format whitespace",
    subcommand: "whitespace",
    tool: "dotnet-format-whitespace",
  });
}

export async function runDotNetTypecheckTask(
  task: PlannedTask,
  runtime: DotNetRunnerRuntime,
): Promise<StageResult> {
  const files = filterDotNetFiles(task.files);
  if (files.length === 0) {
    return runtime.createNoopStageResult(
      task.stageId,
      "No .NET files were selected for typecheck.",
    );
  }

  const diagnostics: Diagnostic[] = [];
  const notes: string[] = [];
  const toolRuns: ToolRunResult[] = [];
  let totalDurationMs = 0;
  let unsupportedFiles: string[] = [];

  try {
    const resolvedProjects = await resolveDotNetProjects(runtime.graph, files, "prefer-project");
    unsupportedFiles = resolvedProjects.unsupportedFiles;

    if (resolvedProjects.projects.length === 0) {
      return runtime.createNotImplementedStageResult(
        task.stageId,
        createUnsupportedDotNetRunnerNote(task.stageId, unsupportedFiles),
      );
    }

    const projectResults = await runProjectBatches(
      resolvedProjects.projects,
      async (project) => runDotNetTypecheckProject(project, runtime),
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
      "dotnet-build",
      files[0] ?? runtime.cwd,
      error,
      totalDurationMs,
      diagnostics,
      toolRuns,
    );
  }

  if (unsupportedFiles.length > 0) {
    notes.push(createUnsupportedDotNetRunnerNote(task.stageId, unsupportedFiles));
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

export async function runDotNetUnitTask(
  task: PlannedTask,
  runtime: DotNetRunnerRuntime,
): Promise<StageResult> {
  return runDotNetTestStage(task, runtime, "unit");
}

export async function runDotNetCoverageTask(
  task: PlannedTask,
  runtime: DotNetRunnerRuntime,
): Promise<StageResult> {
  return runDotNetTestStage(task, runtime, "coverage");
}

export async function runDotNetMetricsTask(
  task: PlannedTask,
  runtime: DotNetRunnerRuntime,
  mode: SharedMetricsMode,
): Promise<StageResult> {
  const files = filterDotNetFiles(task.files);
  if (files.length === 0) {
    return runtime.createNoopStageResult(
      task.stageId,
      `No .NET files were selected for ${task.stageId}.`,
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
    const resolvedProjects = await resolveDotNetProjects(runtime.graph, files, "prefer-project");
    unsupportedFiles = resolvedProjects.unsupportedFiles;
    const projects = await Promise.all(
      resolvedProjects.projects.map(async (project) => ({
        ...project,
        files: await resolveDotNetMetricsFiles(project),
      })),
    );

    for (const project of projects) {
      if (project.files.length === 0) {
        continue;
      }

      const cachedMetrics = await getDotNetMetricsProjectMetrics(project, runtime);
      totalDurationMs += cachedMetrics.cacheHit ? 0 : cachedMetrics.metrics.durationMs;
      scannedFileCount += Object.keys(cachedMetrics.metrics.files).length;
      toolRuns.push(
        runtime.createToolRunResult(
          "aiq-csharp-metrics",
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
        ...createFileMetricDiagnostics(cachedMetrics.metrics.files, mode, "aiq-csharp-metrics"),
      );
    }
  } catch (error) {
    runtime.throwIfAbortError(error);
    return runtime.createExecutionFailureStage(
      task.stageId,
      "aiq-csharp-metrics",
      files[0] ?? runtime.cwd,
      error,
      totalDurationMs,
      diagnostics,
      toolRuns,
    );
  }

  notes.push(
    runtime.readSharedMetricsNote(
      "C#",
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
    notes.push("Reused cached C# metrics for this file batch.");
  }

  unsupportedFiles = task.files.filter((file) => {
    return (
      !dotNetExtensions.has(path.extname(file).toLowerCase()) &&
      !runtime.isSharedMetricsCompanionFile(file)
    );
  });
  if (unsupportedFiles.length > 0) {
    diagnostics.push(
      ...createUnsupportedSharedMetricsDiagnostics(
        unsupportedFiles,
        task.stageId,
        "C#",
        "C# project files",
        runtime.createProcessFailureDiagnostic,
      ),
    );
    notes.push(...readUnsupportedSharedMetricsNotes(unsupportedFiles, task.stageId, "C#"));
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

async function runDotNetFormatSubcommandTask(
  task: PlannedTask,
  runtime: DotNetRunnerRuntime,
  options: {
    failureLabel: string;
    noopNote: string;
    noteLabel: string;
    subcommand: "style" | "whitespace";
    tool: string;
  },
): Promise<StageResult> {
  const files = filterDotNetFiles(task.files);
  if (files.length === 0) {
    return runtime.createNoopStageResult(task.stageId, options.noopNote);
  }

  const diagnostics: Diagnostic[] = [];
  const notes: string[] = [];
  const toolRuns: ToolRunResult[] = [];
  let totalDurationMs = 0;
  let unsupportedFiles: string[] = [];

  try {
    const resolvedProjects = await resolveDotNetProjects(runtime.graph, files, "prefer-project");
    unsupportedFiles = resolvedProjects.unsupportedFiles;

    if (resolvedProjects.projects.length === 0) {
      return runtime.createNotImplementedStageResult(
        task.stageId,
        createUnsupportedDotNetRunnerNote(task.stageId, unsupportedFiles),
      );
    }

    const projectResults = await runProjectBatches(
      resolvedProjects.projects,
      async (project) => runDotNetFormatProject(project, runtime, options),
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
      options.tool,
      files[0] ?? runtime.cwd,
      error,
      totalDurationMs,
      diagnostics,
      toolRuns,
    );
  }

  if (unsupportedFiles.length > 0) {
    notes.push(createUnsupportedDotNetRunnerNote(task.stageId, unsupportedFiles));
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

async function runDotNetTestStage(
  task: PlannedTask,
  runtime: DotNetRunnerRuntime,
  mode: "coverage" | "unit",
): Promise<StageResult> {
  const files = filterDotNetFiles(task.files);
  if (files.length === 0) {
    return runtime.createNoopStageResult(
      task.stageId,
      `No .NET files were selected for ${task.stageId}.`,
    );
  }

  const diagnostics: Diagnostic[] = [];
  const notes: string[] = [];
  const toolRuns: ToolRunResult[] = [];
  let totalDurationMs = 0;
  let unsupportedFiles: string[] = [];

  try {
    const resolvedProjects = await resolveDotNetProjects(runtime.graph, files, "prefer-solution");
    unsupportedFiles = resolvedProjects.unsupportedFiles;

    if (resolvedProjects.projects.length === 0) {
      return runtime.createNotImplementedStageResult(
        task.stageId,
        createUnsupportedDotNetRunnerNote(task.stageId, unsupportedFiles),
      );
    }

    const projectResults = await runProjectBatches(
      resolvedProjects.projects,
      async (project) => runDotNetProjectTestTask(project, mode, runtime),
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
      mode === "coverage" ? "dotnet-test-coverage" : "dotnet-test",
      files[0] ?? runtime.cwd,
      error,
      totalDurationMs,
      diagnostics,
      toolRuns,
    );
  }

  if (unsupportedFiles.length > 0) {
    notes.push(createUnsupportedDotNetRunnerNote(task.stageId, unsupportedFiles));
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

async function resolveDotNetProjects(
  graph: ProjectGraph | undefined,
  files: readonly string[],
  targetPreference: DotNetTargetPreference,
): Promise<{ projects: DotNetProject[]; unsupportedFiles: string[] }> {
  if (graph !== undefined) {
    return selectDotNetProjects(graph, files, targetPreference);
  }

  const projectFiles = new Map<string, string[]>();
  const unsupportedFiles = new Set<string>();

  for (const file of files) {
    const targetPath = await findNearestDotNetTarget(file, targetPreference);
    if (targetPath === undefined) {
      unsupportedFiles.add(file);
      continue;
    }

    const existingFiles = projectFiles.get(targetPath);
    if (existingFiles === undefined) {
      projectFiles.set(targetPath, [file]);
      continue;
    }

    existingFiles.push(file);
  }

  return {
    projects: [...projectFiles.entries()]
      .map(([targetPath, projectRootFiles]) => ({
        files: [...new Set(projectRootFiles)].sort((left, right) => left.localeCompare(right)),
        projectRoot: path.dirname(targetPath),
        targetPath,
      }))
      .sort((left, right) => left.targetPath.localeCompare(right.targetPath)),
    unsupportedFiles: [...unsupportedFiles].sort((left, right) => left.localeCompare(right)),
  };
}

async function findNearestDotNetTarget(
  filePath: string,
  targetPreference: DotNetTargetPreference,
): Promise<string | undefined> {
  const resolvedPath = path.resolve(filePath);
  const extension = path.extname(resolvedPath).toLowerCase();
  if (dotNetProjectExtensions.has(extension)) {
    if (extension === ".csproj" && targetPreference === "prefer-solution") {
      return (await findNearestDotNetOwningSolution(resolvedPath)) ?? resolvedPath;
    }

    return resolvedPath;
  }

  if (!dotNetSourceExtensions.has(extension)) {
    return undefined;
  }

  const projectPath = await findNearestMatchingEntry(resolvedPath, (entryName) =>
    entryName.endsWith(".csproj"),
  );
  const solutionPath =
    projectPath === undefined ? undefined : await findNearestDotNetOwningSolution(projectPath);

  if (targetPreference === "prefer-project") {
    return projectPath ?? solutionPath;
  }

  return solutionPath ?? projectPath;
}

async function resolveDotNetMetricsFiles(project: DotNetProject): Promise<string[]> {
  const selectedSourceFiles = project.files.filter((file) =>
    dotNetSourceExtensions.has(path.extname(file).toLowerCase()),
  );
  if (selectedSourceFiles.length > 0) {
    return [...new Set(selectedSourceFiles)].sort((left, right) => left.localeCompare(right));
  }

  const targetExtension = path.extname(project.targetPath).toLowerCase();
  if (targetExtension === ".sln" || targetExtension === ".slnx") {
    const solutionProjectPaths = await readDotNetSolutionProjectPaths(project.targetPath);
    const projectFiles = await Promise.all(
      solutionProjectPaths.map(async (solutionProjectPath) =>
        resolveDotNetProjectSourceFiles(solutionProjectPath),
      ),
    );
    return [...new Set(projectFiles.flat())].sort((left, right) => left.localeCompare(right));
  }

  return resolveDotNetProjectSourceFiles(project.targetPath);
}

async function resolveDotNetProjectSourceFiles(projectPath: string): Promise<string[]> {
  const projectRoot = path.dirname(projectPath);
  const nestedProjectRoots = await findDotNetNestedProjectRoots(projectPath);
  return findMatchingFiles(
    projectRoot,
    (filePath) => {
      const extension = path.extname(filePath).toLowerCase();
      if (!dotNetSourceExtensions.has(extension)) {
        return false;
      }

      const relativePath = path.relative(projectRoot, filePath);
      const segments = relativePath.split(path.sep).map((segment) => segment.toLowerCase());
      return !segments.includes("bin") && !segments.includes("obj");
    },
    (directoryPath) => nestedProjectRoots.has(path.resolve(directoryPath)),
  );
}

async function findDotNetNestedProjectRoots(projectPath: string): Promise<Set<string>> {
  const normalizedProjectPath = path.resolve(projectPath);
  const projectRoot = path.dirname(normalizedProjectPath);
  const nestedProjectPaths = await findMatchingFiles(projectRoot, (filePath) => {
    const extension = path.extname(filePath).toLowerCase();
    return extension === ".csproj" && path.resolve(filePath) !== normalizedProjectPath;
  });

  return new Set(nestedProjectPaths.map((nestedProjectPath) => path.dirname(nestedProjectPath)));
}

function filterDotNetFiles(files: readonly string[]): string[] {
  return files.filter((file) => dotNetExtensions.has(path.extname(file).toLowerCase()));
}

async function findMatchingFiles(
  directory: string,
  predicate: (filePath: string) => boolean,
  shouldSkipDirectory?: (directoryPath: string) => boolean,
): Promise<string[]> {
  if (!(await pathExists(directory))) {
    return [];
  }

  const entries = await readDirectoryEntries(directory);
  if (entries === undefined) {
    return [];
  }

  const sortedEntries = [...entries].sort((left, right) => left.name.localeCompare(right.name));
  const matches: string[] = [];

  for (const entry of sortedEntries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (shouldSkipDirectory?.(entryPath) === true) {
        continue;
      }
      matches.push(...(await findMatchingFiles(entryPath, predicate, shouldSkipDirectory)));
      continue;
    }

    if (entry.isFile() && predicate(entryPath)) {
      matches.push(entryPath);
    }
  }

  return matches;
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
