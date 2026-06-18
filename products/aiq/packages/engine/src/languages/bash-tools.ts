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

    if (status === "failed" && diagnostics.length === 0) {
      diagnostics.push(
        runtime.createProcessFailureDiagnostic(
          task.files[0] ?? runtime.cwd,
          "shellcheck",
          runtime.readProcessFailureMessage(
            "ShellCheck",
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
          ? ["ShellCheck passed."]
          : [
              `ShellCheck reported ${diagnostics.length} diagnostic${diagnostics.length === 1 ? "" : "s"}.`,
            ],
      stageId: task.stageId,
      status,
      toolRuns: [
        runtime.createToolRunResult(
          "shellcheck",
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

    if (status === "failed" && diagnostics.length === 0) {
      diagnostics.push(
        runtime.createProcessFailureDiagnostic(
          task.files[0] ?? runtime.cwd,
          "shfmt",
          runtime.readProcessFailureMessage(
            "shfmt",
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
          ? ["shfmt passed."]
          : [
              `shfmt reported ${diagnostics.length} formatting diagnostic${diagnostics.length === 1 ? "" : "s"}.`,
            ],
      stageId: task.stageId,
      status,
      toolRuns: [
        runtime.createToolRunResult(
          "shfmt",
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
      "shfmt",
      task.files[0] ?? runtime.cwd,
      error,
    );
  }
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
