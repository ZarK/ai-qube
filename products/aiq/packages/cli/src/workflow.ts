import {
  type LoadedAiqProgress,
  createAiqProgressRunSelection,
  resolveAiqProgressStageIds,
  resolveAiqProgressStageIndex,
  toAiqWorkflowStage,
} from "@tjalve/aiq/config";
import type { RunRequest, RunResult, StageId } from "@tjalve/aiq/model";

import type { RunWorkflowOutput } from "./output.js";
import { cliStageShortcutIds } from "./types.js";

type WorkflowStatus = "failed" | "none" | "not_implemented" | "passed" | "unreadable";
type WorkflowStageLike = {
  id: StageId;
  index: number;
};

export function createRunWorkflowOutput(
  loadedProgress: LoadedAiqProgress,
  request: RunRequest,
  result: RunResult,
): RunWorkflowOutput {
  return createRunWorkflowForStages(
    loadedProgress,
    request.stages ?? resolveAiqProgressStageIds(loadedProgress.progress.current_stage),
    result,
  );
}

export function createRunWorkflowForStages(
  loadedProgress: LoadedAiqProgress,
  selectedStages: readonly StageId[],
  result: RunResult,
): RunWorkflowOutput {
  const selection = createAiqProgressRunSelection(loadedProgress, selectedStages);
  const failedStages = result.stages
    .filter((stage) => stage.status !== "passed")
    .map((stage) => toAiqWorkflowStage(resolveAiqProgressStageIndex(stage.stageId)));
  const currentStageResult = result.stages.find(
    (stage) => stage.stageId === selection.currentStage.id,
  );
  const currentStageSatisfied =
    currentStageResult === undefined ? undefined : currentStageResult.status === "passed";

  return {
    ...selection,
    ...(currentStageSatisfied === undefined ? {} : { currentStageSatisfied }),
    debugCommands: failedStages.map((stage) => createDebugCommand(stage.index)),
    failedStages,
    nextCommand: resolveNextCommand(
      selection.currentStage,
      failedStages,
      result.summary.status,
      currentStageSatisfied,
    ),
  };
}

export function createDefaultRunOutput(currentStageIndex: number): RunWorkflowOutput["defaultRun"] {
  return createAiqProgressRunSelection(
    {
      path: "",
      progress: {
        current_stage: currentStageIndex as LoadedAiqProgress["progress"]["current_stage"],
        disabled: [],
        last_run: null,
        order: [],
      },
      source: "defaults",
    },
    [],
  ).defaultRun;
}

export function resolveNextCommand(
  currentStage: WorkflowStageLike,
  failedStages: readonly WorkflowStageLike[],
  status: WorkflowStatus,
  currentStageSatisfied?: boolean,
): string {
  const [firstFailedStage] = failedStages;
  if (firstFailedStage !== undefined) {
    return createDebugCommand(firstFailedStage.index);
  }

  if (status === "passed" && currentStageSatisfied === true) {
    const nextStage = currentStage.index + 1;
    return nextStage < cliStageShortcutIds.length
      ? `aiq config --set-stage ${nextStage}`
      : "aiq run <paths...>";
  }

  return "aiq run <paths...>";
}

function createDebugCommand(stageIndex: number): string {
  return `aiq run <paths...> --only ${stageIndex} --verbose`;
}
