import {
  aiqLanguageIds,
  aiqProfileNames,
  aiqProgressStageIndexes,
  aiqStageIds,
  aiqSurfaceIds,
  aiqToolIds,
  supportedStageToolIds,
} from "./definitions.js";
import type {
  AiqConfigFile,
  AiqInputsConfig,
  AiqLanguageId,
  AiqProfileConfig,
  AiqProfileName,
  AiqProgressStageIndex,
  AiqProgressState,
  AiqStageConfigFile,
  AiqStageId,
  AiqStageLanguageConfig,
  AiqSurfaceConfig,
  AiqSurfaceId,
  AiqToolId,
} from "./definitions.js";

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
    parseOptionalSurfaceNumber(surfaceConfig, parsedConfig, surfaceId as AiqSurfaceId, source);
    parseOptionalSurfaceStages(surfaceConfig, parsedConfig, surfaceId as AiqSurfaceId, source);
    parseOptionalSurfaceBooleans(surfaceConfig, parsedConfig, surfaceId as AiqSurfaceId, source);
    parseOptionalSurfaceProfile(surfaceConfig, parsedConfig, surfaceId as AiqSurfaceId, source);

    config[surfaceId as AiqSurfaceId] = parsedConfig;
  }

  return config;
}

function parseOptionalSurfaceNumber(
  surfaceConfig: Record<string, unknown>,
  parsedConfig: Partial<AiqSurfaceConfig>,
  surfaceId: AiqSurfaceId,
  source: string,
): void {
  if (surfaceConfig.cadenceMs !== undefined) {
    parsedConfig.cadenceMs = parsePositiveInteger(
      surfaceConfig.cadenceMs,
      `${source}.${surfaceId}.cadenceMs`,
    );
  }
}

function parseOptionalSurfaceStages(
  surfaceConfig: Record<string, unknown>,
  parsedConfig: Partial<AiqSurfaceConfig>,
  surfaceId: AiqSurfaceId,
  source: string,
): void {
  if (surfaceConfig.cadenceStages !== undefined) {
    parsedConfig.cadenceStages = parseStageList(
      surfaceConfig.cadenceStages,
      `${source}.${surfaceId}.cadenceStages`,
    );
  }
  if (surfaceConfig.stages !== undefined) {
    parsedConfig.stages = parseStageList(surfaceConfig.stages, `${source}.${surfaceId}.stages`);
  }
}

function parseOptionalSurfaceBooleans(
  surfaceConfig: Record<string, unknown>,
  parsedConfig: Partial<AiqSurfaceConfig>,
  surfaceId: AiqSurfaceId,
  source: string,
): void {
  const changedOnly = parseOptionalBoolean(
    surfaceConfig.changedOnly,
    `${source}.${surfaceId}.changedOnly`,
  );
  const publishDiagnostics = parseOptionalBoolean(
    surfaceConfig.publishDiagnostics,
    `${source}.${surfaceId}.publishDiagnostics`,
  );
  if (changedOnly !== undefined) {
    parsedConfig.changedOnly = changedOnly;
  }
  if (publishDiagnostics !== undefined) {
    parsedConfig.publishDiagnostics = publishDiagnostics;
  }
}

function parseOptionalSurfaceProfile(
  surfaceConfig: Record<string, unknown>,
  parsedConfig: Partial<AiqSurfaceConfig>,
  surfaceId: AiqSurfaceId,
  source: string,
): void {
  if (surfaceConfig.profile === undefined) {
    return;
  }
  if (!aiqProfileNames.includes(surfaceConfig.profile as AiqProfileName)) {
    throw new Error(`${source}.${surfaceId}.profile must be one of ${aiqProfileNames.join(", ")}.`);
  }
  parsedConfig.profile = surfaceConfig.profile as AiqProfileName;
}

function parseOptionalBoolean(value: unknown, source: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${source} must be a boolean.`);
  }
  return value;
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
