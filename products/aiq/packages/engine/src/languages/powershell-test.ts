import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Diagnostic, StageResult, ToolRunResult } from "../contracts.js";
import * as parsers from "../parsers/index.js";
import { pathExists } from "../utils/path-utils.js";
import type { PowerShellRunnerRuntime } from "./contracts.js";
import {
  type ScriptProject,
  createMissingScriptTestsNote,
  resolvePowerShellProjectCoverageFiles,
  resolvePowerShellProjectTestFiles,
} from "./script.js";

type PowerShellProjectTestResult = {
  diagnostics: Diagnostic[];
  durationMs: number;
  note: string;
  status: StageResult["status"];
  toolRuns: ToolRunResult[];
};
type PowerShellTestSummary = { failed: number; passed: number; total: number };
type PowerShellTestExecutionContext = {
  coverageFiles: string[];
  mode: "coverage" | "unit";
  pesterModulePath: string;
  project: ScriptProject;
  runtime: PowerShellRunnerRuntime;
  testFiles: string[];
};

export async function runPowerShellProjectTestTask(
  project: ScriptProject,
  mode: "coverage" | "unit",
  runtime: PowerShellRunnerRuntime,
): Promise<PowerShellProjectTestResult> {
  const testFiles = await resolvePowerShellProjectTestFiles(project, runtime.findMatchingFiles);
  if (testFiles.length === 0) {
    return createPowerShellTestSetupFailure(
      project,
      `${createMissingScriptTestsNote("PowerShell", project.projectRoot)} Add Pester tests or disable PowerShell ${mode}.`,
      runtime,
    );
  }

  const pesterModulePath = await runtime.resolvePowerShellModuleManifest("Pester");
  if (pesterModulePath === undefined) {
    return createPowerShellTestSetupFailure(
      project,
      `Pester is required for PowerShell ${mode} and was not detected in ${project.projectRoot}. Install Pester or disable PowerShell ${mode}.`,
      runtime,
    );
  }

  const coverageFiles =
    mode === "coverage"
      ? await resolvePowerShellProjectCoverageFiles(project, runtime.findMatchingFiles)
      : [];
  if (mode === "coverage" && coverageFiles.length === 0) {
    return createPowerShellTestSetupFailure(
      project,
      `No PowerShell source files were detected for coverage in ${project.projectRoot}. Add non-test .ps1 sources or disable PowerShell coverage.`,
      runtime,
    );
  }

  return runPesterProject({ coverageFiles, mode, pesterModulePath, project, runtime, testFiles });
}

async function runPesterProject(
  context: PowerShellTestExecutionContext,
): Promise<PowerShellProjectTestResult> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-powershell-runner-"));

  try {
    const junitPath = path.join(tempDir, "junit.xml");
    const coveragePath = path.join(tempDir, "coverage.xml");
    const args = createPesterArgs(context);
    const outcome = await context.runtime.runPowerShellScript(
      createPesterScript(context, junitPath, coveragePath),
      context.project.projectRoot,
      context.runtime.signal,
    );
    const report = await parsers.parseJvmJunitReports(
      [junitPath],
      context.testFiles[0] ?? context.project.projectRoot,
      readOptionalTextFile,
    );
    const diagnostics = readPesterDiagnostics(report.diagnostics);
    const summary = parsers.parsePowerShellTestSummary(outcome.stdout) ?? report.summary;
    const coveragePercent = await readPowerShellCoveragePercent(context.mode, coveragePath);
    const status = readPesterStatus(outcome.exitCode, diagnostics, summary);
    appendSilentPesterFailureDiagnostic({ context, diagnostics, outcome, status, summary });

    return createPowerShellProjectTestResult({
      args,
      coveragePercent,
      diagnostics,
      outcome,
      runtime: context.runtime,
      status,
      summary,
      mode: context.mode,
    });
  } finally {
    await rm(tempDir, { force: true, recursive: true }).catch(() => undefined);
  }
}

function createPesterArgs(context: PowerShellTestExecutionContext): string[] {
  return [
    "Invoke-Pester",
    "-Path",
    ...context.testFiles,
    ...(context.mode === "coverage" ? ["-CodeCoverage", ...context.coverageFiles] : []),
  ];
}

function createPesterScript(
  context: PowerShellTestExecutionContext,
  junitPath: string,
  coveragePath: string,
): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `Import-Module -Name ${toPowerShellStringLiteral(context.pesterModulePath)} -Force`,
    "$configuration = New-PesterConfiguration",
    `$configuration.Run.Path = @(${context.testFiles.map((file) => toPowerShellStringLiteral(file)).join(", ")})`,
    "$configuration.Run.PassThru = $true",
    "$configuration.Run.Exit = $false",
    "$configuration.Output.Verbosity = 'None'",
    "$configuration.TestResult.Enabled = $true",
    `$configuration.TestResult.OutputPath = ${toPowerShellStringLiteral(junitPath)}`,
    "$configuration.TestResult.OutputFormat = 'JUnitXml'",
    ...createPesterCoverageScriptLines(context.mode, context.coverageFiles, coveragePath),
    "$result = Invoke-Pester -Configuration $configuration",
    "[pscustomobject]@{",
    "  TotalCount = $result.TotalCount",
    "  PassedCount = $result.PassedCount",
    "  FailedCount = $result.FailedCount",
    "} | ConvertTo-Json -Compress",
    "",
  ].join("\n");
}

