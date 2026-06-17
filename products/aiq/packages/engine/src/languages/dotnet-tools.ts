import { realpathSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Diagnostic, ToolRunResult } from "../contracts.js";
import * as parsers from "../parsers/index.js";
import * as commands from "../tools/command-builders.js";
import { pathExists } from "../utils/path-utils.js";
import type { DotNetRunnerRuntime } from "./contracts.js";
import type { DotNetProject } from "./dotnet.js";

export type DotNetMetricsFileMetrics = {
  blockCount: number;
  maintainability: { rank: string; score: number };
  maxComplexity: { rank: string; score: number };
  raw: { sloc: number };
};

export type DotNetMetricsProjectMetrics = {
  args: string[];
  durationMs: number;
  exitCode: number | undefined;
  files: Record<string, DotNetMetricsFileMetrics>;
  finishedAt: string;
  startedAt: string;
};

export async function runDotNetFormatProject(
  project: DotNetProject,
  runtime: DotNetRunnerRuntime,
  options: {
    failureLabel: string;
    noteLabel: string;
    subcommand: "style" | "whitespace";
    tool: string;
  },
): Promise<{
  diagnostics: Diagnostic[];
  durationMs: number;
  note: string;
  toolRun: ToolRunResult;
}> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-dotnet-format-"));

  try {
    const reportDir = path.join(tempDir, "report");
    const args = commands.createDotNetFormatArgs({
      reportDir,
      subcommand: options.subcommand,
      targetPath: project.targetPath,
      verifyNoChanges: true,
    });
    const outcome = await runtime.runExecutable(
      runtime.resolveDotNetCommand(),
      args,
      project.projectRoot,
      runtime.signal,
    );
    const report = await readJsonValue(path.join(reportDir, "format-report.json"));
    const parsedDiagnostics = normalizeDiagnosticsToSelection(
      parsers.parseDotNetFormatDiagnostics(report, project.projectRoot),
      project.files,
    );
    const status = outcome.exitCode === 0 && parsedDiagnostics.length === 0 ? "passed" : "failed";

    if (status === "failed" && parsedDiagnostics.length === 0) {
      parsedDiagnostics.push(
        runtime.createProcessFailureDiagnostic(
          project.files[0] ?? project.targetPath,
          "dotnet-format",
          runtime.readProcessFailureMessage(
            options.failureLabel,
            outcome.stderr,
            outcome.stdout,
            outcome.exitCode,
          ),
        ),
      );
    }

    return {
      diagnostics: parsedDiagnostics,
      durationMs: outcome.durationMs,
      note:
        status === "passed"
          ? `${options.noteLabel} passed for ${path.basename(project.targetPath)}.`
          : `${options.noteLabel} reported ${parsedDiagnostics.length} diagnostic${parsedDiagnostics.length === 1 ? "" : "s"} for ${path.basename(project.targetPath)}.`,
      toolRun: runtime.createToolRunResult(
        options.tool,
        args,
        outcome.durationMs,
        outcome.exitCode,
        status,
        outcome.finishedAt,
        outcome.startedAt,
      ),
    };
  } finally {
    await rm(tempDir, { force: true, recursive: true }).catch(() => undefined);
  }
}

export async function runDotNetTypecheckProject(
  project: DotNetProject,
  runtime: DotNetRunnerRuntime,
): Promise<{
  diagnostics: Diagnostic[];
  durationMs: number;
  note: string;
  toolRun: ToolRunResult;
}> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-dotnet-build-"));

  try {
    const sarifPath = path.join(tempDir, "build.sarif.json");
    const args = commands.createDotNetBuildArgs({
      errorLog: sarifPath,
      nologo: true,
      targetPath: project.targetPath,
      verbosity: "minimal",
    });
    const outcome = await runtime.runExecutable(
      runtime.resolveDotNetCommand(),
      args,
      project.projectRoot,
      runtime.signal,
    );
    const report = await readJsonValue(sarifPath);
    const parsedDiagnostics = normalizeDiagnosticsToSelection(
      parsers.parseDotNetSarifDiagnostics(report, project.projectRoot),
      project.files,
    );

    if (outcome.exitCode !== 0 && parsedDiagnostics.length === 0) {
      parsedDiagnostics.push(
        runtime.createProcessFailureDiagnostic(
          project.files[0] ?? project.targetPath,
          "dotnet-build",
          runtime.readProcessFailureMessage(
            "dotnet build",
            outcome.stderr,
            outcome.stdout,
            outcome.exitCode,
          ),
        ),
      );
    }

    return {
      diagnostics: parsedDiagnostics,
      durationMs: outcome.durationMs,
      note:
        parsedDiagnostics.length === 0
          ? `dotnet build passed for ${path.basename(project.targetPath)}.`
          : `dotnet build reported ${parsedDiagnostics.length} diagnostic${parsedDiagnostics.length === 1 ? "" : "s"} for ${path.basename(project.targetPath)}.`,
      toolRun: runtime.createToolRunResult(
        "dotnet-build",
        args,
        outcome.durationMs,
        outcome.exitCode,
        outcome.exitCode === 0 && parsedDiagnostics.length === 0 ? "passed" : "failed",
        outcome.finishedAt,
        outcome.startedAt,
      ),
    };
  } finally {
    await rm(tempDir, { force: true, recursive: true }).catch(() => undefined);
  }
}

