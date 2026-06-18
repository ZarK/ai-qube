import type { Diagnostic } from "../contracts.js";
import {
  deduplicateDiagnostics,
  readIntegerString,
  readString,
  resolveDiagnosticFile,
} from "./utils.js";

export { collectGoVetDiagnostics, parseGoVetDiagnostics } from "./go-vet.js";

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
  const diagnostics: Diagnostic[] = [];
  const testOutputs = new Map<string, string[]>();
  const packageOutputs = new Map<string, string[]>();
  let failed = 0;
  let passed = 0;
  let total = 0;

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
    const action = readString(record, "Action");
    const packageName = readString(record, "Package") ?? cwd;
    const testName = readString(record, "Test");
    const outputLine = readString(record, "Output")?.replace(/\r?\n$/u, "");
    const packageKey = packageName;
    const testKey = `${packageKey}::${testName ?? ""}`;

    if (outputLine !== undefined && outputLine.length > 0) {
      const packageEntries = packageOutputs.get(packageKey) ?? [];
      packageEntries.push(outputLine);
      packageOutputs.set(packageKey, packageEntries);

      if (testName !== undefined) {
        const testEntries = testOutputs.get(testKey) ?? [];
        testEntries.push(outputLine);
        testOutputs.set(testKey, testEntries);
      }
    }

    if (testName !== undefined && action === "pass") {
      total += 1;
      passed += 1;
      continue;
    }

    if (testName !== undefined && action === "fail") {
      total += 1;
      failed += 1;
      diagnostics.push(
        createGoTestFailureDiagnostic(
          testName,
          testOutputs.get(testKey) ?? [],
          cwd,
          source,
          fallbackFile,
        ),
      );
      continue;
    }

    if (testName === undefined && action === "fail") {
      diagnostics.push(
        ...parseGoCompilerDiagnostics(
          (packageOutputs.get(packageKey) ?? []).join("\n"),
          cwd,
          source,
        ),
      );
    }
  }

  const uniqueDiagnostics = deduplicateDiagnostics(diagnostics);
  if (total === 0 && uniqueDiagnostics.length > 0) {
    total = uniqueDiagnostics.length;
    failed = uniqueDiagnostics.length;
    passed = 0;
  }

  return {
    diagnostics: uniqueDiagnostics,
    summary: { failed, passed, total },
  };
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

  const file = resolveDiagnosticFile(match[1], cwd);
  const startLine = readIntegerString(match[2]);
  const startColumn = readIntegerString(match[3]) ?? 1;
  const message = match[4]?.trim();
  if (
    file === undefined ||
    startLine === undefined ||
    message === undefined ||
    message.length === 0
  ) {
    return undefined;
  }

  return {
    file,
    message,
    range: {
      startColumn,
      startLine,
    },
    severity: "error",
    source,
  };
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
