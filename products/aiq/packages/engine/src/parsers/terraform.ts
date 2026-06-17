import type { Diagnostic } from "../contracts.js";
import {
  normalizeSeverity,
  readNestedValue,
  readNumber,
  readRecordArray,
  readString,
  resolveDiagnosticFile,
  stripAnsiEscapes,
} from "./utils.js";

export function parseTerraformValidateDiagnostics(
  output: string,
  cwd: string,
  fallbackFile: string,
): Diagnostic[] {
  const trimmed = output.trim();
  if (trimmed.length === 0) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return readRecordArray(parsed, "diagnostics").map((diagnosticRecord) => {
      const summary = readString(diagnosticRecord, "summary") ?? "terraform validate diagnostic";
      const detail = readString(diagnosticRecord, "detail");
      const file =
        resolveDiagnosticFile(
          readNestedValue(diagnosticRecord, ["range", "filename"]) as string,
          cwd,
        ) ?? fallbackFile;
      const diagnostic: Diagnostic = {
        file,
        message:
          detail !== undefined && detail.length > 0 && detail !== summary
            ? `${summary}\n${detail}`
            : summary,
        severity: normalizeSeverity(readString(diagnosticRecord, "severity")),
        source: "terraform-validate",
      };
      const startLine = readNumber(readNestedValue(diagnosticRecord, ["range", "start", "line"]));
      const startColumn = readNumber(
        readNestedValue(diagnosticRecord, ["range", "start", "column"]),
      );
      const endLine = readNumber(readNestedValue(diagnosticRecord, ["range", "end", "line"]));
      const endColumn = readNumber(readNestedValue(diagnosticRecord, ["range", "end", "column"]));

      if (startLine !== undefined && startColumn !== undefined) {
        diagnostic.range = {
          ...(endColumn === undefined ? {} : { endColumn }),
          ...(endLine === undefined ? {} : { endLine }),
          startColumn,
          startLine,
        };
      }

      return diagnostic;
    });
  } catch {
    return [];
  }
}

export function parseTerraformSyntaxDiagnostics(
  output: string,
  file: string,
  source: string,
): Diagnostic[] {
  const normalizedOutput = stripAnsiEscapes(output).trim();
  if (normalizedOutput.length === 0) {
    return [];
  }

  const diagnostic: Diagnostic = {
    file,
    message: normalizedOutput,
    severity: "error",
    source,
  };
  const lineMatch = / line (\d+)/u.exec(normalizedOutput);

  if (lineMatch !== null) {
    const startLine = Number.parseInt(lineMatch[1] ?? "", 10);
    if (Number.isFinite(startLine)) {
      diagnostic.range = {
        startColumn: 1,
        startLine,
      };
    }
  }

  return [diagnostic];
}

export function parseTerraformFormatDiagnostics(output: string, cwd: string): Diagnostic[] {
  return output
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => ({
      file: resolveDiagnosticFile(line.trim(), cwd) ?? line.trim(),
      message: "File requires formatting.",
      severity: "error" as const,
      source: "terraform-fmt",
    }));
}
