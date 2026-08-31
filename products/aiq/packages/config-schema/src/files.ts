import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import {
  aiqConfigFileNames,
  aiqProgressFileName,
  aiqProgressFileNames,
  aiqProgressStageIndexes,
  aiqStageLadderIds,
  defaultConfig,
  defaultProgressState,
} from "./definitions.js";
import type {
  AiqProgressRunSelection,
  AiqProgressStageIndex,
  AiqProgressState,
  AiqStageId,
  AiqWorkflowStage,
  InitializedAiqProjectConfig,
  LoadAiqConfigOptions,
  LoadedAiqConfig,
  LoadedAiqProgress,
} from "./definitions.js";
import { validateAiqConfigFile, validateAiqProgressState } from "./validation.js";

export async function findAiqConfigFile(startDir: string): Promise<string | undefined> {
  let currentDir = path.resolve(startDir);
  const userGlobalPath = path.join(resolveAiqHome(), ".qube", "aiq", "config.json");

  while (true) {
    for (const relativePath of aiqConfigFileNames) {
      const candidate = path.join(currentDir, relativePath);
      if (!samePath(candidate, userGlobalPath) && await pathExists(candidate)) {
        return candidate;
      }
    }

    if (await pathExists(path.join(currentDir, ".git"))) return undefined;

    const nextDir = path.dirname(currentDir);
    if (nextDir === currentDir) {
      return undefined;
    }

    currentDir = nextDir;
  }
}

export async function findAiqProgressFile(startDir: string): Promise<string | undefined> {
  let currentDir = path.resolve(startDir);

  while (true) {
    for (const relativePath of aiqProgressFileNames) {
      const candidate = path.join(currentDir, relativePath);
      if (await pathExists(candidate)) {
        return candidate;
      }
    }

    const nextDir = path.dirname(currentDir);
    if (nextDir === currentDir) {
      return undefined;
    }

    currentDir = nextDir;
  }
}

export async function findAiqProjectRoot(startDir: string): Promise<string> {
  const progressPath = await findAiqProgressFile(startDir);
  if (progressPath !== undefined) {
    return projectRootFromKnownPath(progressPath);
  }

  const configPath = await findAiqConfigFile(startDir);
  if (configPath !== undefined) {
    return projectRootFromKnownPath(configPath);
  }

  let currentDir = path.resolve(startDir);
  while (true) {
    if (await pathExists(path.join(currentDir, ".git"))) return currentDir;
    const nextDir = path.dirname(currentDir);
    if (nextDir === currentDir) break;
    currentDir = nextDir;
  }

  return path.resolve(startDir);
}

export async function loadAiqConfig(cwd: string, options: LoadAiqConfigOptions = {}): Promise<LoadedAiqConfig> {
  const repoRoot = await findAiqProjectRoot(cwd);
  const configPath = await findAiqConfigFile(cwd);
  const userGlobalPath = path.join(resolveAiqHome(options.homeDirectory), ".qube", "aiq", "config.json");
  const machineLocalPath = path.join(repoRoot, ".qube", "aiq", "config.local.json");
  const [userGlobalConfig, repositoryConfig, machineLocalConfig] = await Promise.all([
    readAiqConfigLayer(userGlobalPath, "user-global"),
    configPath === undefined ? undefined : readAiqConfigLayer(configPath, "repository"),
    readAiqConfigLayer(machineLocalPath, "machine-local"),
  ]);
  const effectivePath = machineLocalConfig !== undefined
    ? machineLocalPath
    : repositoryConfig !== undefined
      ? configPath
      : userGlobalConfig !== undefined
        ? userGlobalPath
        : undefined;

  return {
    ...(repositoryConfig === undefined ? {} : { config: repositoryConfig }),
    ...(configPath === undefined ? {} : { path: configPath }),
    ...(userGlobalConfig === undefined ? {} : { userGlobalConfig }),
    ...(machineLocalConfig === undefined ? {} : { machineLocalConfig }),
    ...(effectivePath === undefined ? {} : { effectivePath }),
    layers: {
      userGlobalPath,
      userGlobalFound: userGlobalConfig !== undefined,
      repositoryPath: configPath ?? path.join(repoRoot, aiqConfigFileNames[0]),
      repositoryFound: repositoryConfig !== undefined,
      machineLocalPath,
      machineLocalFound: machineLocalConfig !== undefined,
    },
  };
}

async function readAiqConfigLayer(
  filePath: string,
  source: "machine-local" | "repository" | "user-global",
): Promise<ReturnType<typeof validateAiqConfigFile> | undefined> {
  if (!await pathExists(filePath)) return undefined;
  try {
    return validateAiqConfigFile(JSON.parse(await readFile(filePath, "utf8")), `${source} config ${filePath}`);
  } catch (error) {
    throw new Error(`Failed to parse or validate ${source} config ${filePath}: ${formatError(error)}`);
  }
}

export async function loadAiqProgress(cwd: string): Promise<LoadedAiqProgress> {
  const progressPath = await findAiqProgressFile(cwd);
  if (progressPath === undefined) {
    const projectRoot = await findAiqProjectRoot(cwd);
    return {
      path: path.join(projectRoot, aiqProgressFileName),
      progress: cloneProgressState(defaultProgressState),
      source: "defaults",
    };
  }

  let rawValue: unknown;
  try {
    rawValue = JSON.parse(await readFile(progressPath, "utf8"));
  } catch (error) {
    throw new Error(`Failed to parse ${progressPath}: ${formatError(error)}`);
  }

  return {
    path: progressPath,
    progress: validateAiqProgressState(rawValue, progressPath),
    source: "file",
  };
}

