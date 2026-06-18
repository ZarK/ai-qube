import path from "node:path";

import type { RunStageConfigurations } from "@tjalve/aiq/model";

import {
  aiqLanguageIds,
  aiqProfileNames,
  aiqStageIds,
  aiqSurfaceIds,
  defaultConfig,
  supportedStageToolIds,
} from "./definitions.js";
import type {
  AiqConfig,
  AiqConfigFile,
  AiqLanguageId,
  AiqProfileConfig,
  AiqProfileName,
  AiqStageConfig,
  AiqStageConfigFile,
  AiqStageId,
  AiqStageLanguageConfig,
  AiqSurfaceConfig,
  AiqSurfaceId,
  ResolveAiqConfigOptions,
  ResolvedAiqConfig,
} from "./definitions.js";
import { loadAiqConfig } from "./files.js";

export function resolveProfile(config: AiqConfig, profile?: AiqProfileName): AiqProfileConfig {
  const selected = profile ?? "fast";
  return cloneProfileConfig(config.profiles[selected]);
}

export function mergeAiqConfig(base: AiqConfig, override?: AiqConfigFile): AiqConfig {
  const merged = cloneAiqConfig(base);
  if (override === undefined) {
    return merged;
  }

  applyInputOverrides(merged, override);
  applyStageOverrides(merged, override);
  applyProfileOverrides(merged, override);
  applySurfaceOverrides(merged, override);

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
  const requestedStages = resolveRequestedStages(options, config, surfaceConfig, profileConfig);
  const cadenceStages = uniqueStages(surfaceConfig.cadenceStages ?? []).filter((stageId) =>
    requestedStages.includes(stageId),
  );

  const resolved: ResolvedAiqConfig = createResolvedAiqConfig({
    cadenceStages,
    config,
    cwd,
    loadedPath: loaded.path,
    options,
    profile,
    profileConfig,
    requestedStages,
    surfaceConfig,
  });

  if (loaded.path !== undefined) {
    resolved.configPath = loaded.path;
    resolved.stageConfigurations = resolveStageConfigurations(config, requestedStages);
  }

  return resolved;
}

function applyInputOverrides(merged: AiqConfig, override: AiqConfigFile): void {
  if (override.inputs?.ignore !== undefined) {
    merged.inputs.ignore = [...override.inputs.ignore];
  }
}

function applyStageOverrides(merged: AiqConfig, override: AiqConfigFile): void {
  for (const stageId of aiqStageIds) {
    const stageOverride = override.stages?.[stageId];
    if (stageOverride === undefined) {
      continue;
    }

    if (stageOverride.enabled !== undefined) {
      merged.stages[stageId].enabled = stageOverride.enabled;
    }
    applyStageLanguageOverrides(merged.stages[stageId], stageOverride);
  }
}

function applyStageLanguageOverrides(
  stage: AiqStageConfig,
  stageOverride: AiqStageConfigFile,
): void {
  for (const languageId of aiqLanguageIds) {
    const languageOverride = stageOverride.languages?.[languageId];
    if (languageOverride !== undefined) {
      stage.languages[languageId] = cloneStageLanguageConfig(languageOverride);
    }
  }
}

function applyProfileOverrides(merged: AiqConfig, override: AiqConfigFile): void {
  for (const profileName of aiqProfileNames) {
    const profileOverride = override.profiles?.[profileName];
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

function applySurfaceOverrides(merged: AiqConfig, override: AiqConfigFile): void {
  for (const surfaceId of aiqSurfaceIds) {
    const surfaceOverride = override.surfaces?.[surfaceId];
    if (surfaceOverride !== undefined) {
      merged.surfaces[surfaceId] = mergeSurfaceConfig(merged.surfaces[surfaceId], surfaceOverride);
    }
  }
}

function mergeSurfaceConfig(
  base: AiqSurfaceConfig,
  override: Partial<AiqSurfaceConfig>,
): AiqSurfaceConfig {
  return {
    ...cloneSurfaceConfig(base),
    ...(override.cadenceMs === undefined ? {} : { cadenceMs: override.cadenceMs }),
    ...(override.cadenceStages === undefined ? {} : { cadenceStages: [...override.cadenceStages] }),
    ...(override.changedOnly === undefined ? {} : { changedOnly: override.changedOnly }),
    ...(override.stages === undefined ? {} : { stages: [...override.stages] }),
    ...(override.profile === undefined ? {} : { profile: override.profile }),
    ...(override.publishDiagnostics === undefined
      ? {}
      : { publishDiagnostics: override.publishDiagnostics }),
  };
}

function resolveRequestedStages(
  options: ResolveAiqConfigOptions,
  config: AiqConfig,
  surfaceConfig: AiqSurfaceConfig,
  profileConfig: AiqProfileConfig,
): AiqStageId[] {
  return options.stages !== undefined
    ? uniqueStages(options.stages)
    : filterEnabledStages(
        config,
        surfaceConfig.stages !== undefined ? surfaceConfig.stages : profileConfig.stages,
      );
}

function createResolvedAiqConfig(options: {
  cadenceStages: AiqStageId[];
  config: AiqConfig;
  cwd: string;
  loadedPath: string | undefined;
  options: ResolveAiqConfigOptions;
  profile: AiqProfileName;
  profileConfig: AiqProfileConfig;
  requestedStages: AiqStageId[];
  surfaceConfig: AiqSurfaceConfig;
}): ResolvedAiqConfig {
  return {
    ...(options.surfaceConfig.cadenceMs === undefined
      ? {}
      : { cadenceMs: options.surfaceConfig.cadenceMs }),
    cadenceStages: options.cadenceStages,
    changedOnly: options.surfaceConfig.changedOnly ?? options.profileConfig.changedOnly,
    config: options.config,
    cwd: options.cwd,
    stages: options.requestedStages,
    profile: options.profile,
    publishDiagnostics: options.surfaceConfig.publishDiagnostics ?? false,
    source: options.loadedPath === undefined ? "defaults" : "file",
    surface: options.options.surface,
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
