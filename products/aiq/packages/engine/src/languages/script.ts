import path from "node:path";

import type { ProjectDescriptor, ProjectGraph, ProjectMetadata } from "../contracts.js";
import { findNearestAnyConfig } from "../utils/path-utils.js";

type ScriptProjectDescriptor = ProjectDescriptor & {
  metadata: ProjectMetadata & {
    kind: "script";
  };
};

export type ScriptProject = {
  files: string[];
  projectRoot: string;
};

export const bashExtensions = new Set([".bash", ".sh"]);
export const bashTestExtensions = new Set([".bats"]);
export const powerShellExtensions = new Set([".ps1", ".psd1", ".psm1"]);
export const scriptProjectConfigNames = ["package.json", "PSScriptAnalyzerSettings.psd1"];

export async function discoverScriptProjects(file: string): Promise<ProjectDescriptor[]> {
  const project = await createScriptProject(file);
  return project === undefined ? [] : [project];
}

export function selectScriptProjects(
  graph: ProjectGraph,
  files: readonly string[],
): ScriptProject[] {
  return selectSingleKindProjects(graph, files, "script").projects.map((project) => ({
    files: project.files,
    projectRoot: project.root,
  }));
}

export function isBashTaskFile(file: string): boolean {
  const extension = path.extname(file).toLowerCase();
  return bashExtensions.has(extension) || bashTestExtensions.has(extension.toLowerCase());
}

export function isPowerShellTaskFile(file: string): boolean {
  const extension = path.extname(file).toLowerCase();
  if (!powerShellExtensions.has(extension)) {
    return false;
  }

  return path.basename(file).toLowerCase() !== "psscriptanalyzersettings.psd1";
}

export function isPowerShellTestFile(file: string): boolean {
  return path.basename(file).toLowerCase().endsWith(".tests.ps1");
}

export function isPowerShellCoverageSourceFile(file: string): boolean {
  const extension = path.extname(file).toLowerCase();
  if (!powerShellExtensions.has(extension)) {
    return false;
  }

  if (extension === ".psd1") {
    return false;
  }

  if (isPowerShellTestFile(file)) {
    return false;
  }

  return path.basename(file).toLowerCase() !== "psscriptanalyzersettings.psd1";
}

export function shouldSkipScriptProjectDirectory(directoryPath: string): boolean {
  const name = path.basename(directoryPath).toLowerCase();
  return [
    ".git",
    ".hg",
    ".svn",
    ".venv",
    "__pycache__",
    "bin",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "obj",
    "target",
    "vendor",
  ].includes(name);
}

export function createMissingScriptTestsNote(
  language: "Bash" | "PowerShell",
  projectRoot: string,
): string {
  return `No ${language} test files were detected in ${projectRoot}.`;
}

export async function resolveScriptProjects(
  graph: ProjectGraph | undefined,
  files: readonly string[],
): Promise<ScriptProject[]> {
  if (graph !== undefined) {
    return selectScriptProjects(graph, files);
  }

  const projectFiles = new Map<string, string[]>();

  for (const file of files) {
    const projectRoot =
      (await findNearestAnyConfig(file, scriptProjectConfigNames)) ??
      path.dirname(path.resolve(file));
    const resolvedFile = path.resolve(file);
    const existingFiles = projectFiles.get(projectRoot);
    if (existingFiles === undefined) {
      projectFiles.set(projectRoot, [resolvedFile]);
      continue;
    }

    existingFiles.push(resolvedFile);
  }

  return [...projectFiles.entries()]
    .map(([projectRoot, projectFilesForRoot]) => ({
      files: [...new Set(projectFilesForRoot)].sort((left, right) => left.localeCompare(right)),
      projectRoot,
    }))
    .sort((left, right) => left.projectRoot.localeCompare(right.projectRoot));
}

