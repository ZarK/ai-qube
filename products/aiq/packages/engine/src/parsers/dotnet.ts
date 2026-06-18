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
  const diagnostic: Diagnostic = {
    file,
    message: readDotNetFormatMessage(record),
    severity: "error",
    source: "dotnet-format",
  };
  const code = readString(record, "DiagnosticId") ?? readString(record, "diagnosticId");
  if (code !== undefined) {
    diagnostic.code = code;
  }

  const range = readDotNetFormatRange(record);
  if (range !== undefined) {
    diagnostic.range = range;
  }

  return diagnostic;
}

function readDotNetFormatMessage(record: Record<string, unknown>): string {
  return (
    readString(record, "FormatDescription") ??
    readString(record, "formatDescription") ??
    readString(record, "Message") ??
    readString(record, "message") ??
    "File requires formatting."
  );
}

function readDotNetFormatRange(record: Record<string, unknown>): Diagnostic["range"] | undefined {
  const lineNumber = readNumber(record.LineNumber ?? record.lineNumber);
  const charNumber = readNumber(record.CharNumber ?? record.charNumber);
  if (lineNumber === undefined || charNumber === undefined) {
    return undefined;
  }

  return {
    startColumn: charNumber,
    startLine: lineNumber,
  };
}

export function parseDotNetSarifDiagnostics(report: unknown, cwd: string): Diagnostic[] {
  if (typeof report !== "object" || report === null) {
    return [];
  }

  return readRecordArray(report, "runs").flatMap((run) =>
    readRecordArray(run, "results").map((result) => createDotNetSarifDiagnostic(result, cwd)),
  );
}

function createDotNetSarifDiagnostic(result: Record<string, unknown>, cwd: string): Diagnostic {
  const primaryLocation = readRecordArray(result, "locations")[0];
  const diagnostic: Diagnostic = {
    file: readDotNetSarifFile(primaryLocation, cwd),
    message: readDotNetSarifMessage(result),
    severity: normalizeSarifSeverity(readString(result, "level")),
    source: "dotnet-build",
  };
  const code = readString(result, "ruleId");
  if (code !== undefined) {
    diagnostic.code = code;
  }

  const range = readDotNetSarifRange(primaryLocation);
  if (range !== undefined) {
    diagnostic.range = range;
  }

  return diagnostic;
}

function readDotNetSarifFile(
  primaryLocation: Record<string, unknown> | undefined,
  cwd: string,
): string {
  const location = primaryLocation ?? {};
  return (
    resolveDiagnosticFile(
      readNestedString(location, ["physicalLocation", "artifactLocation", "uri"]) ??
        readNestedString(location, ["resultFile", "uri"]),
      cwd,
    ) ?? cwd
  );
}

function readDotNetSarifMessage(result: Record<string, unknown>): string {
  return (
    readNestedString(result, ["message", "text"]) ??
    readNestedString(result, ["message", "markdown"]) ??
    readString(result, "message") ??
    "dotnet build reported a diagnostic."
  );
}

function readDotNetSarifRange(
  primaryLocation: Record<string, unknown> | undefined,
): Diagnostic["range"] | undefined {
  const regionSource = readDotNetSarifRegion(primaryLocation);
  const startLine = readRegionNumber(regionSource, "startLine");
  const startColumn = readRegionNumber(regionSource, "startColumn");
  if (startLine === undefined || startColumn === undefined) {
    return undefined;
  }

  return createDotNetRange(
    startLine,
    startColumn,
    readRegionNumber(regionSource, "endLine"),
    readRegionNumber(regionSource, "endColumn"),
  );
}

function readDotNetSarifRegion(
  primaryLocation: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const location = primaryLocation ?? {};
  return (
    readNestedRecord(location, ["physicalLocation", "region"]) ??
    readNestedRecord(location, ["resultFile", "region"]) ??
    {}
  );
}

function readRegionNumber(regionSource: Record<string, unknown>, key: string): number | undefined {
  return readNumber(readNestedValue(regionSource, [key]));
}

