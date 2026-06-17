import type { Diagnostic } from "../contracts.js";
import { readIntegerString, resolveDiagnosticFile } from "./utils.js";
import { decodeXmlEntities, parseXmlAttributes, stripXmlTags } from "./xml.js";

export async function parseJvmJunitReport(
  reportXml: string | undefined,
  projectRoot: string,
): Promise<{
  diagnostics: Diagnostic[];
  summary: { failed: number; passed: number; total: number };
}> {
  if (reportXml === undefined) {
    return {
      diagnostics: [],
      summary: { failed: 0, passed: 0, total: 0 },
    };
  }

  const suiteAttributes = parseXmlAttributes(/<testsuite\b([^>]*)>/u.exec(reportXml)?.[1] ?? "");
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
    const locationMatch = /(\/[^\s:]+\.java):(\d+)/u.exec(failureBody);
    const file =
      resolveDiagnosticFile(testcaseAttributes.file, projectRoot) ??
      resolveDiagnosticFile(locationMatch?.[1], projectRoot) ??
      projectRoot;
    const messageParts = [
      testcaseAttributes.name ?? "Test failure",
      failureMessage,
      failureBody,
    ].filter((value) => value !== undefined && value.trim().length > 0);
    const diagnostic: Diagnostic = {
      file,
      message: messageParts.join("\n"),
      severity: "error",
      source: "junit",
    };
    const lineNumber = readIntegerString(locationMatch?.[2]);
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

export async function parseJvmJunitReports(
  reportPaths: readonly string[],
  fallbackFile: string,
  readReport: (reportPath: string) => Promise<string | undefined>,
): Promise<{
  diagnostics: Diagnostic[];
  summary: { failed: number; passed: number; total: number };
}> {
  let total = 0;
  let failed = 0;
  let passed = 0;
  const diagnostics: Diagnostic[] = [];

  for (const reportPath of reportPaths) {
    const reportXml = await readReport(reportPath);
    if (reportXml === undefined) {
      continue;
    }

    const suites = [...reportXml.matchAll(/<testsuite\b([^>]*)/gu)].map((match) =>
      parseXmlAttributes(match[1] ?? ""),
    );
    if (suites.length > 0) {
      total += suites.reduce(
        (sum, attributes) => sum + (readIntegerString(attributes.tests) ?? 0),
        0,
      );
      const suiteFailures = suites.reduce(
        (sum, attributes) =>
          sum +
          (readIntegerString(attributes.failures) ?? 0) +
          (readIntegerString(attributes.errors) ?? 0),
        0,
      );
      failed += suiteFailures;
      passed += Math.max(
        0,
        suites.reduce((sum, attributes) => sum + (readIntegerString(attributes.tests) ?? 0), 0) -
          suiteFailures -
          suites.reduce((sum, attributes) => sum + (readIntegerString(attributes.skipped) ?? 0), 0),
      );
    }

    for (const match of reportXml.matchAll(/<testcase\b([^>]*)>([\s\S]*?)<\/(?:testcase)>/gu)) {
      const testcaseAttributes = parseXmlAttributes(match[1] ?? "");
      const body = match[2] ?? "";
      const failureMatch = /<(failure|error)\b([^>]*)>([\s\S]*?)<\/\1>/u.exec(body);
      if (failureMatch === null) {
        continue;
      }

      const failureAttributes = parseXmlAttributes(failureMatch[2] ?? "");
      diagnostics.push({
        file: fallbackFile,
        message: [
          testcaseAttributes.name ?? testcaseAttributes.classname ?? "JVM test failure",
          decodeXmlEntities(failureAttributes.message ?? "").trim(),
          decodeXmlEntities(stripXmlTags(failureMatch[3] ?? "")).trim(),
        ]
          .filter((value) => value.length > 0)
          .join("\n"),
        severity: "error",
        source: "junit",
      });
    }
  }

  if (total === 0 && diagnostics.length > 0) {
    total = diagnostics.length;
    failed = diagnostics.length;
    passed = 0;
  }

  return {
    diagnostics,
    summary: { failed, passed, total },
  };
}
