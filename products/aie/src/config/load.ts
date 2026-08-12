import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { ConfigLoadError, type Config, type ConfigLoadResult } from './types.js';
import { validateConfig } from './schema.js';

export const AIE_CONFIG_FILENAME = '.qube/aie/config.json';
export const AIE_LEGACY_CONFIG_FILENAME = 'aie.config.json';
export const AIE_CONFIG_FILENAMES = [AIE_CONFIG_FILENAME, AIE_LEGACY_CONFIG_FILENAME] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Deep-merges a local, never-committed overlay onto the committed config so
 * secrets such as a review publisher's private key reference can stay out of
 * git while still resolving at load time.
 */
export function mergeConfigOverlay(base: unknown, overlay: unknown): unknown {
  if (!isPlainObject(overlay)) return overlay;
  if (!isPlainObject(base)) return overlay;
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    merged[key] = isPlainObject(value) && isPlainObject(base[key]) ? mergeConfigOverlay(base[key], value) : value;
  }
  return merged;
}

export function overlayConfigPath(configPath: string): string {
  return configPath.replace(/\.json$/, '.local.json');
}

function errorCode(err: unknown): unknown {
  return err && typeof err === 'object' && 'code' in err ? (err as { code?: unknown }).code : undefined;
}

async function findRepoRoot(startDir: string): Promise<string> {
  try {
    const root = execSync('git rev-parse --show-toplevel', {
      cwd: startDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return root;
  } catch {
    const fallbackRoot = resolve(startDir);
    let current = fallbackRoot;
    while (true) {
      if (existsSync(join(current, '.git'))) return current;
      const parent = dirname(current);
      if (parent === current) return fallbackRoot;
      current = parent;
    }
  }
}

export async function loadConfigFile(startDir: string = process.cwd()): Promise<ConfigLoadResult> {
  const root = await findRepoRoot(startDir);
  const configPath = selectConfigPath(root);
  const overlayPath = overlayConfigPath(configPath);

  let raw: unknown;
  let present = false;
  try {
    const content = await readFile(configPath, 'utf8');
    raw = JSON.parse(content) as unknown;
    present = true;
  } catch (err: unknown) {
    if (errorCode(err) !== 'ENOENT') {
      const message = err instanceof Error ? err.message : String(err);
      const displayPath = displayConfigPath(root, configPath);
      return { root, path: configPath, present: true, ok: false, errors: [{ kind: 'invalid', path: displayPath, message: `Failed to read or parse ${displayPath}: ${message}` }] };
    }
  }

  let overlay: unknown;
  let overlayPresent = false;
  try {
    const overlayContent = await readFile(overlayPath, 'utf8');
    overlay = JSON.parse(overlayContent) as unknown;
    overlayPresent = true;
  } catch (err: unknown) {
    if (errorCode(err) !== 'ENOENT') {
      const message = err instanceof Error ? err.message : String(err);
      const displayPath = displayConfigPath(root, overlayPath);
      return { root, path: configPath, present, ok: false, errors: [{ kind: 'invalid', path: displayPath, message: `Failed to read or parse local overlay ${displayPath}: ${message}` }] };
    }
  }

  if (!present && !overlayPresent) {
    return { root, path: configPath, present: false, ok: true, errors: [] };
  }

  const merged = overlayPresent ? mergeConfigOverlay(raw, overlay) : raw;
  const validation = validateConfig(merged);
  if (validation.ok && validation.config) {
    return { root, path: configPath, present: true, ok: true, errors: [], config: validation.config };
  }
  return { root, path: configPath, present: true, ok: false, errors: validation.errors };
}

export async function loadConfig(startDir: string = process.cwd()): Promise<Config | null> {
  const result = await loadConfigFile(startDir);
  if (!result.present) return null;
  if (result.ok && result.config) return result.config;
  throw new ConfigLoadError(result.path, result.errors);
}

export function selectConfigPath(root: string): string {
  for (const filename of AIE_CONFIG_FILENAMES) {
    const candidate = join(root, filename);
    if (existsSync(candidate)) return candidate;
  }
  return join(root, AIE_CONFIG_FILENAME);
}

export function displayConfigPath(root: string, configPath: string): string {
  const relativePath = relative(root, configPath);
  if (relativePath.length === 0 || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return configPath.replace(/\\/g, '/');
  }
  return relativePath.replace(/\\/g, '/');
}
