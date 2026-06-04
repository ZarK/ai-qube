import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  type LanguageId,
  type RunStageConfigurations,
  type StageId,
  type SurfaceId,
  languageIds,
  stageIds,
  surfaceIds,
} from "@tjalve/aiq/model";

export const aiqConfigFileNames = [".aiq/aiq.config.json", "aiq.config.json"] as const;
export const aiqProgressFileName = ".aiq/progress.json" as const;

export const aiqProfileNames = ["fast", "standard", "deep"] as const;

export type AiqProfileName = (typeof aiqProfileNames)[number];

export const aiqStageIds = stageIds;

export type AiqStageId = StageId;

export const aiqLanguageIds = languageIds;

export type AiqLanguageId = LanguageId;

export const aiqSurfaceIds = surfaceIds;

export type AiqSurfaceId = SurfaceId;

export const aiqProgressStageIndexes = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

export type AiqProgressStageIndex = (typeof aiqProgressStageIndexes)[number];

export const aiqStageLadderIds = [
  "e2e",
  "lint",
  "format",
  "typecheck",
  "unit",
  "sloc",
  "complexity",
  "maintainability",
  "coverage",
  "security",
] as const satisfies readonly AiqStageId[];

export const aiqToolIds = [
  "bash",
  "biome",
  "css",
  "documents",
  "dotnet",
  "go",
  "html",
  "javascript",
  "jvm",
  "powershell",
  "python",
  "rust",
  "security",
  "sql",
  "terraform",
  "typescript",
  "yaml",
] as const;

export type AiqToolId = (typeof aiqToolIds)[number];

export interface AiqProfileConfig {
  changedOnly: boolean;
  stages: AiqStageId[];
}

export interface AiqStageLanguageConfig {
  enabled: boolean;
  tool: AiqToolId;
}

export interface AiqStageConfig {
  enabled: boolean;
  languages: Partial<Record<AiqLanguageId, AiqStageLanguageConfig>>;
}

export interface AiqStageConfigFile {
  enabled?: boolean;
  languages?: Partial<Record<AiqLanguageId, AiqStageLanguageConfig>>;
}

export interface AiqInputsConfig {
  ignore: string[];
}

export interface AiqSurfaceConfig {
  cadenceMs?: number;
  cadenceStages?: AiqStageId[];
  changedOnly?: boolean;
  stages?: AiqStageId[];
  profile: AiqProfileName;
  publishDiagnostics?: boolean;
}

export interface AiqConfig {
  version: 1;
  inputs: AiqInputsConfig;
  stages: Record<AiqStageId, AiqStageConfig>;
  profiles: Record<AiqProfileName, AiqProfileConfig>;
  surfaces: Record<AiqSurfaceId, AiqSurfaceConfig>;
}

export interface AiqConfigFile {
  $schema?: string;
  version: 1;
  inputs?: Partial<AiqInputsConfig>;
  stages?: Partial<Record<AiqStageId, AiqStageConfigFile>>;
  profiles?: Partial<Record<AiqProfileName, Partial<AiqProfileConfig>>>;
  surfaces?: Partial<Record<AiqSurfaceId, Partial<AiqSurfaceConfig>>>;
}

export interface LoadedAiqConfig {
  config?: AiqConfigFile;
  path?: string;
}

export interface AiqProgressState {
  current_stage: AiqProgressStageIndex;
  disabled: AiqProgressStageIndex[];
  order: AiqProgressStageIndex[];
  last_run: string | null;
}

export interface LoadedAiqProgress {
  path: string;
  progress: AiqProgressState;
  source: "defaults" | "file";
}

export interface AiqWorkflowStage {
  id: AiqStageId;
  index: number;
  name: AiqStageId;
}

export interface AiqProgressRunSelection {
  currentStage: AiqWorkflowStage;
  defaultRun: {
    range: string;
    stages: AiqWorkflowStage[];
  };
  progressPath: string;
  progressSource: "defaults" | "file";
  selectedStages: AiqStageId[];
}

