import path from "node:path";

import type { StageId, StageResult } from "../contracts.js";
import { resolveProjectConcurrencyLimit } from "../runtime-tunables.js";
import type { HashicorpRunnerRuntime } from "./contracts.js";
import { getTerraformValidationProjectResult, runGenericHclFormatFile, runGenericHclLintFile, runTerraformFormatProject } from "./hashicorp-tools.js";
import { filterHashicorpTaskFiles, filterTerraformFiles, resolveHashicorpProjects } from "./hashicorp.js";
import type { TerraformTask } from "./terraform.js";

export async function runGenericHclFormatStage(
  task: TerraformTask,
  terraformBinary: string,
  runtime: HashicorpRunnerRuntime,
): Promise<StageResult> {
  const projects = await resolveHashicorpProjects(
    runtime.graph,
    filterHashicorpTaskFiles(task.files),
  );
  const files = projects.flatMap((project) => project.hclFiles);
  if (files.length === 0) {
    return runtime.createNoopStageResult(
      task.stageId,
      "No generic HCL files were selected for format.",
    );
  }

  const diagnostics = [] as StageResult["diagnostics"];
  const notes: string[] = [];
  const toolRuns = [] as StageResult["toolRuns"];
  const statuses = [] as StageResult["status"][];
  let totalDurationMs = 0;

  try {
    const fileResults = await runProjectBatches(files, async (file) =>
      runGenericHclFormatFile(file, terraformBinary, runtime),
    );

    for (const fileResult of fileResults) {
      totalDurationMs += fileResult.durationMs;
      diagnostics.push(...fileResult.diagnostics);
      notes.push(fileResult.note);
      statuses.push(fileResult.status);
      toolRuns.push(fileResult.toolRun);
    }
  } catch (error) {
    runtime.throwIfAbortError(error);
    return runtime.createExecutionFailureStage(
      task.stageId,
      "terraform-hcl-format",
      files[0] ?? runtime.cwd,
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

export async function runGenericHclLintStage(
  task: TerraformTask,
  terraformBinary: string,
  runtime: HashicorpRunnerRuntime,
): Promise<StageResult> {
  const projects = await resolveHashicorpProjects(
    runtime.graph,
    filterHashicorpTaskFiles(task.files),
  );
  const files = projects.flatMap((project) => project.hclFiles);
  if (files.length === 0) {
    return runtime.createNoopStageResult(
      task.stageId,
      "No generic HCL files were selected for lint.",
    );
  }

  const diagnostics = [] as StageResult["diagnostics"];
  const notes: string[] = [];
  const toolRuns = [] as StageResult["toolRuns"];
  const statuses = [] as StageResult["status"][];
  let totalDurationMs = 0;

  try {
    const fileResults = await runProjectBatches(files, async (file) =>
      runGenericHclLintFile(file, terraformBinary, runtime),
    );

    for (const fileResult of fileResults) {
      totalDurationMs += fileResult.durationMs;
      diagnostics.push(...fileResult.diagnostics);
      notes.push(fileResult.note);
      statuses.push(fileResult.status);
      toolRuns.push(fileResult.toolRun);
    }
  } catch (error) {
    runtime.throwIfAbortError(error);
    return runtime.createExecutionFailureStage(
      task.stageId,
      "terraform-hcl-lint",
      files[0] ?? runtime.cwd,
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

export async function runTerraformNativeFormatStage(
  task: TerraformTask,
  terraformBinary: string,
  runtime: HashicorpRunnerRuntime,
): Promise<StageResult> {
  const files = filterTerraformFiles(task.files);
  if (files.length === 0) {
    return runtime.createNoopStageResult(
      task.stageId,
      "No Terraform files were selected for format.",
    );
  }

  const diagnostics = [] as StageResult["diagnostics"];
  const notes: string[] = [];
  const toolRuns = [] as StageResult["toolRuns"];
  const statuses = [] as StageResult["status"][];
  let totalDurationMs = 0;

  try {
    const projectResults = await runProjectBatches(
      (await resolveHashicorpProjects(runtime.graph, files)).filter(
        (project) => project.terraformFiles.length > 0,
      ),
      async (project) => runTerraformFormatProject(project, terraformBinary, runtime),
    );

    for (const projectResult of projectResults) {
      totalDurationMs += projectResult.durationMs;
      diagnostics.push(...projectResult.diagnostics);
      notes.push(projectResult.note);
      statuses.push(projectResult.status);
      toolRuns.push(projectResult.toolRun);
    }
  } catch (error) {
    runtime.throwIfAbortError(error);
    return runtime.createExecutionFailureStage(
      task.stageId,
      "terraform-fmt",
      files[0] ?? runtime.cwd,
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

export async function runTerraformValidateStage(
  task: TerraformTask,
  runtime: HashicorpRunnerRuntime,
): Promise<StageResult> {
  const files = filterTerraformFiles(task.files);
  if (files.length === 0) {
    return runtime.createNoopStageResult(
      task.stageId,
      `No Terraform files were selected for ${task.stageId}.`,
    );
  }

  const terraformBinary = await runtime.resolveBinaryIfAvailable(["terraform"]);
  if (terraformBinary === undefined) {
    return createMissingTerraformBinaryStageResult(task.stageId, files, "validation", runtime);
  }
  void terraformBinary;

  const diagnostics = [] as StageResult["diagnostics"];
  const notes: string[] = [];
  const toolRuns = [] as StageResult["toolRuns"];
  const statuses = [] as StageResult["status"][];
  let totalDurationMs = 0;
  let reusedCachedValidation = false;

  try {
    const projectResults = await runProjectBatches(
      (await resolveHashicorpProjects(runtime.graph, files)).filter(
        (project) => project.terraformFiles.length > 0,
      ),
      async (project) => {
        const cachedValidation = await getTerraformValidationProjectResult(project, runtime);
        return {
          cacheHit: cachedValidation.cacheHit,
          ...cachedValidation.result,
        };
      },
    );

    for (const projectResult of projectResults) {
      totalDurationMs += projectResult.cacheHit ? 0 : projectResult.durationMs;
      diagnostics.push(...projectResult.diagnostics);
      notes.push(projectResult.note);
      statuses.push(projectResult.status);
      reusedCachedValidation ||= projectResult.cacheHit;
      toolRuns.push(
        ...projectResult.toolRuns.map((toolRun) =>
          cloneToolRunResult(toolRun, projectResult.cacheHit, runtime),
        ),
      );
    }
  } catch (error) {
    runtime.throwIfAbortError(error);
    return runtime.createExecutionFailureStage(
      task.stageId,
      "terraform-validate",
      files[0] ?? runtime.cwd,
      error,
      totalDurationMs,
      diagnostics,
      toolRuns,
    );
  }

  if (reusedCachedValidation) {
    notes.push("Reused cached Terraform validation for this file batch.");
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

function cloneToolRunResult(
  toolRun: StageResult["toolRuns"][number],
  cacheHit: boolean,
  runtime: HashicorpRunnerRuntime,
): StageResult["toolRuns"][number] {
  return runtime.createToolRunResult(
    toolRun.tool,
    toolRun.args,
    cacheHit ? 0 : toolRun.durationMs,
    toolRun.exitCode,
    toolRun.status,
    toolRun.finishedAt,
    toolRun.startedAt,
    cacheHit,
  );
}

export function createMissingTerraformBinaryStageResult(
  stageId: StageId,
  files: readonly string[],
  operation: "format" | "lint" | "validation",
  runtime: HashicorpRunnerRuntime,
): StageResult {
  const file = files[0] ?? runtime.cwd;
  const fileLabel = path.basename(file) || file;
  const operationLabel =
    operation === "validation" ? "Terraform validation" : `Terraform ${operation}`;
  const message = `${operationLabel} requires the 'terraform' binary for ${fileLabel}. Install Terraform, ensure 'terraform' is on PATH, then run \`aiq doctor\` to verify setup.`;

  return {
    diagnostics: [
      {
        file,
        message,
        severity: "error",
        source: "terraform",
      },
    ],
    durationMs: 0,
    notes: [message],
    stageId,
    status: "failed",
    toolRuns: [runtime.createToolRunResult("terraform", [], 0, undefined, "failed")],
  };
}

export function combineStageResults(
  stageId: StageId,
  results: readonly StageResult[],
  runtime: HashicorpRunnerRuntime,
): StageResult {
  const activeResults = results.filter((result) => !isNoopStageResult(result));
  if (activeResults.length === 0) {
    return runtime.createNoopStageResult(
      stageId,
      `No supported files were selected for ${stageId}.`,
    );
  }

  return {
    diagnostics: activeResults.flatMap((result) => result.diagnostics),
    durationMs: activeResults.reduce((total, result) => total + result.durationMs, 0),
    notes: activeResults.flatMap((result) => result.notes),
    stageId,
    status: summarizeProjectStageStatus(activeResults.map((result) => result.status)),
    toolRuns: activeResults.flatMap((result) => result.toolRuns),
  };
}

function isNoopStageResult(result: StageResult): boolean {
  return (
    result.status === "passed" &&
    result.durationMs === 0 &&
    result.diagnostics.length === 0 &&
    result.toolRuns.length === 0
  );
}

async function runProjectBatches<TProject, TResult>(
  projects: readonly TProject[],
  runProject: (project: TProject) => Promise<TResult>,
  concurrencyLimit = resolveProjectConcurrencyLimit(),
): Promise<TResult[]> {
  const results: TResult[] = [];

  for (let index = 0; index < projects.length; index += concurrencyLimit) {
    const projectBatch = projects.slice(index, index + concurrencyLimit);
    results.push(...(await Promise.all(projectBatch.map((project) => runProject(project)))));
  }

  return results;
}

function summarizeProjectStageStatus(
  statuses: readonly StageResult["status"][],
): StageResult["status"] {
  if (statuses.length === 0) {
    return "passed";
  }

  if (statuses.includes("failed")) {
    return "failed";
  }

  if (statuses.includes("not_implemented")) {
    return "not_implemented";
  }

  return "passed";
}
