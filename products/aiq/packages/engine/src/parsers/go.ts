import type { Diagnostic } from "../contracts.js";
import {
  deduplicateDiagnostics,
  readIntegerString,
  readString,
  resolveDiagnosticFile,
} from "./utils.js";

export { collectGoVetDiagnostics, parseGoVetDiagnostics } from "./go-vet.js";

type GoTestReportState = {
  diagnostics: Diagnostic[];
  failed: number;
  packageOutputs: Map<string, string[]>;
  passed: number;
  testOutputs: Map<string, string[]>;
  total: number;
};
type GoTestEvent = {
  action: string | undefined;
  outputLine: string | undefined;
  packageKey: string;
  testKey: string;
  testName: string | undefined;
};

export function parseGoCompilerDiagnostics(
  output: string,
  cwd: string,
  source: string,
): Diagnostic[] {
  return deduplicateDiagnostics(
    output
      .split(/\r?\n/u)
      .map((line) => parseGoOutputDiagnosticLine(line, cwd, source))
      .filter((diagnostic): diagnostic is Diagnostic => diagnostic !== undefined),
  );
}

export function parseGoFormatDiagnostics(output: string, cwd: string): Diagnostic[] {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .flatMap((line) => {
      if (line.length === 0) {
        return [];
      }

      const file = resolveDiagnosticFile(line, cwd);
      if (file === undefined) {
        return [];
      }

      return [
        {
          file,
          message: "File requires formatting.",
          severity: "error" as const,
          source: "gofmt",
        },
      ];
    });
}

export function parseGoTestReport(
  output: string,
  cwd: string,
  source: string,
  fallbackFile: string,
): {
  diagnostics: Diagnostic[];
  summary: { failed: number; passed: number; total: number };
} {
  const state: GoTestReportState = {
    diagnostics: [],
    failed: 0,
    packageOutputs: new Map<string, string[]>(),
    passed: 0,
    testOutputs: new Map<string, string[]>(),
    total: 0,
  };

  for (const line of output.split(/\r?\n/u)) {
    const event = parseGoTestEvent(line, cwd);
    if (event === undefined) {
      continue;
    }

    applyGoTestEvent(event, state, cwd, source, fallbackFile);
  }

  const uniqueDiagnostics = deduplicateDiagnostics(state.diagnostics);
  const summary = readGoTestSummaryFromState(state, uniqueDiagnostics);

  return {
    diagnostics: uniqueDiagnostics,
    summary,
  };
}

function parseGoTestEvent(line: string, cwd: string): GoTestEvent | undefined {
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
  const packageKey = readString(record, "Package") ?? cwd;
  const testName = readString(record, "Test");
  return {
    action: readString(record, "Action"),
    outputLine: readString(record, "Output")?.replace(/\r?\n$/u, ""),
    packageKey,
    testKey: `${packageKey}::${testName ?? ""}`,
    testName,
  };
}

function applyGoTestEvent(
  event: GoTestEvent,
  state: GoTestReportState,
  cwd: string,
  source: string,
  fallbackFile: string,
): void {
  appendGoTestOutput(event, state);
  if (event.testName !== undefined && event.action === "pass") {
    state.total += 1;
    state.passed += 1;
    return;
  }
  if (event.testName !== undefined && event.action === "fail") {
    appendGoTestFailure(event, state, cwd, source, fallbackFile);
    return;
  }
  if (event.testName === undefined && event.action === "fail") {
    state.diagnostics.push(
      ...parseGoCompilerDiagnostics(
        (state.packageOutputs.get(event.packageKey) ?? []).join("\n"),
        cwd,
        source,
      ),
    );
  }
}

function appendGoTestOutput(event: GoTestEvent, state: GoTestReportState): void {
  if (event.outputLine === undefined || event.outputLine.length === 0) {
    return;
  }

  appendMapEntry(state.packageOutputs, event.packageKey, event.outputLine);
  if (event.testName !== undefined) {
    appendMapEntry(state.testOutputs, event.testKey, event.outputLine);
  }
}

function appendMapEntry(map: Map<string, string[]>, key: string, value: string): void {
  const entries = map.get(key) ?? [];
  entries.push(value);
  map.set(key, entries);
}

