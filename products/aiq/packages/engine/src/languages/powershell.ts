import type { PlannedTask, StageResult } from "../contracts.js";
import type { PowerShellRunnerRuntime } from "./contracts.js";
import {
  runPowerShellFormatLanguageTask,
  runPowerShellLintLanguageTask,
  runPowerShellTestLanguageTask,
} from "./powershell-tools.js";
import { isPowerShellTaskFile } from "./script.js";

export {
  isPowerShellCoverageSourceFile,
  isPowerShellTaskFile,
  isPowerShellTestFile,
  powerShellExtensions,
} from "./script.js";

export async function runPowerShellLintTask(
  task: PlannedTask,
  runtime: PowerShellRunnerRuntime,
): Promise<StageResult> {
  const files = filterPowerShellTaskFiles(task.files);
  if (files.length === 0) {
    return runtime.createNoopStageResult(
      task.stageId,
      "No PowerShell files were selected for lint.",
    );
  }

  return runPowerShellLintLanguageTask({ files, stageId: task.stageId }, runtime);
}

export async function runPowerShellFormatTask(
  task: PlannedTask,
  runtime: PowerShellRunnerRuntime,
): Promise<StageResult> {
  const files = filterPowerShellTaskFiles(task.files);
  if (files.length === 0) {
    return runtime.createNoopStageResult(
      task.stageId,
      "No PowerShell files were selected for format.",
    );
  }

  return runPowerShellFormatLanguageTask({ files, stageId: task.stageId }, runtime);
}

export async function runPowerShellUnitTask(
  task: PlannedTask,
  runtime: PowerShellRunnerRuntime,
): Promise<StageResult> {
  const files = filterPowerShellTaskFiles(task.files);
  if (files.length === 0) {
    return runtime.createNoopStageResult(
      task.stageId,
      `No PowerShell files were selected for ${task.stageId}.`,
    );
  }

  return runPowerShellTestLanguageTask({ files, stageId: task.stageId }, runtime, "unit");
}

export async function runPowerShellCoverageTask(
  task: PlannedTask,
  runtime: PowerShellRunnerRuntime,
): Promise<StageResult> {
  const files = filterPowerShellTaskFiles(task.files);
  if (files.length === 0) {
    return runtime.createNoopStageResult(
      task.stageId,
      `No PowerShell files were selected for ${task.stageId}.`,
    );
  }

  return runPowerShellTestLanguageTask({ files, stageId: task.stageId }, runtime, "coverage");
}

function filterPowerShellTaskFiles(files: readonly string[]): string[] {
  return files.filter((file) => isPowerShellTaskFile(file));
}
