import type { Diagnostic } from "../contracts.js";
import { readIntegerString, resolveDiagnosticFile } from "./utils.js";
import { decodeXmlEntities, parseXmlAttributes, stripXmlTags } from "./xml.js";

const pytestTracebackLocationPatterns = [
  /File "((?:[A-Za-z]:[\\/][^\r\n"]+?\.py|\\\\[^\r\n"]+?\.py|\/[^\r\n"]+?\.py|(?:\.\.?[\\/])?[^\r\n"]+?\.py))", line (\d+)/u,
  /File '((?:[A-Za-z]:[\\/][^\r\n']+?\.py|\\\\[^\r\n']+?\.py|\/[^\r\n']+?\.py|(?:\.\.?[\\/])?[^\r\n']+?\.py))', line (\d+)/u,
  /((?:[A-Za-z]:[\\/][^\r\n"]+?\.py|\\\\[^\r\n"]+?\.py|\/[^\r\n"]+?\.py|(?:\.\.?[\\/])?[^:\r\n]+?\.py)):(\d+)/u,
];

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
