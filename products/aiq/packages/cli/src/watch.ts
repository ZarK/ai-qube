import { watch as watchFileSystem } from "node:fs";
import path from "node:path";

import {
  type LoadedAiqProgress,
  loadAiqProgress,
  resolveAiqProgressStageIds,
} from "@tjalve/aiq/config";
import { buildRunPlan, resolveRunRequest, runResolvedRequest } from "@tjalve/aiq/engine";
import type { ResolvedRunRequest, RunPlan, RunRequest } from "@tjalve/aiq/model";

import { writeWatchOutput } from "./output.js";
import { createManifestInput, resolveCliConfig } from "./requests.js";
import {
  createActiveSignal,
  formatError,
  isCliCancellation,
  isErrorCode,
  readStdin,
  splitLines,
  waitForAbort,
} from "./shared.js";
import { type CliIo, type CliRunOptions, type ParsedArgs, defaultWatchCadenceMs } from "./types.js";
import { createRunWorkflowForStages } from "./workflow.js";
import {
  type WatchDirectoryTarget,
  buildWatchReplanPaths,
  buildWatchTargets,
  loadOptionalWatchProgress,
  matchesWatchTarget,
  resolveWatchTrigger,
  sameWatchPaths,
  sameWatchTargets,
  shouldReprepareWatchRun,
  usesWatchProgressDefaults,
} from "./watch-targets.js";

interface WatchPreparedRun {
  cadence?: PreparedWatchExecution;
  cadenceMs?: number;
  continuous?: PreparedWatchExecution;
  progress?: LoadedAiqProgress;
  replanPaths: Set<string>;
  replanWatchPaths: string[];
  targets: WatchDirectoryTarget[];
}

interface PreparedWatchExecution {
  plan: RunPlan;
  request: ResolvedRunRequest;
}

