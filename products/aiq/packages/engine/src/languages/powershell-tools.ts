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
    const moduleManifestPath =
      await runtime.resolveRequiredPowerShellModuleManifest("PSScriptAnalyzer");
    const outcome = await runtime.runPowerShellScript(
      [
        "$ErrorActionPreference = 'Stop'",
        `Import-Module -Name ${toPowerShellStringLiteral(moduleManifestPath)} -Force`,
        `$paths = @(${task.files.map((file) => toPowerShellStringLiteral(file)).join(", ")})`,
        "$results = foreach ($path in $paths) {",
        "  Invoke-ScriptAnalyzer -Path $path",
        "}",
        "$results | ConvertTo-Json -Depth 8 -Compress",
        "",
      ].join("\n"),
      runtime.cwd,
      runtime.signal,
    );
    const diagnostics = normalizeDiagnosticsToSelection(
      parsers.parsePowerShellAnalyzerDiagnostics(outcome.stdout, runtime.cwd),
      task.files,
    );
    const status = outcome.exitCode === 0 && diagnostics.length === 0 ? "passed" : "failed";

    if (status === "failed" && diagnostics.length === 0) {
      diagnostics.push(
        runtime.createProcessFailureDiagnostic(
          task.files[0] ?? runtime.cwd,
          "psscriptanalyzer",
          runtime.readProcessFailureMessage(
            "PSScriptAnalyzer",
            outcome.stderr,
            outcome.stdout,
            outcome.exitCode,
          ),
        ),
      );
    }

    return {
      diagnostics,
      durationMs: outcome.durationMs,
      notes:
        status === "passed"
          ? ["PSScriptAnalyzer passed."]
          : [
              `PSScriptAnalyzer reported ${diagnostics.length} diagnostic${diagnostics.length === 1 ? "" : "s"}.`,
            ],
      stageId: task.stageId,
      status,
      toolRuns: [
        runtime.createToolRunResult(
          "psscriptanalyzer",
          args,
          outcome.durationMs,
          outcome.exitCode,
          status,
          outcome.finishedAt,
          outcome.startedAt,
        ),
      ],
    };
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

export async function runPowerShellFormatLanguageTask(
  task: { files: string[]; stageId: StageResult["stageId"] },
  runtime: PowerShellRunnerRuntime,
): Promise<StageResult> {
  const args = ["Invoke-Formatter", "-Path", ...task.files];

  try {
    const originalContents = new Map(
      await Promise.all(
        task.files.map(async (file) => [file, await readFile(file, "utf8")] as const),
      ),
    );
    const moduleManifestPath =
      await runtime.resolveRequiredPowerShellModuleManifest("PSScriptAnalyzer");
    const outcome = await runtime.runPowerShellScript(
      [
        "$ErrorActionPreference = 'Stop'",
        `Import-Module -Name ${toPowerShellStringLiteral(moduleManifestPath)} -Force`,
        `$paths = @(${task.files.map((file) => toPowerShellStringLiteral(file)).join(", ")})`,
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
    const formatResults = parsers.parsePowerShellFormatResults(outcome.stdout, runtime.cwd);
    const selectedPaths = task.files.map((file) => ({
      file,
      normalized: path.normalize(file),
      realPath: tryRealpath(file),
    }));
    const formattedByFile = new Map(
      formatResults.map((entry) => [
        matchDiagnosticFile(entry.file, selectedPaths) ?? entry.file,
        entry.formatted,
      ]),
    );
    const diagnostics: Diagnostic[] = [];

    for (const file of task.files) {
      const original = originalContents.get(file);
      const formatted = formattedByFile.get(file);
      if (original === undefined || formatted === undefined) {
        continue;
      }

      if (normalizeLineEndings(original) === normalizeLineEndings(formatted)) {
        continue;
      }

      diagnostics.push({
        file,
        message: "File requires formatting.",
        severity: "error",
        source: "invoke-formatter",
      });
    }

    if (outcome.exitCode === 0 && formatResults.length !== task.files.length) {
      diagnostics.push(
        runtime.createProcessFailureDiagnostic(
          task.files[0] ?? runtime.cwd,
          "invoke-formatter",
          "Invoke-Formatter did not return formatted output for every selected file.",
        ),
      );
    }

    const status = outcome.exitCode === 0 && diagnostics.length === 0 ? "passed" : "failed";

    if (status === "failed" && diagnostics.length === 0) {
      diagnostics.push(
        runtime.createProcessFailureDiagnostic(
          task.files[0] ?? runtime.cwd,
          "invoke-formatter",
          runtime.readProcessFailureMessage(
            "Invoke-Formatter",
            outcome.stderr,
            outcome.stdout,
            outcome.exitCode,
          ),
        ),
      );
    }

    return {
      diagnostics,
      durationMs: outcome.durationMs,
      notes:
        status === "passed"
          ? ["Invoke-Formatter passed."]
          : [
              `Invoke-Formatter reported ${diagnostics.length} formatting diagnostic${diagnostics.length === 1 ? "" : "s"}.`,
            ],
      stageId: task.stageId,
      status,
      toolRuns: [
        runtime.createToolRunResult(
          "invoke-formatter",
          args,
          outcome.durationMs,
          outcome.exitCode,
          status,
          outcome.finishedAt,
          outcome.startedAt,
        ),
      ],
    };
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
