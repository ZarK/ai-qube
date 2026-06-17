import type { Diagnostic } from "../contracts.js";
import { readRecordArray, readString, readStringArray, resolveDiagnosticFile } from "./utils.js";

export function parseTestRunnerDiagnostics(
  report: Record<string, unknown> | undefined,
  cwd: string,
  projectRoot: string,
  runner: "jest" | "vitest",
): Diagnostic[] {
  if (report === undefined) {
    return [];
  }

  const testResults = readRecordArray(report, "testResults");
  return testResults.flatMap((testResult) => {
    const file = resolveDiagnosticFile(readString(testResult, "name"), cwd) ?? projectRoot;
    const assertionResults = readRecordArray(testResult, "assertionResults");
    const assertionDiagnostics = assertionResults.flatMap((assertion) => {
      if (readString(assertion, "status") !== "failed") {
        return [];
      }

      const failureMessages = readStringArray(assertion, "failureMessages");
      const name =
        readString(assertion, "fullName") ?? readString(assertion, "title") ?? "Test failed.";

      return [
        {
          file,
          message: failureMessages.length > 0 ? `${name}\n${failureMessages.join("\n")}` : name,
          severity: "error" as const,
          source: runner,
        },
      ];
    });

    if (assertionDiagnostics.length > 0) {
      return assertionDiagnostics;
    }

    const message = readString(testResult, "message");
    if (message === undefined || message.trim().length === 0) {
      return [];
    }

    return [
      {
        file,
        message,
        severity: "error" as const,
        source: runner,
      },
    ];
  });
}
