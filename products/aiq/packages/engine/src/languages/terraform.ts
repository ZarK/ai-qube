import path from "node:path";

import type { PlannedTask, StageId, StageResult } from "../contracts.js";
import type { HashicorpRunnerRuntime } from "./contracts.js";
import {} from "./hashicorp-tools.js";
import {
  discoverHashicorpProjects,
  filterHashicorpTaskFiles,
  filterTerraformFiles,
  selectHashicorpProjects,
} from "./hashicorp.js";

export {
  hclExtensions,
  isHclFile,
  isTerraformFile,
  terraformExtensions,
  hashicorpTaskExtensions as terraformTaskExtensions,
} from "./hashicorp.js";
export type { HashicorpProject as TerraformProject } from "./hashicorp.js";

export async function discoverTerraformProjects(file: string) {
  return discoverHashicorpProjects(file);
}

export function selectTerraformProjects(...args: Parameters<typeof selectHashicorpProjects>) {
  return selectHashicorpProjects(...args);
}

export type TerraformTask = PlannedTask & { stageId: StageId };
import {
  combineStageResults,
  createMissingTerraformBinaryStageResult,
  runGenericHclFormatStage,
  runGenericHclLintStage,
  runTerraformNativeFormatStage,
  runTerraformValidateStage,
} from "./terraform-stages.js";

export async function runTerraformLintTask(
  task: TerraformTask,
  runtime: HashicorpRunnerRuntime,
): Promise<StageResult> {
  const files = filterHashicorpTaskFiles(task.files);
  if (files.length === 0) {
    return runtime.createNoopStageResult(
      task.stageId,
      "No Terraform or HCL files were selected for lint.",
    );
  }

  const terraformBinary = await runtime.resolveBinaryIfAvailable(["terraform"]);
  if (terraformBinary === undefined) {
    return createMissingTerraformBinaryStageResult(task.stageId, files, "lint", runtime);
  }

  const stageResults = await Promise.all([
    runTerraformValidateStage(task, runtime),
    runGenericHclLintStage(task, terraformBinary, runtime),
  ]);

  return combineStageResults(task.stageId, stageResults, runtime);
}

export async function runTerraformTypecheckTask(
  task: TerraformTask,
  runtime: HashicorpRunnerRuntime,
): Promise<StageResult> {
  const files = filterTerraformFiles(task.files);
  if (files.length === 0) {
    return runtime.createNoopStageResult(
      task.stageId,
      "No Terraform files were selected for typecheck.",
    );
  }

  return runTerraformValidateStage(task, runtime);
}

export async function runTerraformFormatTask(
  task: TerraformTask,
  runtime: HashicorpRunnerRuntime,
): Promise<StageResult> {
  const files = filterHashicorpTaskFiles(task.files);
  if (files.length === 0) {
    return runtime.createNoopStageResult(
      task.stageId,
      "No Terraform or HCL files were selected for format.",
    );
  }

  const terraformBinary = await runtime.resolveBinaryIfAvailable(["terraform"]);
  if (terraformBinary === undefined) {
    return createMissingTerraformBinaryStageResult(task.stageId, files, "format", runtime);
  }

  const stageResults = await Promise.all([
    runTerraformNativeFormatStage(task, terraformBinary, runtime),
    runGenericHclFormatStage(task, terraformBinary, runtime),
  ]);

  return combineStageResults(task.stageId, stageResults, runtime);
}
