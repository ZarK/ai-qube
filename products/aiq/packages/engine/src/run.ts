import {
  resolveMetricsArtifactPath,
  resolvePlanArtifactPath,
  resolveReportArtifactPath,
  writeMetricsArtifact,
  writePlanArtifact,
  writeReportArtifact,
} from "./artifacts.js";
import {
  type ArtifactPaths,
  type EngineContext,
  type PlannedTask,
  type ResolvedRunRequest,
  type RunPlan,
  type RunRequest,
  type RunResult,
  type RunStatus,
  type RunSummary,
  type RunTelemetryEvent,
  type RunTelemetryEventType,
  type StageId,
  type StageResult,
  artifactSchemaVersion,
  engineVersion,
} from "./contracts.js";
import { buildRunPlan } from "./planner.js";
import { buildEngineContext, buildEngineContextFromResolvedRequest } from "./request.js";
import { resetRunnerRunScopedValues, runPlannedTask } from "./runners.js";

const pythonConcurrentStages = new Set<StageId>([
  "lint",
  "format",
  "typecheck",
  "unit",
  "sloc",
  "complexity",
  "maintainability",
  "coverage",
  "security",
]);

const pythonSharedMetricsStages = new Set<StageId>(["sloc", "complexity", "maintainability"]);

const pythonStageDependencies: Partial<Record<StageId, readonly StageId[]>> = {
  coverage: ["unit"],
};

export async function runEngine(request: RunRequest): Promise<RunResult> {
  const started = new Date();
  throwIfCancelled(request.signal);
  const resolvedRequest = await buildEngineContext(request);

  return runResolvedRequest(resolvedRequest, undefined, started);
}

export async function runResolvedRequest(
  resolvedRequest: EngineContext | ResolvedRunRequest,
  providedPlan?: RunPlan,
  started = new Date(),
): Promise<RunResult> {
  const engineContext = await ensureEngineContext(resolvedRequest);
  resetRunnerRunScopedValues(engineContext.cache);
  const requestForResult = toResolvedRunRequest(engineContext);
  const stages: StageResult[] = [];
  const plan = providedPlan ?? buildRunPlan(engineContext);
  const telemetry: RunTelemetryEvent[] = [];
  const emitTelemetry = (
    event: RunTelemetryEventType,
    timestamp: Date,
    details: Omit<
      Partial<RunTelemetryEvent>,
      "artifactType" | "artifactVersion" | "context" | "event" | "profile" | "runId" | "timestamp"
    > = {},
  ): void => {
    if (!resolvedRequest.writeArtifacts) {
      return;
    }

    telemetry.push(createTelemetryEvent(engineContext, plan.runId, event, timestamp, details));
  };
  emitTelemetry("run.started", started, {
    fileCount: plan.input.summary.fileCount,
    stageCount: plan.stages.length,
    taskCount: plan.summary.taskCount,
  });
  emitTelemetry("plan.generated", new Date(), {
    fileCount: plan.input.summary.fileCount,
    stageCount: plan.summary.stageCount,
    taskCount: plan.summary.taskCount,
  });

  throwIfCancelled(engineContext.signal);

  const completedStages = new Map<string, StageResult>();
  const executionBatches = createTaskExecutionBatches(plan, engineContext);

  for (const batch of executionBatches) {
    throwIfCancelled(engineContext.signal);

    const batchResults = await Promise.allSettled(
      batch.map(async (task) => {
        throwIfCancelled(engineContext.signal);
        if (engineContext.writeArtifacts) {
          emitTelemetry("stage.started", new Date(), {
            fileCount: task.fileCount,
            stageId: task.stageId,
          });
        }

        const stage = await runPlannedTask(task, engineContext);
        emitStageTelemetry(engineContext, emitTelemetry, stage);
        return [task.id, stage] as const;
      }),
    );

    const failedBatchResult = batchResults.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failedBatchResult !== undefined) {
      throw failedBatchResult.reason;
    }

    const successfulBatchResults = batchResults.filter(
      (result): result is PromiseFulfilledResult<readonly [string, StageResult]> =>
        result.status === "fulfilled",
    );
    for (const result of successfulBatchResults) {
      const [taskId, stage] = result.value;
      completedStages.set(taskId, stage);
    }
  }

  for (const task of plan.tasks) {
    const stage = completedStages.get(task.id);
    if (stage === undefined) {
      throw new Error(`Missing stage result for task '${task.id}'.`);
    }

    stages.push(stage);
  }

  const planPath = engineContext.writeArtifacts
    ? resolvePlanArtifactPath(plan.input.root, engineContext.outDir)
    : undefined;
  const reportPath = engineContext.writeArtifacts
    ? resolveReportArtifactPath(plan.input.root, engineContext.outDir)
    : undefined;
  const metricsPath = engineContext.writeArtifacts
    ? resolveMetricsArtifactPath(plan.input.root, engineContext.outDir)
    : undefined;

  const artifacts: ArtifactPaths = {
    ...(metricsPath === undefined ? {} : { metricsPath }),
    outDir: resolvedRequest.outDir,
    ...(planPath === undefined ? {} : { planPath }),
    ...(reportPath === undefined ? {} : { reportPath }),
  };
  if (planPath !== undefined) {
    await writePlanArtifact(plan, engineContext.outDir);
    emitTelemetry("artifact.written", new Date(), {
      artifact: "plan",
      artifactPath: planPath,
    });
  }

  const finished = new Date();
  const summary = summarizeRun(
    stages,
    plan.input.summary.fileCount,
    plan.summary.taskCount,
    finished.getTime() - started.getTime(),
  );
  emitTelemetry("run.finished", finished, {
    cacheHitRate: summary.cacheHitRate,
    diagnosticCount: summary.diagnosticCount,
    durationMs: summary.durationMs,
    fileCount: summary.fileCount,
    status: summary.status,
    taskCount: summary.taskCount,
    toolRunCount: summary.toolRunCount,
  });

  const result: RunResult = {
    artifactType: "report",
    artifactVersion: artifactSchemaVersion,
    artifacts,
    context: engineContext.context,
    durationMs: finished.getTime() - started.getTime(),
    engineVersion,
    finishedAt: finished.toISOString(),
    mode: engineContext.mode,
    ok: summary.status === "passed",
    stages,
    plan,
    request: requestForResult,
    runId: plan.runId,
    startedAt: started.toISOString(),
    summary,
  };

  if (reportPath !== undefined && metricsPath !== undefined) {
    await writeReportArtifact(result, engineContext.outDir);
    emitTelemetry("artifact.written", new Date(), {
      artifact: "report",
      artifactPath: reportPath,
    });
    emitTelemetry("artifact.written", new Date(), {
      artifact: "metrics",
      artifactPath: metricsPath,
    });
    await writeMetricsArtifact(telemetry, plan.input.root, engineContext.outDir);
  }

  return result;
}

