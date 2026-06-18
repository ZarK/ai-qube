import type { Diagnostic, DiagnosticRange } from "../contracts.js";
import {
  deduplicateDiagnostics,
  readIntegerString,
  resolveDiagnosticFile,
  stripAnsiEscapes,
} from "./utils.js";
import { parseCargoJsonDiagnostics } from "./rust-cargo-json.js";

export { parseCargoJsonDiagnostics } from "./rust-cargo-json.js";

const rustLocationPatterns = [
  /^(.*?\.rs):(\d+):(\d+)$/u,
  /panicked at (.+?\.rs):(\d+):(\d+)(?::|$)/u,
  /(?:^|\s)([^\s:][^:\n]*?\.rs):(\d+):(\d+)(?::|$)/u,
];

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

    const block = readRustTestFailureBlock(lines, index, blockStart[1]);
    index = block.endIndex;
    diagnostics.push(createRustTestFailureDiagnostic(block, cwd, source, fallbackFile));
  }

  if (diagnostics.length > 0) {
    return deduplicateDiagnostics(diagnostics);
  }

  return deduplicateDiagnostics(parseRustCompilerTextDiagnostics(output, cwd, source));
}

function readRustTestFailureBlock(
  lines: readonly string[],
  startIndex: number,
  testName: string | undefined,
): { endIndex: number; lines: string[]; testName: string } {
  const blockLines: string[] = [];
  let index = startIndex + 1;
  while (index < lines.length) {
    const trimmed = lines[index]?.trim() ?? "";
    if (isRustTestFailureBlockTerminator(trimmed)) {
      return createRustTestFailureBlock(blockLines, index - 1, testName);
    }

    blockLines.push(lines[index] ?? "");
    index += 1;
  }

  return createRustTestFailureBlock(blockLines, index, testName);
}

function isRustTestFailureBlockTerminator(line: string): boolean {
  return /^----\s+.+\s+stdout\s+----$/u.test(line) || line === "failures:";
}

function createRustTestFailureBlock(
  lines: string[],
  endIndex: number,
  testName: string | undefined,
): { endIndex: number; lines: string[]; testName: string } {
  return {
    endIndex,
    lines,
    testName: testName ?? "Rust test failure",
  };
}

function createRustTestFailureDiagnostic(
  block: { lines: string[]; testName: string },
  cwd: string,
  source: string,
  fallbackFile: string,
): Diagnostic {
  const location = block.lines
    .map((line) => parseRustLocationLine(line, cwd))
    .find((value) => value !== undefined);
  const messageLines = block.lines.filter((line) => line.trim().length > 0);
  return {
    file: location?.file ?? fallbackFile,
    message:
      messageLines.length > 0
        ? `${block.testName}\n${messageLines.join("\n")}`
        : `${block.testName} failed.`,
    ...(location?.range === undefined ? {} : { range: location.range }),
    severity: "error",
    source,
  };
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
    const header = parseRustCompilerHeader(trimmed);
    if (header !== undefined) {
      current = header;
      continue;
    }

    if (current === undefined) {
      continue;
    }

    const diagnostic = createRustCompilerTextDiagnostic(trimmed, cwd, source, current);
    if (diagnostic === undefined) {
      continue;
    }

    diagnostics.push(diagnostic);
    current = undefined;
  }

  return diagnostics;
}

function parseRustCompilerHeader(
  line: string,
): { code?: string; message: string; severity: Diagnostic["severity"] } | undefined {
  const headerMatch = /^(error|warning)(?:\[([^\]]+)\])?:\s+(.+)$/u.exec(line);
  if (headerMatch === null) {
    return undefined;
  }

  return {
    ...(headerMatch[2] === undefined ? {} : { code: headerMatch[2] }),
    message: headerMatch[3] ?? "Rust compiler reported a diagnostic.",
    severity: headerMatch[1] === "warning" ? "warning" : "error",
  };
}

function createRustCompilerTextDiagnostic(
  line: string,
  cwd: string,
  source: string,
  current: { code?: string; message: string; severity: Diagnostic["severity"] },
): Diagnostic | undefined {
  const locationMatch = /^-->\s+(.+)$/u.exec(line);
  const location = parseRustLocationLine(locationMatch?.[1] ?? "", cwd);
  if (location === undefined) {
    return undefined;
  }

  return {
    ...(current.code === undefined ? {} : { code: current.code }),
    file: location.file,
    message: current.message,
    ...(location.range === undefined ? {} : { range: location.range }),
    severity: current.severity,
    source,
  };
}

export function parseRustLocationLine(
  line: string,
  cwd: string,
): { file: string; range?: DiagnosticRange } | undefined {
  const trimmed = line.trim();
  const match = readRustLocationMatch(trimmed);
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

function readRustLocationMatch(line: string): RegExpExecArray | null {
  for (const pattern of rustLocationPatterns) {
    const match = pattern.exec(line);
    if (match !== null) {
      return match;
    }
  }

  return null;
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
