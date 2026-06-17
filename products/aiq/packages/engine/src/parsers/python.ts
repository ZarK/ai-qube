import type { Diagnostic } from "../contracts.js";
import {
  normalizeMypySeverity,
  normalizeTySeverity,
  readIntegerString,
  readNestedString,
  readNestedValue,
  readNumber,
  readString,
  resolveDiagnosticFile,
} from "./utils.js";
import { decodeXmlEntities, parseXmlAttributes, stripXmlTags } from "./xml.js";

const pytestTracebackLocationPatterns = [
  /File "((?:[A-Za-z]:[\\/][^\r\n"]+?\.py|\\\\[^\r\n"]+?\.py|\/[^\r\n"]+?\.py|(?:\.\.?[\\/])?[^\r\n"]+?\.py))", line (\d+)/u,
  /File '((?:[A-Za-z]:[\\/][^\r\n']+?\.py|\\\\[^\r\n']+?\.py|\/[^\r\n']+?\.py|(?:\.\.?[\\/])?[^\r\n']+?\.py))', line (\d+)/u,
  /((?:[A-Za-z]:[\\/][^\r\n"]+?\.py|\\\\[^\r\n"]+?\.py|\/[^\r\n"]+?\.py|(?:\.\.?[\\/])?[^:\r\n]+?\.py)):(\d+)/u,
];

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

  return parsed.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) {
      return [];
    }

    const record = entry as Record<string, unknown>;
    const file = resolveDiagnosticFile(readNestedString(record, ["location", "path"]), cwd);
    if (file === undefined) {
      return [];
    }

    const startLine = readNumber(
      readNestedValue(record, ["location", "positions", "begin", "line"]),
    );
    const startColumn = readNumber(
      readNestedValue(record, ["location", "positions", "begin", "column"]),
    );
    const endLine = readNumber(readNestedValue(record, ["location", "positions", "end", "line"]));
    const endColumn = readNumber(
      readNestedValue(record, ["location", "positions", "end", "column"]),
    );
    const diagnostic: Diagnostic = {
      file,
      message: readString(record, "description") ?? "ty reported a diagnostic.",
      severity: normalizeTySeverity(readString(record, "severity")),
      source: "ty",
    };
    const code = readString(record, "check_name") ?? readTyDiagnosticCode(diagnostic.message);
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

function readTyDiagnosticCode(message: string): string | undefined {
  const match = /^([a-z0-9-]+):\s/iu.exec(message.trim());
  return match?.[1];
}

export function parsePytestReport(
  reportXml: string | undefined,
  projectRoot: string,
): {
  diagnostics: Diagnostic[];
  summary: { failed: number; passed: number; total: number };
} {
  if (reportXml === undefined) {
    return {
      diagnostics: [],
      summary: { failed: 0, passed: 0, total: 0 },
    };
  }

  const suiteAttributes = parseXmlAttributes(/<testsuite\b([^>]*)/u.exec(reportXml)?.[1] ?? "");
  const total = readIntegerString(suiteAttributes.tests) ?? 0;
  const failures = readIntegerString(suiteAttributes.failures) ?? 0;
  const errors = readIntegerString(suiteAttributes.errors) ?? 0;
  const skipped = readIntegerString(suiteAttributes.skipped) ?? 0;
  const failed = failures + errors;
  const passed = Math.max(0, total - failed - skipped);
  const diagnostics: Diagnostic[] = [];

  for (const match of reportXml.matchAll(
    /<testcase\b([^>]*)>([\s\S]*?)<\/testcase>|<testcase\b([^>]*)\/>/gu,
  )) {
    const attributeSource = match[1] ?? match[3] ?? "";
    const testcaseAttributes = parseXmlAttributes(attributeSource);
    const body = match[2] ?? "";
    const failureMatch = /<(failure|error)\b([^>]*)>([\s\S]*?)<\/\1>/u.exec(body);
    if (failureMatch === null) {
      continue;
    }

    const failureAttributes = parseXmlAttributes(failureMatch[2] ?? "");
    const failureMessage = decodeXmlEntities(failureAttributes.message ?? "").trim();
    const failureBody = decodeXmlEntities(stripXmlTags(failureMatch[3] ?? "")).trim();
    const failureLocation = readPytestFailureLocation(failureBody, projectRoot);
    const file =
      resolveDiagnosticFile(testcaseAttributes.file, projectRoot) ??
      failureLocation?.file ??
      projectRoot;
    const messageParts = [
      testcaseAttributes.name ?? "Pytest failure",
      failureMessage,
      failureBody,
    ].filter((value) => value !== undefined && value.trim().length > 0);
    const diagnostic: Diagnostic = {
      file,
      message: messageParts.join("\n"),
      severity: "error",
      source: "pytest",
    };
    const lineNumber = failureLocation?.lineNumber;
    if (lineNumber !== undefined) {
      diagnostic.range = {
        startColumn: 1,
        startLine: lineNumber,
      };
    }
    diagnostics.push(diagnostic);
  }

  return {
    diagnostics,
    summary: { failed, passed, total },
  };
}

function readPytestFailureLocation(
  failureBody: string,
  projectRoot: string,
): { file: string; lineNumber?: number } | undefined {
  for (const pattern of pytestTracebackLocationPatterns) {
    const match = pattern.exec(failureBody);
    const file = resolveDiagnosticFile(match?.[1], projectRoot);
    if (file === undefined) {
      continue;
    }

    const lineNumber = readIntegerString(match?.[2]);

    return {
      file,
      ...(lineNumber === undefined ? {} : { lineNumber }),
    };
  }

  return undefined;
}

export function parsePythonMetrics(output: string): Record<string, PythonMetricsFileMetrics> {
  const trimmed = output.trim();
  if (trimmed.length === 0) {
    throw new Error("Radon produced no JSON metrics output.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`Failed to parse radon JSON output: ${readOutputSnippet(trimmed)}`);
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Radon metrics output was not a JSON object.");
  }

  const results: Record<string, PythonMetricsFileMetrics> = {};
  for (const [file, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) {
      continue;
    }

    const record = value as Record<string, unknown>;
    const ccEntries = Array.isArray(record.cc)
      ? record.cc.flatMap((entry) => {
          if (typeof entry !== "object" || entry === null) {
            return [];
          }

          const block = entry as Record<string, unknown>;
          const complexity = readNumber(block.complexity);
          const endline = readNumber(block.endline);
          const lineno = readNumber(block.lineno);
          const name = readString(block, "name");
          const rank = readString(block, "rank");
          const type = readString(block, "type");
          if (
            complexity === undefined ||
            endline === undefined ||
            lineno === undefined ||
            name === undefined ||
            rank === undefined ||
            type === undefined
          ) {
            return [];
          }

          return [{ complexity, endline, lineno, name, rank, type }];
        })
      : [];
    const rawRecord =
      typeof record.raw === "object" && record.raw !== null
        ? (record.raw as Record<string, unknown>)
        : {};
    const miRecord =
      typeof record.mi === "object" && record.mi !== null
        ? (record.mi as Record<string, unknown>)
        : {};
    const readabilityRecord =
      typeof record.readability === "object" && record.readability !== null
        ? (record.readability as Record<string, unknown>)
        : undefined;

    results[file] = {
      cc: ccEntries,
      mi: {
        rank: readString(miRecord, "rank") ?? "A",
        score: readNumber(miRecord.score) ?? 0,
      },
      raw: {
        blank: readNumber(rawRecord.blank) ?? 0,
        comments: readNumber(rawRecord.comments) ?? 0,
        lloc: readNumber(rawRecord.lloc) ?? 0,
        loc: readNumber(rawRecord.loc) ?? 0,
        multi: readNumber(rawRecord.multi) ?? 0,
        singleComments: readNumber(rawRecord.singleComments) ?? 0,
        sloc: readNumber(rawRecord.sloc) ?? 0,
      },
      ...(readabilityRecord === undefined
        ? {}
        : {
            readability: {
              score: readNumber(readabilityRecord.score) ?? 0,
            },
          }),
    };
  }

  return results;
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

  return parsed.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) {
      return [];
    }

    const record = entry as Record<string, unknown>;
    const location = readNestedValue(record, ["location"]);
    if (typeof location !== "object" || location === null) {
      return [];
    }

    const locationRecord = location as Record<string, unknown>;
    const filePath = readString(locationRecord, "path");
    if (filePath === undefined) {
      return [];
    }

    const file = resolveDiagnosticFile(filePath, cwd);
    if (file === undefined) {
      return [];
    }

    const positions = readNestedValue(locationRecord, ["positions"]);
    const startLine = readNumber(
      readNestedValue(positions as Record<string, unknown>, ["begin", "line"]),
    );
    const startColumn = readNumber(
      readNestedValue(positions as Record<string, unknown>, ["begin", "column"]),
    );
    const endLine = readNumber(
      readNestedValue(positions as Record<string, unknown>, ["end", "line"]),
    );
    const endColumn = readNumber(
      readNestedValue(positions as Record<string, unknown>, ["end", "column"]),
    );
    const severity = readString(record, "severity");
    const message = readString(record, "description") ?? "ty reported a diagnostic.";
    const code = readString(record, "check_name");

    const diagnostic: Diagnostic = {
      file,
      message,
      severity: severity === "error" ? "error" : "warning",
      source: "ty",
    };

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

export function readOutputSnippet(output: string): string {
  const normalized = output.replace(/\s+/gu, " ").trim();
  if (normalized.length <= 160) {
    return normalized;
  }

  return `${normalized.slice(0, 157)}...`;
}

export interface PythonMetricsFileMetrics {
  cc: Array<{
    complexity: number;
    endline: number;
    lineno: number;
    name: string;
    rank: string;
    type: string;
  }>;
  mi: {
    rank: string;
    score: number;
  };
  raw: {
    blank: number;
    comments: number;
    lloc: number;
    loc: number;
    multi: number;
    singleComments: number;
    sloc: number;
  };
  readability?: {
    score: number;
  };
}