function createDotNetRange(
  startLine: number,
  startColumn: number,
  endLine: number | undefined,
  endColumn: number | undefined,
): NonNullable<Diagnostic["range"]> {
  return {
    ...(endColumn === undefined ? {} : { endColumn }),
    ...(endLine === undefined ? {} : { endLine }),
    startColumn,
    startLine,
  };
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

  const summary = readDotNetTrxSummary(reportXml);
  const diagnostics: Diagnostic[] = [];

  for (const match of reportXml.matchAll(
    /<UnitTestResult\b([^>]*)>([\s\S]*?)<\/UnitTestResult>|<UnitTestResult\b([^>]*)\/>/gu,
  )) {
    const diagnostic = createDotNetTrxDiagnostic(match, reportXml, projectRoot);
    if (diagnostic === undefined) {
      continue;
    }

    diagnostics.push(diagnostic);
  }

  return {
    diagnostics,
    summary,
  };
}

function readDotNetTrxSummary(reportXml: string): {
  failed: number;
  passed: number;
  total: number;
} {
  const countersMatch = /<Counters\b([^>]*)\/>/u.exec(reportXml);
  const counters = parseXmlAttributes(countersMatch?.[1] ?? "");
  const total = readIntegerString(counters.total) ?? 0;
  const failed = readIntegerString(counters.failed) ?? 0;
  const passed = readIntegerString(counters.passed) ?? Math.max(0, total - failed);
  return { failed, passed, total };
}

function createDotNetTrxDiagnostic(
  match: RegExpMatchArray,
  reportXml: string,
  projectRoot: string,
): Diagnostic | undefined {
  const attributes = parseXmlAttributes(match[1] ?? match[3] ?? "");
  if (!isFailedDotNetTrxResult(attributes)) {
    return undefined;
  }

  const failure = readDotNetTrxFailure(match[2] ?? match[0] ?? "");
  const stackTraceLocation = readDotNetStackTraceLocation(failure.stackTrace, projectRoot);
  return addDotNetTrxRange(
    createDotNetTrxBaseDiagnostic(attributes, failure, reportXml, stackTraceLocation, projectRoot),
    stackTraceLocation,
  );
}

function isFailedDotNetTrxResult(attributes: Record<string, string>): boolean {
  return (attributes.outcome ?? "").toLowerCase() === "failed";
}

function createDotNetTrxBaseDiagnostic(
  attributes: Record<string, string>,
  failure: { message: string; stackTrace: string },
  reportXml: string,
  stackTraceLocation: { file: string; lineNumber?: number } | undefined,
  projectRoot: string,
): Diagnostic {
  return {
    file: readDotNetTrxFile(reportXml, attributes.testId, stackTraceLocation, projectRoot),
    message: [attributes.testName ?? "dotnet test failure", failure.message, failure.stackTrace]
      .filter((value) => value.trim().length > 0)
      .join("\n"),
    severity: "error",
    source: "dotnet-test",
  };
}

function addDotNetTrxRange(
  diagnostic: Diagnostic,
  stackTraceLocation: { file: string; lineNumber?: number } | undefined,
): Diagnostic {
  const range = readDotNetTrxRange(stackTraceLocation);
  if (range !== undefined) {
    diagnostic.range = range;
  }

  return diagnostic;
}

function readDotNetTrxRange(
  stackTraceLocation: { file: string; lineNumber?: number } | undefined,
): Diagnostic["range"] | undefined {
  const lineNumber = stackTraceLocation?.lineNumber;
  return lineNumber === undefined ? undefined : { startColumn: 1, startLine: lineNumber };
}

function readDotNetTrxFailure(resultBlock: string): { message: string; stackTrace: string } {
  const errorInfo = /<ErrorInfo>([\s\S]*?)<\/ErrorInfo>/u.exec(resultBlock)?.[1] ?? "";
  return {
    message: readDecodedXmlElement(errorInfo, "Message"),
    stackTrace: readDecodedXmlElement(errorInfo, "StackTrace"),
  };
}

function readDecodedXmlElement(xml: string, elementName: string): string {
  return decodeXmlEntities(
    new RegExp(`<${elementName}>([\\s\\S]*?)<\\/${elementName}>`, "u").exec(xml)?.[1] ?? "",
  ).trim();
}

function readDotNetTrxFile(
  reportXml: string,
  resultId: string | undefined,
  stackTraceLocation: { file: string; lineNumber?: number } | undefined,
  projectRoot: string,
): string {
  return (
    stackTraceLocation?.file ??
    resolveDiagnosticFile(readDotNetTrxCodeBase(reportXml, resultId), projectRoot) ??
    projectRoot
  );
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