export interface InitializedAiqProjectConfig {
  configCreated: boolean;
  configPath: string;
  progressCreated: boolean;
  progressPath: string;
}

export interface ResolveAiqConfigOptions {
  cwd?: string;
  stages?: readonly AiqStageId[];
  profile?: AiqProfileName;
  surface: AiqSurfaceId;
}

export interface ResolvedAiqConfig {
  cadenceMs?: number;
  cadenceStages: AiqStageId[];
  changedOnly: boolean;
  config: AiqConfig;
  configPath?: string;
  cwd: string;
  stages: AiqStageId[];
  stageConfigurations?: RunStageConfigurations;
  profile: AiqProfileName;
  publishDiagnostics: boolean;
  source: "defaults" | "file";
  surface: AiqSurfaceId;
}

const defaultStageLanguageTools: Record<AiqStageId, Partial<Record<AiqLanguageId, AiqToolId>>> = {
  lint: {
    javascript: "biome",
    typescript: "biome",
    python: "python",
    terraform: "terraform",
    hcl: "terraform",
    go: "go",
    rust: "rust",
    dotnet: "dotnet",
    java: "jvm",
    kotlin: "jvm",
    bash: "bash",
    powershell: "powershell",
    html: "html",
    css: "css",
    yaml: "yaml",
    sql: "sql",
  },
  format: {
    javascript: "biome",
    typescript: "biome",
    terraform: "terraform",
    hcl: "terraform",
    go: "go",
    rust: "rust",
    dotnet: "dotnet",
    java: "jvm",
    kotlin: "jvm",
    python: "python",
    bash: "bash",
    powershell: "powershell",
    html: "documents",
    css: "documents",
    yaml: "documents",
    sql: "sql",
  },
  typecheck: {
    terraform: "terraform",
    go: "go",
    rust: "rust",
    dotnet: "dotnet",
    java: "jvm",
    kotlin: "jvm",
    typescript: "typescript",
    python: "python",
  },
  unit: {
    bash: "bash",
    powershell: "powershell",
    go: "go",
    rust: "rust",
    dotnet: "dotnet",
    java: "jvm",
    kotlin: "jvm",
    javascript: "javascript",
    typescript: "javascript",
    python: "python",
  },
  e2e: {
    javascript: "javascript",
    typescript: "javascript",
  },
  sloc: {
    javascript: "javascript",
    typescript: "javascript",
    go: "go",
    rust: "rust",
    dotnet: "dotnet",
    java: "jvm",
    kotlin: "jvm",
    python: "python",
  },
  complexity: {
    javascript: "javascript",
    typescript: "javascript",
    go: "go",
    rust: "rust",
    dotnet: "dotnet",
    java: "jvm",
    kotlin: "jvm",
    python: "python",
  },
  maintainability: {
    javascript: "javascript",
    typescript: "javascript",
    go: "go",
    rust: "rust",
    dotnet: "dotnet",
    java: "jvm",
    kotlin: "jvm",
    python: "python",
  },
  coverage: {
    bash: "bash",
    powershell: "powershell",
    go: "go",
    rust: "rust",
    dotnet: "dotnet",
    java: "jvm",
    kotlin: "jvm",
    javascript: "javascript",
    typescript: "javascript",
    python: "python",
  },
  security: Object.fromEntries(
    aiqLanguageIds.map((languageId) => [languageId, "security"]),
  ) as Partial<Record<AiqLanguageId, AiqToolId>>,
};

const supportedStageToolIds: Record<AiqStageId, readonly AiqToolId[]> = aiqStageIds.reduce(
  (accumulator, stageId) => {
    accumulator[stageId] = [...new Set(Object.values(defaultStageLanguageTools[stageId]))].sort();
    return accumulator;
  },
  {} as Record<AiqStageId, readonly AiqToolId[]>,
);

