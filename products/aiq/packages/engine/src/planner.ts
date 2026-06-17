import crypto from "node:crypto";

import {
  type EngineContext,
  type ResolvedRunRequest,
  type RunPlan,
  type RunRequest,
  type StageId,
  artifactSchemaVersion,
  engineVersion,
} from "./contracts.js";
import { buildEngineContext } from "./request.js";

const defaultStages: StageId[] = [];
const diffOnlySafeStages = new Set<StageId>([
  "lint",
  "format",
  "sloc",
  "complexity",
  "maintainability",
]);

export async function createRunPlan(request: RunRequest): Promise<RunPlan> {
  return buildRunPlan(await buildEngineContext(request));
}

export function buildRunPlan(request: EngineContext | ResolvedRunRequest): RunPlan {
  const createdAt = new Date().toISOString();
  const stages =
    request.selection.stages.length > 0 ? [...request.selection.stages] : [...defaultStages];
  const inputFileCount = request.manifest.summary.fileCount;
  const taskCount = stages.length;
  const runId = crypto.randomUUID();
  const fullRunFiles = resolveFullRunFiles(request);

  return {
    artifactType: "plan",
    artifactVersion: artifactSchemaVersion,
    artifacts: {
      outDir: request.outDir,
    },
    context: request.context,
    createdAt,
    engineVersion,
    input: request.manifest,
    stages,
    profile: request.selection.profile,
    runId,
    summary: {
      fileCount: inputFileCount,
      stageCount: stages.length,
      taskCount,
    },
    tasks: stages.map((stageId, index) => {
      const files = resolveTaskFiles(request, stageId, fullRunFiles);
      return {
        fileCount: files.length,
        files,
        id: `${runId}:${index + 1}:${stageId}`,
        stageId,
      };
    }),
  };
}

function resolveTaskFiles(
  request: EngineContext | ResolvedRunRequest,
  stageId: StageId,
  fullRunFiles: readonly string[],
): string[] {
  if (request.diffOnly && diffOnlySafeStages.has(stageId)) {
    return request.diffOnlyFiles.length > 0
      ? [...request.diffOnlyFiles]
      : [...request.manifest.files];
  }

  return [...fullRunFiles];
}

function resolveFullRunFiles(request: EngineContext | ResolvedRunRequest): string[] {
  if (!request.diffOnly || !("graph" in request)) {
    return [...request.manifest.files];
  }

  return [
    ...new Set([
      ...request.manifest.files,
      ...request.graph.projects.flatMap((project) => [
        ...project.manifestFiles,
        ...project.sourceFiles,
      ]),
    ]),
  ].sort((left, right) => left.localeCompare(right));
}