export async function runDotNetProjectTestTask(
  project: DotNetProject,
  mode: "coverage" | "unit",
  runtime: DotNetRunnerRuntime,
): Promise<{
  diagnostics: Diagnostic[];
  durationMs: number;
  note: string;
  toolRun: ToolRunResult;
}> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-dotnet-test-"));

  try {
    const trxPath = path.join(tempDir, "results.trx");
    const args = commands.createDotNetTestArgs({
      logger: `trx;LogFileName=${path.basename(trxPath)}`,
      nologo: true,
      resultsDir: tempDir,
      targetPath: project.targetPath,
      verbosity: "minimal",
    });
    if (mode === "coverage") {
      args.push("--collect", "XPlat Code Coverage");
    }

    const outcome = await runtime.runExecutable(
      runtime.resolveDotNetCommand(),
      args,
      project.projectRoot,
      runtime.signal,
    );
    const report = parsers.parseDotNetTrxReport(
      await readOptionalTextFile(trxPath),
      project.projectRoot,
    );
    const coverageReportPath =
      mode === "coverage"
        ? await findFirstFile(tempDir, (filePath) => filePath.endsWith("coverage.cobertura.xml"))
        : undefined;
    const coveragePercent =
      mode === "coverage"
        ? parsers.readCoberturaLineRate(
            coverageReportPath === undefined
              ? undefined
              : await readOptionalTextFile(coverageReportPath),
          )
        : undefined;
    const status = outcome.exitCode === 0 && report.diagnostics.length === 0 ? "passed" : "failed";

    if (status === "failed" && report.diagnostics.length === 0) {
      report.diagnostics.push(
        runtime.createProcessFailureDiagnostic(
          project.files[0] ?? project.targetPath,
          "dotnet-test",
          runtime.readProcessFailureMessage(
            "dotnet test",
            outcome.stderr,
            outcome.stdout,
            outcome.exitCode,
          ),
        ),
      );
    }

    return {
      diagnostics: report.diagnostics,
      durationMs: outcome.durationMs,
      note:
        mode === "coverage"
          ? readDotNetCoverageNote(report.summary, coveragePercent)
          : readDotNetUnitNote(report.summary),
      toolRun: runtime.createToolRunResult(
        mode === "coverage" ? "dotnet-test-coverage" : "dotnet-test",
        args,
        outcome.durationMs,
        outcome.exitCode,
        status,
        outcome.finishedAt,
        outcome.startedAt,
      ),
    };
  } finally {
    await rm(tempDir, { force: true, recursive: true }).catch(() => undefined);
  }
}

export async function getDotNetMetricsProjectMetrics(
  project: DotNetProject,
  runtime: DotNetRunnerRuntime,
): Promise<{ cacheHit: boolean; metrics: DotNetMetricsProjectMetrics }> {
  const manifestKey = createDotNetMetricsManifestKey(project);
  const cacheKey = await createDotNetMetricsCacheKey(project, manifestKey);
  const cached = await runtime.getCachedValue("metrics:dotnet", manifestKey, cacheKey, () =>
    runDotNetMetricsProjectTask(project, runtime),
  );

  return {
    cacheHit: cached.cacheHit,
    metrics: cached.value,
  };
}

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

function createDotNetMetricsManifestKey(project: DotNetProject): string {
  return `${project.targetPath}:${[...project.files].sort().join("|")}`;
}

