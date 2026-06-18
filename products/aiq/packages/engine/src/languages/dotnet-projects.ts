import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import type { Diagnostic, ProjectDescriptor, ProjectGraph, ProjectMetadata, StageResult } from "../contracts.js";
import { resolveProjectConcurrencyLimit } from "../runtime-tunables.js";
import { pathExists } from "../utils/path-utils.js";
import { createUnsupportedDotNetRunnerNote } from "./dotnet-tools.js";

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

export * from "./dotnet-resolution.js";
