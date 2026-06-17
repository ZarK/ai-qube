import type { PlannedTask, StageResult } from "../contracts.js";
import {
  runBashFormatLanguageTask,
  runBashLintLanguageTask,
  runBashTestLanguageTask,
} from "./bash-tools.js";
import type { BashRunnerRuntime } from "./contracts.js";
import { isBashTaskFile } from "./script.js";

export { bashExtensions, bashTestExtensions, isBashTaskFile } from "./script.js";

export async function runBashLintTask(
  task: PlannedTask,
  runtime: BashRunnerRuntime,
): Promise<StageResult> {
  const files = filterBashTaskFiles(task.files);
  if (files.length === 0) {
    return runtime.createNoopStageResult(task.stageId, "No Bash files were selected for lint.");
  }

  return runBashLintLanguageTask({ files, stageId: task.stageId }, runtime);
}

export async function runBashFormatTask(
  task: PlannedTask,
  runtime: BashRunnerRuntime,
): Promise<StageResult> {
  const files = filterBashTaskFiles(task.files);
  if (files.length === 0) {
    return runtime.createNoopStageResult(task.stageId, "No Bash files were selected for format.");
  }

  return runBashFormatLanguageTask({ files, stageId: task.stageId }, runtime);
}

export async function runBashUnitTask(
  task: PlannedTask,
  runtime: BashRunnerRuntime,
): Promise<StageResult> {
  const files = filterBashTaskFiles(task.files);
  if (files.length === 0) {
    return runtime.createNoopStageResult(
      task.stageId,
      `No Bash files were selected for ${task.stageId}.`,
    );
  }

  return runBashTestLanguageTask({ files, stageId: task.stageId }, runtime, "unit");
}

export async function runBashCoverageTask(
  task: PlannedTask,
  runtime: BashRunnerRuntime,
): Promise<StageResult> {
  const files = filterBashTaskFiles(task.files);
  if (files.length === 0) {
    return runtime.createNoopStageResult(
      task.stageId,
      `No Bash files were selected for ${task.stageId}.`,
    );
  }

  return runBashTestLanguageTask({ files, stageId: task.stageId }, runtime, "coverage");
}

function filterBashTaskFiles(files: readonly string[]): string[] {
  return files.filter((file) => isBashTaskFile(file));
}
