import type { PlannedTask, StageResult } from "../contracts.js";
import type { PythonRunnerRuntime } from "./contracts.js";
import { runRuffCheckProject, runRuffFormatProject, runTyCheckProject } from "./python-tools.js";
import { filterPythonTaskFiles, resolvePythonProjects, resolvePythonSourceProject, runProjectBatches } from "./python-projects.js";

export async function runPythonLintTask(
  task: PlannedTask,
  runtime: PythonRunnerRuntime,
): Promise<StageResult> {
  const files = filterPythonTaskFiles(task.files);
  if (files.length === 0) {
    return runtime.createNoopStageResult(task.stageId, "No Python files were selected for lint.");
  }

  const diagnostics = [] as Awaited<ReturnType<typeof runRuffCheckProject>>["diagnostics"];
  const toolRuns = [] as StageResult["toolRuns"];
  let totalDurationMs = 0;

  try {
    const projects = await resolvePythonProjects(runtime.graph, files);
    const projectResults = await runProjectBatches(projects, async (project) =>
      runRuffCheckProject(await resolvePythonSourceProject(project, runtime), runtime),
    );

    for (const projectResult of projectResults) {
      totalDurationMs += projectResult.durationMs;
      diagnostics.push(...projectResult.diagnostics);
      toolRuns.push(projectResult.toolRun);
    }
  } catch (error) {
    runtime.throwIfAbortError(error);
    return runtime.createExecutionFailureStage(
      task.stageId,
      "ruff",
      files[0] ?? runtime.cwd,
      error,
      totalDurationMs,
      diagnostics,
      toolRuns,
    );
  }

  const status = diagnostics.length === 0 ? "passed" : "failed";

  return {
    diagnostics,
    durationMs: totalDurationMs,
    notes:
      status === "passed"
        ? ["Ruff lint passed."]
        : [`Ruff reported ${diagnostics.length} diagnostic${diagnostics.length === 1 ? "" : "s"}.`],
    stageId: task.stageId,
    status,
    toolRuns,
  };
}

export async function runPythonFormatTask(
  task: PlannedTask,
  runtime: PythonRunnerRuntime,
): Promise<StageResult> {
  const files = filterPythonTaskFiles(task.files);
  if (files.length === 0) {
    return runtime.createNoopStageResult(task.stageId, "No Python files were selected for format.");
  }

  const diagnostics = [] as Awaited<ReturnType<typeof runRuffFormatProject>>["diagnostics"];
  const toolRuns = [] as StageResult["toolRuns"];
  let totalDurationMs = 0;

  try {
    const projects = await resolvePythonProjects(runtime.graph, files);
    const projectResults = await runProjectBatches(projects, async (project) =>
      runRuffFormatProject(await resolvePythonSourceProject(project, runtime), runtime),
    );

    for (const projectResult of projectResults) {
      totalDurationMs += projectResult.durationMs;
      diagnostics.push(...projectResult.diagnostics);
      toolRuns.push(projectResult.toolRun);
    }
  } catch (error) {
    runtime.throwIfAbortError(error);
    return runtime.createExecutionFailureStage(
      task.stageId,
      "ruff",
      files[0] ?? runtime.cwd,
      error,
      totalDurationMs,
      diagnostics,
      toolRuns,
    );
  }

  const status = diagnostics.length === 0 ? "passed" : "failed";

  return {
    diagnostics,
    durationMs: totalDurationMs,
    notes:
      status === "passed"
        ? ["Ruff format passed."]
        : [
            `Ruff reported ${diagnostics.length} formatting diagnostic${diagnostics.length === 1 ? "" : "s"}.`,
          ],
    stageId: task.stageId,
    status,
    toolRuns,
  };
}

export async function runPythonTypecheckTask(
  task: PlannedTask,
  runtime: PythonRunnerRuntime,
): Promise<StageResult> {
  const files = filterPythonTaskFiles(task.files);
  if (files.length === 0) {
    return runtime.createNoopStageResult(
      task.stageId,
      "No Python files were selected for typecheck.",
    );
  }

  const diagnostics = [] as Awaited<ReturnType<typeof runTyCheckProject>>["diagnostics"];
  const toolRuns = [] as StageResult["toolRuns"];
  let totalDurationMs = 0;

  try {
    const projects = await resolvePythonProjects(runtime.graph, files);
    const projectResults = await runProjectBatches(projects, async (project) =>
      runTyCheckProject(await resolvePythonSourceProject(project, runtime), runtime),
    );

    for (const projectResult of projectResults) {
      totalDurationMs += projectResult.durationMs;
      diagnostics.push(...projectResult.diagnostics);
      toolRuns.push(projectResult.toolRun);
    }
  } catch (error) {
    runtime.throwIfAbortError(error);
    return runtime.createExecutionFailureStage(
      task.stageId,
      "ty",
      files[0] ?? runtime.cwd,
      error,
      totalDurationMs,
      diagnostics,
      toolRuns,
    );
  }

  const status = diagnostics.length === 0 ? "passed" : "failed";

  return {
    diagnostics,
    durationMs: totalDurationMs,
    notes:
      status === "passed"
        ? [`ty typecheck passed for ${toolRuns.length} project${toolRuns.length === 1 ? "" : "s"}.`]
        : [`ty reported ${diagnostics.length} diagnostic${diagnostics.length === 1 ? "" : "s"}.`],
    stageId: task.stageId,
    status,
    toolRuns,
  };
}
