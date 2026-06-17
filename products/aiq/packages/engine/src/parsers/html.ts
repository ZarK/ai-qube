import type { Diagnostic } from "../contracts.js";
import { normalizeSeverity, readOptionalCode } from "./utils.js";

interface HtmlHintIssue {
  message: string;
  type?: string;
  line: number;
  col: number;
  rule?: {
    id?: string;
  };
}

export function createHtmlHintDiagnostic(file: string, issue: HtmlHintIssue): Diagnostic {
  const diagnostic: Diagnostic = {
    file,
    message: issue.message,
    severity: normalizeSeverity(issue.type),
    source: "htmlhint",
  };

  const code = readOptionalCode(issue.rule?.id);
  if (code !== undefined) {
    diagnostic.code = code;
  }

  if (Number.isFinite(issue.line) && Number.isFinite(issue.col)) {
    diagnostic.range = {
      startColumn: issue.col,
      startLine: issue.line,
    };
  }

  return diagnostic;
}
