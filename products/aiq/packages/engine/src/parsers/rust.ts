import type { Diagnostic, DiagnosticRange } from "../contracts.js";
import {
  deduplicateDiagnostics,
  normalizeRustSeverity,
  readIntegerString,
  readNestedRecord,
  readNestedString,
  readNumber,
  readRecordArrayFromValue,
  readString,
  resolveDiagnosticFile,
  stripAnsiEscapes,
} from "./utils.js";

export function parseCargoJsonDiagnostics(
  output: string,
  cwd: string,
  source: string,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const line of output.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (typeof parsed !== "object" || parsed === null) {
      continue;
    }

    const record = parsed as Record<string, unknown>;
    if (readString(record, "reason") !== "compiler-message") {
      continue;
    }

    const message = readNestedRecord(record, ["message"]);
    if (message === undefined) {
      continue;
    }

    const file = readRustDiagnosticFile(message, cwd);
    if (file === undefined) {
      continue;
    }

    const rustDiagnostic: Diagnostic = {
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
      rustDiagnostic.code = code;
    }

    const range = readRustDiagnosticRange(message);
    if (range !== undefined) {
      rustDiagnostic.range = range;
    }

    diagnostics.push(rustDiagnostic);
  }

  return deduplicateDiagnostics(diagnostics);
}

export function readRustDiagnosticFile(
  message: Record<string, unknown>,
  cwd: string,
): string | undefined {
  const spans = readRecordArrayFromValue(message.spans);
  const primarySpan = spans.find((span) => span.is_primary === true) ?? spans[0];
  return resolveDiagnosticFile(readString(primarySpan ?? {}, "file_name"), cwd);
}

export function readRustDiagnosticRange(
  message: Record<string, unknown>,
): DiagnosticRange | undefined {
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

export function parseRustFormatDiagnostics(output: string, cwd: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const line of stripAnsiEscapes(output).split(/\r?\n/u)) {
    const match = /^Diff in (.+?\.rs):(\d+):/u.exec(line.trim());
    if (match === null) {
      continue;
    }

    const file = resolveDiagnosticFile(match[1], cwd);
    const startLine = readIntegerString(match[2]);
    if (file === undefined) {
      continue;
    }

    diagnostics.push({
      file,
      message: "File requires formatting.",
      ...(startLine === undefined ? {} : { range: { startColumn: 1, startLine } }),
      severity: "error",
      source: "cargo-fmt",
    });
  }

  return deduplicateDiagnostics(diagnostics);
}

export function parseRustTestReport(
  output: string,
  cwd: string,
  source: string,
  fallbackFile: string,
): {
  diagnostics: Diagnostic[];
  summary: { failed: number; passed: number; total: number };
} {
  const diagnostics = deduplicateDiagnostics([
    ...parseRustTestFailureDiagnostics(output, cwd, source, fallbackFile),
    ...parseCargoJsonDiagnostics(output, cwd, source),
  ]);
  const summary = readRustTestSummary(output, diagnostics.length);
  return {
    diagnostics,
    summary,
  };
}

export function isMissingCargoSubcommand(output: string, subcommand: string): boolean {
  const normalizedOutput = stripAnsiEscapes(output);
  return (
    normalizedOutput.includes(`no such command: \`${subcommand}\``) ||
    normalizedOutput.includes(`no such command: ${subcommand}`)
  );
}

