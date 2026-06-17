import type { Diagnostic } from "../contracts.js";
import {
  normalizeSeverity,
  readNumber,
  readRecordArray,
  readString,
  resolveDiagnosticFile,
} from "./utils.js";

export function parseShellcheckDiagnostics(output: string, cwd: string): Diagnostic[] {
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

  const comments = readRecordArray(parsed, "comments");
  return comments.flatMap((comment) => {
    const file = resolveDiagnosticFile(readString(comment, "file"), cwd);
    if (file === undefined) {
      return [];
    }

    const numericCode = readNumber(comment.code);
    const diagnostic: Diagnostic = {
      ...(numericCode === undefined ? {} : { code: `SC${numericCode}` }),
      file,
      message: readString(comment, "message") ?? "ShellCheck reported a diagnostic.",
      severity: normalizeSeverity(readString(comment, "level")),
      source: "shellcheck",
    };
    const startLine = readNumber(comment.line);
    const startColumn = readNumber(comment.column);
    const endLine = readNumber(comment.endLine);
    const endColumn = readNumber(comment.endColumn);
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

export function parseShellFormatDiagnostics(output: string, cwd: string): Diagnostic[] {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const file = resolveDiagnosticFile(line, cwd);
      if (file === undefined) {
        return [];
      }

      return [
        {
          file,
          message: "File requires formatting.",
          severity: "error" as const,
          source: "shfmt",
        },
      ];
    });
}
