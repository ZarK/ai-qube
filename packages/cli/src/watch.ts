import { watch as watchFileSystem } from "node:fs";
import path from "node:path";

import {
  type LoadedAiqProgress,
  loadAiqProgress,
  resolveAiqProgressStageIds,
} from "@tjalve/aiq-config-schema";
import { buildRunPlan, resolveRunRequest, runResolvedRequest } from "@tjalve/aiq-engine";
import type { ResolvedRunRequest, RunPlan, RunRequest } from "@tjalve/aiq-model";

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

interface WatchDirectoryTarget {
  dir: string;
  names: Set<string>;
}

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

    const runKind =
      pendingContinuousTrigger !== undefined && timer === undefined
        ? "continuous"
        : cadenceRequested
          ? "cadence"
          : undefined;
    if (runKind === undefined) {
      return;
    }

    runInFlight = true;
    const trigger = runKind === "continuous" ? (pendingContinuousTrigger ?? "startup") : "cadence";
    if (runKind === "continuous") {
      pendingContinuousTrigger = undefined;
    } else {
      cadenceRequested = false;
    }

    try {
      const nextPrepared = await ensurePrepared(trigger);
      const execution = runKind === "continuous" ? nextPrepared.continuous : nextPrepared.cadence;
      if (execution === undefined) {
        if (runKind === "continuous" && nextPrepared.cadence !== undefined) {
          cadenceRequested = true;
        }
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
    } catch (error) {
      if (isCliCancellation(error, activeSignal.signal)) {
        return;
      }

      lastExitCode = 1;
      io.stderr.write(`${formatError(error)}\n`);
    } finally {
      runInFlight = false;
      if (!activeSignal.signal.aborted) {
        if (rerunRequested && pendingContinuousTrigger !== undefined) {
          rerunRequested = false;
          scheduleContinuousRun(pendingContinuousTrigger);
        } else if (pendingContinuousTrigger !== undefined && timer === undefined) {
          void executeNextRun();
        } else if (cadenceRequested) {
          void executeNextRun();
        }
      }
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

function buildWatchReplanPaths(
  cwd: string,
  configPath?: string,
  progressPath?: string,
  watchProgressPath = false,
  filesFromPath?: string,
): Set<string> {
  const replanPaths = new Set<string>();
  if (configPath === undefined) {
    replanPaths.add(path.resolve(cwd, "aiq.config.json"));
    replanPaths.add(path.resolve(cwd, ".aiq", "aiq.config.json"));
  } else {
    replanPaths.add(path.resolve(configPath));
  }
  if (progressPath !== undefined) {
    replanPaths.add(path.resolve(progressPath));
  } else if (watchProgressPath) {
    replanPaths.add(path.resolve(cwd, ".aiq", "progress.json"));
  }
  if (filesFromPath !== undefined) {
    replanPaths.add(path.resolve(filesFromPath));
  }
  return replanPaths;
}

async function loadOptionalWatchProgress(
  parsed: ParsedArgs,
  io: CliIo,
): Promise<LoadedAiqProgress | undefined> {
  if (!usesWatchProgressDefaults(parsed)) {
    return undefined;
  }

  const progress = await loadAiqProgress(io.cwd);
  return progress.source === "file" ? progress : undefined;
}

function usesWatchProgressDefaults(parsed: ParsedArgs): boolean {
  return parsed.stages.length === 0 && parsed.profile === undefined;
}

function shouldReprepareWatchRun(prepared: WatchPreparedRun, trigger: string): boolean {
  const resolvedTrigger = path.resolve(trigger);
  if (prepared.replanPaths.has(resolvedTrigger)) {
    return true;
  }

  return [...prepared.replanPaths].some(
    (replanPath) => path.dirname(replanPath) === resolvedTrigger,
  );
}

function buildWatchTargets(
  cwd: string,
  files: readonly string[],
  configPath?: string,
  progressPath?: string,
  watchProgressPath = false,
  filesFromPath?: string,
): WatchDirectoryTarget[] {
  const targets = new Map<string, Set<string>>();

  for (const file of files) {
    addWatchTarget(targets, cwd, file);
  }

  if (filesFromPath !== undefined) {
    addWatchTarget(targets, cwd, filesFromPath);
  }

  if (configPath !== undefined) {
    addWatchTarget(targets, cwd, configPath);
  } else {
    addWatchTarget(targets, cwd, path.join(cwd, "aiq.config.json"));
    addWatchTarget(targets, cwd, path.join(cwd, ".aiq", "aiq.config.json"));
  }

  if (progressPath !== undefined) {
    addWatchTarget(targets, cwd, progressPath);
  } else if (watchProgressPath) {
    addWatchTarget(targets, cwd, path.join(cwd, ".aiq", "progress.json"));
  }

  return [...targets.entries()]
    .map(([dir, names]) => ({ dir, names }))
    .sort((left, right) => left.dir.localeCompare(right.dir));
}

function addWatchTarget(targets: Map<string, Set<string>>, cwd: string, filePath: string): void {
  const absolutePath = path.resolve(cwd, filePath);
  const dir = path.dirname(absolutePath);
  const name = path.basename(absolutePath);
  const names = targets.get(dir) ?? new Set<string>();
  names.add(name);
  targets.set(dir, names);
}

function sameWatchTargets(left: WatchDirectoryTarget[], right: WatchDirectoryTarget[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((target, index) => {
    const other = right[index];
    return other !== undefined && normalizeWatchTarget(target) === normalizeWatchTarget(other);
  });
}

function normalizeWatchTarget(target: WatchDirectoryTarget): string {
  return `${target.dir}:${[...target.names].sort().join(",")}`;
}

function sameWatchPaths(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  const normalizedLeft = [...left].sort();
  const normalizedRight = [...right].sort();
  return normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function matchesWatchTarget(
  filename: Buffer | string | null | undefined,
  names: Set<string>,
): boolean {
  if (filename === null || filename === undefined) {
    return true;
  }

  return names.has(filename.toString());
}

function resolveWatchTrigger(
  dir: string,
  filename: Buffer | string | null | undefined,
  names?: Set<string>,
): string {
  if (filename === null || filename === undefined) {
    if (names?.size === 1) {
      const [name] = names;
      if (name !== undefined) {
        return path.join(dir, name);
      }
    }

    return dir;
  }

  return path.join(dir, filename.toString());
}
