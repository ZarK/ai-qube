import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  type AiqProgressStageIndex,
  type AiqProgressState,
  type AiqStageId,
  type AiqStageMetadata,
  aiqConfigFileNames,
  aiqProgressFileName,
  aiqProgressStageIndexes,
  aiqStageLadderIds,
  aiqStageMetadata,
} from "./definitions.js";
import {
  findAiqConfigFile,
  findAiqProgressFile,
  findAiqProjectRoot,
  loadAiqConfig,
  loadAiqProgress,
  resolveAiqProgressStageIds,
  saveAiqProgress,
} from "./files.js";

export type AiqSetupFileOperation = "create" | "skip" | "update";
export type AiqSetupSelectionMode = "cumulative" | "exact";

export interface AiqSetupOptions {
  cwd?: string;
  dryRun?: boolean;
  stages?: readonly AiqStageId[];
}

export interface AiqSetupFileAction {
  operation: AiqSetupFileOperation;
  path: string;
  reason: string;
}

export interface AiqSetupConfigAction extends AiqSetupFileAction {
  custom: boolean;
}

export interface AiqSetupProgressAction extends AiqSetupFileAction {
  value: AiqProgressState;
}

export interface AiqSetupSelection {
  mode: AiqSetupSelectionMode;
  requestedStages: AiqStageId[];
  resolvedStages: AiqStageId[];
}

export interface AiqSetupPlan {
  config: AiqSetupConfigAction;
  dryRun: boolean;
  ok: true;
  progress: AiqSetupProgressAction;
  repoRoot: string;
  selection: AiqSetupSelection;
  stageMetadata: readonly AiqStageMetadata[];
}

export async function planAiqSetup(options: AiqSetupOptions = {}): Promise<AiqSetupPlan> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const repoRoot = await findAiqProjectRoot(cwd);
  const [existingConfigPath, existingProgressPath] = await Promise.all([
    findAiqConfigFile(cwd),
    findAiqProgressFile(cwd),
  ]);
  const [loadedConfig, loadedProgress] = await Promise.all([
    loadAiqConfig(cwd),
    loadAiqProgress(cwd),
  ]);
  const requestedStages = normalizeRequestedStages(options.stages ?? []);
  const desiredProgress =
    requestedStages.length === 0
      ? cloneProgress(loadedProgress.progress)
      : createSelectedProgress(loadedProgress.progress, requestedStages);
  const resolvedStages = resolveAiqProgressStageIds(desiredProgress);
  const mode =
    requestedStages.length > 1
      ? "exact"
      : isCumulativeSelection(desiredProgress, resolvedStages)
        ? "cumulative"
        : "exact";
  const configPath = existingConfigPath ?? path.join(repoRoot, aiqConfigFileNames[0]);
  const progressPath = existingProgressPath ?? path.join(repoRoot, aiqProgressFileName);
  const configCustom =
    loadedConfig.config !== undefined &&
    Object.keys(loadedConfig.config).some((key) => key !== "version");
  const progressOperation =
    existingProgressPath === undefined
      ? "create"
      : progressEqual(loadedProgress.progress, desiredProgress)
        ? "skip"
        : "update";

  return {
    config: {
      custom: configCustom,
      operation: existingConfigPath === undefined ? "create" : "skip",
      path: configPath,
      reason:
        existingConfigPath === undefined
          ? "The repository does not have AIQ config."
          : configCustom
            ? "The existing valid custom config is preserved."
            : "The existing valid config is preserved.",
    },
    dryRun: options.dryRun === true,
    ok: true,
    progress: {
      operation: progressOperation,
      path: progressPath,
      reason:
        progressOperation === "create"
          ? "The repository does not have AIQ progress state."
          : progressOperation === "update"
            ? "The selected stages change AIQ progress state."
            : "The existing AIQ progress state already matches the selection.",
      value: desiredProgress,
    },
    repoRoot,
    selection: {
      mode,
      requestedStages,
      resolvedStages,
    },
    stageMetadata: aiqStageMetadata,
  };
}

export async function applyAiqSetupPlan(plan: AiqSetupPlan): Promise<AiqSetupPlan> {
  if (plan.dryRun) {
    return plan;
  }

  const refreshed = await planAiqSetup({
    cwd: plan.repoRoot,
    ...(plan.selection.requestedStages.length === 0
      ? {}
      : { stages: plan.selection.requestedStages }),
  });
  if (refreshed.config.operation === "create") {
    await mkdir(path.dirname(refreshed.config.path), { recursive: true });
    await writeFile(refreshed.config.path, `${JSON.stringify({ version: 1 }, null, 2)}\n`, "utf8");
  }
  if (refreshed.progress.operation !== "skip") {
    await saveAiqProgress(refreshed.progress.path, refreshed.progress.value);
  }
  return refreshed;
}

function normalizeRequestedStages(stages: readonly AiqStageId[]): AiqStageId[] {
  const requested = new Set(stages);
  for (const stage of requested) {
    if (!aiqStageLadderIds.includes(stage)) {
      throw new Error(
        `Unknown AIQ stage id '${stage}'. Expected one of ${aiqStageLadderIds.join(", ")}.`,
      );
    }
  }
  return aiqStageLadderIds.filter((stage) => requested.has(stage));
}

function createSelectedProgress(
  existing: AiqProgressState,
  requestedStages: readonly AiqStageId[],
): AiqProgressState {
  const requestedIndexes = requestedStages.map((stage) =>
    aiqStageLadderIds.indexOf(stage),
  ) as AiqProgressStageIndex[];
  const currentStage = Math.max(...requestedIndexes) as AiqProgressStageIndex;
  if (requestedStages.length === 1) {
    return {
      current_stage: currentStage,
      disabled: [],
      order: [...aiqProgressStageIndexes],
      last_run: existing.last_run,
    };
  }

  const selected = new Set(requestedIndexes);
  return {
    current_stage: currentStage,
    disabled: aiqProgressStageIndexes.filter(
      (stageIndex) => stageIndex <= currentStage && !selected.has(stageIndex),
    ),
    order: [...aiqProgressStageIndexes],
    last_run: existing.last_run,
  };
}

function isCumulativeSelection(
  progress: AiqProgressState,
  resolvedStages: readonly AiqStageId[],
): boolean {
  return arraysEqual(resolvedStages, resolveAiqProgressStageIds(progress.current_stage));
}

function progressEqual(left: AiqProgressState, right: AiqProgressState): boolean {
  return (
    left.current_stage === right.current_stage &&
    left.last_run === right.last_run &&
    arraysEqual(left.disabled, right.disabled) &&
    arraysEqual(left.order, right.order)
  );
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function cloneProgress(progress: AiqProgressState): AiqProgressState {
  return {
    current_stage: progress.current_stage,
    disabled: [...progress.disabled],
    order: [...progress.order],
    last_run: progress.last_run,
  };
}
