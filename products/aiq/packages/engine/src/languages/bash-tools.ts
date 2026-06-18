import type { Diagnostic, StageResult, ToolRunResult } from "../contracts.js";
import * as parsers from "../parsers/index.js";
import * as commands from "../tools/command-builders.js";
import type { BashRunnerRuntime } from "./contracts.js";
import { runBashProjectTestTask, summarizeProjectStageStatus } from "./bash-test.js";
import {
  resolveScriptProjects,
} from "./script.js";

export async function runBashLintLanguageTask(
  task: { files: string[]; stageId: StageResult["stageId"] },
  runtime: BashRunnerRuntime,
): Promise<StageResult> {
  const args = commands.createShellcheckArgs({ files: task.files });

  try {
    const outcome = await runtime.runExecutable(
      await runtime.resolveRequiredBinary(
        process.platform === "win32" ? ["shellcheck.exe", "shellcheck"] : ["shellcheck"],
        "ShellCheck",
        "Install ShellCheck to enable Bash linting.",
      ),
      args,
      runtime.cwd,
      runtime.signal,
    );
    const diagnostics = parsers.parseShellcheckDiagnostics(outcome.stdout, runtime.cwd);
    const status = outcome.exitCode === 0 && diagnostics.length === 0 ? "passed" : "failed";
    appendSilentBashToolFailureDiagnostic({
      diagnostics,
      files: task.files,
      label: "ShellCheck",
      outcome,
      runtime,
      status,
      tool: "shellcheck",
    });

    return createBashToolStageResult({
      args,
      diagnostics,
      label: "ShellCheck",
      outcome,
      runtime,
      stageId: task.stageId,
      status,
      tool: "shellcheck",
    });
  } catch (error) {
    runtime.throwIfAbortError(error);
    return runtime.createExecutionFailureStage(
      task.stageId,
      "shellcheck",
      task.files[0] ?? runtime.cwd,
      error,
    );
  }
}

export async function runBashFormatLanguageTask(
  task: { files: string[]; stageId: StageResult["stageId"] },
  runtime: BashRunnerRuntime,
): Promise<StageResult> {
  const args = commands.createShfmtArgs({ files: task.files });

  try {
    const outcome = await runtime.runExecutable(
      await runtime.resolveRequiredBinary(
        process.platform === "win32" ? ["shfmt.exe", "shfmt"] : ["shfmt"],
        "shfmt",
        "Install shfmt to enable Bash formatting checks.",
      ),
      args,
      runtime.cwd,
      runtime.signal,
    );
    const diagnostics = parsers.parseShellFormatDiagnostics(outcome.stdout, runtime.cwd);
    const status = outcome.exitCode === 0 && diagnostics.length === 0 ? "passed" : "failed";
    appendSilentBashToolFailureDiagnostic({
      diagnostics,
      files: task.files,
      label: "shfmt",
      outcome,
      runtime,
      status,
      tool: "shfmt",
    });

    return createBashToolStageResult({
      args,
      diagnostics,
      label: "shfmt",
      outcome,
      runtime,
      stageId: task.stageId,
      status,
      tool: "shfmt",
    });
  } catch (error) {
    runtime.throwIfAbortError(error);
    return runtime.createExecutionFailureStage(
      task.stageId,
      "shfmt",
      task.files[0] ?? runtime.cwd,
      error,
    );
  }
}

function appendSilentBashToolFailureDiagnostic(options: {
  diagnostics: Diagnostic[];
  files: readonly string[];
  label: string;
  outcome: Awaited<ReturnType<BashRunnerRuntime["runExecutable"]>>;
  runtime: BashRunnerRuntime;
  status: StageResult["status"];
  tool: "shellcheck" | "shfmt";
}): void {
  if (options.status !== "failed" || options.diagnostics.length > 0) {
    return;
  }

  options.diagnostics.push(
    options.runtime.createProcessFailureDiagnostic(
      options.files[0] ?? options.runtime.cwd,
      options.tool,
      options.runtime.readProcessFailureMessage(
        options.label,
        options.outcome.stderr,
        options.outcome.stdout,
        options.outcome.exitCode,
      ),
    ),
  );
}

function createBashToolStageResult(options: {
  args: string[];
  diagnostics: Diagnostic[];
  label: string;
  outcome: Awaited<ReturnType<BashRunnerRuntime["runExecutable"]>>;
  runtime: BashRunnerRuntime;
  stageId: StageResult["stageId"];
  status: StageResult["status"];
  tool: "shellcheck" | "shfmt";
}): StageResult {
  return {
    diagnostics: options.diagnostics,
    durationMs: options.outcome.durationMs,
    notes: readBashToolNotes(options.label, options.status, options.diagnostics),
    stageId: options.stageId,
    status: options.status,
    toolRuns: [
      options.runtime.createToolRunResult(
        options.tool,
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

function readBashToolNotes(
  label: string,
  status: StageResult["status"],
  diagnostics: readonly Diagnostic[],
): string[] {
  if (status === "passed") {
    return [`${label} passed.`];
  }

  const kind = label === "shfmt" ? "formatting diagnostic" : "diagnostic";
  return [`${label} reported ${diagnostics.length} ${kind}${diagnostics.length === 1 ? "" : "s"}.`];
}

export async function runBashTestLanguageTask(
  task: { files: string[]; stageId: StageResult["stageId"] },
  runtime: BashRunnerRuntime,
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
        runBashProjectTestTask(project, mode, runtime),
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
      mode === "coverage" ? "kcov" : "bats",
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