async function ensureEngineContext(
  resolvedRequest: EngineContext | ResolvedRunRequest,
): Promise<EngineContext> {
  return isEngineContext(resolvedRequest)
    ? resolvedRequest
    : buildEngineContextFromResolvedRequest(resolvedRequest);
}

function isEngineContext(request: EngineContext | ResolvedRunRequest): request is EngineContext {
  return "cache" in request && "graph" in request;
}

function toResolvedRunRequest(request: EngineContext): ResolvedRunRequest {
  return {
    context: request.context,
    cwd: request.cwd,
    diffOnly: request.diffOnly,
    diffOnlyFiles: request.diffOnlyFiles,
    manifest: request.manifest,
    mode: request.mode,
    outDir: request.outDir,
    selection: request.selection,
    writeArtifacts: request.writeArtifacts,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  };
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new AiqEngineCancelledError();
  }
}

export class AiqEngineCancelledError extends Error {
  constructor(message = "AIQ engine run cancelled.") {
    super(message);
    this.name = "AiqEngineCancelledError";
  }
}

function summarizeRun(
  stages: StageResult[],
  fileCount: number,
  taskCount: number,
  durationMs: number,
): RunSummary {
  const diagnosticCount = stages.reduce((total, stage) => total + stage.diagnostics.length, 0);
  const notImplementedStageCount = stages.filter(
    (stage) => stage.status === "not_implemented",
  ).length;
  const toolRuns = stages.flatMap((stage) => stage.toolRuns);
  const cacheHitCount = toolRuns.filter((toolRun) => toolRun.cacheHit).length;
  const cacheMissCount = toolRuns.length - cacheHitCount;
  const toolDurationMs = toolRuns.reduce((total, toolRun) => total + toolRun.durationMs, 0);

  return {
    cacheHitCount,
    cacheHitRate: toolRuns.length === 0 ? 0 : cacheHitCount / toolRuns.length,
    cacheMissCount,
    diagnosticCount,
    durationMs,
    fileCount,
    notImplementedStageCount,
    stageCount: stages.length,
    status: summarizeRunStatus(stages),
    taskCount,
    toolDurationMs,
    toolRunCount: toolRuns.length,
  };
}