export async function runWatchCommand(
  parsed: ParsedArgs,
  io: CliIo,
  options: CliRunOptions,
): Promise<number> {
  const activeSignal = createActiveSignal(options.signal);
  const watchers: Array<ReturnType<typeof watchFileSystem>> = [];
  let cadenceTimer: ReturnType<typeof setInterval> | undefined;
  let cachedStreamFiles: string[] | undefined;
  let currentTargets: WatchDirectoryTarget[] = [];
  let currentReplanWatchPaths: string[] = [];
  let lastExitCode = 0;
  let cadenceRequested = false;
  let pendingContinuousTrigger: string | undefined;
  let prepared: WatchPreparedRun | undefined;
  let rerunRequested = false;
  let runInFlight = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const closeWatchers = (): void => {
    for (const watcher of watchers.splice(0)) {
      watcher.close();
    }
  };

  const clearPendingTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const clearCadenceTimer = (): void => {
    if (cadenceTimer !== undefined) {
      clearInterval(cadenceTimer);
      cadenceTimer = undefined;
    }
  };

  const updateWatchers = (targets: WatchDirectoryTarget[], replanWatchPaths: string[]): void => {
    closeWatchers();
    currentTargets = targets;
    currentReplanWatchPaths = replanWatchPaths;

    for (const target of targets) {
      try {
        watchers.push(
          watchFileSystem(target.dir, (_eventType, filename) => {
            if (!matchesWatchTarget(filename, target.names)) {
              return;
            }

            scheduleContinuousRun(resolveWatchTrigger(target.dir, filename, target.names));
          }),
        );
      } catch (error) {
        if (!isErrorCode(error, "ENOENT")) {
          throw error;
        }
      }
    }

    for (const replanWatchPath of replanWatchPaths) {
      try {
        watchers.push(
          watchFileSystem(replanWatchPath, () => {
            scheduleContinuousRun(replanWatchPath);
          }),
        );
      } catch (error) {
        if (!isErrorCode(error, "ENOENT")) {
          throw error;
        }
      }
    }
  };

  const updateCadenceTimer = (nextPrepared: WatchPreparedRun): void => {
    clearCadenceTimer();
    if (nextPrepared.cadence === undefined || nextPrepared.cadenceMs === undefined) {
      return;
    }

    cadenceTimer = setInterval(() => {
      cadenceRequested = true;
      if (!runInFlight && timer === undefined) {
        void executeNextRun();
      }
    }, nextPrepared.cadenceMs);
  };

  const ensurePrepared = async (trigger: string): Promise<WatchPreparedRun> => {
    if (prepared !== undefined && !shouldReprepareWatchRun(prepared, trigger)) {
      return prepared;
    }

    const nextPrepared = await createWatchPreparedRun(parsed, io, cachedStreamFiles);
    if (
      !sameWatchTargets(currentTargets, nextPrepared.targets) ||
      !sameWatchPaths(currentReplanWatchPaths, nextPrepared.replanWatchPaths)
    ) {
      updateWatchers(nextPrepared.targets, nextPrepared.replanWatchPaths);
    }
    updateCadenceTimer(nextPrepared);
    prepared = nextPrepared;
    return nextPrepared;
  };

  const executeNextRun = async (): Promise<void> => {
    if (activeSignal.signal.aborted || runInFlight) {
      return;
    }

    const runKind = resolveNextWatchRunKind(pendingContinuousTrigger, cadenceRequested, timer);
    if (runKind === undefined) {
      return;
    }

    runInFlight = true;
    const trigger = consumeWatchRunTrigger(runKind);

    try {
      await executePreparedWatchRun(runKind, trigger);
    } catch (error) {
      if (isCliCancellation(error, activeSignal.signal)) {
        return;
      }

      lastExitCode = 1;
      io.stderr.write(`${formatError(error)}\n`);
    } finally {
      runInFlight = false;
      scheduleFollowUpRun();
    }
  };

  const consumeWatchRunTrigger = (runKind: "cadence" | "continuous"): string => {
    if (runKind === "cadence") {
      cadenceRequested = false;
      return "cadence";
    }

    const trigger = pendingContinuousTrigger ?? "startup";
    pendingContinuousTrigger = undefined;
    return trigger;
  };

  const executePreparedWatchRun = async (
    runKind: "cadence" | "continuous",
    trigger: string,
  ): Promise<void> => {
    const nextPrepared = await ensurePrepared(trigger);
    const execution = runKind === "continuous" ? nextPrepared.continuous : nextPrepared.cadence;
    if (execution === undefined) {
      cadenceRequested = runKind === "continuous" && nextPrepared.cadence !== undefined;
      lastExitCode = 0;
      return;
    }

    const result = await runResolvedRequest(
      {
        ...execution.request,
        signal: activeSignal.signal,
      },
      execution.plan,
    );
    lastExitCode = result.ok ? 0 : 1;
    writeWatchOutput(
      io,
      parsed.format,
      trigger,
      result,
      nextPrepared.progress === undefined
        ? undefined
        : createRunWorkflowForStages(
            nextPrepared.progress,
            execution.request.selection.stages,
            result,
          ),
    );
  };

  const scheduleFollowUpRun = (): void => {
    if (activeSignal.signal.aborted) {
      return;
    }

    if (rerunRequested && pendingContinuousTrigger !== undefined) {
      rerunRequested = false;
      scheduleContinuousRun(pendingContinuousTrigger);
      return;
    }

    if (pendingContinuousTrigger !== undefined && timer === undefined) {
      void executeNextRun();
      return;
    }

    if (cadenceRequested) {
      void executeNextRun();
    }
  };

  const scheduleContinuousRun = (trigger: string): void => {
    const pendingTriggerRequiresReplan =
      prepared !== undefined &&
      pendingContinuousTrigger !== undefined &&
      shouldReprepareWatchRun(prepared, pendingContinuousTrigger);
    const nextTriggerRequiresReplan =
      prepared !== undefined && shouldReprepareWatchRun(prepared, trigger);

    if (!pendingTriggerRequiresReplan || nextTriggerRequiresReplan) {
      pendingContinuousTrigger = trigger;
    }

    if (activeSignal.signal.aborted) {
      return;
    }

    if (runInFlight) {
      rerunRequested = true;
      return;
    }

    clearPendingTimer();
    timer = setTimeout(() => {
      timer = undefined;
      void executeNextRun();
    }, parsed.debounceMs);
  };

  try {
    cachedStreamFiles = parsed.stdinFileList ? splitLines(await readStdin(io.stdin)) : undefined;
    const initialPrepared = await createWatchPreparedRun(parsed, io, cachedStreamFiles);
    prepared = initialPrepared;
    if (initialPrepared.continuous !== undefined) {
      pendingContinuousTrigger = "startup";
    } else if (initialPrepared.cadence !== undefined) {
      cadenceRequested = true;
    }
    await executeNextRun();
    updateWatchers(initialPrepared.targets, initialPrepared.replanWatchPaths);
    updateCadenceTimer(initialPrepared);
    await waitForAbort(activeSignal.signal);
    return lastExitCode;
  } catch (error) {
    if (isCliCancellation(error, activeSignal.signal)) {
      return 0;
    }

    io.stderr.write(`${formatError(error)}\n`);
    return 2;
  } finally {
    clearCadenceTimer();
    clearPendingTimer();
    closeWatchers();
    activeSignal.cleanup();
  }
}

