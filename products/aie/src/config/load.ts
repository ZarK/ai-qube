import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { ConfigLoadError, type Config, type ConfigLoadResult } from './types.js';
import { validateConfig } from './schema.js';

export const AIE_CONFIG_FILENAME = '.qube/aie/config.json';
export const AIE_LEGACY_CONFIG_FILENAME = 'aie.config.json';
export const AIE_CONFIG_FILENAMES = [AIE_CONFIG_FILENAME, AIE_LEGACY_CONFIG_FILENAME] as const;

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

  try {
    const content = await readFile(configPath, 'utf8');
    const raw = JSON.parse(content) as unknown;
    const validation = validateConfig(raw);
    if (validation.ok && validation.config) {
      return { root, path: configPath, present: true, ok: true, errors: [], config: validation.config };
    }
    return { root, path: configPath, present: true, ok: false, errors: validation.errors };
  } catch (err: unknown) {
    const code = err && typeof err === 'object' && 'code' in err ? (err as { code?: unknown }).code : undefined;
    if (code === 'ENOENT') {
      return { root, path: configPath, present: false, ok: true, errors: [] };
    }
    const message = err instanceof Error ? err.message : String(err);
    const displayPath = displayConfigPath(root, configPath);
    return { root, path: configPath, present: true, ok: false, errors: [{ kind: 'invalid', path: displayPath, message: `Failed to read or parse ${displayPath}: ${message}` }] };
  }
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
