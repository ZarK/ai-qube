import path from "node:path";

import type { ProjectDescriptor, ProjectGraph, ProjectMetadata } from "../contracts.js";
import * as parsers from "../parsers/index.js";
import { resolveProjectConcurrencyLimit } from "../runtime-tunables.js";
import { findNearestAnyConfig, pathExists } from "../utils/path-utils.js";
import type { PythonRunnerRuntime } from "./contracts.js";
import type { PythonProjectExecution } from "./python-tools.js";

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

export async function resolvePythonProjects(
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

export function filterPythonTaskFiles(files: readonly string[]): string[] {
  return files.filter((file) => isPythonTaskFile(file));
}

export async function resolvePythonSourceProject(
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

export function isPythonConfigFile(file: string): boolean {
  return pythonTaskConfigNames.includes(path.basename(file).toLowerCase());
}

export function isPythonSourceFile(file: string): boolean {
  return pythonTaskExtensions.has(path.extname(file).toLowerCase());
}

export function isPythonTaskFile(file: string): boolean {
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

export function createPythonProjectExecutionKey(project: PythonProject): string {
  return `${project.projectRoot}:${[...project.files].sort().join("|")}`;
}

export function readPythonUnitNote(summary: { failed: number; passed: number; total: number }): string {
  if (summary.total === 0) {
    return "Pytest found no tests.";
  }

  return `Pytest ran ${summary.total} test${summary.total === 1 ? "" : "s"}: ${summary.passed} passed, ${summary.failed} failed.`;
}

export function readPythonCoverageNote(
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

export async function runProjectBatches<TProject, TResult>(
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
