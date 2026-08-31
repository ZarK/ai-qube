import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { ConfigLoadError, type Config, type ConfigLoadResult, type ReviewPublisherConfigField, type ReviewPublisherConfigSource, type ValidationError } from './types.js';
import { cloneConfigFile, configToFileShape, DEFAULT_CONFIG_FILE } from './defaults.js';
import { validateConfig } from './schema.js';
import { parseUserReviewPublisherFile, userReviewPublisherPath } from './user_review_publisher.js';

export const AIE_CONFIG_FILENAME = '.qube/aie/config.json';
export const AIE_USER_CONFIG_PATH = '.qube/aie/config.json';

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
  const globalConfigPath = userConfigPath(options.homeDirectory);
  const globalPublisherPath = userReviewPublisherPath(options.homeDirectory);

  const repositoryRead = await readJsonFile(configPath, displayConfigPath(root, configPath), 'config');
  if (repositoryRead.error) return loadFailure(root, configPath, true, repositoryRead.error, 'repository', configPath);
  const overlayRead = await readJsonFile(overlayPath, displayConfigPath(root, overlayPath), 'machine-local overlay');
  if (overlayRead.error) return loadFailure(root, configPath, repositoryRead.present, overlayRead.error, 'machine-local', overlayPath);
  const globalConfigRead = await readJsonFile(globalConfigPath, globalConfigPath.replace(/\\/g, '/'), 'user-global config');
  if (globalConfigRead.error) return loadFailure(root, configPath, repositoryRead.present || overlayRead.present, globalConfigRead.error, 'user-global', globalConfigPath);
  const globalRead = await readJsonFile(globalPublisherPath, globalPublisherPath.replace(/\\/g, '/'), 'user-global review publisher config');
  if (globalRead.error) return loadFailure(root, configPath, repositoryRead.present || overlayRead.present || globalConfigRead.present || globalRead.present, globalRead.error, 'user-global', globalPublisherPath);

  let globalPublisher: Readonly<Record<string, unknown>> | null = null;
  if (globalRead.present) {
    const parsed = parseUserReviewPublisherFile(globalRead.raw);
    if (!parsed.ok || !parsed.publisher) {
      return {
        root,
        path: configPath,
        present: true,
        ok: false,
        errors: parsed.errors.map(error => layerError(error, 'user-global', globalPublisherPath)),
      };
    }
    globalPublisher = parsed.publisher;
  }

  let validationBaseline: unknown = globalPublisher
    ? mergeConfigOverlay(getDefaultsShape(), { providers: { review: { kind: 'github', publisher: globalPublisher } } })
    : getDefaultsShape();
  for (const layer of [
    { read: globalConfigRead, scope: 'user-global' as const, path: globalConfigPath, requireVersion: true },
    { read: repositoryRead, scope: 'repository' as const, path: configPath, requireVersion: true },
    { read: overlayRead, scope: 'machine-local' as const, path: overlayPath, requireVersion: false },
  ]) {
    if (!layer.read.present) continue;
    const errors = validatePartialLayer(layer.read.raw, validationBaseline, layer.scope, layer.path, layer.requireVersion);
    if (errors.length > 0) {
      return {
        root,
        path: configPath,
        present: repositoryRead.present || overlayRead.present || globalConfigRead.present || globalRead.present,
        ok: false,
        errors,
      };
    }
    validationBaseline = mergeConfigOverlay(validationBaseline, layer.read.raw);
    if (layer.scope === 'user-global' && globalPublisher) {
      validationBaseline = mergeConfigOverlay(validationBaseline, { providers: { review: { kind: 'github', publisher: globalPublisher } } });
    }
  }

  const raw = repositoryRead.raw;
  const overlay = overlayRead.raw;
  const userRaw = globalConfigRead.raw;
  const present = repositoryRead.present;
  const overlayPresent = overlayRead.present;

  if (!present && !overlayPresent && !globalConfigRead.present && !globalPublisher) {
    return {
      root,
      path: configPath,
      present: false,
      ok: true,
      errors: [],
      publisherSource: 'default',
      publisherFieldSources: {},
      fieldSources: effectiveFieldSources(getDefaultsShape(), null, null, null),
      layers: { userGlobalPath: globalConfigPath, userGlobal: null, userPublisherPath: globalPublisherPath, userPublisher: null, repository: null, machineLocal: null },
    };
  }

  const globalPublisherLayer = globalPublisher ? { version: 1, providers: { review: { kind: 'github', publisher: globalPublisher } } } : undefined;
  const globalLayer = globalPublisherLayer ? mergeConfigOverlay(userRaw, globalPublisherLayer) : userRaw;
  const withGlobal = isPlainObject(globalLayer) ? mergeConfigOverlay(getDefaultsShape(), globalLayer) : getDefaultsShape();
  const withRepository = present ? mergeConfigOverlay(withGlobal, raw) : withGlobal;
  const merged = overlayPresent ? mergeConfigOverlay(withRepository, overlay) : withRepository;
  const validation = validateConfig(merged);
  const sourceState = publisherSourceState(readPublisher(globalLayer), raw, overlay, validation.config?.providers.review.publisher?.mode);
  const layers = {
    userGlobalPath: globalConfigPath,
    userGlobal: isPlainObject(globalLayer) ? Object.freeze({ ...globalLayer }) : null,
    userPublisherPath: globalPublisherPath,
    userPublisher: globalPublisher,
    repository: isPlainObject(raw) ? Object.freeze({ ...raw }) : null,
    machineLocal: isPlainObject(overlay) ? Object.freeze({ ...overlay }) : null,
  } as const;
  if (validation.ok && validation.config) {
    return {
      root, path: configPath, present: true, ok: true, errors: [], config: validation.config, ...sourceState,
      fieldSources: effectiveFieldSources(configToFileShape(validation.config), globalLayer, raw, overlay),
      layers,
    };
  }
  return {
    root, path: configPath, present: true, ok: false,
    errors: validation.errors.map(error => layerError(error, 'effective', configPath)),
    ...sourceState, layers,
  };
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

