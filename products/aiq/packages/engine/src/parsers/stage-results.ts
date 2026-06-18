import type { Diagnostic } from "../contracts.js";

type StageResultStatus = "failed" | "not_implemented" | "passed";

type StageResultShape = {
  diagnostics: Diagnostic[];
  durationMs: number;
  notes: string[];
  stageId: string;
  status: StageResultStatus;
  toolRuns: unknown[];
};

type ToolRunResultShape = {
  args: string[];
  cacheHit: boolean;
  durationMs: number;
  exitCode?: number;
  finishedAt?: string;
  startedAt?: string;
  status: StageResultStatus;
  tool: string;
};

type ExecutionFailureStageInput = {
  diagnostics?: Diagnostic[];
  durationMs?: number;
  error: unknown;
  file: string;
  stageId: string;
  tool: string;
  toolRuns?: unknown[];
};

type ToolRunResultInput = {
  args: string[];
  cacheHit?: boolean;
  durationMs: number;
  exitCode: number | undefined;
  finishedAt?: string;
  startedAt?: string;
  status: StageResultStatus;
  tool: string;
};

export function createExecutionFailureStage(input: ExecutionFailureStageInput): StageResultShape {
  const message = input.error instanceof Error ? input.error.message : String(input.error);

  return {
    diagnostics: [
      ...(input.diagnostics ?? []),
      createProcessFailureDiagnostic(input.file, input.tool, message),
    ],
    durationMs: input.durationMs ?? 0,
    notes: [message],
    stageId: input.stageId,
    status: "failed",
    toolRuns: input.toolRuns ?? [],
  };
}

export function createNoopStageResult(stageId: string, note: string): StageResultShape {
  return {
    diagnostics: [],
    durationMs: 0,
    notes: [note],
    stageId,
    status: "passed",
    toolRuns: [],
  };
}

export function combineStageResults(
  stageId: string,
  results: readonly StageResultShape[],
): StageResultShape {
  const activeResults = results.filter((result) => !isNoopStageResult(result));
  if (activeResults.length === 0) {
    return createNoopStageResult(stageId, `No supported files were selected for ${stageId}.`);
  }

  return {
    diagnostics: activeResults.flatMap((result) => result.diagnostics),
    durationMs: activeResults.reduce((total, result) => total + result.durationMs, 0),
    notes: activeResults.flatMap((result) => result.notes),
    stageId,
    status: summarizeCombinedStageStatus(activeResults),
    toolRuns: activeResults.flatMap((result) => result.toolRuns),
  };
}

export function isNoopStageResult(result: {
  diagnostics: Diagnostic[];
  durationMs: number;
  status: string;
  toolRuns: unknown[];
}): boolean {
  return (
    result.status === "passed" &&
    result.durationMs === 0 &&
    result.diagnostics.length === 0 &&
    result.toolRuns.length === 0
  );
}

export function summarizeCombinedStageStatus(
  results: readonly { status: StageResultStatus }[],
): StageResultStatus {
  if (results.some((result) => result.status === "failed")) {
    return "failed";
  }

  if (results.some((result) => result.status === "not_implemented")) {
    return "not_implemented";
  }

  return "passed";
}

export function createToolRunResult(input: ToolRunResultInput): ToolRunResultShape {
  const result: ToolRunResultShape = {
    args: input.args,
    cacheHit: input.cacheHit ?? false,
    durationMs: input.durationMs,
    ...(input.finishedAt === undefined ? {} : { finishedAt: input.finishedAt }),
    ...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }),
    status: input.status,
    tool: input.tool,
  };

  if (input.exitCode !== undefined) {
    result.exitCode = input.exitCode;
  }

  return result;
}

export function cloneToolRunResult(
  toolRun: {
    args: string[];
    durationMs: number;
    exitCode?: number;
    finishedAt?: string;
    startedAt?: string;
    status: StageResultStatus;
    tool: string;
  },
  cacheHit: boolean,
): ToolRunResultShape {
  return createToolRunResult({
    args: toolRun.args,
    cacheHit,
    durationMs: cacheHit ? 0 : toolRun.durationMs,
    exitCode: toolRun.exitCode,
    ...(toolRun.finishedAt === undefined ? {} : { finishedAt: toolRun.finishedAt }),
    ...(toolRun.startedAt === undefined ? {} : { startedAt: toolRun.startedAt }),
    status: toolRun.status,
    tool: toolRun.tool,
  });
}

function createProcessFailureDiagnostic(file: string, source: string, message: string): Diagnostic {
  return {
    file,
    message,
    severity: "error",
    source,
  };
}