function summarizeRunStatus(stages: StageResult[]): RunStatus {
  if (stages.some((stage) => stage.status === "failed")) {
    return "failed";
  }

  if (stages.some((stage) => stage.status === "not_implemented")) {
    return "not_implemented";
  }

  return "passed";
}

function createTelemetryEvent(
  request: Pick<ResolvedRunRequest, "context" | "selection">,
  runId: string,
  event: RunTelemetryEventType,
  timestamp: Date,
  details: Omit<
    Partial<RunTelemetryEvent>,
    "artifactType" | "artifactVersion" | "context" | "event" | "profile" | "runId" | "timestamp"
  > = {},
): RunTelemetryEvent {
  return {
    artifactType: "metrics-event",
    artifactVersion: artifactSchemaVersion,
    context: request.context,
    event,
    profile: request.selection.profile,
    runId,
    timestamp: timestamp.toISOString(),
    ...details,
  };
}

function emitStageTelemetry(
  request: Pick<ResolvedRunRequest, "writeArtifacts">,
  emitTelemetry: (
    event: RunTelemetryEventType,
    timestamp: Date,
    details?: Omit<
      Partial<RunTelemetryEvent>,
      "artifactType" | "artifactVersion" | "context" | "event" | "profile" | "runId" | "timestamp"
    >,
  ) => void,
  stage: StageResult,
): void {
  if (!request.writeArtifacts) {
    return;
  }

  const stageFinished = new Date();
  for (const toolRun of stage.toolRuns) {
    const toolFinishedAt =
      toolRun.finishedAt === undefined ? stageFinished : new Date(toolRun.finishedAt);
    emitTelemetry(toolRun.cacheHit ? "cache.hit" : "cache.miss", toolFinishedAt, {
      cacheHit: toolRun.cacheHit,
      durationMs: toolRun.durationMs,
      stageId: stage.stageId,
      tool: toolRun.tool,
    });
    emitTelemetry("tool.finished", toolFinishedAt, {
      cacheHit: toolRun.cacheHit,
      durationMs: toolRun.durationMs,
      stageId: stage.stageId,
      status: toolRun.status,
      tool: toolRun.tool,
    });
  }

  emitTelemetry("stage.finished", stageFinished, {
    diagnosticCount: stage.diagnostics.length,
    durationMs: stage.durationMs,
    stageId: stage.stageId,
    status: stage.status,
    toolRunCount: stage.toolRuns.length,
  });
}

function createTaskExecutionBatches(plan: RunPlan, engineContext: EngineContext): PlannedTask[][] {
  if (!shouldParallelizePythonStages(plan, engineContext)) {
    return plan.tasks.map((task) => [task]);
  }

  const pendingTasks = [...plan.tasks];
  const completedStages = new Set<StageId>();
  const batches: PlannedTask[][] = [];
  const dependencyMap = createPythonTaskDependencyMap(plan);

  while (pendingTasks.length > 0) {
    const batch = pendingTasks.filter((task) => {
      const dependencies = dependencyMap.get(task.id) ?? [];
      return dependencies.every(
        (dependency) => !plan.stages.includes(dependency) || completedStages.has(dependency),
      );
    });

    if (batch.length === 0) {
      return plan.tasks.map((task) => [task]);
    }

    batches.push(batch);
    for (const task of batch) {
      completedStages.add(task.stageId);
      const taskIndex = pendingTasks.findIndex((pendingTask) => pendingTask.id === task.id);
      pendingTasks.splice(taskIndex, 1);
    }
  }

  return batches;
}

function shouldParallelizePythonStages(plan: RunPlan, engineContext: EngineContext): boolean {
  return (
    engineContext.graph.projects.length > 0 &&
    engineContext.graph.projects.every((project) => project.ecosystem === "python") &&
    plan.stages.every((stage) => pythonConcurrentStages.has(stage))
  );
}

function createPythonTaskDependencyMap(plan: RunPlan): Map<string, StageId[]> {
  const dependencyMap = new Map<string, StageId[]>();
  let previousSharedMetricsStage: StageId | undefined;

  for (const task of plan.tasks) {
    const dependencies = [...(pythonStageDependencies[task.stageId] ?? [])];
    if (pythonSharedMetricsStages.has(task.stageId) && previousSharedMetricsStage !== undefined) {
      dependencies.push(previousSharedMetricsStage);
    }

    dependencyMap.set(task.id, dependencies);
    if (pythonSharedMetricsStages.has(task.stageId)) {
      previousSharedMetricsStage = task.stageId;
    }
  }

  return dependencyMap;
}
