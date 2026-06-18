import path from "node:path";
import { readFile } from "node:fs/promises";

import type {
  Diagnostic,
  ProjectDescriptor,
  ProjectGraph,
  ProjectMetadata,
  StageResult,
} from "../contracts.js";
import { resolveProjectConcurrencyLimit } from "../runtime-tunables.js";
import { pathExists } from "../utils/path-utils.js";
import type { JvmRunnerRuntime } from "./contracts.js";
import { createUnsupportedJvmRunnerNote } from "./jvm-tools.js";

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

export function createJvmSetupFailureStage(
  stageId: StageResult["stageId"],
  files: readonly string[],
  message: string,
  runtime: JvmRunnerRuntime,
): StageResult {
  return {
    diagnostics: createJvmSetupDiagnostics(files, message),
    durationMs: 0,
    notes: [message],
    stageId,
    status: "failed",
    toolRuns: [runtime.createToolRunResult("jvm-unavailable", [], 0, undefined, "failed")],
  };
}

export function createJvmSetupDiagnostics(files: readonly string[], message: string): Diagnostic[] {
  return files.map((file) => ({
    file,
    message,
    severity: "error",
    source: "jvm-unavailable",
  }));
}

export function createUnsupportedJvmSetupMessage(
  stageId: StageResult["stageId"],
  files: readonly string[],
): string {
  const target = files.length === 0 ? `for ${stageId}` : `for ${stageId} in: ${files.join(", ")}`;
  return `No JVM build target was detected ${target}. Add pom.xml, build.gradle, or build.gradle.kts with Maven/Gradle tooling, or disable JVM ${stageId}.`;
}

export function createMissingJvmCommandMessage(
  project: JvmProject,
  mode: "coverage" | "typecheck" | "unit",
): string {
  const expected =
    project.buildSystem === "maven"
      ? "mvnw or an installed Maven command"
      : "gradlew or an installed Gradle command";
  const label = project.buildSystem === "maven" ? "Maven" : "Gradle";
  return `${label} is required for JVM ${mode} in ${project.projectRoot}. Add ${expected}, install ${label}, or disable JVM ${mode}.`;
}

export function createUnsupportedJvmCommandMessage(
  project: JvmProject,
  mode: "format" | "lint",
): string {
  return `No supported JVM ${mode} command was detected for ${project.projectRoot}. Configure a supported Maven or Gradle ${mode} plugin, or disable JVM ${mode}.`;
}

export async function resolveJvmProjects(
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

export function filterJvmFiles(files: readonly string[]): string[] {
  return files.filter((file) => isJvmTaskFile(file));
}

export function joinOutputs(...values: string[]): string {
  return values.filter((value) => value.length > 0).join("\n");
}

export async function runProjectBatches<TProject, TResult>(
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

export async function readOptionalTextFile(
  filePath: string | undefined,
): Promise<string | undefined> {
  if (filePath === undefined || !(await pathExists(filePath))) {
    return undefined;
  }

  return readFile(filePath, "utf8");
}
