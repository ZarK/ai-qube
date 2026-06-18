import type { Diagnostic } from "../contracts.js";
export { parsePythonMetrics, readOutputSnippet } from "./python-metrics.js";
export type { PythonMetricsFileMetrics } from "./python-metrics.js";
export { parsePytestReport } from "./python-pytest.js";
import {
  normalizeMypySeverity,
  normalizeTySeverity,
  readNestedString,
  readNestedValue,
  readNumber,
  readString,
  resolveDiagnosticFile,
} from "./utils.js";

export function parseRuffDiagnostics(output: string, cwd: string): Diagnostic[] {
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

  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) {
      return [];
    }

    const record = entry as Record<string, unknown>;
    const file = resolveDiagnosticFile(readString(record, "filename"), cwd);
    if (file === undefined) {
      return [];
    }

    const startLine = readNumber(readNestedValue(record, ["location", "row"]));
    const startColumn = readNumber(readNestedValue(record, ["location", "column"]));
    const endLine = readNumber(readNestedValue(record, ["end_location", "row"]));
    const endColumn = readNumber(readNestedValue(record, ["end_location", "column"]));
    const diagnostic: Diagnostic = {
      file,
      message: readString(record, "message") ?? "Ruff reported a diagnostic.",
      severity: "error",
      source: "ruff",
    };
    const code = readString(record, "code");
    if (code !== undefined) {
      diagnostic.code = code;
    }
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

export function parseRuffFormatDiagnostics(output: string, cwd: string): Diagnostic[] {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .flatMap((line) => {
      const match = /^Would reformat:\s+(.+)$/u.exec(line);
      if (match === null) {
        return [];
      }

      const file = resolveDiagnosticFile(match[1], cwd);
      if (file === undefined) {
        return [];
      }

      return [
        {
          file,
          message: "File requires formatting.",
          severity: "error" as const,
          source: "ruff",
        },
      ];
    });
}

export function parseMypyDiagnostics(output: string, cwd: string): Diagnostic[] {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return [];
      }

      if (typeof parsed !== "object" || parsed === null) {
        return [];
      }

      const record = parsed as Record<string, unknown>;
      const file = resolveDiagnosticFile(readString(record, "file"), cwd);
      if (file === undefined) {
        return [];
      }

      const lineValue = readNumber(record.line);
      const columnValue = readNumber(record.column);
      const diagnostic: Diagnostic = {
        file,
        message: readString(record, "message") ?? "mypy reported a diagnostic.",
        severity: normalizeMypySeverity(readString(record, "severity")),
        source: "mypy",
      };
      const code = readString(record, "code");
      if (code !== undefined) {
        diagnostic.code = code;
      }
      if (lineValue !== undefined && columnValue !== undefined) {
        diagnostic.range = {
          startColumn: columnValue,
          startLine: lineValue,
        };
      }

      return [diagnostic];
    });
}

export function parseTyGitlabDiagnostics(output: string, cwd: string): Diagnostic[] {
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

  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.flatMap((entry) => parseTyGitlabDiagnosticEntry(entry, cwd));
}

function parseTyGitlabDiagnosticEntry(entry: unknown, cwd: string): Diagnostic[] {
  if (typeof entry !== "object" || entry === null) {
    return [];
  }

  const record = entry as Record<string, unknown>;
  const file = resolveDiagnosticFile(readNestedString(record, ["location", "path"]), cwd);
  if (file === undefined) {
    return [];
  }

  const diagnostic: Diagnostic = {
    file,
    message: readString(record, "description") ?? "ty reported a diagnostic.",
    severity: normalizeTySeverity(readString(record, "severity")),
    source: "ty",
  };
  appendTyGitlabDiagnosticCode(diagnostic, record);
  appendTyGitlabDiagnosticRange(diagnostic, record);
  return [diagnostic];
}

function appendTyGitlabDiagnosticCode(
  diagnostic: Diagnostic,
  record: Record<string, unknown>,
): void {
  const code = readString(record, "check_name") ?? readTyDiagnosticCode(diagnostic.message);
  if (code !== undefined) {
    diagnostic.code = code;
  }
}

function appendTyGitlabDiagnosticRange(
  diagnostic: Diagnostic,
  record: Record<string, unknown>,
): void {
  const startLine = readNumber(readNestedValue(record, ["location", "positions", "begin", "line"]));
  const startColumn = readNumber(
    readNestedValue(record, ["location", "positions", "begin", "column"]),
  );
  if (startLine === undefined || startColumn === undefined) {
    return;
  }

  const endLine = readNumber(readNestedValue(record, ["location", "positions", "end", "line"]));
  const endColumn = readNumber(readNestedValue(record, ["location", "positions", "end", "column"]));
  diagnostic.range = {
    ...(endColumn === undefined ? {} : { endColumn }),
    ...(endLine === undefined ? {} : { endLine }),
    startColumn,
    startLine,
  };
}

function readTyDiagnosticCode(message: string): string | undefined {
  const match = /^([a-z0-9-]+):\s/iu.exec(message.trim());
  return match?.[1];
}

export function parseTyDiagnostics(output: string, cwd: string): Diagnostic[] {
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

  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.flatMap((entry) => parseTyDiagnosticEntry(entry, cwd));
}

function parseTyDiagnosticEntry(entry: unknown, cwd: string): Diagnostic[] {
  if (typeof entry !== "object" || entry === null) {
    return [];
  }

  const record = entry as Record<string, unknown>;
  const locationRecord = readTyLocationRecord(record);
  const file = resolveDiagnosticFile(readString(locationRecord, "path"), cwd);
  if (file === undefined) {
    return [];
  }

  const diagnostic: Diagnostic = {
    file,
    message: readString(record, "description") ?? "ty reported a diagnostic.",
    severity: readString(record, "severity") === "error" ? "error" : "warning",
    source: "ty",
  };
  appendTyDiagnosticCode(diagnostic, record);
  appendTyDiagnosticRange(diagnostic, locationRecord);
  return [diagnostic];
}

function readTyLocationRecord(record: Record<string, unknown>): Record<string, unknown> {
  const location = readNestedValue(record, ["location"]);
  return typeof location === "object" && location !== null
    ? (location as Record<string, unknown>)
    : {};
}

function appendTyDiagnosticCode(diagnostic: Diagnostic, record: Record<string, unknown>): void {
  const code = readString(record, "check_name");
  if (code !== undefined) {
    diagnostic.code = code;
  }
}

function appendTyDiagnosticRange(
  diagnostic: Diagnostic,
  locationRecord: Record<string, unknown>,
): void {
  const positions = readNestedValue(locationRecord, ["positions"]);
  const startLine = readNumber(
    readNestedValue(positions as Record<string, unknown>, ["begin", "line"]),
  );
  const startColumn = readNumber(
    readNestedValue(positions as Record<string, unknown>, ["begin", "column"]),
  );
  if (startLine === undefined || startColumn === undefined) {
    return;
  }

  const endLine = readNumber(
    readNestedValue(positions as Record<string, unknown>, ["end", "line"]),
  );
  const endColumn = readNumber(
    readNestedValue(positions as Record<string, unknown>, ["end", "column"]),
  );
  diagnostic.range = {
    ...(endColumn === undefined ? {} : { endColumn }),
    ...(endLine === undefined ? {} : { endLine }),
    startColumn,
    startLine,
  };
}
