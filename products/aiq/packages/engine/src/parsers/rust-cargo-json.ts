import type { Diagnostic, DiagnosticRange } from "../contracts.js";
import {
  deduplicateDiagnostics,
  normalizeRustSeverity,
  readNestedRecord,
  readNestedString,
  readNumber,
  readRecordArrayFromValue,
  readString,
  resolveDiagnosticFile,
} from "./utils.js";

export function parseCargoJsonDiagnostics(
  output: string,
  cwd: string,
  source: string,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const line of output.split(/\r?\n/u)) {
    const diagnostic = parseCargoJsonDiagnosticLine(line, cwd, source);
    if (diagnostic !== undefined) {
      diagnostics.push(diagnostic);
    }
  }

  return deduplicateDiagnostics(diagnostics);
}

function parseCargoJsonDiagnosticLine(
  line: string,
  cwd: string,
  source: string,
): Diagnostic | undefined {
  const record = readCargoJsonCompilerMessage(line);
  const message = record === undefined ? undefined : readNestedRecord(record, ["message"]);
  if (message === undefined) {
    return undefined;
  }

  return createRustCargoDiagnostic(message, cwd, source);
}

function readCargoJsonCompilerMessage(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }

  const record = parsed as Record<string, unknown>;
  return readString(record, "reason") === "compiler-message" ? record : undefined;
}

function createRustCargoDiagnostic(
  message: Record<string, unknown>,
  cwd: string,
  source: string,
): Diagnostic | undefined {
  const file = readRustDiagnosticFile(message, cwd);
  if (file === undefined) {
    return undefined;
  }

  const diagnostic: Diagnostic = {
    file,
    message:
      readString(message, "message") ??
      readString(message, "rendered") ??
      "Rust compiler reported a diagnostic.",
    severity: normalizeRustSeverity(readString(message, "level")),
    source,
  };
  const code = readNestedString(message, ["code", "code"]);
  if (code !== undefined) {
    diagnostic.code = code;
  }

  const range = readRustDiagnosticRange(message);
  if (range !== undefined) {
    diagnostic.range = range;
  }

  return diagnostic;
}

function readRustDiagnosticFile(message: Record<string, unknown>, cwd: string): string | undefined {
  const spans = readRecordArrayFromValue(message.spans);
  const primarySpan = spans.find((span) => span.is_primary === true) ?? spans[0];
  return resolveDiagnosticFile(readString(primarySpan ?? {}, "file_name"), cwd);
}

function readRustDiagnosticRange(message: Record<string, unknown>): DiagnosticRange | undefined {
  const spans = readRecordArrayFromValue(message.spans);
  const primarySpan = spans.find((span) => span.is_primary === true) ?? spans[0];
  if (primarySpan === undefined) {
    return undefined;
  }

  const startLine = readNumber(primarySpan.line_start);
  const startColumn = readNumber(primarySpan.column_start);
  const endLine = readNumber(primarySpan.line_end);
  const endColumn = readNumber(primarySpan.column_end);
  if (startLine === undefined || startColumn === undefined) {
    return undefined;
  }

  return {
    ...(endColumn === undefined ? {} : { endColumn }),
    ...(endLine === undefined ? {} : { endLine }),
    startColumn,
    startLine,
  };
}
