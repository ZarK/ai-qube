import { stat } from "node:fs/promises";
import path from "node:path";

import { findNearestAnyConfigPath } from "../utils/path-utils.js";

export const biomeConfigNames = ["biome.json", "biome.jsonc"] as const;
export const lizardConfigNames = [".lizard", ".lizardrc", "lizard.conf"] as const;
export const playwrightConfigNames = [
  "playwright.config.cjs",
  "playwright.config.cts",
  "playwright.config.js",
  "playwright.config.mjs",
  "playwright.config.mts",
  "playwright.config.ts",
] as const;
export const pythonQualityConfigNames = [
  "pyproject.toml",
  "ruff.toml",
  ".ruff.toml",
  "setup.cfg",
  "tox.ini",
  "radon.cfg",
] as const;

export async function findNearestBiomeConfig(filePath: string): Promise<string | undefined> {
  return findNearestAnyConfigPath(filePath, biomeConfigNames);
}

export async function findNearestLizardConfig(filePath: string): Promise<string | undefined> {
  return findNearestAnyConfigPath(filePath, lizardConfigNames);
}

export async function findNearestPlaywrightConfig(filePath: string): Promise<string | undefined> {
  return findNearestAnyConfigPath(filePath, playwrightConfigNames);
}

export async function findNearestPythonQualityConfig(
  filePath: string,
): Promise<string | undefined> {
  return findNearestAnyConfigPath(filePath, pythonQualityConfigNames);
}

export async function readConfigFingerprint(configPath: string | undefined): Promise<string> {
  if (configPath === undefined) {
    return "native-config:none";
  }

  try {
    const stats = await stat(configPath);
    return `native-config:${path.resolve(configPath)}@${stats.size}:${stats.mtimeMs}`;
  } catch {
    return "native-config:none";
  }
}
