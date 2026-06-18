import { realpathSync } from "node:fs";
import path from "node:path";

import type { Diagnostic, StageId } from "./contracts.js";
import * as parsers from "./parsers/index.js";
import { formatError } from "./runner-results.js";
import { readNumber } from "./runner-toolbox.js";

export function normalizeDiagnosticsToSelection(
  diagnostics: readonly Diagnostic[],
  selectedFiles: readonly string[],
): Diagnostic[] {
  if (diagnostics.length === 0 || selectedFiles.length === 0) {
    return [...diagnostics];
  }

  const selectedPaths = selectedFiles.map((file) => ({
    file,
    normalized: path.normalize(file),
    realPath: tryRealpath(file),
  }));

  return diagnostics.map((diagnostic) => {
    const matchedFile = matchDiagnosticFile(diagnostic.file, selectedPaths);
    if (matchedFile === undefined || matchedFile === diagnostic.file) {
      return diagnostic;
    }

    return {
      ...diagnostic,
      file: matchedFile,
    };
  });
}

function matchDiagnosticFile(
  file: string,
  selectedPaths: ReadonlyArray<{ file: string; normalized: string; realPath: string | undefined }>,
): string | undefined {
  const normalized = path.normalize(file);
  const directMatch = selectedPaths.find((entry) => entry.normalized === normalized);
  if (directMatch !== undefined) {
    return directMatch.file;
  }

  const realPath = tryRealpath(file);
  if (realPath === undefined) {
    return undefined;
  }

  return selectedPaths.find((entry) => entry.realPath === realPath)?.file;
}

function tryRealpath(filePath: string): string | undefined {
  try {
    return realpathSync.native(filePath);
  } catch {
    return undefined;
  }
}

export function deduplicateDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  const uniqueDiagnostics: Diagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const key = [
      diagnostic.source,
      diagnostic.code ?? "",
      diagnostic.file,
      diagnostic.range?.startLine ?? "",
      diagnostic.range?.startColumn ?? "",
      diagnostic.message,
    ].join("|");
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    uniqueDiagnostics.push(diagnostic);
  }

  return uniqueDiagnostics;
}

export function createMissingStylelintConfigNote(
  stageId: StageId,
  files: readonly string[],
): string {
  if (files.length === 0) {
    return `No Stylelint configuration was detected for ${stageId}.`;
  }

  return `No Stylelint configuration was detected for ${stageId} in: ${files.join(", ")}. Add a Stylelint config such as .stylelintrc.json, or disable CSS lint for those files.`;
}

export function createMissingStylelintConfigDiagnostics(
  stageId: StageId,
  files: readonly string[],
): Diagnostic[] {
  return files.map((file) => ({
    file,
    message: `CSS ${stageId} requires a Stylelint configuration for this file. Add a Stylelint config such as .stylelintrc.json, or disable CSS lint for this file.`,
    severity: "error",
    source: "stylelint",
  }));
}

export function isMissingStylelintConfigError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    error.name === "ConfigurationError" &&
    error.message.startsWith("No configuration provided")
  );
}

export function parseStylelintDiagnostics(report: string, cwd: string): Diagnostic[] {
  return parsers.parseStylelintDiagnostics(report, cwd);
}

export function createFormattingDiagnostic(file: string, source: string): Diagnostic {
  return {
    file,
    message: "File requires formatting.",
    severity: "error",
    source,
  };
}

export function createPrettierDiagnostic(file: string, error: unknown): Diagnostic {
  const diagnostic: Diagnostic = {
    file,
    message: formatError(error).trim() || "Prettier could not parse the file.",
    severity: "error",
    source: "prettier",
  };

  if (typeof error !== "object" || error === null || !("loc" in error)) {
    return diagnostic;
  }

  const location = (
    error as {
      loc?: {
        end?: { column?: number; line?: number };
        start?: { column?: number; line?: number };
      };
    }
  ).loc;
  const startLine = readNumber(location?.start?.line);
  const startColumn = readNumber(location?.start?.column);
  const endLine = readNumber(location?.end?.line);
  const endColumn = readNumber(location?.end?.column);
  if (startLine !== undefined && startColumn !== undefined) {
    diagnostic.range = {
      ...(endColumn === undefined ? {} : { endColumn }),
      ...(endLine === undefined ? {} : { endLine }),
      startColumn,
      startLine,
    };
  }

  return diagnostic;
}

export function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}
