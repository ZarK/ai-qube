import type { Diagnostic } from "../contracts.js";
import {
  normalizeSeverity,
  readNestedValue,
  readNumber,
  readOptionalCode,
  readRecordArray,
  readRecordArrayFromValue,
  readString,
  resolveDiagnosticFile,
} from "./utils.js";

export function parseStylelintDiagnostics(report: string, cwd: string): Diagnostic[] {
  const trimmed = report.trim();
  if (trimmed.length === 0) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error("Stylelint did not return a valid JSON report.", { cause: error });
  }

  return readRecordArrayFromValue(parsed).flatMap((entry) => {
    const file = resolveDiagnosticFile(readString(entry, "source"), cwd) ?? cwd;
    const warnings = readRecordArray(entry, "warnings").map((warning) => {
      const diagnostic: Diagnostic = {
        file,
        message: readString(warning, "text") ?? "Stylelint reported a diagnostic.",
        severity: normalizeSeverity(readString(warning, "severity")),
        source: "stylelint",
      };

      const code = readOptionalCode(readString(warning, "rule"));
      if (code !== undefined) {
        diagnostic.code = code;
      }

      const startLine = readNumber(readNestedValue(warning, ["line"]));
      const startColumn = readNumber(readNestedValue(warning, ["column"]));
      const endLine = readNumber(readNestedValue(warning, ["endLine"]));
      const endColumn = readNumber(readNestedValue(warning, ["endColumn"]));
      if (startLine !== undefined && startColumn !== undefined) {
        diagnostic.range = {
          ...(endColumn === undefined ? {} : { endColumn }),
          ...(endLine === undefined ? {} : { endLine }),
          startColumn,
          startLine,
        };
      }

      return diagnostic;
    });
    const invalidOptionWarnings: Diagnostic[] = readRecordArray(entry, "invalidOptionWarnings").map(
      (warning) => ({
        file,
        message: readString(warning, "text") ?? "Stylelint reported an invalid option warning.",
        severity: "error",
        source: "stylelint",
      }),
    );

    return [...warnings, ...invalidOptionWarnings];
  });
}
