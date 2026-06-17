import type { Diagnostic } from "../contracts.js";
import { readIntegerString, resolveDiagnosticFile } from "./utils.js";

export function parseJvmCompilerDiagnostics(
  output: string,
  cwd: string,
  source: string,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const javacMatch = /^(.*?\.(?:java|kt)):(\d+):(?:(\d+):)?\s*(error|warning):\s*(.+)$/u.exec(
      line.trim(),
    );
    if (javacMatch !== null) {
      const file = resolveDiagnosticFile(javacMatch[1], cwd) ?? cwd;
      const startLine = readIntegerString(javacMatch[2]) ?? 1;
      const startColumn = readIntegerString(javacMatch[3]) ?? 1;
      diagnostics.push({
        file,
        message: javacMatch[5] ?? "JVM compiler reported a diagnostic.",
        range: { startColumn, startLine },
        severity: javacMatch[4] === "warning" ? "warning" : "error",
        source,
      });
      continue;
    }

    const kotlinMatch = /^e:\s+(file:\/\/)?(.*?\.kt):(\d+):(\d+)\s+(.+)$/u.exec(line.trim());
    if (kotlinMatch !== null) {
      const file = resolveDiagnosticFile(kotlinMatch[2], cwd) ?? cwd;
      diagnostics.push({
        file,
        message: kotlinMatch[5] ?? "Kotlin compiler reported a diagnostic.",
        range: {
          startColumn: readIntegerString(kotlinMatch[4]) ?? 1,
          startLine: readIntegerString(kotlinMatch[3]) ?? 1,
        },
        severity: "error",
        source,
      });
    }
  }

  return diagnostics;
}
