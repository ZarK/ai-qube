import type { Diagnostic } from "../contracts.js";
import {
  normalizeSeverity,
  readNestedString,
  readNestedValue,
  readNumber,
  readRecordArrayFromValue,
  readString,
  resolveDiagnosticFile,
} from "./utils.js";

export function parsePowerShellAnalyzerDiagnostics(output: string, cwd: string): Diagnostic[] {
  const trimmed = output.trim();
  if (trimmed.length === 0) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }

  const records = Array.isArray(parsed)
    ? readRecordArrayFromValue(parsed)
    : typeof parsed === "object" && parsed !== null
      ? [parsed as Record<string, unknown>]
      : [];

  return records.flatMap((record) => {
    const file =
      resolveDiagnosticFile(readString(record, "ScriptPath"), cwd) ??
      resolveDiagnosticFile(readNestedString(record, ["Extent", "File"]), cwd) ??
      resolveDiagnosticFile(readNestedString(record, ["Extent", "ScriptName"]), cwd);
    if (file === undefined) {
      return [];
    }

    const diagnostic: Diagnostic = {
      file,
      message: readString(record, "Message") ?? "PSScriptAnalyzer reported a diagnostic.",
      severity: normalizeSeverity(
        readString(record, "Severity")?.toLowerCase() === "parseerror"
          ? "error"
          : readString(record, "Severity")?.toLowerCase(),
      ),
      source: "psscriptanalyzer",
    };
    const code = readString(record, "RuleName");
    if (code !== undefined) {
      diagnostic.code = code;
    }

    const startLine =
      readNumber(record.Line) ?? readNumber(readNestedValue(record, ["Extent", "StartLineNumber"]));
    const startColumn =
      readNumber(record.Column) ??
      readNumber(readNestedValue(record, ["Extent", "StartColumnNumber"]));
    const endLine = readNumber(readNestedValue(record, ["Extent", "EndLineNumber"]));
    const endColumn = readNumber(readNestedValue(record, ["Extent", "EndColumnNumber"]));
    if (startLine !== undefined && startColumn !== undefined) {
      diagnostic.range = {
        ...(endColumn === undefined ? {} : { endColumn }),
        ...(endLine === undefined ? {} : { endLine }),
        startColumn,
        startLine,
      };
    }

    return [diagnostic];
  });
}

export function parsePowerShellFormatResults(
  output: string,
  cwd: string,
): Array<{ file: string; formatted: string }> {
  const trimmed = output.trim();
  if (trimmed.length === 0) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }

  const records = Array.isArray(parsed)
    ? readRecordArrayFromValue(parsed)
    : typeof parsed === "object" && parsed !== null
      ? [parsed as Record<string, unknown>]
      : [];

  return records.flatMap((record) => {
    const file = resolveDiagnosticFile(readString(record, "Path"), cwd);
    const formatted = readString(record, "Formatted");
    if (file === undefined || formatted === undefined) {
      return [];
    }

    return [{ file, formatted }];
  });
}

export function parsePowerShellTestSummary(output: string):
  | {
      failed: number;
      passed: number;
      total: number;
    }
  | undefined {
  const trimmed = output.trim();
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
  const total =
    readNumber(record.TotalCount) ?? readNumber(record.totalCount) ?? readNumber(record.Total);
  const passed =
    readNumber(record.PassedCount) ?? readNumber(record.passedCount) ?? readNumber(record.Passed);
  const failed =
    readNumber(record.FailedCount) ?? readNumber(record.failedCount) ?? readNumber(record.Failed);
  if (total === undefined && passed === undefined && failed === undefined) {
    return undefined;
  }

  return {
    failed: failed ?? 0,
    passed: passed ?? Math.max(0, (total ?? 0) - (failed ?? 0)),
    total: total ?? (passed ?? 0) + (failed ?? 0),
  };
}

export function toPowerShellStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
