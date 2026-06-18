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