export const defaultConfig: AiqConfig = {
  version: 1,
  inputs: {
    ignore: ["node_modules/**", ".git/**", ".venv/**", "dist/**", "build/**"],
  },
  stages: Object.fromEntries(
    aiqStageIds.map((stageId) => [stageId, createDefaultStageConfig(stageId)]),
  ) as Record<AiqStageId, AiqStageConfig>,
  profiles: {
    fast: {
      changedOnly: true,
      stages: ["lint"],
    },
    standard: {
      changedOnly: false,
      stages: ["lint", "typecheck", "unit"],
    },
    deep: {
      changedOnly: false,
      stages: ["lint", "typecheck", "unit", "coverage", "security"],
    },
  },
  surfaces: {
    cli: {
      profile: "fast",
    },
    hook: {
      profile: "fast",
    },
    github: {
      profile: "deep",
      publishDiagnostics: true,
    },
    opencode: {
      profile: "fast",
      publishDiagnostics: true,
    },
    lsp: {
      profile: "fast",
      publishDiagnostics: true,
    },
    mcp: {
      profile: "fast",
    },
    watch: {
      profile: "fast",
    },
    serve: {
      profile: "standard",
    },
  },
};

export const defaultProgressState: AiqProgressState = {
  current_stage: 1,
  disabled: [],
  order: [...aiqProgressStageIndexes],
  last_run: null,
};

export function resolveProfile(config: AiqConfig, profile?: AiqProfileName): AiqProfileConfig {
  const selected = profile ?? "fast";
  return cloneProfileConfig(config.profiles[selected]);
}

