import type {
  Diagnostic,
  StageId,
  StageResult,
  ToolRunResult,
  ToolRunStatus,
} from "./contracts.js";
import type { SharedMetricsMode } from "./languages/contracts.js";

type SharedMetricsNoteArgs = [
  string,
  SharedMetricsMode,
  number,
  number,
  number,
  number,
  string,
  number,
  string,
  string,
];

type ToolRunResultArgs = [
  string,
  string[],
  number,
  number | undefined,
  ToolRunStatus,
  string?,
  string?,
  boolean?,
];

type ExecutionFailureStageArgs = [
  StageId,
  string,
  string,
  unknown,
  number?,
  Diagnostic[]?,
  ToolRunResult[]?,
];

export function createNotImplementedStageResult(stageId: StageId, note?: string): StageResult {
  return {
    diagnostics: [],
    durationMs: 0,
    notes: [note ?? `Stage '${stageId}' is not implemented yet.`],
    stageId,
    status: "not_implemented",
    toolRuns: [],
  };
}

export function createSharedMetricsNotImplementedNote(stageId: StageId): string {
  return `Stage '${stageId}' metrics are unsupported for the selected files. Select Python, JavaScript, TypeScript, C#, Go, Rust, Java, or Kotlin files, or adjust stage selection.`;
}

export function readSharedMetricsNote(...values: SharedMetricsNoteArgs): string {
  const [
    languageLabel,
    mode,
    fileCount,
    totalSloc,
    totalBlocks,
    maxComplexity,
    maxRank,
    minMaintainability,
    minMaintainabilityRank,
    emptyBlockLabel,
  ] = values;
  if (mode === "sloc") {
    return `${languageLabel} SLOC: ${totalSloc} across ${fileCount} file${fileCount === 1 ? "" : "s"}.`;
  }

  if (mode === "complexity") {
    return totalBlocks === 0
      ? `${languageLabel} complexity scanned ${fileCount} file${fileCount === 1 ? "" : "s"}; no ${emptyBlockLabel} were detected. Shared metrics observed ${totalSloc} SLOC.`
      : `${languageLabel} complexity max: ${maxComplexity} (${maxRank}) across ${totalBlocks} block${totalBlocks === 1 ? "" : "s"}; Shared metrics observed ${totalSloc} SLOC.`;
  }

  return Number.isFinite(minMaintainability)
    ? `${languageLabel} maintainability min: ${minMaintainability.toFixed(1)} (${minMaintainabilityRank}) across ${fileCount} file${fileCount === 1 ? "" : "s"}.`
    : `${languageLabel} maintainability scanned ${fileCount} file${fileCount === 1 ? "" : "s"}.`;
}

export function createNoopStageResult(stageId: StageId, note: string): StageResult {
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
  stageId: StageId,
  results: readonly StageResult[],
): StageResult {
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

export function isNoopStageResult(result: StageResult): boolean {
  return (
    result.status === "passed" &&
    result.durationMs === 0 &&
    result.diagnostics.length === 0 &&
    result.toolRuns.length === 0
  );
}

export function summarizeCombinedStageStatus(
  results: readonly StageResult[],
): StageResult["status"] {
  if (results.some((result) => result.status === "failed")) {
    return "failed";
  }

  if (results.some((result) => result.status === "not_implemented")) {
    return "not_implemented";
  }

  return "passed";
}

export function createToolRunResult(...values: ToolRunResultArgs): ToolRunResult {
  const [tool, toolArgs, durationMs, exitCode, status, finishedAt, startedAt, cacheHit = false] =
    values;
  const result: ToolRunResult = {
    args: toolArgs,
    cacheHit,
    durationMs,
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(startedAt === undefined ? {} : { startedAt }),
    status,
    tool,
  };

  if (exitCode !== undefined) {
    result.exitCode = exitCode;
  }

  return result;
}

export function createExecutionFailureStage(...values: ExecutionFailureStageArgs): StageResult {
  const [stageId, tool, file, error, durationMs = 0, diagnostics = [], toolRuns = []] = values;
  const message = formatError(error);

  return {
    diagnostics: [...diagnostics, createProcessFailureDiagnostic(file, tool, message)],
    durationMs,
    notes: [message],
    stageId,
    status: "failed",
    toolRuns,
  };
}

export function createProcessFailureDiagnostic(
  file: string,
  source: string,
  message: string,
): Diagnostic {
  return {
    file,
    message,
    severity: "error",
    source,
  };
}

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
