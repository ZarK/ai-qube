import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
import * as parsers from "../parsers/index.js";
import type { LizardMetricsFileMetrics } from "../parsers/lizard.js";
import { resolveProjectConcurrencyLimit } from "../runtime-tunables.js";
import * as binaries from "../tools/binary-resolver.js";
import * as commands from "../tools/command-builders.js";
import {
  findNearestLizardConfig,
  findNearestPlaywrightConfig,
  playwrightConfigNames,
  readConfigFingerprint,
} from "../tools/native-config.js";
import { createJavaScriptTestCommand } from "../tools/node.js";
import {
  type JavaScriptTestExecutionMode,
  type JavaScriptTestRunner,
  detectJavaScriptTestRunner,
  findNearestPackageJson,
  hasPackageDependency,
  javaScriptMetricsSourceExtensions,
  readPackageJson,
  resolveJavaScriptTestExecutionMode,
} from "../utils/node-utils.js";
import type { JavaScriptRunnerRuntime, SharedMetricsMode } from "./contracts.js";

type JavaScriptPackageProjectDescriptor = ProjectDescriptor & {
  metadata: ProjectMetadata & {
    kind: "javascript-package";
    packageJsonPath: string;
  };
};

export type JavaScriptPackageProject = {
  files: string[];
  packageJsonPath: string;
  projectRoot: string;
};

type JavaScriptProject = {
  executionMode: JavaScriptTestExecutionMode;
  files: string[];
  projectRoot: string;
  runner: JavaScriptTestRunner;
};

type JavaScriptMetricsProject = {
  files: string[];
  packageJsonPath: string;
  projectRoot: string;
};

type JavaScriptE2eProject = {
  files: string[];
  packageJsonPath: string;
  projectRoot: string;
};

type JavaScriptE2eRunner =
  | {
      args: string[];
      command: string;
      kind: "agent-browser" | "playwright-script" | "script";
      name: "agent-browser" | "e2e" | "playwright";
    }
  | {
      installMessage: string;
      kind: "missing-playwright";
      name: "playwright";
    }
  | {
      args: string[];
      command: string;
      kind: "playwright";
      name: "playwright";
    };

type JavaScriptMetricsProjectMetrics = {
  args: string[];
  durationMs: number;
  exitCode: number | undefined;
  files: Record<string, LizardMetricsFileMetrics>;
  finishedAt: string;
  startedAt: string;
};

type JavaScriptProjectExecution = {
  coverageSummary: Record<string, unknown> | undefined;
  coverageSummaryError: string | undefined;
  diagnostics: Diagnostic[];
  runner: JavaScriptTestRunner;
  summary: {
    failed: number;
    passed: number;
    total: number;
  };
  toolRun: ToolRunResult;
};

export async function discoverJavaScriptProjects(file: string): Promise<ProjectDescriptor[]> {
  const project = await createJavaScriptPackageProject(file);
  return project === undefined ? [] : [project];
}

export function selectJavaScriptPackageProjects(
  graph: ProjectGraph,
  files: readonly string[],
): { projects: JavaScriptPackageProject[]; unsupportedFiles: string[] } {
  const grouped = selectSingleKindProjects(graph, files, "javascript-package");

  return {
    projects: grouped.projects.map((project) => ({
      files: project.files,
      packageJsonPath: project.metadata.packageJsonPath,
      projectRoot: project.root,
    })),
    unsupportedFiles: grouped.unsupportedFiles,
  };
}

export async function selectJavaScriptProjects(
  graph: ProjectGraph,
  files: readonly string[],
): Promise<{ projects: JavaScriptProject[]; unsupportedProjectRoots: string[] }> {
  return resolveSelectedJavaScriptProjects(selectJavaScriptPackageProjects(graph, files));
}

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