function createPesterCoverageScriptLines(
  mode: "coverage" | "unit",
  coverageFiles: readonly string[],
  coveragePath: string,
): string[] {
  if (mode !== "coverage") {
    return [];
  }

  return [
    "$configuration.CodeCoverage.Enabled = $true",
    `$configuration.CodeCoverage.Path = @(${coverageFiles.map((file) => toPowerShellStringLiteral(file)).join(", ")})`,
    `$configuration.CodeCoverage.OutputPath = ${toPowerShellStringLiteral(coveragePath)}`,
    "$configuration.CodeCoverage.OutputFormat = 'Cobertura'",
  ];
}

function readPesterDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return diagnostics.map((diagnostic) => ({
    ...diagnostic,
    source: "pester",
  }));
}

async function readPowerShellCoveragePercent(
  mode: "coverage" | "unit",
  coveragePath: string,
): Promise<number | undefined> {
  return mode === "coverage"
    ? parsers.readCoberturaLineRate(await readOptionalTextFile(coveragePath))
    : undefined;
}

function readPesterStatus(
  exitCode: number | undefined,
  diagnostics: readonly Diagnostic[],
  summary: PowerShellTestSummary,
): StageResult["status"] {
  return exitCode === 0 && diagnostics.length === 0 && summary.failed === 0 ? "passed" : "failed";
}

function appendSilentPesterFailureDiagnostic(options: {
  context: PowerShellTestExecutionContext;
  diagnostics: Diagnostic[];
  outcome: Awaited<ReturnType<PowerShellRunnerRuntime["runPowerShellScript"]>>;
  status: StageResult["status"];
  summary: PowerShellTestSummary;
}): void {
  if (options.status !== "failed" || options.diagnostics.length > 0) {
    return;
  }

  options.diagnostics.push(
    options.context.runtime.createProcessFailureDiagnostic(
      options.context.testFiles[0] ?? options.context.project.projectRoot,
      "pester",
      readPesterFailureMessage(options.context.runtime, options.outcome, options.summary),
    ),
  );
}

function readPesterFailureMessage(
  runtime: PowerShellRunnerRuntime,
  outcome: Awaited<ReturnType<PowerShellRunnerRuntime["runPowerShellScript"]>>,
  summary: PowerShellTestSummary,
): string {
  return summary.failed > 0
    ? `Pester reported ${summary.failed} failing test${summary.failed === 1 ? "" : "s"}.`
    : runtime.readProcessFailureMessage("Pester", outcome.stderr, outcome.stdout, outcome.exitCode);
}

function createPowerShellProjectTestResult(options: {
  args: string[];
  coveragePercent: number | undefined;
  diagnostics: Diagnostic[];
  mode: "coverage" | "unit";
  outcome: Awaited<ReturnType<PowerShellRunnerRuntime["runPowerShellScript"]>>;
  runtime: PowerShellRunnerRuntime;
  status: StageResult["status"];
  summary: PowerShellTestSummary;
}): PowerShellProjectTestResult {
  return {
    diagnostics: options.diagnostics,
    durationMs: options.outcome.durationMs,
    note:
      options.mode === "coverage"
        ? readPowerShellCoverageNote(options.summary, options.coveragePercent)
        : readPowerShellUnitNote(options.summary),
    status: options.status,
    toolRuns: [
      options.runtime.createToolRunResult(
        "pester",
        options.args,
        options.outcome.durationMs,
        options.outcome.exitCode,
        options.status,
        options.outcome.finishedAt,
        options.outcome.startedAt,
      ),
    ],
  };
}

function createPowerShellTestSetupFailure(
  project: ScriptProject,
  message: string,
  runtime: PowerShellRunnerRuntime,
): {
  diagnostics: Diagnostic[];
  durationMs: number;
  note: string;
  status: StageResult["status"];
  toolRuns: ToolRunResult[];
} {
  const file = project.files[0] ?? project.projectRoot;

  return {
    diagnostics: [
      {
        file,
        message,
        severity: "error",
        source: "pester",
      },
    ],
    durationMs: 0,
    note: message,
    status: "failed",
    toolRuns: [runtime.createToolRunResult("pester", [], 0, undefined, "failed")],
  };
}

export function summarizeProjectStageStatus(
  statuses: readonly StageResult["status"][],
): StageResult["status"] {
  if (statuses.length === 0) {
    return "passed";
  }
  if (statuses.includes("failed")) {
    return "failed";
  }
  return "passed";
}

function readPowerShellUnitNote(summary: {
  failed: number;
  passed: number;
  total: number;
}): string {
  if (summary.total === 0) {
    return "Pester found no tests.";
  }
  return `Pester ran ${summary.total} test${summary.total === 1 ? "" : "s"}: ${summary.passed} passed, ${summary.failed} failed.`;
}

function readPowerShellCoverageNote(
  summary: { failed: number; passed: number; total: number },
  coveragePercent: number | undefined,
): string {
  if (summary.total === 0) {
    return "Pester found no tests.";
  }
  if (coveragePercent === undefined) {
    return `PowerShell coverage completed after ${summary.total} test${summary.total === 1 ? "" : "s"}.`;
  }
  return `PowerShell coverage lines: ${coveragePercent.toFixed(1)}% across ${summary.total} test${summary.total === 1 ? "" : "s"}.`;
}

export function toPowerShellStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/gu, "\n");
}

export function readErrorFilePath(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("path" in error)) {
    return undefined;
  }

  return typeof error.path === "string" ? path.resolve(error.path) : undefined;
}

async function readOptionalTextFile(filePath: string | undefined): Promise<string | undefined> {
  if (filePath === undefined || !(await pathExists(filePath))) {
    return undefined;
  }
  return readFile(filePath, "utf8");
}

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

export function matchDiagnosticFile(
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

export function tryRealpath(filePath: string): string | undefined {
  try {
    return realpathSync.native(filePath);
  } catch {
    return undefined;
  }
}
