import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Diagnostic } from "../contracts.js";

export function resolveDiagnosticFile(file: string | undefined, cwd: string): string | undefined {
  const trimmed = file?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return undefined;
  }

  if (trimmed.startsWith("file://")) {
    return resolveDiagnosticFileUrl(trimmed);
  }

  if (looksLikeWindowsAbsolutePath(trimmed)) {
    return normalizeWindowsPath(trimmed);
  }

  if (looksLikeWindowsRelativePath(trimmed)) {
    return resolveWindowsRelativePath(trimmed, cwd);
  }

  return path.resolve(cwd, trimmed);
}

function resolveDiagnosticFileUrl(fileUrl: string): string | undefined {
  try {
    const url = new URL(fileUrl);
    if (url.protocol !== "file:") {
      return undefined;
    }

    const decodedPathname = decodeURIComponent(url.pathname);
    if (url.hostname.length > 0 && url.hostname.toLowerCase() !== "localhost") {
      return path.win32.normalize(`\\\\${url.hostname}${decodedPathname.replace(/\//gu, "\\")}`);
    }

    if (/^\/[A-Za-z]:/u.test(decodedPathname)) {
      return path.win32.normalize(decodedPathname.slice(1).replace(/\//gu, "\\"));
    }

    return path.normalize(fileURLToPath(url));
  } catch {
    return undefined;
  }
}

function looksLikeWindowsAbsolutePath(file: string): boolean {
  const normalized = stripWindowsNamespacePrefix(file);
  return (
    /^[A-Za-z]:[\\/]/u.test(normalized) ||
    /^\/[A-Za-z]:\//u.test(normalized) ||
    /^\\\\/u.test(normalized)
  );
}

function looksLikeWindowsRelativePath(file: string): boolean {
  const normalized = stripWindowsNamespacePrefix(file);
  return !looksLikeWindowsAbsolutePath(normalized) && normalized.includes("\\");
}

function normalizeWindowsPath(file: string): string {
  const normalized = stripWindowsNamespacePrefix(file);
  const withoutLeadingSlash = /^\/[A-Za-z]:\//u.test(normalized) ? normalized.slice(1) : normalized;
  return path.win32.normalize(withoutLeadingSlash.replace(/\//gu, "\\"));
}

function resolveWindowsRelativePath(file: string, cwd: string): string {
  return path.resolve(cwd, stripWindowsNamespacePrefix(file).replace(/[\\/]/gu, path.sep));
}

function stripWindowsNamespacePrefix(file: string): string {
  if (file.startsWith("\\\\?\\UNC\\")) {
    return `\\\\${file.slice("\\\\?\\UNC\\".length)}`;
  }

  return file.startsWith("\\\\?\\") ? file.slice(4) : file;
}

export function normalizeSeverity(value: string | undefined): Diagnostic["severity"] {
  if (value === "error" || value === "fatal") {
    return "error";
  }

  if (value === "warning") {
    return "warning";
  }

  return "info";
}

export function normalizeMypySeverity(value: string | undefined): Diagnostic["severity"] {
  if (value === "error") {
    return "error";
  }

  if (value === "warning") {
    return "warning";
  }

  return "info";
}

export function normalizeTySeverity(value: string | undefined): Diagnostic["severity"] {
  if (value === "blocker" || value === "critical" || value === "major") {
    return "error";
  }

  if (value === "minor") {
    return "warning";
  }

  return "info";
}

export function normalizeSarifSeverity(value: string | undefined): Diagnostic["severity"] {
  if (value === "error") {
    return "error";
  }
  if (value === "warning" || value === "note") {
    return "warning";
  }
  return "info";
}

export function normalizeRustSeverity(value: string | undefined): Diagnostic["severity"] {
  if (value === "warning") {
    return "warning";
  }
  if (value === "help" || value === "note" || value === "failure-note") {
    return "info";
  }
  return "error";
}

export function readOptionalCode(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value;
}

export function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

export function readStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

export function readNestedString(
  record: Record<string, unknown>,
  keys: string[],
): string | undefined {
  const value = readNestedValue(record, keys);
  return typeof value === "string" ? value : undefined;
}

export function readNestedRecord(
  record: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> | undefined {
  const value = readNestedValue(record, keys);
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

export function readNestedValue(record: Record<string, unknown>, keys: string[]): unknown {
  let current: unknown = record;

  for (const key of keys) {
    if (typeof current !== "object" || current === null || !(key in current)) {
      return undefined;
    }

    current = (current as Record<string, unknown>)[key];
  }

  return current;
}

export function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function readIntegerString(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function readRecordArray(value: unknown, key: string): Array<Record<string, unknown>> {
  if (typeof value !== "object" || value === null) {
    return [];
  }

  return readRecordArrayFromValue((value as Record<string, unknown>)[key]);
}

export function readRecordArrayFromValue(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (item): item is Record<string, unknown> => typeof item === "object" && item !== null,
  );
}

export function deduplicateDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  const uniqueDiagnostics: Diagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const key = [
      diagnostic.source,
      diagnostic.code ?? "",
      diagnostic.file,
      diagnostic.range?.startLine ?? "",
      diagnostic.range?.startColumn ?? "",
      diagnostic.message,
    ].join("|");
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    uniqueDiagnostics.push(diagnostic);
  }

  return uniqueDiagnostics;
}

export function normalizeDiagnosticsToSelection(
  diagnostics: Diagnostic[],
  selectedFiles: readonly string[],
): Diagnostic[] {
  const selectedSet = new Set(selectedFiles.map((file) => file.toLowerCase()));
  return diagnostics.filter((diagnostic) => selectedSet.has(diagnostic.file.toLowerCase()));
}

export function matchDiagnosticFile(file: string, cwd: string): string | undefined {
  return resolveDiagnosticFile(file, cwd);
}

export function tryRealpath(filePath: string): string | undefined {
  try {
    return realpathSync.native(filePath);
  } catch {
    return undefined;
  }
}

export function createFormattingDiagnostic(file: string, source: string): Diagnostic {
  return {
    file,
    message: "File requires formatting.",
    severity: "error",
    source,
  };
}

export function createPrettierDiagnostic(file: string, error: unknown): Diagnostic {
  const message = error instanceof Error ? error.message : String(error);
  const diagnostic: Diagnostic = {
    file,
    message: message.trim() || "Prettier could not parse the file.",
    severity: "error",
    source: "prettier",
  };

  if (typeof error !== "object" || error === null || !("loc" in error)) {
    return diagnostic;
  }

  const location = (
    error as {
      loc?: {
        end?: { column?: number; line?: number };
        start?: { column?: number; line?: number };
      };
    }
  ).loc;
  const startLine = readNumber(location?.start?.line);
  const startColumn = readNumber(location?.start?.column);
  const endLine = readNumber(location?.end?.line);
  const endColumn = readNumber(location?.end?.column);
  if (startLine !== undefined && startColumn !== undefined) {
    diagnostic.range = {
      ...(endColumn === undefined ? {} : { endColumn }),
      ...(endLine === undefined ? {} : { endLine }),
      startColumn,
      startLine,
    };
  }

  return diagnostic;
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

export function createExecutionFailureStage(
  stageId: string,
  tool: string,
  file: string,
  error: unknown,
  durationMs = 0,
  diagnostics: Diagnostic[] = [],
  toolRuns: unknown[] = [],
): {
  diagnostics: Diagnostic[];
  durationMs: number;
  notes: string[];
  stageId: string;
  status: "failed";
  toolRuns: unknown[];
} {
  const message = error instanceof Error ? error.message : String(error);

  return {
    diagnostics: [...diagnostics, createProcessFailureDiagnostic(file, tool, message)],
    durationMs,
    notes: [message],
    stageId,
    status: "failed",
    toolRuns,
  };
}

export function createNoopStageResult(
  stageId: string,
  note: string,
): {
  diagnostics: Diagnostic[];
  durationMs: number;
  notes: string[];
  stageId: string;
  status: "passed";
  toolRuns: unknown[];
} {
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
  results: readonly {
    diagnostics: Diagnostic[];
    durationMs: number;
    notes: string[];
    stageId: string;
    status: "failed" | "not_implemented" | "passed";
    toolRuns: unknown[];
  }[],
): {
  diagnostics: Diagnostic[];
  durationMs: number;
  notes: string[];
  stageId: string;
  status: "failed" | "not_implemented" | "passed";
  toolRuns: unknown[];
} {
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
  results: readonly { status: "failed" | "not_implemented" | "passed" }[],
): "failed" | "not_implemented" | "passed" {
  if (results.some((result) => result.status === "failed")) {
    return "failed";
  }

  if (results.some((result) => result.status === "not_implemented")) {
    return "not_implemented";
  }

  return "passed";
}

export function createToolRunResult(
  tool: string,
  args: string[],
  durationMs: number,
  exitCode: number | undefined,
  status: "failed" | "not_implemented" | "passed",
  finishedAt?: string,
  startedAt?: string,
  cacheHit = false,
): {
  args: string[];
  cacheHit: boolean;
  durationMs: number;
  exitCode?: number;
  finishedAt?: string;
  startedAt?: string;
  status: "failed" | "not_implemented" | "passed";
  tool: string;
} {
  const result: {
    args: string[];
    cacheHit: boolean;
    durationMs: number;
    exitCode?: number;
    finishedAt?: string;
    startedAt?: string;
    status: "failed" | "not_implemented" | "passed";
    tool: string;
  } = {
    args,
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

export function cloneToolRunResult(
  toolRun: {
    args: string[];
    durationMs: number;
    exitCode?: number;
    finishedAt?: string;
    startedAt?: string;
    status: "failed" | "not_implemented" | "passed";
    tool: string;
  },
  cacheHit: boolean,
): {
  args: string[];
  cacheHit: boolean;
  durationMs: number;
  exitCode?: number;
  finishedAt?: string;
  startedAt?: string;
  status: "failed" | "not_implemented" | "passed";
  tool: string;
} {
  return createToolRunResult(
    toolRun.tool,
    toolRun.args,
    cacheHit ? 0 : toolRun.durationMs,
    toolRun.exitCode,
    toolRun.status,
    toolRun.finishedAt,
    toolRun.startedAt,
    cacheHit,
  );
}

export function stripAnsiEscapes(value: string): string {
  const escapeCharacter = String.fromCharCode(27);
  return value.replace(new RegExp(`${escapeCharacter}\\[[0-9;]*m`, "gu"), "");
}

export function joinOutputs(...values: string[]): string {
  return values.filter((value) => value.trim().length > 0).join("\n");
}

export function readProcessFailureMessage(
  toolName: string,
  stderr: string,
  stdout: string,
  exitCode: number | undefined,
): string {
  const combined = joinOutputs(stderr, stdout).trim();
  if (combined.length > 0) {
    return combined;
  }

  return `${toolName} exited with code ${exitCode ?? "unknown"}.`;
}

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function capitalize(value: string): string {
  return value.length === 0 ? value : value.slice(0, 1).toUpperCase() + value.slice(1);
}

export function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
