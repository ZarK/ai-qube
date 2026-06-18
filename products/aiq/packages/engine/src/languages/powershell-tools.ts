import { readFile } from "node:fs/promises";
import path from "node:path";

import type { Diagnostic, StageResult, ToolRunResult } from "../contracts.js";
import * as parsers from "../parsers/index.js";
import type { PowerShellRunnerRuntime } from "./contracts.js";
import {
  normalizeDiagnosticsToSelection,
  normalizeLineEndings,
  readErrorFilePath,
  runPowerShellProjectTestTask,
  summarizeProjectStageStatus,
  toPowerShellStringLiteral,
  tryRealpath,
  matchDiagnosticFile,
} from "./powershell-test.js";
import {
  resolveScriptProjects,
} from "./script.js";

export async function runPowerShellLintLanguageTask(
  task: { files: string[]; stageId: StageResult["stageId"] },
  runtime: PowerShellRunnerRuntime,
): Promise<StageResult> {
  const args = ["Invoke-ScriptAnalyzer", "-Path", ...task.files];

  try {
    const outcome = await runPSScriptAnalyzer(task.files, runtime);
    const diagnostics = normalizeDiagnosticsToSelection(
      parsers.parsePowerShellAnalyzerDiagnostics(outcome.stdout, runtime.cwd),
      task.files,
    );
    const status = outcome.exitCode === 0 && diagnostics.length === 0 ? "passed" : "failed";
    appendSilentPSScriptAnalyzerFailureDiagnostic({ diagnostics, files: task.files, outcome, runtime, status });

    return createPSScriptAnalyzerStageResult({ args, diagnostics, outcome, runtime, stageId: task.stageId, status });
  } catch (error) {
    runtime.throwIfAbortError(error);
    return runtime.createExecutionFailureStage(
      task.stageId,
      "psscriptanalyzer",
      task.files[0] ?? runtime.cwd,
      error,
    );
  }
}

async function runPSScriptAnalyzer(
  files: readonly string[],
  runtime: PowerShellRunnerRuntime,
): Promise<Awaited<ReturnType<PowerShellRunnerRuntime["runPowerShellScript"]>>> {
  const moduleManifestPath =
    await runtime.resolveRequiredPowerShellModuleManifest("PSScriptAnalyzer");
  return runtime.runPowerShellScript(
    [
      "$ErrorActionPreference = 'Stop'",
      `Import-Module -Name ${toPowerShellStringLiteral(moduleManifestPath)} -Force`,
      `$paths = @(${files.map((file) => toPowerShellStringLiteral(file)).join(", ")})`,
      "$results = foreach ($path in $paths) {",
      "  Invoke-ScriptAnalyzer -Path $path",
      "}",
      "$results | ConvertTo-Json -Depth 8 -Compress",
      "",
    ].join("\n"),
    runtime.cwd,
    runtime.signal,
  );
}

function appendSilentPSScriptAnalyzerFailureDiagnostic(options: {
  diagnostics: Diagnostic[];
  files: readonly string[];
  outcome: Awaited<ReturnType<PowerShellRunnerRuntime["runPowerShellScript"]>>;
  runtime: PowerShellRunnerRuntime;
  status: StageResult["status"];
}): void {
  if (options.status !== "failed" || options.diagnostics.length > 0) {
    return;
  }

  options.diagnostics.push(
    options.runtime.createProcessFailureDiagnostic(
      options.files[0] ?? options.runtime.cwd,
      "psscriptanalyzer",
      options.runtime.readProcessFailureMessage(
        "PSScriptAnalyzer",
        options.outcome.stderr,
        options.outcome.stdout,
        options.outcome.exitCode,
      ),
    ),
  );
}

