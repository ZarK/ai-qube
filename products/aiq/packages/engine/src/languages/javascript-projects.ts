import path from "node:path";

import type {
  Diagnostic,
  ProjectDescriptor,
  ProjectGraph,
  ProjectMetadata,
  ToolRunResult,
} from "../contracts.js";
import type { LizardMetricsFileMetrics } from "../parsers/lizard.js";
import { findNearestLizardConfig } from "../tools/native-config.js";
import { type JavaScriptTestExecutionMode, type JavaScriptTestRunner, detectJavaScriptTestRunner, findNearestPackageJson, hasPackageDependency, javaScriptMetricsSourceExtensions, readPackageJson, resolveJavaScriptTestExecutionMode } from "../utils/node-utils.js";
import type { JavaScriptRunnerRuntime } from "./contracts.js";
import { readPackageScript, readProjectName } from "./javascript-utils.js";

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

export type JavaScriptProject = {
  executionMode: JavaScriptTestExecutionMode;
  files: string[];
  projectRoot: string;
  runner: JavaScriptTestRunner;
};

export type UnsupportedJavaScriptTestProject = {
  file: string;
  message: string;
  projectRoot: string;
};

export type JavaScriptMetricsProject = {
  files: string[];
  packageJsonPath: string;
  projectRoot: string;
};

export type JavaScriptE2eProject = {
  files: string[];
  packageJsonPath: string;
  projectRoot: string;
};

export type JavaScriptE2eRunner =
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

export type JavaScriptMetricsProjectMetrics = {
  args: string[];
  durationMs: number;
  exitCode: number | undefined;
  files: Record<string, LizardMetricsFileMetrics>;
  finishedAt: string;
  startedAt: string;
};

export type JavaScriptProjectExecution = {
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
): Promise<{
  projects: JavaScriptProject[];
  unsupportedProjects: UnsupportedJavaScriptTestProject[];
}> {
  return resolveSelectedJavaScriptProjects(selectJavaScriptPackageProjects(graph, files));
}

export async function createJavaScriptPackageProject(
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

export async function resolveJavaScriptProjects(
  graph: ProjectGraph | undefined,
  files: readonly string[],
): Promise<{
  projects: JavaScriptProject[];
  unsupportedProjects: UnsupportedJavaScriptTestProject[];
}> {
  if (graph !== undefined) {
    return selectJavaScriptProjects(graph, files);
  }

  return resolveSelectedJavaScriptProjects(await resolveFallbackJavaScriptPackageProjects(files));
}

export async function resolveSelectedJavaScriptProjects(packageProjects: {
  projects: JavaScriptPackageProject[];
  unsupportedFiles: string[];
}): Promise<{
  projects: JavaScriptProject[];
  unsupportedProjects: UnsupportedJavaScriptTestProject[];
}> {
  const unsupportedProjects = new Map<string, UnsupportedJavaScriptTestProject>();

  for (const file of packageProjects.unsupportedFiles) {
    const projectRoot = path.dirname(file);
    unsupportedProjects.set(projectRoot, {
      file,
      message: `No JavaScript or TypeScript package project was found for ${projectRoot}. Add package.json with a supported Vitest or Jest unit/coverage runner, or adjust the selected files.`,
      projectRoot,
    });
  }

  const projects = await Promise.all(
    packageProjects.projects.map(async (project) => {
      const runner = await detectJavaScriptTestRunner(project.projectRoot);
      if (runner === undefined) {
        unsupportedProjects.set(
          project.projectRoot,
          await createUnsupportedJavaScriptTestProject(project),
        );
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
    unsupportedProjects: [...unsupportedProjects.values()].sort((left, right) =>
      left.projectRoot.localeCompare(right.projectRoot),
    ),
  };
}

export async function createUnsupportedJavaScriptTestProject(
  project: JavaScriptPackageProject,
): Promise<UnsupportedJavaScriptTestProject> {
  const packageJson = await readPackageJson(project.packageJsonPath);
  const testScript = readPackageScript(packageJson, "test");
  if (testScript !== undefined && testScript.trim().length > 0) {
    return {
      file: project.packageJsonPath,
      message: `Unsupported JavaScript or TypeScript test runner for ${project.projectRoot}: package script "test" is "${testScript}". AIQ unit/coverage supports Vitest and Jest reports; use the e2e stage for browser tests or configure a supported runner.`,
      projectRoot: project.projectRoot,
    };
  }

  return {
    file: project.packageJsonPath,
    message: `No JavaScript or TypeScript test runner is configured for ${project.projectRoot}. Add a Vitest or Jest config, dependency, or supported test script before using AIQ unit/coverage gates.`,
    projectRoot: project.projectRoot,
  };
}

export async function resolveFallbackJavaScriptPackageProjects(files: readonly string[]): Promise<{
  projects: JavaScriptPackageProject[];
  unsupportedFiles: string[];
}> {
  return resolvePackageProjectsFromFiles(files, isJavaScriptTestTaskFile);
}

export async function resolveJavaScriptMetricsProjects(
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

export async function packageJsonCoversWorkspaceProject(
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

export function readWorkspacePatterns(packageJson: Record<string, unknown>): string[] {
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

export function workspacePatternMatchesProject(pattern: string, relativeProjectRoot: string): boolean {
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

export async function resolvePackageProjectsFromFiles(
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

export async function resolveJavaScriptMetricsFiles(
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

export function filterJavaScriptMetricsFiles(files: readonly string[]): string[] {
  return files.filter((file) => isJavaScriptMetricsTaskFile(file));
}

export function filterJavaScriptTestFiles(files: readonly string[]): string[] {
  return files.filter((file) => isJavaScriptTestTaskFile(file));
}

export function isJavaScriptMetricsTaskFile(file: string): boolean {
  return (
    javaScriptMetricsSourceExtensions.has(path.extname(file).toLowerCase()) ||
    path.basename(file).toLowerCase() === "package.json"
  );
}

export function isJavaScriptTestTaskFile(file: string): boolean {
  return (
    javaScriptMetricsSourceExtensions.has(path.extname(file).toLowerCase()) ||
    path.basename(file).toLowerCase() === "package.json"
  );
}

export function getProjectsForKind(
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

export function selectSingleKindProjects(
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
