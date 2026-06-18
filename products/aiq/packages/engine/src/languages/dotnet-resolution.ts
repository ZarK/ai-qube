import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import type { Diagnostic, ProjectGraph, StageResult } from "../contracts.js";
import { resolveProjectConcurrencyLimit } from "../runtime-tunables.js";
import { pathExists } from "../utils/path-utils.js";
import { createUnsupportedDotNetRunnerNote } from "./dotnet-tools.js";
import { selectDotNetProjects } from "./dotnet-projects.js";
import type { DotNetProject, DotNetTargetPreference } from "./dotnet-projects.js";

const dotNetSourceExtensions = new Set([".cs"]);
const dotNetProjectExtensions = new Set([".csproj", ".sln", ".slnx"]);
const dotNetExtensions = new Set([...dotNetSourceExtensions, ...dotNetProjectExtensions]);

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
      ? readSlnxProjectReferences(contents)
      : readSlnProjectReferences(contents);

  return normalizeDotNetSolutionProjectPaths(solutionRoot, matches);
}

function readSlnxProjectReferences(contents: string): string[] {
  return readRegexCaptureValues(contents, /<Project\b[^>]*\bPath="([^"]+\.csproj)"/gu);
}

function readSlnProjectReferences(contents: string): string[] {
  return readRegexCaptureValues(contents, /Project\([^)]*\)\s*=\s*"[^"]*",\s*"([^"]+\.csproj)"/gu);
}

function readRegexCaptureValues(contents: string, pattern: RegExp): string[] {
  return [...contents.matchAll(pattern)].flatMap((match) =>
    typeof match[1] === "string" ? [match[1]] : [],
  );
}

function normalizeDotNetSolutionProjectPaths(
  solutionRoot: string,
  matches: readonly string[],
): string[] {
  return [
    ...new Set(matches.map((match) => resolveDotNetSolutionProjectPath(solutionRoot, match))),
  ].sort((left, right) => left.localeCompare(right));
}

function resolveDotNetSolutionProjectPath(solutionRoot: string, projectPath: string): string {
  return path.resolve(solutionRoot, projectPath.replace(/\\/gu, path.sep));
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

export async function resolveDotNetProjects(
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

export function createDotNetProjectResolutionFailureStage(
  stageId: StageResult["stageId"],
  files: readonly string[],
): StageResult {
  const message = createDotNetProjectResolutionMessage(stageId, files);
  return {
    diagnostics: createDotNetProjectResolutionDiagnostics(files, message),
    durationMs: 0,
    notes: [message],
    stageId,
    status: "failed",
    toolRuns: [
      { args: [], cacheHit: false, durationMs: 0, status: "failed", tool: "dotnet-unavailable" },
    ],
  };
}

export function createDotNetProjectResolutionDiagnostics(
  files: readonly string[],
  message: string,
): Diagnostic[] {
  return files.map((file) => ({
    file,
    message,
    severity: "error",
    source: "dotnet-unavailable",
  }));
}

export function createDotNetProjectResolutionMessage(
  stageId: StageResult["stageId"],
  files: readonly string[],
): string {
  const baseMessage = createUnsupportedDotNetRunnerNote(stageId, files);
  return `${baseMessage} Add a .csproj, .sln, or .slnx target for the selected C# source, select files inside an existing .NET project, or disable .NET ${stageId}.`;
}

export async function findNearestDotNetTarget(
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

export async function resolveDotNetMetricsFiles(project: DotNetProject): Promise<string[]> {
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

export async function resolveDotNetProjectSourceFiles(projectPath: string): Promise<string[]> {
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

export function filterDotNetFiles(files: readonly string[]): string[] {
  return files.filter((file) => dotNetExtensions.has(path.extname(file).toLowerCase()));
}

export async function findMatchingFiles(
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
