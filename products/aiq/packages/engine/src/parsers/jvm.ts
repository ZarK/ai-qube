import type { Diagnostic } from "../contracts.js";
import { readIntegerString, resolveDiagnosticFile } from "./utils.js";

export function parseJvmCompilerDiagnostics(
  output: string,
  cwd: string,
  source: string,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const diagnostic = parseJvmCompilerLine(line, cwd, source);
    if (diagnostic !== undefined) {
      diagnostics.push(diagnostic);
    }
  }

  return diagnostics;
}

function parseJvmCompilerLine(line: string, cwd: string, source: string): Diagnostic | undefined {
  const trimmed = line.trim();
  return (
    parseJavacDiagnosticLine(trimmed, cwd, source) ??
    parseKotlinDiagnosticLine(trimmed, cwd, source)
  );
}

function parseJavacDiagnosticLine(
  line: string,
  cwd: string,
  source: string,
): Diagnostic | undefined {
  const javacMatch = /^(.*?\.(?:java|kt)):(\d+):(?:(\d+):)?\s*(error|warning):\s*(.+)$/u.exec(line);
  if (javacMatch === null) {
    return undefined;
  }

  return {
    file: resolveDiagnosticFile(javacMatch[1], cwd) ?? cwd,
    message: javacMatch[5] ?? "JVM compiler reported a diagnostic.",
    range: {
      startColumn: readIntegerString(javacMatch[3]) ?? 1,
      startLine: readIntegerString(javacMatch[2]) ?? 1,
    },
    severity: javacMatch[4] === "warning" ? "warning" : "error",
    source,
  };
}

function parseKotlinDiagnosticLine(
  line: string,
  cwd: string,
  source: string,
): Diagnostic | undefined {
  const kotlinMatch = /^e:\s+(file:\/\/)?(.*?\.kt):(\d+):(\d+)\s+(.+)$/u.exec(line);
  if (kotlinMatch === null) {
    return undefined;
  }

  return {
    file: resolveDiagnosticFile(kotlinMatch[2], cwd) ?? cwd,
    message: kotlinMatch[5] ?? "Kotlin compiler reported a diagnostic.",
    range: readKotlinDiagnosticRange(kotlinMatch),
    severity: "error",
    source,
  };
}

function readKotlinDiagnosticRange(match: RegExpExecArray): NonNullable<Diagnostic["range"]> {
  return {
    startColumn: readIntegerString(match[4]) ?? 1,
    startLine: readIntegerString(match[3]) ?? 1,
  };
}