async function createWatchPreparedRun(
  parsed: ParsedArgs,
  io: CliIo,
  cachedStreamFiles?: string[],
): Promise<WatchPreparedRun> {
  const manifest = await createManifestInput(parsed, io, cachedStreamFiles);
  const progress = await loadOptionalWatchProgress(parsed, io);
  const watchProgressPath = usesWatchProgressDefaults(parsed);
  const resolvedConfig = await resolveCliConfig(parsed, io, {
    ...(progress === undefined
      ? {}
      : { stageOverrides: resolveAiqProgressStageIds(progress.progress.current_stage) }),
    surface: "watch",
  });
  const baseRequest: RunRequest = {
    context: "watch",
    cwd: resolvedConfig.cwd,
    manifest,
    mode: "check",
    ...(parsed.outDir === undefined ? {} : { outDir: parsed.outDir }),
    profile: resolvedConfig.profile,
    writeArtifacts: true,
  };
  const cadenceStageSet = new Set(resolvedConfig.cadenceStages);
  const continuousStages = resolvedConfig.stages.filter((stageId) => !cadenceStageSet.has(stageId));
  const requestOptions =
    resolvedConfig.stageConfigurations === undefined
      ? {}
      : { stageConfigurations: resolvedConfig.stageConfigurations };
  const filesFromPath =
    parsed.filesFrom === undefined ? undefined : path.resolve(io.cwd, parsed.filesFrom);
  const [targetRequest, continuous, cadence] = await Promise.all([
    resolveRunRequest({
      ...baseRequest,
      stages: resolvedConfig.stages,
      ...requestOptions,
    }),
    createPreparedWatchExecution({
      ...baseRequest,
      stages: continuousStages,
      ...requestOptions,
    }),
    createPreparedWatchExecution({
      ...baseRequest,
      stages: resolvedConfig.cadenceStages,
      ...requestOptions,
    }),
  ]);
  const replanPaths = buildWatchReplanPaths(
    targetRequest.cwd,
    resolvedConfig.configPath,
    progress?.path,
    watchProgressPath,
    filesFromPath,
  );
  const preparedRun: WatchPreparedRun = {
    ...(progress === undefined ? {} : { progress }),
    replanPaths,
    replanWatchPaths: [...replanPaths],
    targets: buildWatchTargets(
      targetRequest.cwd,
      targetRequest.manifest.files,
      resolvedConfig.configPath,
      progress?.path,
      watchProgressPath,
      filesFromPath,
    ),
  };

  if (continuous !== undefined) {
    preparedRun.continuous = continuous;
  }

  if (cadence !== undefined) {
    preparedRun.cadence = cadence;
    preparedRun.cadenceMs = resolvedConfig.cadenceMs ?? defaultWatchCadenceMs;
  }

  return preparedRun;
}

async function createPreparedWatchExecution(
  request: RunRequest,
): Promise<PreparedWatchExecution | undefined> {
  if (request.stages === undefined || request.stages.length === 0) {
    return undefined;
  }

  const resolvedRequest = await resolveRunRequest(request);
  return {
    plan: buildRunPlan(resolvedRequest),
    request: resolvedRequest,
  };
}

function resolveNextWatchRunKind(
  pendingContinuousTrigger: string | undefined,
  cadenceRequested: boolean,
  timer: ReturnType<typeof setTimeout> | undefined,
): "cadence" | "continuous" | undefined {
  if (pendingContinuousTrigger !== undefined && timer === undefined) {
    return "continuous";
  }

  return cadenceRequested ? "cadence" : undefined;
}