export function parseRustTestFailureDiagnostics(
  output: string,
  cwd: string,
  source: string,
  fallbackFile: string,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const lines = stripAnsiEscapes(output).split(/\r?\n/u);

  for (let index = 0; index < lines.length; index += 1) {
    const blockStart = /^----\s+(.+)\s+stdout\s+----$/u.exec(lines[index]?.trim() ?? "");
    if (blockStart === null) {
      continue;
    }

    const testName = blockStart[1] ?? "Rust test failure";
    const blockLines: string[] = [];
    index += 1;
    while (index < lines.length) {
      const trimmed = lines[index]?.trim() ?? "";
      if (/^----\s+.+\s+stdout\s+----$/u.test(trimmed) || trimmed === "failures:") {
        index -= 1;
        break;
      }
      blockLines.push(lines[index] ?? "");
      index += 1;
    }

    const location = blockLines
      .map((line) => parseRustLocationLine(line, cwd))
      .find((value) => value !== undefined);
    diagnostics.push({
      file: location?.file ?? fallbackFile,
      message:
        blockLines.filter((line) => line.trim().length > 0).length > 0
          ? `${testName}\n${blockLines.filter((line) => line.trim().length > 0).join("\n")}`
          : `${testName} failed.`,
      ...(location?.range === undefined ? {} : { range: location.range }),
      severity: "error",
      source,
    });
  }

  if (diagnostics.length > 0) {
    return deduplicateDiagnostics(diagnostics);
  }

  return deduplicateDiagnostics(parseRustCompilerTextDiagnostics(output, cwd, source));
}

export function parseRustCompilerTextDiagnostics(
  output: string,
  cwd: string,
  source: string,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const lines = stripAnsiEscapes(output).split(/\r?\n/u);
  let current: { code?: string; message: string; severity: Diagnostic["severity"] } | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index]?.trim() ?? "";
    const headerMatch = /^(error|warning)(?:\[([^\]]+)\])?:\s+(.+)$/u.exec(trimmed);
    if (headerMatch !== null) {
      current = {
        ...(headerMatch[2] === undefined ? {} : { code: headerMatch[2] }),
        message: headerMatch[3] ?? "Rust compiler reported a diagnostic.",
        severity: headerMatch[1] === "warning" ? "warning" : "error",
      };
      continue;
    }

    if (current === undefined) {
      continue;
    }

    const locationMatch = /^-->\s+(.+)$/u.exec(trimmed);
    if (locationMatch === null) {
      continue;
    }

    const location = parseRustLocationLine(locationMatch[1] ?? "", cwd);
    if (location === undefined) {
      continue;
    }

    diagnostics.push({
      ...(current.code === undefined ? {} : { code: current.code }),
      file: location.file,
      message: current.message,
      ...(location.range === undefined ? {} : { range: location.range }),
      severity: current.severity,
      source,
    });
    current = undefined;
  }

  return diagnostics;
}

export function parseRustLocationLine(
  line: string,
  cwd: string,
): { file: string; range?: DiagnosticRange } | undefined {
  const trimmed = line.trim();
  const match =
    /^(.*?\.rs):(\d+):(\d+)$/u.exec(trimmed) ??
    /panicked at (.+?\.rs):(\d+):(\d+)(?::|$)/u.exec(trimmed) ??
    /(?:^|\s)([^\s:][^:\n]*?\.rs):(\d+):(\d+)(?::|$)/u.exec(trimmed);
  if (match === null) {
    return undefined;
  }

  const file = resolveDiagnosticFile(match[1], cwd);
  const startLine = readIntegerString(match[2]);
  const startColumn = readIntegerString(match[3]);
  if (file === undefined || startLine === undefined || startColumn === undefined) {
    return undefined;
  }

  return {
    file,
    range: {
      startColumn,
      startLine,
    },
  };
}

export function readRustTestSummary(
  output: string,
  diagnosticCount: number,
): { failed: number; passed: number; total: number } {
  let passed = 0;
  let failed = 0;

  for (const summaryMatch of stripAnsiEscapes(output).matchAll(
    /test result:\s+(?:ok|FAILED).\s+(\d+) passed;\s+(\d+) failed;/gu,
  )) {
    passed += readIntegerString(summaryMatch[1]) ?? 0;
    failed += readIntegerString(summaryMatch[2]) ?? 0;
  }

  if (passed > 0 || failed > 0) {
    return {
      failed,
      passed,
      total: passed + failed,
    };
  }

  return {
    failed: diagnosticCount,
    passed: 0,
    total: diagnosticCount,
  };
}