export async function findAiqConfigFile(startDir: string): Promise<string | undefined> {
  let currentDir = path.resolve(startDir);

  while (true) {
    for (const relativePath of aiqConfigFileNames) {
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

export async function findAiqProgressFile(startDir: string): Promise<string | undefined> {
  let currentDir = path.resolve(startDir);

  while (true) {
    const candidate = path.join(currentDir, aiqProgressFileName);
    if (await pathExists(candidate)) {
      return candidate;
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
    return path.dirname(path.dirname(progressPath));
  }

  const configPath = await findAiqConfigFile(startDir);
  if (configPath !== undefined) {
    const configDir = path.dirname(configPath);
    return path.basename(configDir) === ".aiq" ? path.dirname(configDir) : configDir;
  }

  return path.resolve(startDir);
}

export async function loadAiqConfig(cwd: string): Promise<LoadedAiqConfig> {
  const configPath = await findAiqConfigFile(cwd);
  if (configPath === undefined) {
    return {};
  }

  let rawValue: unknown;
  try {
    rawValue = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    throw new Error(`Failed to parse ${configPath}: ${formatError(error)}`);
  }

  return {
    config: validateAiqConfigFile(rawValue, configPath),
    path: configPath,
  };
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

export function resolveAiqProgressStageIds(currentStage: AiqProgressStageIndex): AiqStageId[] {
  return [...aiqStageLadderIds.slice(0, currentStage + 1)];
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
  return {
    currentStage,
    defaultRun: {
      range: `0..${loadedProgress.progress.current_stage}`,
      stages: resolveAiqProgressStageIds(loadedProgress.progress.current_stage).map(
        (_stageId, index) => toAiqWorkflowStage(index),
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

  if (existingConfigPath === undefined) {
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeJsonFile(configPath, { version: 1 });
  } else {
    await loadAiqConfig(cwd);
  }

  if (existingProgressPath === undefined) {
    await saveAiqProgress(progressPath, defaultProgressState);
  } else {
    await loadAiqProgress(cwd);
  }

  return {
    configCreated: existingConfigPath === undefined,
    configPath,
    progressCreated: existingProgressPath === undefined,
    progressPath,
  };
}

export function mergeAiqConfig(base: AiqConfig, override?: AiqConfigFile): AiqConfig {
  const merged = cloneAiqConfig(base);
  if (override === undefined) {
    return merged;
  }

  if (override.inputs?.ignore !== undefined) {
    merged.inputs.ignore = [...override.inputs.ignore];
  }

  if (override.stages !== undefined) {
    for (const stageId of aiqStageIds) {
      const stageOverride = override.stages[stageId];
      if (stageOverride === undefined) {
        continue;
      }

      if (stageOverride?.enabled !== undefined) {
        merged.stages[stageId].enabled = stageOverride.enabled;
      }

      if (stageOverride.languages !== undefined) {
        for (const languageId of aiqLanguageIds) {
          const languageOverride = stageOverride.languages[languageId];
          if (languageOverride === undefined) {
            continue;
          }

          merged.stages[stageId].languages[languageId] = cloneStageLanguageConfig(languageOverride);
        }
      }
    }
  }

  if (override.profiles !== undefined) {
    for (const profileName of aiqProfileNames) {
      const profileOverride = override.profiles[profileName];
      if (profileOverride === undefined) {
        continue;
      }

      if (profileOverride.changedOnly !== undefined) {
        merged.profiles[profileName].changedOnly = profileOverride.changedOnly;
      }

      if (profileOverride.stages !== undefined) {
        merged.profiles[profileName].stages = [...profileOverride.stages];
      }
    }
  }

  if (override.surfaces !== undefined) {
    for (const surfaceId of aiqSurfaceIds) {
      const surfaceOverride = override.surfaces[surfaceId];
      if (surfaceOverride === undefined) {
        continue;
      }

      const surface = cloneSurfaceConfig(merged.surfaces[surfaceId]);
      if (surfaceOverride.cadenceMs !== undefined) {
        surface.cadenceMs = surfaceOverride.cadenceMs;
      }
      if (surfaceOverride.cadenceStages !== undefined) {
        surface.cadenceStages = [...surfaceOverride.cadenceStages];
      }
      if (surfaceOverride.changedOnly !== undefined) {
        surface.changedOnly = surfaceOverride.changedOnly;
      }
      if (surfaceOverride.stages !== undefined) {
        surface.stages = [...surfaceOverride.stages];
      }
      if (surfaceOverride.profile !== undefined) {
        surface.profile = surfaceOverride.profile;
      }
      if (surfaceOverride.publishDiagnostics !== undefined) {
        surface.publishDiagnostics = surfaceOverride.publishDiagnostics;
      }

      merged.surfaces[surfaceId] = surface;
    }
  }

  return merged;
}

export async function resolveAiqConfig(
  options: ResolveAiqConfigOptions,
): Promise<ResolvedAiqConfig> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const loaded = await loadAiqConfig(cwd);
  const config = mergeAiqConfig(defaultConfig, loaded.config);
  const surfaceConfig = config.surfaces[options.surface];
  const profile = options.profile ?? surfaceConfig.profile;
  const profileConfig = resolveProfile(config, profile);
  const requestedStages =
    options.stages !== undefined
      ? uniqueStages(options.stages)
      : filterEnabledStages(
          config,
          surfaceConfig.stages !== undefined ? surfaceConfig.stages : profileConfig.stages,
        );
  const cadenceStages = uniqueStages(surfaceConfig.cadenceStages ?? []).filter((stageId) =>
    requestedStages.includes(stageId),
  );

  const resolved: ResolvedAiqConfig = {
    ...(surfaceConfig.cadenceMs === undefined ? {} : { cadenceMs: surfaceConfig.cadenceMs }),
    cadenceStages,
    changedOnly: surfaceConfig.changedOnly ?? profileConfig.changedOnly,
    config,
    cwd,
    stages: requestedStages,
    profile,
    publishDiagnostics: surfaceConfig.publishDiagnostics ?? false,
    source: loaded.path === undefined ? "defaults" : "file",
    surface: options.surface,
  };

  if (loaded.path !== undefined) {
    resolved.configPath = loaded.path;
    resolved.stageConfigurations = resolveStageConfigurations(config, requestedStages);
  }

  return resolved;
}

export function validateAiqConfigFile(value: unknown, source = "AIQ config"): AiqConfigFile {
  const record = requireRecord(value, source);
  assertAllowedKeys(
    record,
    ["$schema", "version", "inputs", "stages", "profiles", "surfaces"],
    source,
  );

  if (record.version !== 1) {
    throw new Error(`${source}.version must be 1.`);
  }

  const config: AiqConfigFile = {
    version: 1,
  };

  if (record.$schema !== undefined) {
    if (typeof record.$schema !== "string") {
      throw new Error(`${source}.$schema must be a string.`);
    }
    config.$schema = record.$schema;
  }

  if (record.inputs !== undefined) {
    config.inputs = parseInputsConfig(record.inputs, `${source}.inputs`);
  }

  if (record.stages !== undefined) {
    config.stages = parseStageConfigOverrides(record.stages, `${source}.stages`);
  }

  if (record.profiles !== undefined) {
    config.profiles = parseProfileConfigOverrides(record.profiles, `${source}.profiles`);
  }

  if (record.surfaces !== undefined) {
    config.surfaces = parseSurfaceConfigOverrides(record.surfaces, `${source}.surfaces`);
  }

  return config;
}

export function validateAiqProgressState(
  value: unknown,
  source = "AIQ progress",
): AiqProgressState {
  const record = requireRecord(value, source);
  assertAllowedKeys(record, ["current_stage", "disabled", "order", "last_run"], source);

  if (record.current_stage === undefined) {
    throw new Error(`${source}.current_stage must be a stage index from 0 to 9.`);
  }

  return {
    current_stage: parseProgressStageIndex(record.current_stage, `${source}.current_stage`),
    disabled:
      record.disabled === undefined
        ? []
        : parseProgressStageIndexArray(record.disabled, `${source}.disabled`),
    order:
      record.order === undefined
        ? [...aiqProgressStageIndexes]
        : parseProgressStageIndexArray(record.order, `${source}.order`),
    last_run: parseNullableString(record.last_run, `${source}.last_run`),
  };
}

function cloneAiqConfig(config: AiqConfig): AiqConfig {
  return {
    version: 1,
    inputs: {
      ignore: [...config.inputs.ignore],
    },
    stages: Object.fromEntries(
      aiqStageIds.map((stageId) => [stageId, cloneStageConfig(config.stages[stageId])]),
    ) as Record<AiqStageId, AiqStageConfig>,
    profiles: Object.fromEntries(
      aiqProfileNames.map((profileName) => [
        profileName,
        cloneProfileConfig(config.profiles[profileName]),
      ]),
    ) as Record<AiqProfileName, AiqProfileConfig>,
    surfaces: Object.fromEntries(
      aiqSurfaceIds.map((surfaceId) => [surfaceId, cloneSurfaceConfig(config.surfaces[surfaceId])]),
    ) as Record<AiqSurfaceId, AiqSurfaceConfig>,
  };
}

function cloneStageConfig(config: AiqStageConfig): AiqStageConfig {
  return {
    enabled: config.enabled,
    languages: cloneStageLanguages(config.languages),
  };
}

function cloneStageLanguages(
  languages: Partial<Record<AiqLanguageId, AiqStageLanguageConfig>>,
): Partial<Record<AiqLanguageId, AiqStageLanguageConfig>> {
  return Object.fromEntries(
    Object.entries(languages).map(([languageId, languageConfig]) => [
      languageId,
      cloneStageLanguageConfig(languageConfig),
    ]),
  ) as Partial<Record<AiqLanguageId, AiqStageLanguageConfig>>;
}

function cloneStageLanguageConfig(config: AiqStageLanguageConfig): AiqStageLanguageConfig {
  return {
    enabled: config.enabled,
    tool: config.tool,
  };
}

function cloneProfileConfig(config: AiqProfileConfig): AiqProfileConfig {
  return {
    changedOnly: config.changedOnly,
    stages: [...config.stages],
  };
}

function cloneSurfaceConfig(config: AiqSurfaceConfig): AiqSurfaceConfig {
  const cloned: AiqSurfaceConfig = {
    profile: config.profile,
  };

  if (config.cadenceMs !== undefined) {
    cloned.cadenceMs = config.cadenceMs;
  }

  if (config.cadenceStages !== undefined) {
    cloned.cadenceStages = [...config.cadenceStages];
  }

  if (config.changedOnly !== undefined) {
    cloned.changedOnly = config.changedOnly;
  }

  if (config.stages !== undefined) {
    cloned.stages = [...config.stages];
  }

  if (config.publishDiagnostics !== undefined) {
    cloned.publishDiagnostics = config.publishDiagnostics;
  }

  return cloned;
}

function cloneProgressState(progress: AiqProgressState): AiqProgressState {
  return {
    current_stage: progress.current_stage,
    disabled: [...progress.disabled],
    order: [...progress.order],
    last_run: progress.last_run,
  };
}

function createDefaultStageConfig(stageId: AiqStageId): AiqStageConfig {
  return {
    enabled: true,
    languages: Object.fromEntries(
      Object.entries(defaultStageLanguageTools[stageId]).map(([languageId, tool]) => [
        languageId,
        { enabled: true, tool },
      ]),
    ) as Partial<Record<AiqLanguageId, AiqStageLanguageConfig>>,
  };
}

function filterEnabledStages(config: AiqConfig, stages: readonly AiqStageId[]): AiqStageId[] {
  const enabled: AiqStageId[] = [];

  for (const stageId of uniqueStages(stages)) {
    if (!config.stages[stageId].enabled) {
      continue;
    }

    enabled.push(stageId);
  }

  return enabled;
}

function resolveStageConfigurations(
  config: AiqConfig,
  stages: readonly AiqStageId[],
): RunStageConfigurations {
  return Object.fromEntries(
    stages.map((stageId) => {
      const languages = Object.fromEntries(
        Object.entries(config.stages[stageId].languages)
          .filter(([, languageConfig]) => languageConfig.enabled)
          .map(([languageId, languageConfig]) => [languageId, { toolId: languageConfig.tool }]),
      );

      return [stageId, { languages }];
    }),
  ) as RunStageConfigurations;
}

function uniqueStages(stages: readonly AiqStageId[]): AiqStageId[] {
  const seen = new Set<AiqStageId>();
  const unique: AiqStageId[] = [];

  for (const stageId of stages) {
    if (seen.has(stageId)) {
      continue;
    }

    seen.add(stageId);
    unique.push(stageId);
  }

  return unique;
}

function parseInputsConfig(value: unknown, source: string): Partial<AiqInputsConfig> {
  const record = requireRecord(value, source);
  assertAllowedKeys(record, ["ignore"], source);

  const config: Partial<AiqInputsConfig> = {};
  if (record.ignore !== undefined) {
    config.ignore = parseStringArray(record.ignore, `${source}.ignore`);
  }

  return config;
}

function parseStageConfigOverrides(
  value: unknown,
  source: string,
): Partial<Record<AiqStageId, AiqStageConfigFile>> {
  const record = requireRecord(value, source);
  const config: Partial<Record<AiqStageId, AiqStageConfigFile>> = {};

  for (const [stageId, rawStageConfig] of Object.entries(record)) {
    if (!aiqStageIds.includes(stageId as AiqStageId)) {
      throw new Error(`${source} contains unsupported stage '${stageId}'.`);
    }

    const stageConfig = requireRecord(rawStageConfig, `${source}.${stageId}`);
    assertAllowedKeys(stageConfig, ["enabled", "languages"], `${source}.${stageId}`);

    const parsedConfig: AiqStageConfigFile = {};
    if (stageConfig.enabled !== undefined) {
      if (typeof stageConfig.enabled !== "boolean") {
        throw new Error(`${source}.${stageId}.enabled must be a boolean.`);
      }
      parsedConfig.enabled = stageConfig.enabled;
    }

    if (stageConfig.languages !== undefined) {
      parsedConfig.languages = parseStageLanguageConfigOverrides(
        stageConfig.languages,
        stageId as AiqStageId,
        `${source}.${stageId}.languages`,
      );
    }

    config[stageId as AiqStageId] = parsedConfig;
  }

  return config;
}

function parseStageLanguageConfigOverrides(
  value: unknown,
  stageId: AiqStageId,
  source: string,
): Partial<Record<AiqLanguageId, AiqStageLanguageConfig>> {
  const record = requireRecord(value, source);
  const config: Partial<Record<AiqLanguageId, AiqStageLanguageConfig>> = {};

  for (const [languageId, rawLanguageConfig] of Object.entries(record)) {
    if (!aiqLanguageIds.includes(languageId as AiqLanguageId)) {
      throw new Error(`${source} contains unsupported language '${languageId}'.`);
    }

    config[languageId as AiqLanguageId] = parseStageLanguageConfig(
      rawLanguageConfig,
      stageId,
      `${source}.${languageId}`,
    );
  }

  return config;
}

function parseStageLanguageConfig(
  value: unknown,
  stageId: AiqStageId,
  source: string,
): AiqStageLanguageConfig {
  const record = requireRecord(value, source);
  assertAllowedKeys(record, ["enabled", "tool"], source);

  if (typeof record.enabled !== "boolean") {
    throw new Error(`${source}.enabled must be a boolean.`);
  }

  if (!aiqToolIds.includes(record.tool as AiqToolId)) {
    throw new Error(`${source}.tool must be one of ${aiqToolIds.join(", ")}.`);
  }

  const toolId = record.tool as AiqToolId;
  if (!supportedStageToolIds[stageId].includes(toolId)) {
    throw new Error(
      `${source}.tool '${toolId}' is unsupported for stage '${stageId}'. Allowed tools: ${supportedStageToolIds[stageId].join(", ")}.`,
    );
  }

  return {
    enabled: record.enabled,
    tool: toolId,
  };
}

function parseProfileConfigOverrides(
  value: unknown,
  source: string,
): Partial<Record<AiqProfileName, Partial<AiqProfileConfig>>> {
  const record = requireRecord(value, source);
  const config: Partial<Record<AiqProfileName, Partial<AiqProfileConfig>>> = {};

  for (const [profileName, rawProfileConfig] of Object.entries(record)) {
    if (!aiqProfileNames.includes(profileName as AiqProfileName)) {
      throw new Error(`${source} contains unsupported profile '${profileName}'.`);
    }

    const profileConfig = requireRecord(rawProfileConfig, `${source}.${profileName}`);
    assertAllowedKeys(profileConfig, ["changedOnly", "stages"], `${source}.${profileName}`);

    const parsedConfig: Partial<AiqProfileConfig> = {};
    if (profileConfig.changedOnly !== undefined) {
      if (typeof profileConfig.changedOnly !== "boolean") {
        throw new Error(`${source}.${profileName}.changedOnly must be a boolean.`);
      }
      parsedConfig.changedOnly = profileConfig.changedOnly;
    }

    if (profileConfig.stages !== undefined) {
      parsedConfig.stages = parseStageList(profileConfig.stages, `${source}.${profileName}.stages`);
    }

    config[profileName as AiqProfileName] = parsedConfig;
  }

  return config;
}

function parseSurfaceConfigOverrides(
  value: unknown,
  source: string,
): Partial<Record<AiqSurfaceId, Partial<AiqSurfaceConfig>>> {
  const record = requireRecord(value, source);
  const config: Partial<Record<AiqSurfaceId, Partial<AiqSurfaceConfig>>> = {};

  for (const [surfaceId, rawSurfaceConfig] of Object.entries(record)) {
    if (!aiqSurfaceIds.includes(surfaceId as AiqSurfaceId)) {
      throw new Error(`${source} contains unsupported surface '${surfaceId}'.`);
    }

    const surfaceConfig = requireRecord(rawSurfaceConfig, `${source}.${surfaceId}`);
    assertAllowedKeys(
      surfaceConfig,
      ["cadenceMs", "cadenceStages", "changedOnly", "stages", "profile", "publishDiagnostics"],
      `${source}.${surfaceId}`,
    );

    const parsedConfig: Partial<AiqSurfaceConfig> = {};
    if (surfaceConfig.cadenceMs !== undefined) {
      parsedConfig.cadenceMs = parsePositiveInteger(
        surfaceConfig.cadenceMs,
        `${source}.${surfaceId}.cadenceMs`,
      );
    }

    if (surfaceConfig.cadenceStages !== undefined) {
      parsedConfig.cadenceStages = parseStageList(
        surfaceConfig.cadenceStages,
        `${source}.${surfaceId}.cadenceStages`,
      );
    }

    if (surfaceConfig.changedOnly !== undefined) {
      if (typeof surfaceConfig.changedOnly !== "boolean") {
        throw new Error(`${source}.${surfaceId}.changedOnly must be a boolean.`);
      }
      parsedConfig.changedOnly = surfaceConfig.changedOnly;
    }

    if (surfaceConfig.stages !== undefined) {
      parsedConfig.stages = parseStageList(surfaceConfig.stages, `${source}.${surfaceId}.stages`);
    }

    if (surfaceConfig.profile !== undefined) {
      if (!aiqProfileNames.includes(surfaceConfig.profile as AiqProfileName)) {
        throw new Error(
          `${source}.${surfaceId}.profile must be one of ${aiqProfileNames.join(", ")}.`,
        );
      }
      parsedConfig.profile = surfaceConfig.profile as AiqProfileName;
    }

    if (surfaceConfig.publishDiagnostics !== undefined) {
      if (typeof surfaceConfig.publishDiagnostics !== "boolean") {
        throw new Error(`${source}.${surfaceId}.publishDiagnostics must be a boolean.`);
      }
      parsedConfig.publishDiagnostics = surfaceConfig.publishDiagnostics;
    }

    config[surfaceId as AiqSurfaceId] = parsedConfig;
  }

  return config;
}

function parseStageList(value: unknown, source: string): AiqStageId[] {
  return parseStringArray(value, source).map((stageId) => {
    if (!aiqStageIds.includes(stageId as AiqStageId)) {
      throw new Error(`${source} contains unsupported stage '${stageId}'.`);
    }
    return stageId as AiqStageId;
  });
}

function parseStringArray(value: unknown, source: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${source} must be an array.`);
  }

  return value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new Error(`${source}[${index}] must be a string.`);
    }
    return entry;
  });
}

function parsePositiveInteger(value: unknown, source: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${source} must be a positive integer.`);
  }

  return value;
}

function parseProgressStageIndex(value: unknown, source: string): AiqProgressStageIndex {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${source} must be a stage index from 0 to 9.`);
  }

  if (!aiqProgressStageIndexes.includes(value as AiqProgressStageIndex)) {
    throw new Error(`${source} must be a stage index from 0 to 9.`);
  }

  return value as AiqProgressStageIndex;
}

function parseProgressStageIndexArray(value: unknown, source: string): AiqProgressStageIndex[] {
  if (!Array.isArray(value)) {
    throw new Error(`${source} must be an array of stage indexes from 0 to 9.`);
  }

  return value.map((entry, index) => parseProgressStageIndex(entry, `${source}[${index}]`));
}

function parseNullableString(value: unknown, source: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new Error(`${source} must be a string or null.`);
  }

  return value;
}

function requireRecord(value: unknown, source: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${source} must be an object.`);
  }

  return value as Record<string, unknown>;
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  source: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) {
      throw new Error(`${source} contains unsupported key '${key}'.`);
    }
  }
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