function createPSScriptAnalyzerStageResult(options: {
  args: string[];
  diagnostics: Diagnostic[];
  outcome: Awaited<ReturnType<PowerShellRunnerRuntime["runPowerShellScript"]>>;
  runtime: PowerShellRunnerRuntime;
  stageId: StageResult["stageId"];
  status: StageResult["status"];
}): StageResult {
  return {
    diagnostics: options.diagnostics,
    durationMs: options.outcome.durationMs,
    notes: readPSScriptAnalyzerNotes(options.status, options.diagnostics),
    stageId: options.stageId,
    status: options.status,
    toolRuns: [
      options.runtime.createToolRunResult(
        "psscriptanalyzer",
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

function readPSScriptAnalyzerNotes(
  status: StageResult["status"],
  diagnostics: readonly Diagnostic[],
): string[] {
  return status === "passed"
    ? ["PSScriptAnalyzer passed."]
    : [
        `PSScriptAnalyzer reported ${diagnostics.length} diagnostic${diagnostics.length === 1 ? "" : "s"}.`,
      ];
}

export async function runPowerShellFormatLanguageTask(
  task: { files: string[]; stageId: StageResult["stageId"] },
  runtime: PowerShellRunnerRuntime,
): Promise<StageResult> {
  const args = ["Invoke-Formatter", "-Path", ...task.files];

  try {
    const originalContents = await readOriginalPowerShellContents(task.files);
    const outcome = await runInvokeFormatter(task.files, runtime);
    const formatResults = parsers.parsePowerShellFormatResults(outcome.stdout, runtime.cwd);
    const diagnostics = readPowerShellFormatDiagnostics(
      task.files,
      originalContents,
      formatResults,
    );
    appendPowerShellFormatCompletenessDiagnostic({
      diagnostics,
      files: task.files,
      formatResults,
      outcome,
      runtime,
    });

    const status = outcome.exitCode === 0 && diagnostics.length === 0 ? "passed" : "failed";
    appendSilentPowerShellFormatFailureDiagnostic({ diagnostics, files: task.files, outcome, runtime, status });

    return createPowerShellFormatStageResult({ args, diagnostics, outcome, runtime, stageId: task.stageId, status });
  } catch (error) {
    runtime.throwIfAbortError(error);
    return runtime.createExecutionFailureStage(
      task.stageId,
      "invoke-formatter",
      readErrorFilePath(error) ?? task.files[0] ?? runtime.cwd,
      error,
    );
  }
}

async function readOriginalPowerShellContents(files: readonly string[]): Promise<Map<string, string>> {
  return new Map(
    await Promise.all(files.map(async (file) => [file, await readFile(file, "utf8")] as const)),
  );
}

async function runInvokeFormatter(
  files: readonly string[],
  runtime: PowerShellRunnerRuntime,
): Promise<Awaited<ReturnType<PowerShellRunnerRuntime["runPowerShellScript"]>>> {
  const moduleManifestPath =
    await runtime.resolveRequiredPowerShellModuleManifest("PSScriptAnalyzer");
  return runtime.runPowerShellScript(
    [
      "$ErrorActionPreference = 'Stop'",
      `Import-Module -Name ${toPowerShellStringLiteral(moduleManifestPath)} -Force`,
      `$paths = @(${files.map((file) => toPowerShellStringLiteral(file)).join(", ")})`,
      "$results = foreach ($path in $paths) {",
      "  $content = Get-Content -LiteralPath $path -Raw",
      "  [pscustomobject]@{",
      "    Path = (Resolve-Path -LiteralPath $path).Path",
      "    Formatted = (Invoke-Formatter -ScriptDefinition $content)",
      "  }",
      "}",
      "$results | ConvertTo-Json -Depth 8 -Compress",
      "",
    ].join("\n"),
    runtime.cwd,
    runtime.signal,
  );
}

function readPowerShellFormatDiagnostics(
  files: readonly string[],
  originalContents: ReadonlyMap<string, string>,
  formatResults: ReturnType<typeof parsers.parsePowerShellFormatResults>,
): Diagnostic[] {
  const formattedByFile = readFormattedPowerShellFiles(files, formatResults);
  return files.flatMap((file) =>
    readPowerShellFileFormatDiagnostic(file, originalContents.get(file), formattedByFile.get(file)),
  );
}

function readFormattedPowerShellFiles(
  files: readonly string[],
  formatResults: ReturnType<typeof parsers.parsePowerShellFormatResults>,
): Map<string, string> {
  const selectedPaths = files.map((file) => ({
    file,
    normalized: path.normalize(file),
    realPath: tryRealpath(file),
  }));

  return new Map(
    formatResults.map((entry) => [
      matchDiagnosticFile(entry.file, selectedPaths) ?? entry.file,
      entry.formatted,
    ]),
  );
}

function readPowerShellFileFormatDiagnostic(
  file: string,
  original: string | undefined,
  formatted: string | undefined,
): Diagnostic[] {
  if (original === undefined || formatted === undefined) {
    return [];
  }
  if (normalizeLineEndings(original) === normalizeLineEndings(formatted)) {
    return [];
  }

  return [
    {
      file,
      message: "File requires formatting.",
      severity: "error",
      source: "invoke-formatter",
    },
  ];
}

function appendPowerShellFormatCompletenessDiagnostic(options: {
  diagnostics: Diagnostic[];
  files: readonly string[];
  formatResults: ReturnType<typeof parsers.parsePowerShellFormatResults>;
  outcome: Awaited<ReturnType<PowerShellRunnerRuntime["runPowerShellScript"]>>;
  runtime: PowerShellRunnerRuntime;
}): void {
  if (options.outcome.exitCode !== 0 || options.formatResults.length === options.files.length) {
    return;
  }

  options.diagnostics.push(
    options.runtime.createProcessFailureDiagnostic(
      options.files[0] ?? options.runtime.cwd,
      "invoke-formatter",
      "Invoke-Formatter did not return formatted output for every selected file.",
    ),
  );
}

function appendSilentPowerShellFormatFailureDiagnostic(options: {
  diagnostics: Diagnostic[];
  files: readonly string[];
  outcome: Awaited<ReturnType<PowerShellRunnerRuntime["runPowerShellScript"]>>;
  runtime: PowerShellRunnerRuntime;
  status: StageResult["status"];
}): void {
  if (options.status !== "failed" || options.diagnostics.length > 0) {
    return;
  }

  options.diagnostics.push(
    options.runtime.createProcessFailureDiagnostic(
      options.files[0] ?? options.runtime.cwd,
      "invoke-formatter",
      options.runtime.readProcessFailureMessage(
        "Invoke-Formatter",
        options.outcome.stderr,
        options.outcome.stdout,
        options.outcome.exitCode,
      ),
    ),
  );
}

function createPowerShellFormatStageResult(options: {
  args: string[];
  diagnostics: Diagnostic[];
  outcome: Awaited<ReturnType<PowerShellRunnerRuntime["runPowerShellScript"]>>;
  runtime: PowerShellRunnerRuntime;
  stageId: StageResult["stageId"];
  status: StageResult["status"];
}): StageResult {
  return {
    diagnostics: options.diagnostics,
    durationMs: options.outcome.durationMs,
    notes:
      options.status === "passed"
        ? ["Invoke-Formatter passed."]
        : [
            `Invoke-Formatter reported ${options.diagnostics.length} formatting diagnostic${options.diagnostics.length === 1 ? "" : "s"}.`,
          ],
    stageId: options.stageId,
    status: options.status,
    toolRuns: [
      options.runtime.createToolRunResult(
        "invoke-formatter",
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

export async function runPowerShellTestLanguageTask(
  task: { files: string[]; stageId: StageResult["stageId"] },
  runtime: PowerShellRunnerRuntime,
  mode: "coverage" | "unit",
): Promise<StageResult> {
  const diagnostics: Diagnostic[] = [];
  const notes: string[] = [];
  const toolRuns: ToolRunResult[] = [];
  const statuses: StageResult["status"][] = [];
  let totalDurationMs = 0;

  try {
    const projectResults = await Promise.all(
      (await resolveScriptProjects(runtime.graph, task.files)).map((project) =>
        runPowerShellProjectTestTask(project, mode, runtime),
      ),
    );

    for (const projectResult of projectResults) {
      totalDurationMs += projectResult.durationMs;
      diagnostics.push(...projectResult.diagnostics);
      notes.push(projectResult.note);
      toolRuns.push(...projectResult.toolRuns);
      statuses.push(projectResult.status);
    }
  } catch (error) {
    runtime.throwIfAbortError(error);
    return runtime.createExecutionFailureStage(
      task.stageId,
      "pester",
      task.files[0] ?? runtime.cwd,
      error,
      totalDurationMs,
      diagnostics,
      toolRuns,
    );
  }

  return {
    diagnostics,
    durationMs: totalDurationMs,
    notes,
    stageId: task.stageId,
    status: summarizeProjectStageStatus(statuses),
    toolRuns,
  };
}
