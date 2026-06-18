import { AsyncLocalStorage } from "node:async_hooks";

import { createCacheService } from "./cache.js";
import type {
  CacheService,
  EngineContext,
  ProjectGraph,
  RunStageConfigurations,
  StageId,
} from "./contracts.js";
import { ToolRunner } from "./tool-runner.js";

export type RunnerExecutionContext = {
  cache: CacheService;
  cwd: string;
  graph: ProjectGraph | undefined;
  selectedStages: readonly StageId[];
  stageConfigurations: RunStageConfigurations | undefined;
  signal: AbortSignal | undefined;
  sharedState: RunnerSharedState;
  toolRunner: ToolRunner;
};

type RunnerSharedState = {
  runScopedValues: Map<string, unknown>;
};

const defaultRunnerCache = createCacheService();
const defaultRunnerToolRunner = new ToolRunner(defaultRunnerCache);
const runnerSharedStateByCache = new WeakMap<CacheService, RunnerSharedState>();

export const runnerExecutionContextStorage = new AsyncLocalStorage<RunnerExecutionContext>();

function getRunnerSharedState(cache: CacheService): RunnerSharedState {
  const existing = runnerSharedStateByCache.get(cache);
  if (existing !== undefined) {
    return existing;
  }

  const created: RunnerSharedState = {
    runScopedValues: new Map<string, unknown>(),
  };
  runnerSharedStateByCache.set(cache, created);
  return created;
}

export function resetRunnerRunScopedValues(cache: CacheService): void {
  getRunnerSharedState(cache).runScopedValues.clear();
}

export function createRunnerExecutionContext(
  cwdOrContext: EngineContext | string,
  signal?: AbortSignal,
): RunnerExecutionContext {
  if (isEngineContext(cwdOrContext)) {
    const toolRunnerOverride = readToolRunnerOverride(cwdOrContext);

    return {
      cache: cwdOrContext.cache,
      cwd: cwdOrContext.cwd,
      graph: cwdOrContext.graph,
      selectedStages: [...cwdOrContext.selection.stages],
      stageConfigurations: cwdOrContext.selection.stageConfigurations,
      signal: signal ?? cwdOrContext.signal,
      sharedState: getRunnerSharedState(cwdOrContext.cache),
      toolRunner: toolRunnerOverride ?? new ToolRunner(cwdOrContext.cache),
    };
  }

  return {
    cache: defaultRunnerCache,
    cwd: cwdOrContext,
    graph: undefined,
    selectedStages: [],
    stageConfigurations: undefined,
    signal,
    sharedState: getRunnerSharedState(defaultRunnerCache),
    toolRunner: defaultRunnerToolRunner,
  };
}

function isEngineContext(value: EngineContext | string): value is EngineContext {
  return typeof value !== "string";
}

function readToolRunnerOverride(value: EngineContext): ToolRunner | undefined {
  return "toolRunner" in value && value.toolRunner instanceof ToolRunner
    ? value.toolRunner
    : undefined;
}

export function getRunnerExecutionContext(): RunnerExecutionContext {
  return (
    runnerExecutionContextStorage.getStore() ?? {
      cache: defaultRunnerCache,
      cwd: process.cwd(),
      graph: undefined,
      selectedStages: [],
      stageConfigurations: undefined,
      signal: undefined,
      sharedState: getRunnerSharedState(defaultRunnerCache),
      toolRunner: defaultRunnerToolRunner,
    }
  );
}

export function getRunnerGraph(): ProjectGraph | undefined {
  return getRunnerExecutionContext().graph;
}

export function getRunnerCache(): CacheService {
  return getRunnerExecutionContext().cache;
}

export async function getCachedRunnerValue<T>(
  scope: string,
  manifestKey: string,
  cacheKey: string,
  createValue: () => Promise<T>,
): Promise<{ cacheHit: boolean; value: T }> {
  const cache = getRunnerCache();
  const prefix = `${cache.generateKey([scope, manifestKey])}:`;
  const scopedCacheKey = cache.generateKey([scope, cacheKey]);
  await cache.deleteByPrefix(prefix, [scopedCacheKey]);
  return cache.getOrCreate(scopedCacheKey, createValue);
}

export function getRunnerSelectedStages(): readonly StageId[] {
  return getRunnerExecutionContext().selectedStages;
}

export function getRunnerStageConfigurations(): RunStageConfigurations | undefined {
  return getRunnerExecutionContext().stageConfigurations;
}

export function getRunnerRunScopedValue<T>(scope: string, key: string): T | undefined {
  return getRunnerExecutionContext().sharedState.runScopedValues.get(`${scope}:${key}`) as
    | T
    | undefined;
}

export function setRunnerRunScopedValue<T>(scope: string, key: string, value: T): void {
  getRunnerExecutionContext().sharedState.runScopedValues.set(`${scope}:${key}`, value);
}

export function getRunnerToolRunner(): ToolRunner {
  return getRunnerExecutionContext().toolRunner;
}
