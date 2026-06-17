import path from "node:path";

import type {
  PlannedTask,
  ProjectDescriptor,
  ProjectGraph,
  ProjectMetadata,
  StageResult,
} from "../contracts.js";
import * as parsers from "../parsers/index.js";
import { createTypeScriptTypecheckCommand } from "../tools/node.js";
import { typeScriptTypecheckExtensions } from "../utils/node-utils.js";
import { findNearestConfig } from "../utils/path-utils.js";
import type { TypeScriptRunnerRuntime } from "./contracts.js";

type TypeScriptProjectDescriptor = ProjectDescriptor & {
  metadata: ProjectMetadata & {
    kind: "typescript-typecheck";
    tsconfigPath: string;
  };
};

export type TypeScriptProject = {
  files: string[];
  projectRoot: string;
  tsconfigPath: string;
};

export async function discoverTypeScriptProjects(file: string): Promise<ProjectDescriptor[]> {
  const project = await createTypeScriptProject(file);
  return project === undefined ? [] : [project];
}

export function selectTypeScriptProjects(
  graph: ProjectGraph,
  files: readonly string[],
): { projects: TypeScriptProject[]; unsupportedFiles: string[] } {
  const grouped = selectSingleKindProjects(graph, files, "typescript-typecheck");

  return {
    projects: grouped.projects.map((project) => ({
      files: project.files,
      projectRoot: project.root,
      tsconfigPath: project.metadata.tsconfigPath,
    })),
    unsupportedFiles: grouped.unsupportedFiles,
  };
}

