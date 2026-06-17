import type { Diagnostic } from "../contracts.js";

export function createYamlDiagnostic(
  file: string,
  message: string,
  linePositions: ReadonlyArray<{ col: number; line: number }> | null | undefined,
  severity: Diagnostic["severity"],
): Diagnostic {
  const diagnostic: Diagnostic = {
    file,
    message: message.trim(),
    severity,
    source: "yaml",
  };

  const start = linePositions?.[0];
  const end = linePositions?.[1];
  if (start !== undefined) {
    diagnostic.range = {
      ...(end?.col === undefined ? {} : { endColumn: end.col }),
      ...(end?.line === undefined ? {} : { endLine: end.line }),
      startColumn: start.col,
      startLine: start.line,
    };
  }

  return diagnostic;
}