export async function resolveBashProjectTestFiles(
  project: ScriptProject,
  findMatchingFiles: (
    root: string,
    predicate: (filePath: string) => boolean,
    shouldSkipDirectory?: (directoryPath: string) => boolean,
  ) => Promise<string[]>,
): Promise<string[]> {
  const selectedTestFiles = project.files.filter((file) =>
    bashTestExtensions.has(path.extname(file).toLowerCase()),
  );
  if (selectedTestFiles.length > 0) {
    return [...new Set(selectedTestFiles)].sort((left, right) => left.localeCompare(right));
  }

  return findMatchingFiles(
    project.projectRoot,
    (filePath) => bashTestExtensions.has(path.extname(filePath).toLowerCase()),
    shouldSkipScriptProjectDirectory,
  );
}

export async function resolvePowerShellProjectTestFiles(
  project: ScriptProject,
  findMatchingFiles: (
    root: string,
    predicate: (filePath: string) => boolean,
    shouldSkipDirectory?: (directoryPath: string) => boolean,
  ) => Promise<string[]>,
): Promise<string[]> {
  const selectedTestFiles = project.files.filter((file) => isPowerShellTestFile(file));
  if (selectedTestFiles.length > 0) {
    return [...new Set(selectedTestFiles)].sort((left, right) => left.localeCompare(right));
  }

  return findMatchingFiles(
    project.projectRoot,
    isPowerShellTestFile,
    shouldSkipScriptProjectDirectory,
  );
}

export async function resolvePowerShellProjectCoverageFiles(
  project: ScriptProject,
  findMatchingFiles: (
    root: string,
    predicate: (filePath: string) => boolean,
    shouldSkipDirectory?: (directoryPath: string) => boolean,
  ) => Promise<string[]>,
): Promise<string[]> {
  const selectedCoverageFiles = project.files.filter((file) =>
    isPowerShellCoverageSourceFile(file),
  );
  if (selectedCoverageFiles.length > 0) {
    return [...new Set(selectedCoverageFiles)].sort((left, right) => left.localeCompare(right));
  }

  return findMatchingFiles(
    project.projectRoot,
    isPowerShellCoverageSourceFile,
    shouldSkipScriptProjectDirectory,
  );
}

async function createScriptProject(file: string): Promise<ScriptProjectDescriptor | undefined> {
  const resolvedFile = path.resolve(file);
  if (!isScriptTaskFile(resolvedFile)) {
    return undefined;
  }

  const projectRoot =
    (await findNearestAnyConfig(resolvedFile, scriptProjectConfigNames)) ??
    path.dirname(resolvedFile);

  return {
    ecosystem: "shell",
    id: `script:${projectRoot}`,
    language: "shell",
    manifestFiles: [],
    metadata: {
      kind: "script",
    },
    name: readProjectName(projectRoot),
    root: projectRoot,
    sourceFiles: [resolvedFile],
  };
}

function getProjectsForKind(
  graph: ProjectGraph,
  file: string,
  kind: "script",
): ScriptProjectDescriptor[] {
  const ids = graph.fileToProjectIds[path.resolve(file)] ?? [];
  const projectsById = new Map(graph.projects.map((project) => [project.id, project]));

  return ids
    .map((id) => projectsById.get(id))
    .filter(
      (project): project is ScriptProjectDescriptor =>
        project !== undefined && project.metadata.kind === kind,
    );
}

function selectSingleKindProjects(
  graph: ProjectGraph,
  files: readonly string[],
  kind: "script",
): { projects: Array<ScriptProjectDescriptor & { files: string[] }>; unsupportedFiles: string[] } {
  const groupedFiles = new Map<string, string[]>();
  const unsupportedFiles = new Set<string>();
  const selectedProjectsById = new Map<string, ScriptProjectDescriptor>();

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
        (project): project is ScriptProjectDescriptor & { files: string[] } =>
          project !== undefined,
      )
      .sort((left, right) => left.id.localeCompare(right.id)),
    unsupportedFiles: [...unsupportedFiles].sort((left, right) => left.localeCompare(right)),
  };
}

function isScriptTaskFile(file: string): boolean {
  return isBashTaskFile(file) || isPowerShellTaskFile(file);
}

function readProjectName(projectRoot: string): string {
  const baseName = path.basename(projectRoot);
  return baseName.length > 0 ? baseName : projectRoot;
}
