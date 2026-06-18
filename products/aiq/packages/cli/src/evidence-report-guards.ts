import type { RunResult, StageStatus } from "@tjalve/aiq/model";

export function isRunResult(value: unknown): value is RunResult {
  if (!isRecord(value)) {
    return false;
  }

  return (
    hasReportIdentity(value) &&
    hasRunSummary(value.summary) &&
    hasRunStages(value.stages) &&
    hasRunManifest(value.request)
  );
}

function hasReportIdentity(value: Record<string, unknown>): boolean {
  return (
    value.artifactType === "report" &&
    typeof value.finishedAt === "string" &&
    typeof value.runId === "string"
  );
}

function hasRunSummary(value: unknown): boolean {
  return isRecord(value) && isRunStatus(value.status);
}

function hasRunStages(value: unknown): boolean {
  return Array.isArray(value) && value.every(isRunStage);
}

function hasRunManifest(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.manifest)) {
    return false;
  }

  const files = value.manifest.files;
  return Array.isArray(files) && files.every((file) => typeof file === "string");
}

function isRunStatus(value: unknown): value is RunResult["summary"]["status"] {
  return value === "failed" || value === "not_implemented" || value === "passed";
}

function isRunStage(value: unknown): value is RunResult["stages"][number] {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.stageId === "string" &&
    isStageStatus(value.status) &&
    Array.isArray(value.diagnostics) &&
    value.diagnostics.every(isDiagnostic)
  );
}

function isStageStatus(value: unknown): value is StageStatus {
  return value === "failed" || value === "not_implemented" || value === "passed";
}

function isDiagnostic(value: unknown): value is RunResult["stages"][number]["diagnostics"][number] {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.file === "string" &&
    typeof value.message === "string" &&
    isDiagnosticSeverity(value.severity) &&
    typeof value.source === "string"
  );
}

function isDiagnosticSeverity(
  value: unknown,
): value is RunResult["stages"][number]["diagnostics"][number]["severity"] {
  return value === "error" || value === "warning" || value === "info";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
