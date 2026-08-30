import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { ConfigLoadError, type Config, type ConfigLoadResult, type ReviewPublisherConfigField, type ReviewPublisherConfigSource, type ValidationError } from './types.js';
import { validateConfig } from './schema.js';
import { parseUserReviewPublisherFile, userReviewPublisherPath } from './user_review_publisher.js';

export const AIE_CONFIG_FILENAME = '.qube/aie/config.json';

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
    if (key === 'publisher' && isPlainObject(value) && isPlainObject(base[key])) {
      const lowerMode = base[key].mode;
      const higherMode = value.mode;
      merged[key] = typeof higherMode === 'string' && typeof lowerMode === 'string' && higherMode !== lowerMode
        ? value
        : mergeConfigOverlay(base[key], value);
      continue;
    }
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

export async function loadConfigFile(
  startDir: string = process.cwd(),
  options: { readonly homeDirectory?: string } = {},
): Promise<ConfigLoadResult> {
  const root = await findRepoRoot(startDir);
  const configPath = selectConfigPath(root);
  const overlayPath = overlayConfigPath(configPath);
  const globalPublisherPath = userReviewPublisherPath(options.homeDirectory);

  const repositoryRead = await readJsonFile(configPath, displayConfigPath(root, configPath), 'config');
  if (repositoryRead.error) return { root, path: configPath, present: true, ok: false, errors: [repositoryRead.error] };
  const overlayRead = await readJsonFile(overlayPath, displayConfigPath(root, overlayPath), 'local overlay');
  if (overlayRead.error) return { root, path: configPath, present: repositoryRead.present, ok: false, errors: [overlayRead.error] };
  const globalRead = await readJsonFile(globalPublisherPath, globalPublisherPath.replace(/\\/g, '/'), 'user-global review publisher config');
  if (globalRead.error) return { root, path: configPath, present: repositoryRead.present || overlayRead.present || globalRead.present, ok: false, errors: [globalRead.error] };

  let globalPublisher: Readonly<Record<string, unknown>> | null = null;
  if (globalRead.present) {
    const parsed = parseUserReviewPublisherFile(globalRead.raw);
    if (!parsed.ok || !parsed.publisher) {
      return {
        root,
        path: configPath,
        present: true,
        ok: false,
        errors: parsed.errors.map(error => ({ ...error, path: `${globalPublisherPath.replace(/\\/g, '/')}:${error.path}` })),
      };
    }
    globalPublisher = parsed.publisher;
  }

  const raw = repositoryRead.raw;
  const overlay = overlayRead.raw;
  const present = repositoryRead.present;
  const overlayPresent = overlayRead.present;

  if (!present && !overlayPresent && !globalPublisher) {
    return {
      root,
      path: configPath,
      present: false,
      ok: true,
      errors: [],
      publisherSource: 'default',
      publisherFieldSources: {},
      layers: { userPublisherPath: globalPublisherPath, userPublisher: null, repository: null, repositoryOverlay: null },
    };
  }

  const globalLayer = globalPublisher ? { version: 1, providers: { review: { kind: 'github', publisher: globalPublisher } } } : undefined;
  const withRepository = present ? mergeConfigOverlay(globalLayer, raw) : globalLayer;
  const merged = overlayPresent ? mergeConfigOverlay(withRepository, overlay) : withRepository;
  const validation = validateConfig(merged);
  const sourceState = publisherSourceState(globalPublisher, raw, overlay, validation.config?.providers.review.publisher?.mode);
  const layers = {
    userPublisherPath: globalPublisherPath,
    userPublisher: globalPublisher,
    repository: isPlainObject(raw) ? Object.freeze({ ...raw }) : null,
    repositoryOverlay: isPlainObject(overlay) ? Object.freeze({ ...overlay }) : null,
  } as const;
  if (validation.ok && validation.config) {
    return { root, path: configPath, present: true, ok: true, errors: [], config: validation.config, ...sourceState, layers };
  }
  return { root, path: configPath, present: true, ok: false, errors: validation.errors, ...sourceState, layers };
}

export async function loadConfig(startDir: string = process.cwd()): Promise<Config | null> {
  const result = await loadConfigFile(startDir);
  if (!result.present) return null;
  if (result.ok && result.config) return result.config;
  throw new ConfigLoadError(result.path, result.errors);
}

export function selectConfigPath(root: string): string {
  return join(root, AIE_CONFIG_FILENAME);
}

export function displayConfigPath(root: string, configPath: string): string {
  const relativePath = relative(root, configPath);
  if (relativePath.length === 0 || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return configPath.replace(/\\/g, '/');
  }
  return relativePath.replace(/\\/g, '/');
}

async function readJsonFile(
  path: string,
  displayPath: string,
  label: string,
): Promise<{ readonly present: boolean; readonly raw?: unknown; readonly error?: ValidationError }> {
  try {
    return { present: true, raw: JSON.parse(await readFile(path, 'utf8')) as unknown };
  } catch (err: unknown) {
    if (errorCode(err) === 'ENOENT') return { present: false };
    const message = err instanceof Error ? err.message : String(err);
    const subject = label === 'config' ? displayPath : `${label} ${displayPath}`;
    return { present: true, error: { kind: 'invalid', path: displayPath, message: `Failed to read or parse ${subject}: ${message}` } };
  }
}

const PUBLISHER_FIELDS: readonly ReviewPublisherConfigField[] = [
  'mode',
  'githubApp.appId',
  'githubApp.installationId',
  'githubApp.privateKeyEnv',
  'githubApp.privateKeyPath',
  'githubApp.login',
];

function publisherSourceState(
  globalPublisher: Readonly<Record<string, unknown>> | null,
  repository: unknown,
  overlay: unknown,
  effectiveMode: string | undefined,
): Pick<ConfigLoadResult, 'publisherSource' | 'publisherFieldSources'> {
  const layers: readonly { source: ReviewPublisherConfigSource; publisher: unknown }[] = [
    { source: 'repository-overlay', publisher: readPublisher(overlay) },
    { source: 'repository', publisher: readPublisher(repository) },
    { source: 'user-global', publisher: globalPublisher },
  ];
  const fieldSources: Partial<Record<ReviewPublisherConfigField, ReviewPublisherConfigSource>> = {};
  for (const field of PUBLISHER_FIELDS) {
    if (effectiveMode !== 'github-app' && field !== 'mode') continue;
    for (const layer of layers) {
      if (readPath(layer.publisher, field.split('.')) !== undefined) {
        fieldSources[field] = layer.source;
        break;
      }
    }
  }
  const values = Object.values(fieldSources);
  const publisherSource: ReviewPublisherConfigSource = values.includes('repository-overlay')
    ? 'repository-overlay'
    : values.includes('repository')
      ? 'repository'
      : values.includes('user-global')
        ? 'user-global'
        : 'default';
  return { publisherSource, publisherFieldSources: Object.freeze(fieldSources) };
}

function readPublisher(value: unknown): unknown {
  if (!isPlainObject(value)) return undefined;
  const providers = value.providers;
  if (!isPlainObject(providers) || !isPlainObject(providers.review)) return undefined;
  return providers.review.publisher;
}

function readPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (!isPlainObject(current) || !(segment in current)) return undefined;
    current = current[segment];
  }
  return current;
}