export function userConfigPath(homeDirectory = defaultHomeDirectory()): string {
  return join(resolve(homeDirectory), ...AIE_USER_CONFIG_PATH.split('/'));
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
  globalPublisher: unknown,
  repository: unknown,
  overlay: unknown,
  effectiveMode: string | undefined,
): Pick<ConfigLoadResult, 'publisherSource' | 'publisherFieldSources'> {
  const layers: readonly { source: ReviewPublisherConfigSource; publisher: unknown }[] = [
    { source: 'machine-local', publisher: readPublisher(overlay) },
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
  const publisherSource: ReviewPublisherConfigSource = values.includes('machine-local')
    ? 'machine-local'
    : values.includes('repository')
      ? 'repository'
      : values.includes('user-global')
        ? 'user-global'
        : 'default';
  return { publisherSource, publisherFieldSources: Object.freeze(fieldSources) };
}

function defaultHomeDirectory(): string {
  return process.env.USERPROFILE ?? process.env.HOME ?? homedir();
}

function getDefaultsShape(): Readonly<Record<string, unknown>> {
  return cloneConfigFile(DEFAULT_CONFIG_FILE) as unknown as Readonly<Record<string, unknown>>;
}

function validatePartialLayer(
  raw: unknown,
  lowerLayers: unknown,
  scope: 'machine-local' | 'repository' | 'user-global',
  sourcePath: string,
  requireVersion: boolean,
): ValidationError[] {
  if (!isPlainObject(raw)) {
    return [layerError({ kind: 'invalid', path: '.', message: 'Config layer must be a JSON object.' }, scope, sourcePath)];
  }
  if (requireVersion && raw.version !== 1) {
    return [layerError({ kind: raw.version === undefined ? 'missing' : 'invalid', path: 'version', message: 'version must be 1' }, scope, sourcePath)];
  }
  if (!requireVersion && raw.version !== undefined && raw.version !== 1) {
    return [layerError({ kind: 'invalid', path: 'version', message: 'version must be 1 when provided' }, scope, sourcePath)];
  }
  const candidate = mergeConfigOverlay(lowerLayers, raw);
  const validation = validateConfig(candidate);
  return validation.errors.map(error => layerError(error, scope, sourcePath));
}

function layerError(
  error: ValidationError,
  scope: 'machine-local' | 'repository' | 'user-global' | 'effective',
  sourcePath: string,
): ValidationError {
  const field = error.field ?? error.path;
  const reason = error.reason ?? error.message;
  const normalizedPath = sourcePath.replace(/\\/g, '/');
  return {
    ...error,
    scope,
    sourcePath: normalizedPath,
    field,
    reason,
    nextAction: `Fix ${normalizedPath} at ${field}, then rerun the command.`,
  };
}

function loadFailure(
  root: string,
  path: string,
  present: boolean,
  error: ValidationError,
  scope: 'machine-local' | 'repository' | 'user-global',
  sourcePath: string,
): ConfigLoadResult {
  return { root, path, present, ok: false, errors: [layerError(error, scope, sourcePath)] };
}

function effectiveFieldSources(
  effective: unknown,
  userGlobal: unknown,
  repository: unknown,
  machineLocal: unknown,
): Readonly<Record<string, ReviewPublisherConfigSource>> {
  const sources: Record<string, ReviewPublisherConfigSource> = {};
  for (const path of leafPaths(effective)) {
    const segments = path.split('.');
    sources[path] = readPath(machineLocal, segments) !== undefined ? 'machine-local'
      : readPath(repository, segments) !== undefined ? 'repository'
        : readPath(userGlobal, segments) !== undefined ? 'user-global'
          : 'default';
  }
  return Object.freeze(sources);
}

function leafPaths(value: unknown, prefix = ''): string[] {
  if (!isPlainObject(value)) return prefix ? [prefix] : [];
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return isPlainObject(child) ? leafPaths(child, path) : [path];
  });
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
