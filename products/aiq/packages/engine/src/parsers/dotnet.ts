import type { Diagnostic } from "../contracts.js";
import {
  normalizeSarifSeverity,
  readIntegerString,
  readNestedRecord,
  readNestedString,
  readNestedValue,
  readNumber,
  readRecordArray,
  readRecordArrayFromValue,
  readString,
  resolveDiagnosticFile,
} from "./utils.js";
import { decodeXmlEntities, parseXmlAttributes } from "./xml.js";

const dotNetStackTraceLocationPatterns = [
  /\bin\s+((?:[A-Za-z]:[\\/][^\r\n]+?\.cs|\\\\[^\r\n]+?\.cs|\/[^\r\n]+?\.cs|(?:\.\.?[\\/])?[^\r\n:]+?\.cs)):line\s+(\d+)/u,
  /((?:[A-Za-z]:[\\/][^\r\n]+?\.cs|\\\\[^\r\n]+?\.cs|\/[^\r\n]+?\.cs|(?:\.\.?[\\/])?[^\r\n:]+?\.cs)):(\d+)/u,
];

export function parseDotNetFormatDiagnostics(report: unknown, cwd: string): Diagnostic[] {
  if (!Array.isArray(report)) {
    return [];
  }

  return report.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) {
      return [];
    }

    const record = entry as Record<string, unknown>;
    const file = resolveDiagnosticFile(
      readString(record, "FilePath") ?? readString(record, "filePath"),
      cwd,
    );
    if (file === undefined) {
      return [];
    }

    const fileChanges = readRecordArrayFromValue(record.FileChanges ?? record.fileChanges);
    if (fileChanges.length > 0) {
      return fileChanges.flatMap((change) => {
        const diagnostic = createDotNetFormatDiagnostic(file, change);
        return diagnostic === undefined ? [] : [diagnostic];
      });
    }

    const diagnostic = createDotNetFormatDiagnostic(file, record);
    return diagnostic === undefined ? [] : [diagnostic];
  });
}

function createDotNetFormatDiagnostic(
  file: string,
  record: Record<string, unknown>,
): Diagnostic | undefined {
  const message =
    readString(record, "FormatDescription") ??
    readString(record, "formatDescription") ??
    readString(record, "Message") ??
    readString(record, "message") ??
    "File requires formatting.";
  const diagnostic: Diagnostic = {
    file,
    message,
    severity: "error",
    source: "dotnet-format",
  };
  const code = readString(record, "DiagnosticId") ?? readString(record, "diagnosticId");
  if (code !== undefined) {
    diagnostic.code = code;
  }

  const lineNumber = readNumber(record.LineNumber ?? record.lineNumber);
  const charNumber = readNumber(record.CharNumber ?? record.charNumber);
  if (lineNumber !== undefined && charNumber !== undefined) {
    diagnostic.range = {
      startColumn: charNumber,
      startLine: lineNumber,
    };
  }

  return diagnostic;
}

export function parseDotNetSarifDiagnostics(report: unknown, cwd: string): Diagnostic[] {
  if (typeof report !== "object" || report === null) {
    return [];
  }

  return readRecordArray(report, "runs").flatMap((run) =>
    readRecordArray(run, "results").flatMap((result) => {
      const locations = readRecordArray(result, "locations");
      const primaryLocation = locations[0];
      const regionSource =
        readNestedRecord(primaryLocation ?? {}, ["physicalLocation", "region"]) ??
        readNestedRecord(primaryLocation ?? {}, ["resultFile", "region"]);
      const file =
        resolveDiagnosticFile(
          readNestedString(primaryLocation ?? {}, [
            "physicalLocation",
            "artifactLocation",
            "uri",
          ]) ?? readNestedString(primaryLocation ?? {}, ["resultFile", "uri"]),
          cwd,
        ) ?? cwd;
      const diagnostic: Diagnostic = {
        file,
        message:
          readNestedString(result, ["message", "text"]) ??
          readNestedString(result, ["message", "markdown"]) ??
          readString(result, "message") ??
          "dotnet build reported a diagnostic.",
        severity: normalizeSarifSeverity(readString(result, "level")),
        source: "dotnet-build",
      };
      const code = readString(result, "ruleId");
      if (code !== undefined) {
        diagnostic.code = code;
      }

      const startLine = readNumber(readNestedValue(regionSource ?? {}, ["startLine"]));
      const startColumn = readNumber(readNestedValue(regionSource ?? {}, ["startColumn"]));
      const endLine = readNumber(readNestedValue(regionSource ?? {}, ["endLine"]));
      const endColumn = readNumber(readNestedValue(regionSource ?? {}, ["endColumn"]));
      if (startLine !== undefined && startColumn !== undefined) {
        diagnostic.range = {
          ...(endColumn === undefined ? {} : { endColumn }),
          ...(endLine === undefined ? {} : { endLine }),
          startColumn,
          startLine,
        };
      }

      return [diagnostic];
    }),
  );
}