function appendGoTestFailure(
  event: GoTestEvent,
  state: GoTestReportState,
  cwd: string,
  source: string,
  fallbackFile: string,
): void {
  state.total += 1;
  state.failed += 1;
  state.diagnostics.push(
    createGoTestFailureDiagnostic(
      event.testName ?? "",
      state.testOutputs.get(event.testKey) ?? [],
      cwd,
      source,
      fallbackFile,
    ),
  );
}

function readGoTestSummaryFromState(
  state: GoTestReportState,
  diagnostics: readonly Diagnostic[],
): { failed: number; passed: number; total: number } {
  return state.total === 0 && diagnostics.length > 0
    ? { failed: diagnostics.length, passed: 0, total: diagnostics.length }
    : { failed: state.failed, passed: state.passed, total: state.total };
}

export function createGoTestFailureDiagnostic(
  testName: string,
  outputLines: readonly string[],
  cwd: string,
  source: string,
  fallbackFile: string,
): Diagnostic {
  const informativeLines = outputLines
    .map((line) => line.trimEnd())
    .filter(
      (line) =>
        line.trim().length > 0 &&
        !/^=== RUN/u.test(line.trim()) &&
        !/^--- (?:FAIL|PASS|SKIP):/u.test(line.trim()) &&
        !/^FAIL\b/u.test(line.trim()) &&
        !/^ok\s/u.test(line.trim()) &&
        !/^\?\s/u.test(line.trim()),
    );
  const locationDiagnostic = informativeLines
    .map((line) => parseGoOutputDiagnosticLine(line, cwd, source))
    .find((diagnostic) => diagnostic !== undefined);

  return {
    file: locationDiagnostic?.file ?? fallbackFile,
    message:
      informativeLines.length > 0
        ? `${testName}\n${informativeLines.join("\n")}`
        : `${testName} failed.`,
    ...(locationDiagnostic?.range === undefined ? {} : { range: locationDiagnostic.range }),
    severity: "error",
    source,
  };
}

export function parseGoCoveragePercent(output: string): number | undefined {
  const match = /^total:\s+\(statements\)\s+(\d+(?:\.\d+)?)%$/mu.exec(output);
  if (match?.[1] === undefined) {
    return undefined;
  }

  const parsed = Number.parseFloat(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseGoOutputDiagnosticLine(
  line: string,
  cwd: string,
  source: string,
): Diagnostic | undefined {
  const match = /^\s*(.*?\.go):(\d+)(?::(\d+))?:\s*(.+)$/u.exec(line.trim());
  if (match === null) {
    return undefined;
  }

  const parts = readGoDiagnosticLineMatchParts(match, cwd);
  if (parts === undefined) {
    return undefined;
  }

  return {
    file: parts.file,
    message: parts.message,
    range: {
      startColumn: parts.startColumn,
      startLine: parts.startLine,
    },
    severity: "error",
    source,
  };
}

function readGoDiagnosticLineMatchParts(
  match: RegExpExecArray,
  cwd: string,
):
  | {
      file: string;
      message: string;
      startColumn: number;
      startLine: number;
    }
  | undefined {
  const file = resolveDiagnosticFile(match[1], cwd);
  const startLine = readIntegerString(match[2]);
  const startColumn = readIntegerString(match[3]) ?? 1;
  const message = match[4]?.trim();
  return file === undefined ||
    startLine === undefined ||
    message === undefined ||
    message.length === 0
    ? undefined
    : { file, message, startColumn, startLine };
}

export function parseGoPosition(
  value: string | undefined,
  cwd: string,
): { file: string; range?: { startColumn: number; startLine: number } } | undefined {
  if (value === undefined) {
    return undefined;
  }

  const match = /^(.*?\.go):(\d+)(?::(\d+))?/u.exec(value.trim());
  if (match === null) {
    return undefined;
  }

  const file = resolveDiagnosticFile(match[1], cwd);
  const startLine = readIntegerString(match[2]);
  const startColumn = readIntegerString(match[3]) ?? 1;
  if (file === undefined || startLine === undefined) {
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
