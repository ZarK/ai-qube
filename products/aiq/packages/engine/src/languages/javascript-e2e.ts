import path from "node:path";

import type {
  Diagnostic,
  PlannedTask,
  ProjectGraph,
  StageResult,
  ToolRunResult,
} from "../contracts.js";
import type { JavaScriptRunnerRuntime } from "./contracts.js";
import type {
  JavaScriptE2eProject,
  JavaScriptE2eRunner,
  JavaScriptPackageProject,
  UnsupportedJavaScriptTestProject,
} from "./javascript-projects.js";
import {
  filterJavaScriptTestFiles,
  isJavaScriptTestTaskFile,
  packageJsonCoversWorkspaceProject,
  resolveFallbackJavaScriptPackageProjects,
  resolvePackageProjectsFromFiles,
  selectJavaScriptPackageProjects,
} from "./javascript-projects.js";
import { readE2eNote, runProjectBatches } from "./javascript-utils.js";
import { fileExists, resolveJavaScriptE2eRunner } from "./javascript-e2e-runner.js";

export async function resolveJavaScriptE2eProjects(
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

export async function collapseConfiguredJavaScriptE2eProjects(
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

export async function findConfiguredJavaScriptE2eProject(
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

export function createUnsupportedJavaScriptTestDiagnostics(
  projects: readonly UnsupportedJavaScriptTestProject[],
  runtime: JavaScriptRunnerRuntime,
): Diagnostic[] {
  return projects.map((project) =>
    runtime.createProcessFailureDiagnostic(project.file, "aiq-js-test-runner", project.message),
  );
}

export function readUnsupportedJavaScriptTestNotes(
  projects: readonly UnsupportedJavaScriptTestProject[],
  stageId: string,
): string[] {
  if (projects.length === 0) {
    return [];
  }

  const roots = projects.map((project) => project.projectRoot).join(", ");
  return [
    `Unsupported JavaScript/TypeScript test configuration for ${stageId} in: ${roots}.`,
    ...projects.map((project) => project.message),
  ];
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