export function parseDotNetTrxReport(
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

  const countersMatch = /<Counters\b([^>]*)\/>/u.exec(reportXml);
  const counters = parseXmlAttributes(countersMatch?.[1] ?? "");
  const total = readIntegerString(counters.total) ?? 0;
  const failed = readIntegerString(counters.failed) ?? 0;
  const passed = readIntegerString(counters.passed) ?? Math.max(0, total - failed);
  const diagnostics: Diagnostic[] = [];

  for (const match of reportXml.matchAll(
    /<UnitTestResult\b([^>]*)>([\s\S]*?)<\/UnitTestResult>|<UnitTestResult\b([^>]*)\/>/gu,
  )) {
    const attributes = parseXmlAttributes(match[1] ?? match[3] ?? "");
    if ((attributes.outcome ?? "").toLowerCase() !== "failed") {
      continue;
    }

    const resultId = attributes.testId;
    const testName = attributes.testName ?? "dotnet test failure";
    const resultBlock = match[2] ?? match[0] ?? "";
    const errorInfo = /<ErrorInfo>([\s\S]*?)<\/ErrorInfo>/u.exec(resultBlock)?.[1] ?? "";
    const message = decodeXmlEntities(
      /<Message>([\s\S]*?)<\/Message>/u.exec(errorInfo)?.[1] ?? "",
    ).trim();
    const stackTrace = decodeXmlEntities(
      /<StackTrace>([\s\S]*?)<\/StackTrace>/u.exec(errorInfo)?.[1] ?? "",
    ).trim();
    const stackTraceLocation = readDotNetStackTraceLocation(stackTrace, projectRoot);
    const file =
      stackTraceLocation?.file ??
      resolveDiagnosticFile(readDotNetTrxCodeBase(reportXml, resultId), projectRoot) ??
      projectRoot;
    const diagnostic: Diagnostic = {
      file,
      message: [testName, message, stackTrace]
        .filter((value) => value !== undefined && value.trim().length > 0)
        .join("\n"),
      severity: "error",
      source: "dotnet-test",
    };
    const lineNumber = stackTraceLocation?.lineNumber;
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

function readDotNetStackTraceLocation(
  stackTrace: string,
  projectRoot: string,
): { file: string; lineNumber?: number } | undefined {
  for (const pattern of dotNetStackTraceLocationPatterns) {
    const match = pattern.exec(stackTrace);
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

function readDotNetTrxCodeBase(
  reportXml: string,
  executionId: string | undefined,
): string | undefined {
  if (executionId === undefined || executionId.length === 0) {
    return undefined;
  }

  const escapedExecutionId = escapeRegExp(executionId);
  const unitTestMatch = new RegExp(
    `<UnitTest\\b[^>]*id="${escapedExecutionId}"[^>]*>[\\s\\S]*?<TestMethod\\b([^>]*)\\/>[\\s\\S]*?<\\/UnitTest>`,
    "u",
  ).exec(reportXml);
  if (unitTestMatch === null) {
    return undefined;
  }

  return parseXmlAttributes(unitTestMatch[1] ?? "").codeBase;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
