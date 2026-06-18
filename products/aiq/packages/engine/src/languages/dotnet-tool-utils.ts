import { realpathSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import type { Diagnostic } from "../contracts.js";
import { pathExists } from "../utils/path-utils.js";

export function createUnsupportedDotNetRunnerNote(
  stageId: string,
  files: readonly string[],
): string {
  if (files.length === 0) {
    return `No .NET project or solution target was detected for ${stageId}.`;
  }

  return `No .NET project or solution target was detected for ${stageId} in: ${files.join(", ")}.`;
}

export function readDotNetUnitNote(summary: {
  failed: number;
  passed: number;
  total: number;
}): string {
  if (summary.total === 0) {
    return "dotnet test found no tests.";
  }

  return `dotnet test ran ${summary.total} test${summary.total === 1 ? "" : "s"}: ${summary.passed} passed, ${summary.failed} failed.`;
}

export function readDotNetCoverageNote(
  summary: { failed: number; passed: number; total: number },
  coveragePercent: number | undefined,
): string {
  if (summary.total === 0) {
    return "dotnet test found no tests.";
  }

  if (coveragePercent === undefined) {
    return `dotnet test coverage completed after ${summary.total} test${summary.total === 1 ? "" : "s"}.`;
  }

  return `dotnet test coverage lines: ${coveragePercent.toFixed(1)}% across ${summary.total} test${summary.total === 1 ? "" : "s"}.`;
}

export function normalizeDotNetDiagnosticsToSelection(
  diagnostics: readonly Diagnostic[],
  selectedFiles: readonly string[],
): Diagnostic[] {
  return normalizeDiagnosticsToSelection(diagnostics, selectedFiles);
}

function normalizeDiagnosticsToSelection(
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

export async function readJsonValue(filePath: string): Promise<unknown> {
  if (!(await pathExists(filePath))) {
    return undefined;
  }

  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

export async function readOptionalTextFile(filePath: string | undefined): Promise<string | undefined> {
  if (filePath === undefined || !(await pathExists(filePath))) {
    return undefined;
  }

  return readFile(filePath, "utf8");
}

export async function findFirstFile(
  directory: string,
  predicate: (filePath: string) => boolean,
): Promise<string | undefined> {
  if (!(await pathExists(directory))) {
    return undefined;
  }

  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  );

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await findFirstFile(entryPath, predicate);
      if (nested !== undefined) {
        return nested;
      }
      continue;
    }

    if (entry.isFile() && predicate(entryPath)) {
      return entryPath;
    }
  }

  return undefined;
}