export async function runJavaScriptE2eTask(
  task: PlannedTask,
  runtime: JavaScriptRunnerRuntime,
): Promise<StageResult> {
  const files = filterJavaScriptTestFiles(task.files);
  if (files.length === 0) {
    return runtime.createNoopStageResult(
      task.stageId,
      "No JavaScript or TypeScript project files were selected for e2e.",
    );
  }

  const diagnostics = [] as ReturnType<JavaScriptRunnerRuntime["createProcessFailureDiagnostic"]>[];
  const toolRuns = [] as ReturnType<JavaScriptRunnerRuntime["createToolRunResult"]>[];
  const notes: string[] = [];
  let totalDurationMs = 0;

  try {
    const resolvedProjects = await resolveJavaScriptE2eProjects(runtime.graph, files);
    const projects = await collapseConfiguredJavaScriptE2eProjects(
      resolvedProjects.projects,
      runtime,
    );
    for (const file of resolvedProjects.unsupportedFiles) {
      const message =
        "No JavaScript or TypeScript package project was found for e2e. Add package.json plus a Playwright config/tests or an agent-browser/manual-audit script before using AIQ refactoring gates.";
      diagnostics.push(runtime.createProcessFailureDiagnostic(file, "aiq-e2e", message));
      notes.push(message);
    }

    if (projects.length === 0) {
      if (diagnostics.length > 0) {
        return {
          diagnostics,
          durationMs: totalDurationMs,
          notes,
          stageId: task.stageId,
          status: "failed",
          toolRuns,
        };
      }

      return runtime.createNoopStageResult(
        task.stageId,
        "No JavaScript or TypeScript package projects were selected for e2e.",
      );
    }

    const projectResults = await runProjectBatches(projects, async (project) =>
      runJavaScriptE2eProjectTask(project, runtime),
    );

    for (const projectResult of projectResults) {
      totalDurationMs += projectResult.durationMs;
      diagnostics.push(...projectResult.diagnostics);
      notes.push(projectResult.note);
      if (projectResult.toolRun !== undefined) {
        toolRuns.push(projectResult.toolRun);
      }
    }
  } catch (error) {
    runtime.throwIfAbortError(error);
    return runtime.createExecutionFailureStage(
      task.stageId,
      "e2e",
      files[0] ?? runtime.cwd,
      error,
      totalDurationMs,
      diagnostics,
      toolRuns,
    );
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

export async function runJavaScriptMetricsTask(
  task: PlannedTask,
  runtime: JavaScriptRunnerRuntime,
  mode: SharedMetricsMode,
): Promise<StageResult> {
  const files = filterJavaScriptMetricsFiles(task.files);
  if (files.length === 0) {
    return runtime.createNoopStageResult(
      task.stageId,
      `No JavaScript or TypeScript files were selected for ${task.stageId}.`,
    );
  }

  const diagnostics: Diagnostic[] = [];
  const notes: string[] = [];
  const toolRuns = [] as ReturnType<JavaScriptRunnerRuntime["createToolRunResult"]>[];
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
    const resolvedProjects = await resolveJavaScriptMetricsProjects(runtime.graph, files);
    unsupportedFiles = resolvedProjects.unsupportedFiles.sort((left, right) =>
      left.localeCompare(right),
    );

    const projects = await Promise.all(
      resolvedProjects.projects.map(async (project) => ({
        ...project,
        files: await resolveJavaScriptMetricsFiles(project, runtime),
      })),
    );

    for (const project of projects) {
      if (project.files.length === 0) {
        continue;
      }

      const cachedMetrics = await getJavaScriptMetricsProjectMetrics(project, runtime);
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
      "JavaScript/TypeScript",
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
    notes.push("Reused cached JavaScript/TypeScript metrics for this file batch.");
  }

  if (unsupportedFiles.length > 0) {
    notes.push(
      `Stage '${task.stageId}' is not implemented yet for non-JavaScript/TypeScript files in this selection: ${unsupportedFiles.join(", ")}.`,
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

async function createJavaScriptPackageProject(
  file: string,
): Promise<JavaScriptPackageProjectDescriptor | undefined> {
  const resolvedFile = path.resolve(file);
  if (!isJavaScriptMetricsTaskFile(resolvedFile)) {
    return undefined;
  }

  const packageJsonPath = await findNearestPackageJson(resolvedFile);
  if (packageJsonPath === undefined) {
    return undefined;
  }

  const projectRoot = path.dirname(packageJsonPath);

  return {
    ecosystem: "javascript",
    id: `javascript-package:${packageJsonPath}`,
    language: "javascript",
    manifestFiles: [packageJsonPath],
    metadata: {
      kind: "javascript-package",
      packageJsonPath,
    },
    name: readProjectName(projectRoot),
    root: projectRoot,
    sourceFiles: [resolvedFile],
  };
}

async function resolveJavaScriptProjects(
  graph: ProjectGraph | undefined,
  files: readonly string[],
): Promise<{ projects: JavaScriptProject[]; unsupportedProjectRoots: string[] }> {
  if (graph !== undefined) {
    return selectJavaScriptProjects(graph, files);
  }

  return resolveSelectedJavaScriptProjects(await resolveFallbackJavaScriptPackageProjects(files));
}

async function resolveSelectedJavaScriptProjects(packageProjects: {
  projects: JavaScriptPackageProject[];
  unsupportedFiles: string[];
}): Promise<{ projects: JavaScriptProject[]; unsupportedProjectRoots: string[] }> {
  const unsupportedProjectRoots = new Set<string>();

  for (const file of packageProjects.unsupportedFiles) {
    unsupportedProjectRoots.add(path.dirname(file));
  }

  const projects = await Promise.all(
    packageProjects.projects.map(async (project) => {
      const runner = await detectJavaScriptTestRunner(project.projectRoot);
      if (runner === undefined) {
        unsupportedProjectRoots.add(project.projectRoot);
        return undefined;
      }

      return {
        executionMode: await resolveJavaScriptTestExecutionMode(project.projectRoot, runner),
        files: project.files,
        projectRoot: project.projectRoot,
        runner,
      };
    }),
  );

  return {
    projects: projects
      .filter((project): project is JavaScriptProject => project !== undefined)
      .sort((left, right) => left.projectRoot.localeCompare(right.projectRoot)),
    unsupportedProjectRoots: [...unsupportedProjectRoots].sort((left, right) =>
      left.localeCompare(right),
    ),
  };
}

async function resolveFallbackJavaScriptPackageProjects(files: readonly string[]): Promise<{
  projects: JavaScriptPackageProject[];
  unsupportedFiles: string[];
}> {
  return resolvePackageProjectsFromFiles(files, isJavaScriptTestTaskFile);
}

async function resolveJavaScriptMetricsProjects(
  graph: ProjectGraph | undefined,
  files: readonly string[],
): Promise<{ projects: JavaScriptMetricsProject[]; unsupportedFiles: string[] }> {
  if (graph !== undefined) {
    const grouped = selectJavaScriptPackageProjects(graph, files);
    return {
      projects: grouped.projects.map((project) => ({
        files: project.files,
        packageJsonPath: project.packageJsonPath,
        projectRoot: project.projectRoot,
      })),
      unsupportedFiles: grouped.unsupportedFiles,
    };
  }

  return resolvePackageProjectsFromFiles(files, isJavaScriptMetricsTaskFile);
}

async function resolveJavaScriptE2eProjects(
  graph: ProjectGraph | undefined,
  files: readonly string[],
): Promise<{ projects: JavaScriptE2eProject[]; unsupportedFiles: string[] }> {
  if (graph !== undefined) {
    const grouped = selectJavaScriptPackageProjects(graph, files);
    return {
      projects: grouped.projects.map((project) => ({
        files: project.files,
        packageJsonPath: project.packageJsonPath,
        projectRoot: project.projectRoot,
      })),
      unsupportedFiles: grouped.unsupportedFiles,
    };
  }

  return resolvePackageProjectsFromFiles(files, isJavaScriptTestTaskFile);
}

async function collapseConfiguredJavaScriptE2eProjects(
  projects: readonly JavaScriptE2eProject[],
  runtime: JavaScriptRunnerRuntime,
): Promise<JavaScriptE2eProject[]> {
  const collapsedProjects = new Map<string, JavaScriptE2eProject>();

  for (const project of projects) {
    const effectiveProject =
      (await findConfiguredJavaScriptE2eProject(project, runtime)) ?? project;
    const existingProject = collapsedProjects.get(effectiveProject.packageJsonPath);
    if (existingProject === undefined) {
      collapsedProjects.set(effectiveProject.packageJsonPath, {
        ...effectiveProject,
        files: [...new Set(project.files)].sort((left, right) => left.localeCompare(right)),
      });
      continue;
    }

    existingProject.files = [...new Set([...existingProject.files, ...project.files])].sort(
      (left, right) => left.localeCompare(right),
    );
  }

  return [...collapsedProjects.values()].sort((left, right) =>
    left.projectRoot.localeCompare(right.projectRoot),
  );
}

async function findConfiguredJavaScriptE2eProject(
  project: JavaScriptE2eProject,
  runtime: JavaScriptRunnerRuntime,
): Promise<JavaScriptE2eProject | undefined> {
  let projectRoot = project.projectRoot;
  let packageJsonPath = project.packageJsonPath;

  while (true) {
    const candidate = {
      files: project.files,
      packageJsonPath,
      projectRoot,
    };
    if (
      (await resolveJavaScriptE2eRunner(candidate, runtime)) !== undefined &&
      (candidate.packageJsonPath === project.packageJsonPath ||
        (await packageJsonCoversWorkspaceProject(candidate.packageJsonPath, project.projectRoot)))
    ) {
      return candidate;
    }

    let foundAncestorPackage = false;
    let nextRoot = path.dirname(projectRoot);
    while (nextRoot !== projectRoot) {
      const parentPackageJsonPath = path.join(nextRoot, "package.json");
      if (await fileExists(parentPackageJsonPath)) {
        projectRoot = nextRoot;
        packageJsonPath = parentPackageJsonPath;
        foundAncestorPackage = true;
        break;
      }

      projectRoot = nextRoot;
      nextRoot = path.dirname(nextRoot);
    }

    if (!foundAncestorPackage) {
      return undefined;
    }
  }
}

async function packageJsonCoversWorkspaceProject(
  packageJsonPath: string,
  projectRoot: string,
): Promise<boolean> {
  const packageJson = await readPackageJson(packageJsonPath);
  const workspacePatterns = readWorkspacePatterns(packageJson);
  if (workspacePatterns.length === 0) {
    return false;
  }

  const root = path.dirname(packageJsonPath);
  const relativeProjectRoot = path.relative(root, projectRoot).replace(/\\/gu, "/");
  if (relativeProjectRoot.length === 0 || relativeProjectRoot.startsWith("../")) {
    return false;
  }

  return workspacePatterns.some((pattern) =>
    workspacePatternMatchesProject(pattern, relativeProjectRoot),
  );
}

function readWorkspacePatterns(packageJson: Record<string, unknown>): string[] {
  const workspaces = packageJson.workspaces;
  if (Array.isArray(workspaces)) {
    return workspaces.filter((entry): entry is string => typeof entry === "string");
  }

  if (typeof workspaces === "object" && workspaces !== null) {
    const packages = (workspaces as Record<string, unknown>).packages;
    return Array.isArray(packages)
      ? packages.filter((entry): entry is string => typeof entry === "string")
      : [];
  }

  return [];
}

function workspacePatternMatchesProject(pattern: string, relativeProjectRoot: string): boolean {
  const normalizedPattern = pattern.replace(/\\/gu, "/").replace(/\/+$/u, "");
  if (normalizedPattern.endsWith("/**")) {
    const prefix = normalizedPattern.slice(0, -"/**".length);
    return relativeProjectRoot === prefix || relativeProjectRoot.startsWith(`${prefix}/`);
  }

  if (normalizedPattern.endsWith("/*")) {
    const prefix = normalizedPattern.slice(0, -"/*".length);
    if (!relativeProjectRoot.startsWith(`${prefix}/`)) {
      return false;
    }

    return !relativeProjectRoot.slice(prefix.length + 1).includes("/");
  }

  return relativeProjectRoot === normalizedPattern;
}

async function resolvePackageProjectsFromFiles(
  files: readonly string[],
  isSupportedFile: (file: string) => boolean,
): Promise<{ projects: JavaScriptPackageProject[]; unsupportedFiles: string[] }> {
  const projectFiles = new Map<string, string[]>();
  const unsupportedFiles = new Set<string>();

  for (const file of files) {
    const resolvedFile = path.resolve(file);
    if (!isSupportedFile(resolvedFile)) {
      unsupportedFiles.add(resolvedFile);
      continue;
    }

    const packageJsonPath = await findNearestPackageJson(resolvedFile);
    if (packageJsonPath === undefined) {
      unsupportedFiles.add(resolvedFile);
      continue;
    }

    const existingFiles = projectFiles.get(packageJsonPath);
    if (existingFiles === undefined) {
      projectFiles.set(packageJsonPath, [resolvedFile]);
      continue;
    }

    existingFiles.push(resolvedFile);
  }

  return {
    projects: [...projectFiles.entries()]
      .map(([packageJsonPath, selectedFiles]) => ({
        files: [...new Set(selectedFiles)].sort((left, right) => left.localeCompare(right)),
        packageJsonPath,
        projectRoot: path.dirname(packageJsonPath),
      }))
      .sort((left, right) => left.projectRoot.localeCompare(right.projectRoot)),
    unsupportedFiles: [...unsupportedFiles].sort((left, right) => left.localeCompare(right)),
  };
}

async function resolveJavaScriptMetricsFiles(
  project: JavaScriptMetricsProject,
  runtime: JavaScriptRunnerRuntime,
): Promise<string[]> {
  const selectedSourceFiles = project.files.filter((file) =>
    javaScriptMetricsSourceExtensions.has(path.extname(file).toLowerCase()),
  );
  if (selectedSourceFiles.length > 0) {
    return [...new Set(selectedSourceFiles)].sort((left, right) => left.localeCompare(right));
  }

  return runtime.findMatchingFiles(
    project.projectRoot,
    (filePath) => javaScriptMetricsSourceExtensions.has(path.extname(filePath).toLowerCase()),
    runtime.shouldSkipProjectDirectory,
  );
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
  let unsupportedProjectRoots: string[] = [];
  const stageTempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-js-stage-"));

  try {
    const resolvedProjects = await resolveJavaScriptProjects(runtime.graph, files);
    unsupportedProjectRoots = resolvedProjects.unsupportedProjectRoots;

    if (resolvedProjects.projects.length === 0) {
      return runtime.createNotImplementedStageResult(
        task.stageId,
        runtime.readUnsupportedRunnerNote(task.stageId, unsupportedProjectRoots),
      );
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

  const status =
    diagnostics.length > 0
      ? "failed"
      : unsupportedProjectRoots.length > 0
        ? "not_implemented"
        : "passed";

  if (unsupportedProjectRoots.length > 0) {
    notes.push(runtime.readUnsupportedRunnerNote(task.stageId, unsupportedProjectRoots));
  }

  return {
    diagnostics,
    durationMs: totalDurationMs,
    notes,
    stageId: task.stageId,
    status,
    toolRuns,
  };
}

async function runJavaScriptE2eProjectTask(
  project: JavaScriptE2eProject,
  runtime: JavaScriptRunnerRuntime,
): Promise<{
  diagnostics: Diagnostic[];
  durationMs: number;
  note: string;
  toolRun?: ToolRunResult;
}> {
  const runner = await resolveJavaScriptE2eRunner(project, runtime);
  if (runner === undefined) {
    const note = `No e2e runner is configured for ${project.projectRoot}. Add Playwright config/tests or an agent-browser/manual-audit script, then run aiq setup if project dependencies are missing.`;
    return {
      diagnostics: [
        runtime.createProcessFailureDiagnostic(project.packageJsonPath, "aiq-e2e", note),
      ],
      durationMs: 0,
      note,
    };
  }

  if (runner.kind === "missing-playwright") {
    return {
      diagnostics: [
        runtime.createProcessFailureDiagnostic(
          project.packageJsonPath,
          runner.name,
          runner.installMessage,
        ),
      ],
      durationMs: 0,
      note: runner.installMessage,
      toolRun: runtime.createToolRunResult(runner.name, [], 0, undefined, "failed"),
    };
  }

  const outcome = await runtime.runExecutable(
    runner.command,
    runner.args,
    project.projectRoot,
    runtime.signal,
  );
  const status = outcome.exitCode === 0 ? "passed" : "failed";
  const diagnostics: Diagnostic[] = [];
  if (status === "failed") {
    diagnostics.push(
      runtime.createProcessFailureDiagnostic(
        project.files[0] ?? project.packageJsonPath,
        runner.name,
        runtime.readProcessFailureMessage(
          runner.name,
          outcome.stderr,
          outcome.stdout,
          outcome.exitCode,
        ),
      ),
    );
  }

  return {
    diagnostics,
    durationMs: outcome.durationMs,
    note: readE2eNote(runner, outcome.stdout, status),
    toolRun: runtime.createToolRunResult(
      runner.name,
      runner.args,
      outcome.durationMs,
      outcome.exitCode,
      status,
      outcome.finishedAt,
      outcome.startedAt,
    ),
  };
}

async function resolveJavaScriptE2eRunner(
  project: JavaScriptE2eProject,
  runtime: JavaScriptRunnerRuntime,
): Promise<JavaScriptE2eRunner | undefined> {
  const packageJson = await readPackageJson(project.packageJsonPath);
  const script = selectE2eScript(packageJson);
  if (script !== undefined) {
    return {
      args: ["run", script.name, "--", ...script.extraArgs],
      command: binaries.resolveNpmCommand(),
      kind: script.kind,
      name:
        script.kind === "agent-browser"
          ? "agent-browser"
          : script.kind === "script"
            ? "e2e"
            : "playwright",
    };
  }

  if (!(await hasPlaywrightSignals(project, runtime, packageJson))) {
    return undefined;
  }

  const playwrightBinary = await resolveLocalPlaywrightBinary(project.projectRoot);
  if (playwrightBinary === undefined) {
    return {
      installMessage:
        "Playwright e2e is configured, but the local Playwright binary was not found in node_modules/.bin. Run aiq setup for required setup steps, then install this project's dependencies.",
      kind: "missing-playwright",
      name: "playwright",
    };
  }

  const configPath = await findNearestPlaywrightConfig(project.packageJsonPath);
  return {
    args: commands.createPlaywrightTestArgs(configPath === undefined ? {} : { configPath }),
    command: playwrightBinary,
    kind: "playwright",
    name: "playwright",
  };
}

function selectE2eScript(
  packageJson: Record<string, unknown>,
):
  | { extraArgs: string[]; kind: "agent-browser" | "playwright-script" | "script"; name: string }
  | undefined {
  const scripts = readPackageScripts(packageJson);
  const preferredNames = ["aiq:e2e", "test:e2e", "e2e", "audit:ui", "aiq:audit-ui"];
  for (const name of preferredNames) {
    const script = scripts.get(name)?.toLowerCase();
    if (script === undefined) {
      continue;
    }

    if (script.includes("agent-browser") || script.includes("manual-audit")) {
      return { extraArgs: [], kind: "agent-browser", name };
    }

    if (script.includes("playwright")) {
      return { extraArgs: ["--reporter=json"], kind: "playwright-script", name };
    }

    if (name === "aiq:e2e" || name === "test:e2e" || name === "e2e") {
      return { extraArgs: [], kind: "script", name };
    }
  }

  return undefined;
}

async function hasPlaywrightSignals(
  project: JavaScriptE2eProject,
  runtime: JavaScriptRunnerRuntime,
  packageJson: Record<string, unknown>,
): Promise<boolean> {
  return (
    hasPackageDependency(packageJson, "@playwright/test") ||
    hasPackageDependency(packageJson, "playwright") ||
    (await hasAnyProjectFile(project.projectRoot, playwrightConfigNames)) ||
    (await hasAnyPlaywrightSpec(project.projectRoot, runtime))
  );
}

async function hasAnyProjectFile(root: string, names: readonly string[]): Promise<boolean> {
  for (const name of names) {
    if (await fileExists(path.join(root, name))) {
      return true;
    }
  }

  return false;
}

async function hasAnyPlaywrightSpec(
  root: string,
  runtime: JavaScriptRunnerRuntime,
): Promise<boolean> {
  const files = await runtime.findMatchingFiles(
    root,
    (filePath) => isPlaywrightSpecFile(filePath),
    runtime.shouldSkipProjectDirectory,
  );
  return files.length > 0;
}

async function resolveLocalPlaywrightBinary(projectRoot: string): Promise<string | undefined> {
  const binName = process.platform === "win32" ? "playwright.cmd" : "playwright";
  const binaryPath = path.join(projectRoot, "node_modules", ".bin", binName);
  return (await fileExists(binaryPath)) ? binaryPath : undefined;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stats = await stat(filePath);
    return stats.isFile();
  } catch {
    return false;
  }
}

function isPlaywrightSpecFile(filePath: string): boolean {
  const name = path.basename(filePath).toLowerCase();
  return /\.(?:e2e|spec)\.[cm]?[jt]sx?$/u.test(name);
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

async function getJavaScriptMetricsProjectMetrics(
  project: JavaScriptMetricsProject & { files: string[] },
  runtime: JavaScriptRunnerRuntime,
): Promise<{ cacheHit: boolean; metrics: JavaScriptMetricsProjectMetrics }> {
  const manifestKey = createJavaScriptMetricsManifestKey(project);
  const cacheKey = await createJavaScriptMetricsCacheKey(project, manifestKey);
  const cached = await runtime.getCachedValue("metrics:javascript", manifestKey, cacheKey, () =>
    runJavaScriptMetricsProjectTask(project, runtime),
  );

  return {
    cacheHit: cached.cacheHit,
    metrics: cached.value,
  };
}

function createJavaScriptProjectExecutionKey(project: JavaScriptProject): string {
  return `${project.runner}:${project.projectRoot}:${[...project.files].sort().join("|")}`;
}

function createJavaScriptMetricsManifestKey(project: {
  files: string[];
  packageJsonPath: string;
}): string {
  return `${project.packageJsonPath}:${[...project.files].sort().join("|")}`;
}

async function createJavaScriptMetricsCacheKey(
  project: { files: string[]; packageJsonPath: string },
  manifestKey = createJavaScriptMetricsManifestKey(project),
): Promise<string> {
  const [configFingerprint, fileEntries] = await Promise.all([
    readJavaScriptMetricsConfigFingerprint(project.files),
    Promise.all(
      [...project.files]
        .sort((left, right) => left.localeCompare(right))
        .map(async (file) => {
          const fileStats = await stat(file);
          return `${file}@${fileStats.size}:${fileStats.mtimeMs}`;
        }),
    ),
  ]);

  return `${manifestKey}:${configFingerprint}:${fileEntries.join("|")}`;
}

async function readJavaScriptMetricsConfigFingerprint(files: readonly string[]): Promise<string> {
  const fingerprints = await Promise.all(
    [...files]
      .sort((left, right) => left.localeCompare(right))
      .map(async (file) => {
        const configPath = await findNearestLizardConfig(file);
        return readConfigFingerprint(configPath);
      }),
  );

  return [...new Set(fingerprints)].join("|");
}

async function runJavaScriptMetricsProjectTask(
  project: JavaScriptMetricsProject & { files: string[] },
  runtime: JavaScriptRunnerRuntime,
): Promise<JavaScriptMetricsProjectMetrics> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-js-metrics-"));

  try {
    const inputFile = path.join(tempDir, "files.txt");
    await writeFile(inputFile, `${project.files.join("\n")}\n`, "utf8");
    const args = commands.createLizardArgs({
      inputFile,
      languages: ["javascript", "typescript", "tsx"],
    });
    const outcome = await runtime.runExecutable(
      runtime.resolveUvxCommand(),
      args,
      project.projectRoot,
      runtime.signal,
    );
    if (outcome.exitCode !== 0) {
      throw new Error(
        runtime.readProcessFailureMessage(
          "lizard",
          outcome.stderr,
          outcome.stdout,
          outcome.exitCode,
        ),
      );
    }

    return {
      args,
      durationMs: outcome.durationMs,
      exitCode: outcome.exitCode,
      files: await parsers.parseLizardMetrics(outcome.stdout, project.projectRoot, project.files),
      finishedAt: outcome.finishedAt,
      startedAt: outcome.startedAt,
    };
  } finally {
    await rm(tempDir, { force: true, recursive: true }).catch(() => undefined);
  }
}

function filterJavaScriptMetricsFiles(files: readonly string[]): string[] {
  return files.filter((file) => isJavaScriptMetricsTaskFile(file));
}

function filterJavaScriptTestFiles(files: readonly string[]): string[] {
  return files.filter((file) => isJavaScriptTestTaskFile(file));
}

function isJavaScriptMetricsTaskFile(file: string): boolean {
  return (
    javaScriptMetricsSourceExtensions.has(path.extname(file).toLowerCase()) ||
    path.basename(file).toLowerCase() === "package.json"
  );
}

function isJavaScriptTestTaskFile(file: string): boolean {
  return (
    javaScriptMetricsSourceExtensions.has(path.extname(file).toLowerCase()) ||
    path.basename(file).toLowerCase() === "package.json"
  );
}

function getProjectsForKind(
  graph: ProjectGraph,
  projectsById: ReadonlyMap<string, ProjectDescriptor>,
  file: string,
  kind: "javascript-package",
): JavaScriptPackageProjectDescriptor[] {
  const ids = graph.fileToProjectIds[path.resolve(file)] ?? [];

  return ids
    .map((id) => projectsById.get(id))
    .filter(
      (project): project is JavaScriptPackageProjectDescriptor =>
        project !== undefined && project.metadata.kind === kind,
    )
    .sort((left, right) => right.root.length - left.root.length);
}

function selectSingleKindProjects(
  graph: ProjectGraph,
  files: readonly string[],
  kind: "javascript-package",
): {
  projects: Array<JavaScriptPackageProjectDescriptor & { files: string[] }>;
  unsupportedFiles: string[];
} {
  const groupedFiles = new Map<string, string[]>();
  const unsupportedFiles = new Set<string>();
  const graphProjectsById = new Map(graph.projects.map((project) => [project.id, project]));
  const selectedProjectsById = new Map<string, JavaScriptPackageProjectDescriptor>();

  for (const file of files) {
    const project = getProjectsForKind(graph, graphProjectsById, file, kind)[0];
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
        (project): project is JavaScriptPackageProjectDescriptor & { files: string[] } =>
          project !== undefined,
      )
      .sort((left, right) => left.id.localeCompare(right.id)),
    unsupportedFiles: [...unsupportedFiles].sort((left, right) => left.localeCompare(right)),
  };
}

function readCoverageMetric(
  summary: Record<string, unknown> | undefined,
  ...keys: string[]
): number | undefined {
  if (summary === undefined) {
    return undefined;
  }

  let current: unknown = summary;
  for (const key of keys) {
    if (typeof current !== "object" || current === null || !(key in current)) {
      return undefined;
    }

    current = (current as Record<string, unknown>)[key];
  }

  return typeof current === "number" && Number.isFinite(current) ? current : undefined;
}

function isValidJavaScriptTestReport(
  report: Record<string, unknown> | undefined,
): report is Record<string, unknown> {
  if (report === undefined) {
    return false;
  }

  const failed = readCoverageMetric(report, "numFailedTests");
  const passed = readCoverageMetric(report, "numPassedTests");
  const total = readCoverageMetric(report, "numTotalTests");

  return (
    isRecordArray(report.testResults) &&
    failed !== undefined &&
    passed !== undefined &&
    total !== undefined &&
    isNonNegativeInteger(failed) &&
    isNonNegativeInteger(passed) &&
    isNonNegativeInteger(total) &&
    failed <= total &&
    passed <= total &&
    failed + passed <= total
  );
}

function isValidCoverageSummary(
  coverageSummary: Record<string, unknown> | undefined,
): coverageSummary is Record<string, unknown> {
  const total = readCoverageMetric(coverageSummary, "total", "lines", "total");
  const covered = readCoverageMetric(coverageSummary, "total", "lines", "covered");
  const skipped = readCoverageMetric(coverageSummary, "total", "lines", "skipped");
  const pct = readCoverageMetric(coverageSummary, "total", "lines", "pct");

  return (
    total !== undefined &&
    covered !== undefined &&
    skipped !== undefined &&
    pct !== undefined &&
    isNonNegativeInteger(total) &&
    isNonNegativeInteger(covered) &&
    isNonNegativeInteger(skipped) &&
    covered <= total &&
    covered + skipped <= total &&
    pct >= 0 &&
    pct <= 100 &&
    isCoveragePctConsistent(total, covered, pct)
  );
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function isCoveragePctConsistent(total: number, covered: number, pct: number): boolean {
  if (total === 0) {
    return pct === 0 || pct === 100;
  }

  const exactPct = (covered / total) * 100;
  const allowedValues = [exactPct, roundToPrecision(exactPct, 1), roundToPrecision(exactPct, 2)];

  return allowedValues.includes(pct);
}

function roundToPrecision(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function isRecordArray(value: unknown): value is Record<string, unknown>[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "object" && entry !== null)
  );
}

function readTestSummary(report: Record<string, unknown> | undefined): {
  failed: number;
  passed: number;
  total: number;
} {
  return {
    failed: readCoverageMetric(report, "numFailedTests") ?? 0,
    passed: readCoverageMetric(report, "numPassedTests") ?? 0,
    total: readCoverageMetric(report, "numTotalTests") ?? 0,
  };
}

function readUnitNote(
  runner: JavaScriptTestRunner,
  summary: { failed: number; passed: number; total: number },
): string {
  if (summary.total === 0) {
    return `${capitalize(runner)} found no tests.`;
  }

  return `${capitalize(runner)} ran ${summary.total} test${summary.total === 1 ? "" : "s"}: ${summary.passed} passed, ${summary.failed} failed.`;
}

function readCoverageNote(
  runner: JavaScriptTestRunner,
  coverageSummary: Record<string, unknown> | undefined,
  summary: { failed: number; passed: number; total: number },
): string {
  const totalCoverage = readCoverageMetric(coverageSummary, "total", "lines", "pct");
  if (totalCoverage === undefined) {
    return `${capitalize(runner)} coverage completed after ${summary.total} test${summary.total === 1 ? "" : "s"}: ${summary.passed} passed, ${summary.failed} failed.`;
  }

  return `${capitalize(runner)} coverage lines: ${totalCoverage.toFixed(1)}% across ${summary.total} test${summary.total === 1 ? "" : "s"}: ${summary.passed} passed, ${summary.failed} failed.`;
}

function readE2eNote(
  runner: JavaScriptE2eRunner,
  stdout: string,
  status: "failed" | "passed",
): string {
  if (runner.kind === "agent-browser") {
    return `Agent-browser e2e audit ${status}.`;
  }

  if (runner.kind === "script") {
    return `E2E script ${status}.`;
  }

  const summary = readPlaywrightSummary(stdout);
  if (summary === undefined) {
    return `Playwright e2e ${status}.`;
  }

  return `Playwright ran ${summary.total} e2e test${summary.total === 1 ? "" : "s"}: ${summary.passed} passed, ${summary.failed} failed.`;
}

function readPlaywrightSummary(
  stdout: string,
): { failed: number; passed: number; total: number } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return undefined;
  }

  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const suites = Array.isArray((value as Record<string, unknown>).suites)
    ? ((value as Record<string, unknown>).suites as unknown[])
    : [];
  const counts = countPlaywrightTests(suites);
  return counts.total === 0 ? undefined : counts;
}

function countPlaywrightTests(entries: readonly unknown[]): {
  failed: number;
  passed: number;
  total: number;
} {
  let failed = 0;
  let passed = 0;
  let total = 0;

  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }

    const record = entry as Record<string, unknown>;
    if (Array.isArray(record.specs)) {
      for (const spec of record.specs) {
        const specCounts = countPlaywrightSpecTests(spec);
        failed += specCounts.failed;
        passed += specCounts.passed;
        total += specCounts.total;
      }
    }

    if (Array.isArray(record.suites)) {
      const suiteCounts = countPlaywrightTests(record.suites);
      failed += suiteCounts.failed;
      passed += suiteCounts.passed;
      total += suiteCounts.total;
    }
  }

  return { failed, passed, total };
}

function countPlaywrightSpecTests(spec: unknown): {
  failed: number;
  passed: number;
  total: number;
} {
  if (typeof spec !== "object" || spec === null) {
    return { failed: 0, passed: 0, total: 0 };
  }

  const tests = Array.isArray((spec as Record<string, unknown>).tests)
    ? ((spec as Record<string, unknown>).tests as unknown[])
    : [];
  let failed = 0;
  let passed = 0;
  for (const test of tests) {
    const outcome = readPlaywrightTestOutcome(test);
    if (outcome === "passed") {
      passed += 1;
    } else if (outcome === "failed") {
      failed += 1;
    }
  }

  return { failed, passed, total: tests.length };
}

function readPlaywrightTestOutcome(test: unknown): "failed" | "passed" | undefined {
  if (typeof test !== "object" || test === null) {
    return undefined;
  }

  const results = Array.isArray((test as Record<string, unknown>).results)
    ? ((test as Record<string, unknown>).results as unknown[])
    : [];
  if (
    results.some(
      (result) =>
        typeof result === "object" &&
        result !== null &&
        (result as Record<string, unknown>).status !== "passed",
    )
  ) {
    return "failed";
  }

  return results.length > 0 ? "passed" : undefined;
}

function readPackageScripts(packageJson: Record<string, unknown>): Map<string, string> {
  const scripts = packageJson.scripts;
  if (typeof scripts !== "object" || scripts === null) {
    return new Map();
  }

  return new Map(
    Object.entries(scripts)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([name, script]) => [name, script]),
  );
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

async function runProjectBatches<TProject, TResult>(
  projects: readonly TProject[],
  runProject: (project: TProject, index: number) => Promise<TResult>,
): Promise<TResult[]> {
  const results: TResult[] = [];
  const concurrencyLimit = readProjectConcurrencyLimit();

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

function readProjectConcurrencyLimit(): number {
  return resolveProjectConcurrencyLimit();
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function readProjectName(projectRoot: string): string {
  const baseName = path.basename(projectRoot);
  return baseName.length > 0 ? baseName : projectRoot;
}