export async function runTypeScriptTypecheckTask(
  task: PlannedTask,
  runtime: TypeScriptRunnerRuntime,
): Promise<StageResult> {
  const files = filterFiles(task.files, typeScriptTypecheckExtensions);
  if (files.length === 0) {
    return runtime.createNoopStageResult(
      task.stageId,
      "No TypeScript files were selected for typecheck.",
    );
  }

  const { projects, unsupportedFiles } = await resolveTypeScriptProjects(runtime.graph, files);
  const tsconfigProjects = new Map<string, string[]>();
  const diagnostics = unsupportedFiles.map((file) =>
    runtime.createProcessFailureDiagnostic(file, "tsc", `No tsconfig.json was found for ${file}.`),
  );
  const toolRuns: ReturnType<TypeScriptRunnerRuntime["createToolRunResult"]>[] = [];
  let totalDurationMs = 0;

  for (const project of projects) {
    tsconfigProjects.set(project.tsconfigPath, project.files);
  }

  try {
    const projectResults = await Promise.all(
      [...tsconfigProjects.keys()].sort().map(async (tsconfigPath) => {
        const command = createTypeScriptTypecheckCommand(tsconfigPath);
        const outcome = await runtime.runNodeTool(
          command.scriptPath,
          command.args,
          runtime.cwd,
          runtime.signal,
        );
        const parsedDiagnostics = parsers.parseTscDiagnostics(
          runtime.joinOutputs(outcome.stdout, outcome.stderr),
          runtime.cwd,
        );

        if (outcome.exitCode !== 0 && parsedDiagnostics.length === 0) {
          parsedDiagnostics.push(
            runtime.createProcessFailureDiagnostic(
              tsconfigProjects.get(tsconfigPath)?.[0] ?? tsconfigPath,
              "tsc",
              runtime.readProcessFailureMessage(
                "TypeScript",
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
          toolRun: runtime.createToolRunResult(
            "tsc",
            command.args,
            outcome.durationMs,
            outcome.exitCode,
            outcome.exitCode === 0 ? "passed" : "failed",
            outcome.finishedAt,
            outcome.startedAt,
          ),
        };
      }),
    );

    for (const projectResult of projectResults) {
      totalDurationMs += projectResult.durationMs;
      diagnostics.push(...projectResult.diagnostics);
      toolRuns.push(projectResult.toolRun);
    }
  } catch (error) {
    runtime.throwIfAbortError(error);
    return runtime.createExecutionFailureStage(
      task.stageId,
      "tsc",
      files[0] ?? runtime.cwd,
      error,
      totalDurationMs,
      diagnostics,
      toolRuns,
    );
  }

  const status = diagnostics.length === 0 ? "passed" : "failed";

  return {
    diagnostics,
    durationMs: totalDurationMs,
    notes:
      status === "passed"
        ? [
            `TypeScript typecheck passed for ${toolRuns.length} project${toolRuns.length === 1 ? "" : "s"}.`,
          ]
        : [
            `TypeScript reported ${diagnostics.length} diagnostic${diagnostics.length === 1 ? "" : "s"}.`,
          ],
    stageId: task.stageId,
    status,
    toolRuns,
  };
}

async function createTypeScriptProject(
  file: string,
): Promise<TypeScriptProjectDescriptor | undefined> {
  const resolvedFile = path.resolve(file);
  if (!typeScriptTypecheckExtensions.has(path.extname(resolvedFile).toLowerCase())) {
    return undefined;
  }

  const tsconfigPath = await findNearestConfig(resolvedFile, "tsconfig.json");
  if (tsconfigPath === undefined) {
    return undefined;
  }

  return {
    ecosystem: "typescript",
    id: `typescript-typecheck:${tsconfigPath}`,
    language: "typescript",
    manifestFiles: [tsconfigPath],
    metadata: {
      kind: "typescript-typecheck",
      tsconfigPath,
    },
    name: readProjectName(path.dirname(tsconfigPath)),
    root: path.dirname(tsconfigPath),
    sourceFiles: [resolvedFile],
  };
}

async function resolveTypeScriptProjects(
  graph: ProjectGraph | undefined,
  files: readonly string[],
): Promise<{ projects: TypeScriptProject[]; unsupportedFiles: string[] }> {
  if (graph !== undefined) {
    return selectTypeScriptProjects(graph, files);
  }

  const projectFiles = new Map<string, string[]>();
  const unsupportedFiles = new Set<string>();

  for (const file of files) {
    const tsconfigPath = await findNearestConfig(file, "tsconfig.json");
    if (tsconfigPath === undefined) {
      unsupportedFiles.add(file);
      continue;
    }

    const existingFiles = projectFiles.get(tsconfigPath);
    if (existingFiles === undefined) {
      projectFiles.set(tsconfigPath, [file]);
      continue;
    }

    existingFiles.push(file);
  }

  return {
    projects: [...projectFiles.entries()]
      .map(([tsconfigPath, selectedFiles]) => ({
        files: [...new Set(selectedFiles)].sort((left, right) => left.localeCompare(right)),
        projectRoot: path.dirname(tsconfigPath),
        tsconfigPath,
      }))
      .sort((left, right) => left.tsconfigPath.localeCompare(right.tsconfigPath)),
    unsupportedFiles: [...unsupportedFiles].sort((left, right) => left.localeCompare(right)),
  };
}

function filterFiles(files: readonly string[], supportedExtensions: ReadonlySet<string>): string[] {
  return files.filter((file) => supportedExtensions.has(path.extname(file).toLowerCase()));
}

function getProjectsForKind(
  graph: ProjectGraph,
  file: string,
  kind: "typescript-typecheck",
): TypeScriptProjectDescriptor[] {
  const ids = graph.fileToProjectIds[path.resolve(file)] ?? [];
  const projectsById = new Map(graph.projects.map((project) => [project.id, project]));

  return ids
    .map((id) => projectsById.get(id))
    .filter(
      (project): project is TypeScriptProjectDescriptor =>
        project !== undefined && project.metadata.kind === kind,
    );
}

function selectSingleKindProjects(
  graph: ProjectGraph,
  files: readonly string[],
  kind: "typescript-typecheck",
): {
  projects: Array<TypeScriptProjectDescriptor & { files: string[] }>;
  unsupportedFiles: string[];
} {
  const groupedFiles = new Map<string, string[]>();
  const unsupportedFiles = new Set<string>();
  const projectsById = new Map<string, TypeScriptProjectDescriptor>();

  for (const file of files) {
    const project = getProjectsForKind(graph, file, kind)[0];
    if (project === undefined) {
      unsupportedFiles.add(file);
      continue;
    }

    const existingFiles = groupedFiles.get(project.id);
    if (existingFiles === undefined) {
      groupedFiles.set(project.id, [file]);
      projectsById.set(project.id, project);
      continue;
    }

    existingFiles.push(file);
  }

  return {
    projects: [...groupedFiles.entries()]
      .map(([projectId, selectedFiles]) => {
        const project = projectsById.get(projectId);
        if (project === undefined) {
          return undefined;
        }

        return {
          ...project,
          files: [...new Set(selectedFiles)].sort((left, right) => left.localeCompare(right)),
        };
      })
      .filter(
        (project): project is TypeScriptProjectDescriptor & { files: string[] } =>
          project !== undefined,
      )
      .sort((left, right) => left.id.localeCompare(right.id)),
    unsupportedFiles: [...unsupportedFiles].sort((left, right) => left.localeCompare(right)),
  };
}

function readProjectName(projectRoot: string): string {
  const baseName = path.basename(projectRoot);
  return baseName.length > 0 ? baseName : projectRoot;
}