export function resolveAiqProgressStageIds(
  progress: AiqProgressStageIndex | AiqProgressState,
): AiqStageId[] {
  if (typeof progress === "number") {
    return [...aiqStageLadderIds.slice(0, progress + 1)];
  }

  const disabled = new Set(progress.disabled);
  const selected = new Set<AiqProgressStageIndex>();
  const stages: AiqStageId[] = [];
  for (const stageIndex of progress.order) {
    if (
      stageIndex > progress.current_stage ||
      disabled.has(stageIndex) ||
      selected.has(stageIndex)
    ) {
      continue;
    }

    const stageId = aiqStageLadderIds[stageIndex];
    if (stageId !== undefined) {
      selected.add(stageIndex);
      stages.push(stageId);
    }
  }
  return stages;
}

export function resolveAiqProgressStageIndex(stageId: AiqStageId): number {
  const index = aiqStageLadderIds.indexOf(stageId);
  if (index < 0) {
    throw new Error(
      `Unknown AIQ stage id '${stageId}'. Expected one of ${aiqStageLadderIds.join(", ")}.`,
    );
  }

  return index;
}

export function toAiqWorkflowStage(index: number): AiqWorkflowStage {
  const id = aiqStageLadderIds[index];
  if (id === undefined) {
    throw new Error(`Unknown AIQ stage index: ${index}`);
  }

  return {
    id,
    index,
    name: id,
  };
}

export function createAiqProgressRunSelection(
  loadedProgress: LoadedAiqProgress,
  selectedStages: readonly AiqStageId[],
): AiqProgressRunSelection {
  const currentStage = toAiqWorkflowStage(loadedProgress.progress.current_stage);
  const defaultStageIds = resolveAiqProgressStageIds(loadedProgress.progress);
  const cumulativeStageIds = resolveAiqProgressStageIds(loadedProgress.progress.current_stage);
  const range = arraysEqual(defaultStageIds, cumulativeStageIds)
    ? `0..${loadedProgress.progress.current_stage}`
    : defaultStageIds.map(resolveAiqProgressStageIndex).join(",");
  return {
    currentStage,
    defaultRun: {
      range,
      stages: defaultStageIds.map((stageId) =>
        toAiqWorkflowStage(resolveAiqProgressStageIndex(stageId)),
      ),
    },
    progressPath: loadedProgress.path,
    progressSource: loadedProgress.source,
    selectedStages: [...selectedStages],
  };
}

export async function saveAiqProgress(
  progressPath: string,
  progress: AiqProgressState,
): Promise<void> {
  await mkdir(path.dirname(progressPath), { recursive: true });
  await writeJsonFile(progressPath, validateAiqProgressState(progress, progressPath));
}

export async function setAiqProgressStage(
  cwd: string,
  stageIndex: AiqProgressStageIndex,
): Promise<LoadedAiqProgress> {
  const loaded = await loadAiqProgress(cwd);
  const progress: AiqProgressState = {
    ...loaded.progress,
    current_stage: stageIndex,
    disabled: [],
    order: [...aiqProgressStageIndexes],
  };
  await saveAiqProgress(loaded.path, progress);
  return {
    path: loaded.path,
    progress,
    source: "file",
  };
}

export async function initializeAiqProjectConfig(
  cwd: string,
): Promise<InitializedAiqProjectConfig> {
  const projectRoot = await findAiqProjectRoot(cwd);
  const existingConfigPath = await findAiqConfigFile(cwd);
  const existingProgressPath = await findAiqProgressFile(cwd);
  const configPath = existingConfigPath ?? path.join(projectRoot, aiqConfigFileNames[0]);
  const progressPath = existingProgressPath ?? path.join(projectRoot, aiqProgressFileName);

  if (existingConfigPath !== undefined) {
    await loadAiqConfig(cwd);
  }

  if (existingProgressPath === undefined) {
    await saveAiqProgress(progressPath, defaultProgressState);
  } else {
    await loadAiqProgress(cwd);
  }

  return {
    configCreated: false,
    configPath,
    progressCreated: existingProgressPath === undefined,
    progressPath,
  };
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function cloneProgressState(progress: AiqProgressState): AiqProgressState {
  return {
    current_stage: progress.current_stage,
    disabled: [...progress.disabled],
    order: [...progress.order],
    last_run: progress.last_run,
  };
}

function projectRootFromKnownPath(filePath: string): string {
  const parent = path.dirname(filePath);
  const productDir = path.basename(parent);
  const namespaceDir = path.basename(path.dirname(parent));
  if (namespaceDir === ".qube" && productDir === "aiq") {
    return path.dirname(path.dirname(parent));
  }
  if (productDir === ".aiq") {
    return path.dirname(parent);
  }
  return parent;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveAiqHome(homeDirectory?: string): string {
  return path.resolve(homeDirectory ?? process.env.USERPROFILE ?? process.env.HOME ?? homedir());
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}