async function createDotNetMetricsCacheKey(
  project: DotNetProject,
  manifestKey = createDotNetMetricsManifestKey(project),
): Promise<string> {
  const fileEntries = await Promise.all(
    [...project.files]
      .sort((left, right) => left.localeCompare(right))
      .map(async (file) => {
        const fileStats = await stat(file);
        return `${file}@${fileStats.size}:${fileStats.mtimeMs}`;
      }),
  );

  return `${manifestKey}:${fileEntries.join("|")}`;
}

async function runDotNetMetricsProjectTask(
  project: DotNetProject,
  runtime: DotNetRunnerRuntime,
): Promise<DotNetMetricsProjectMetrics> {
  if (runtime.signal?.aborted) {
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    runtime.throwIfAbortError(abortError);
  }

  const startedAt = new Date();
  const files = await Promise.all(
    project.files.map(
      async (file) =>
        [file, await readDotNetFileMetrics(await runtime.readFileText(file))] as const,
    ),
  );
  const finishedAt = new Date();

  return {
    args: ["scan", ...project.files],
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    exitCode: 0,
    files: Object.fromEntries(files),
    finishedAt: finishedAt.toISOString(),
    startedAt: startedAt.toISOString(),
  };
}

async function readDotNetFileMetrics(source: string): Promise<DotNetMetricsFileMetrics> {
  const stripped = stripDotNetComments(source);
  const codeLines = stripped
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const sloc = codeLines.length;
  const methodCount = countMatches(
    stripped,
    /^[ \t]*(?:\[[^\]]+\]\s*)*(?:(?:public|private|protected|internal|static|sealed|virtual|override|async|extern|unsafe|new|partial)\s+)*(?:[A-Za-z_][\w<>,?.\[\]]*\s+)+[A-Za-z_][\w]*\s*\([^;{}]*\)\s*(?:where\b[^\{]+)?\{/gmu,
  );
  const decisionCount =
    countMatches(stripped, /\bif\b/gu) +
    countMatches(stripped, /\bfor\b/gu) +
    countMatches(stripped, /\bforeach\b/gu) +
    countMatches(stripped, /\bwhile\b/gu) +
    countMatches(stripped, /\bcase\b/gu) +
    countMatches(stripped, /\bcatch\b/gu) +
    countMatches(stripped, /&&/gu) +
    countMatches(stripped, /\|\|/gu) +
    countDotNetTernaryOperators(stripped);
  const blockCount = methodCount;
  const maxComplexityScore =
    methodCount === 0 ? 0 : Math.max(1, Math.ceil((decisionCount + methodCount) / methodCount));
  const maintainabilityScore = clampNumber(
    100 - Math.log(sloc + 1) * 12 - maxComplexityScore * 5 - Math.max(0, methodCount - 1) * 1.5,
    0,
    100,
  );

  return {
    blockCount,
    maintainability: {
      rank: rankMaintainabilityScore(maintainabilityScore),
      score: maintainabilityScore,
    },
    maxComplexity: {
      rank: rankComplexityScore(maxComplexityScore),
      score: maxComplexityScore,
    },
    raw: { sloc },
  };
}

async function readJsonValue(filePath: string): Promise<unknown> {
  if (!(await pathExists(filePath))) {
    return undefined;
  }

  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

async function readOptionalTextFile(filePath: string | undefined): Promise<string | undefined> {
  if (filePath === undefined || !(await pathExists(filePath))) {
    return undefined;
  }

  return readFile(filePath, "utf8");
}

async function findFirstFile(
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

function stripDotNetComments(source: string): string {
  let result = "";
  let index = 0;
  let inBlockComment = false;
  let inString = false;
  let inVerbatimString = false;
  let inChar = false;

  while (index < source.length) {
    const current = source[index];
    const next = source[index + 1];
    if (inBlockComment) {
      if (current === "*" && next === "/") {
        inBlockComment = false;
        index += 2;
        continue;
      }
      if (current === "\n") {
        result += "\n";
      }
      index += 1;
      continue;
    }
    if (inString) {
      result += current ?? "";
      if (current === "\\") {
        result += next ?? "";
        index += 2;
        continue;
      }
      if (current === '"') {
        inString = false;
      }
      index += 1;
      continue;
    }
    if (inVerbatimString) {
      result += current ?? "";
      if (current === '"' && next === '"') {
        result += next;
        index += 2;
        continue;
      }
      if (current === '"') {
        inVerbatimString = false;
      }
      index += 1;
      continue;
    }
    if (inChar) {
      result += current ?? "";
      if (current === "\\") {
        result += next ?? "";
        index += 2;
        continue;
      }
      if (current === "'") {
        inChar = false;
      }
      index += 1;
      continue;
    }
    if (current === "@" && next === '"') {
      result += '@"';
      inVerbatimString = true;
      index += 2;
      continue;
    }
    if (current === '"') {
      inString = true;
      result += current;
      index += 1;
      continue;
    }
    if (current === "'") {
      inChar = true;
      result += current;
      index += 1;
      continue;
    }
    if (current === "/" && next === "*") {
      inBlockComment = true;
      index += 2;
      continue;
    }
    if (current === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") {
        index += 1;
      }
      continue;
    }
    result += current ?? "";
    index += 1;
  }

  return result;
}

function countDotNetTernaryOperators(source: string): number {
  let count = 0;
  let index = 0;
  let inString = false;
  let inVerbatimString = false;
  let inChar = false;

  while (index < source.length) {
    const current = source[index];
    const next = source[index + 1];
    if (inString) {
      if (current === "\\") {
        index += 2;
        continue;
      }
      if (current === '"') {
        inString = false;
      }
      index += 1;
      continue;
    }
    if (inVerbatimString) {
      if (current === '"' && next === '"') {
        index += 2;
        continue;
      }
      if (current === '"') {
        inVerbatimString = false;
      }
      index += 1;
      continue;
    }
    if (inChar) {
      if (current === "\\") {
        index += 2;
        continue;
      }
      if (current === "'") {
        inChar = false;
      }
      index += 1;
      continue;
    }
    if (current === "@" && next === '"') {
      inVerbatimString = true;
      index += 2;
      continue;
    }
    if (current === '"') {
      inString = true;
      index += 1;
      continue;
    }
    if (current === "'") {
      inChar = true;
      index += 1;
      continue;
    }
    if (
      current === "?" &&
      next !== "?" &&
      next !== "." &&
      next !== "[" &&
      hasDotNetTernaryBranch(source, index)
    ) {
      count += 1;
    }
    index += 1;
  }

  return count;
}

function hasDotNetTernaryBranch(source: string, questionMarkIndex: number): boolean {
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let index = questionMarkIndex + 1;
  let inString = false;
  let inVerbatimString = false;
  let inChar = false;

  while (index < source.length) {
    const current = source[index];
    const next = source[index + 1];
    if (inString) {
      if (current === "\\") {
        index += 2;
        continue;
      }
      if (current === '"') {
        inString = false;
      }
      index += 1;
      continue;
    }
    if (inVerbatimString) {
      if (current === '"' && next === '"') {
        index += 2;
        continue;
      }
      if (current === '"') {
        inVerbatimString = false;
      }
      index += 1;
      continue;
    }
    if (inChar) {
      if (current === "\\") {
        index += 2;
        continue;
      }
      if (current === "'") {
        inChar = false;
      }
      index += 1;
      continue;
    }
    if (current === "@" && next === '"') {
      inVerbatimString = true;
      index += 2;
      continue;
    }
    if (current === '"') {
      inString = true;
      index += 1;
      continue;
    }
    if (current === "'") {
      inChar = true;
      index += 1;
      continue;
    }
    if (current === "(") {
      parenDepth += 1;
      index += 1;
      continue;
    }
    if (current === ")") {
      if (parenDepth === 0) return false;
      parenDepth -= 1;
      index += 1;
      continue;
    }
    if (current === "[") {
      bracketDepth += 1;
      index += 1;
      continue;
    }
    if (current === "]") {
      if (bracketDepth === 0) return false;
      bracketDepth -= 1;
      index += 1;
      continue;
    }
    if (current === "{") {
      braceDepth += 1;
      index += 1;
      continue;
    }
    if (current === "}") {
      if (braceDepth === 0) return false;
      braceDepth -= 1;
      index += 1;
      continue;
    }
    if (current === ":" && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) return true;
    if (
      (current === ";" || current === ",") &&
      parenDepth === 0 &&
      bracketDepth === 0 &&
      braceDepth === 0
    )
      return false;
    index += 1;
  }

  return false;
}

function countMatches(value: string, pattern: RegExp): number {
  return [...value.matchAll(pattern)].length;
}

function rankComplexityScore(score: number): string {
  if (score <= 5) return "A";
  if (score <= 10) return "B";
  if (score <= 20) return "C";
  if (score <= 30) return "D";
  return "E";
}

function rankMaintainabilityScore(score: number): string {
  if (score >= 80) return "A";
  if (score >= 60) return "B";
  if (score >= 40) return "C";
  if (score >= 20) return "D";
  return "E";
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
