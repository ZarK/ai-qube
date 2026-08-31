import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { AIE_CONFIG_FILENAME, validateConfig } from '../config/index.js';
import { REVIEW_MODEL_HOST_IDS, type ReviewModelHostId } from '../core/policy.js';
import { isReviewMode } from '../review_mode.js';
import { isolatedReviewHostPackageName } from '../app/review_host_adapters.js';
import { isolatedReviewHostsOnMachine, type GuideMachine } from './questions.js';
import type { InitFromReport } from './types.js';
import { evaluateGitHubReadiness, runGh, type GitHubReadiness } from '../providers/github_adapter_exports.js';

export type FromSourceFailure = 'absolute-path' | 'parent-directory' | 'symlink-escape' | 'url' | 'missing' | 'unreadable' | 'invalid-config' | 'forged-marker' | 'repo-fetch-failed';

export interface AdoptedSource {
  ok: true;
  record: Record<string, unknown>;
  report: InitFromReport;
}

export interface AdoptedSourceError {
  ok: false;
  failure: FromSourceFailure;
  error: string;
}

const REPO_SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const URL_PREFIX = /^(?:[a-z][a-z0-9+.-]*:|git@)/i;

export function isGithubRepoSlug(spec: string): boolean {
  const trimmed = spec.trim();
  if (trimmed.includes('..') || trimmed.startsWith('.') || trimmed.includes('/.') ) return false;
  return REPO_SLUG.test(trimmed);
}

export function classifyFromSpec(spec: string): 'repo' | 'url' | 'path' {
  const trimmed = spec.trim();
  if (trimmed === '') return 'path';
  if (isGithubRepoSlug(trimmed)) return 'repo';
  if (isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed)) return 'path';
  if (URL_PREFIX.test(trimmed) || trimmed.includes('://')) return 'url';
  return 'path';
}

export function resolveContainedFromPath(root: string, spec: string): { ok: true; path: string } | { ok: false; failure: FromSourceFailure; error: string } {
  const trimmed = spec.trim();
  if (trimmed === '') {
    return { ok: false, failure: 'missing', error: '--from requires a path relative to the working directory or an owner/repo slug.' };
  }
  if (classifyFromSpec(trimmed) === 'url') {
    return { ok: false, failure: 'url', error: '--from does not accept URLs. Use a path relative to the working directory or an owner/repo slug.' };
  }
  const normalized = trimmed.replace(/\\/g, '/');
  if (isAbsolute(trimmed) || isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized) || normalized.startsWith('/') || normalized.startsWith('//')) {
    return { ok: false, failure: 'absolute-path', error: '--from must be a path relative to the working directory. Absolute paths are rejected.' };
  }
  const segments = normalized.split('/').filter(segment => segment !== '');
  if (segments.some(segment => segment === '..')) {
    return { ok: false, failure: 'parent-directory', error: '--from must not include parent-directory segments.' };
  }
  const rootResolved = resolve(root);
  const realRoot = existsSync(rootResolved) ? realpathSync(rootResolved) : rootResolved;
  let current = rootResolved;
  for (const segment of segments.filter(segment => segment !== '.')) {
    current = resolve(current, segment);
    const lexical = relative(rootResolved, current);
    if (lexical.startsWith('..') || isAbsolute(lexical)) {
      return { ok: false, failure: 'parent-directory', error: '--from must stay under the working directory.' };
    }
    if (!existsSync(current)) {
      return { ok: false, failure: 'missing', error: `--from path was not found: ${segments.join('/')}.` };
    }
    try {
      if (lstatSync(current).isSymbolicLink()) {
        const realCurrent = realpathSync(current);
        const escaped = relative(realRoot, realCurrent);
        if (escaped.startsWith('..') || isAbsolute(escaped)) {
          return { ok: false, failure: 'symlink-escape', error: '--from must not escape the working directory through a symlink or junction.' };
        }
      }
    } catch {
      return { ok: false, failure: 'unreadable', error: `--from path is unreadable: ${segments.join('/')}.` };
    }
  }
  return { ok: true, path: current };
}

export function configPathFromResolvedSource(resolved: string): { ok: true; path: string } | { ok: false; failure: FromSourceFailure; error: string } {
  if (!existsSync(resolved)) {
    return { ok: false, failure: 'missing', error: `--from path was not found: ${resolved}.` };
  }
  const stats = lstatSync(resolved);
  if (stats.isSymbolicLink()) {
    return { ok: false, failure: 'symlink-escape', error: '--from must not read a symlink as the source config.' };
  }
  if (stats.isDirectory()) {
    return { ok: false, failure: 'missing', error: `--from directory must be resolved through the contained config path ${AIE_CONFIG_FILENAME}.` };
  }
  if (!stats.isFile()) {
    return { ok: false, failure: 'unreadable', error: '--from must point at a repository directory or a config file.' };
  }
  return { ok: true, path: resolved };
}

export function parseAdoptedConfig(rawText: string): { ok: true; record: Record<string, unknown>; digest: string } | { ok: false; failure: FromSourceFailure; error: string } {
  const digest = createHash('sha256').update(rawText).digest('hex');
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err: unknown) {
    return { ok: false, failure: 'invalid-config', error: `Source config is not valid JSON: ${err instanceof Error ? err.message : String(err)}.` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, failure: 'invalid-config', error: 'Source config must be a JSON object.' };
  }
  const record = parsed as Record<string, unknown>;
  if ('ok' in record || 'shipReady' in record || 'approved' in record) {
    return { ok: false, failure: 'forged-marker', error: 'Source document is not an Executor config. Init does not trust approval or ok markers from --from input.' };
  }
  const validation = validateConfig(record);
  if (!validation.ok || !validation.config) {
    const first = validation.errors[0];
    return { ok: false, failure: 'invalid-config', error: `Source config is invalid at ${first.path}: ${first.message}.` };
  }
  return { ok: true, record, digest };
}

export async function fetchGithubRepoConfig(slug: string): Promise<string> {
  const output = await runGh(['api', '--hostname', 'github.com', `repos/${slug}/contents/${AIE_CONFIG_FILENAME}`], { timeoutMs: 15_000 });
  const parsed = JSON.parse(output.stdout) as { content?: string; encoding?: string; message?: string };
  if (typeof parsed.content !== 'string') {
    throw new Error(parsed.message ?? `GitHub did not return ${AIE_CONFIG_FILENAME} for ${slug}.`);
  }
  return Buffer.from(parsed.content.replace(/\s+/g, ''), 'base64').toString('utf8');
}

export async function adoptFromSource(input: {
  spec: string;
  cwd: string;
  fetchRepoConfig?: (slug: string) => Promise<string>;
  evaluateReadiness?: (options: Parameters<typeof evaluateGitHubReadiness>[0]) => Promise<GitHubReadiness>;
  machine: GuideMachine;
}): Promise<AdoptedSource | AdoptedSourceError> {
  const kind = classifyFromSpec(input.spec);
  if (kind === 'url') {
    return { ok: false, failure: 'url', error: '--from does not accept URLs. Use a path relative to the working directory or an owner/repo slug.' };
  }
  let rawText: string;
  let sourceLabel: string;
  let adoptedKind: InitFromReport['kind'] = 'path';
  const pathResult = readContainedConfigText(input.cwd, input.spec);
  if (kind === 'repo' && (!pathResult.ok && pathResult.failure === 'missing')) {
    const slug = input.spec.trim();
    try {
      const githubReadiness = input.evaluateReadiness
        ? await input.evaluateReadiness({ cwd: input.cwd, repository: slug, roles: ['setup-source'], env: process.env })
        : input.fetchRepoConfig
          ? ({ status: 'ready', reasonCode: 'ready', summary: 'The injected source fetcher owns readiness for this call.', nextAction: null } as const)
          : await evaluateGitHubReadiness({ cwd: input.cwd, repository: slug, roles: ['setup-source'], env: process.env });
      if (githubReadiness.status !== 'ready') {
        return {
          ok: false,
          failure: 'repo-fetch-failed',
          error: `GitHub setup source is ${githubReadiness.status} (${githubReadiness.reasonCode}): ${githubReadiness.summary} ${githubReadiness.nextAction ?? ''}`.trim(),
        };
      }
      rawText = await (input.fetchRepoConfig ?? fetchGithubRepoConfig)(slug);
      sourceLabel = slug;
      adoptedKind = 'repo';
    } catch (err: unknown) {
      return {
        ok: false,
        failure: 'repo-fetch-failed',
        error: `Failed to fetch ${AIE_CONFIG_FILENAME} from ${slug}: ${err instanceof Error ? err.message : String(err)}.`,
      };
    }
  } else if (!pathResult.ok) {
    return pathResult;
  } else {
    rawText = pathResult.text;
    sourceLabel = pathResult.label;
  }
  const parsed = parseAdoptedConfig(rawText);
  if (!parsed.ok) return parsed;
  const adjustments = adjustAdoptedRecord(parsed.record, input.machine);
  return {
    ok: true,
    record: parsed.record,
    report: {
      source: sourceLabel,
      kind: adoptedKind,
      sourceDigest: parsed.digest,
      adjustments,
    },
  };
}

function readContainedConfigText(cwd: string, spec: string): { ok: true; text: string; label: string } | AdoptedSourceError {
  const normalized = spec.trim().replace(/\\/g, '/').replace(/\/$/, '');
  const candidateSpecs = normalized.endsWith(AIE_CONFIG_FILENAME) ? [normalized] : [normalized, `${normalized}/${AIE_CONFIG_FILENAME}`];
  let lastError: AdoptedSourceError | null = null;
  for (const candidate of candidateSpecs) {
    const resolved = resolveContainedFromPath(cwd, candidate);
    if (!resolved.ok) {
      lastError = resolved;
      continue;
    }
    const configPath = configPathFromResolvedSource(resolved.path);
    if (!configPath.ok) {
      lastError = configPath;
      continue;
    }
    try {
      return {
        ok: true,
        text: readFileSync(configPath.path, 'utf8'),
        label: relative(cwd, configPath.path).replace(/\\/g, '/'),
      };
    } catch (err: unknown) {
      return { ok: false, failure: 'unreadable', error: `Source config is unreadable: ${err instanceof Error ? err.message : String(err)}.` };
    }
  }
  return lastError ?? { ok: false, failure: 'missing', error: `--from path was not found: ${normalized}.` };
}

export function adjustAdoptedRecord(record: Record<string, unknown>, machine: GuideMachine): string[] {
  const adjustments: string[] = [];
  const policy = isPlainObject(record.policy) ? record.policy : {};
  record.policy = policy;
  const reviews = isPlainObject(policy.reviews) ? policy.reviews : {};
  policy.reviews = reviews;
  const gates = isPlainObject(policy.gates) ? policy.gates : {};
  policy.gates = gates;
  const audit = isPlainObject(policy.audit) ? policy.audit : {};
  policy.audit = audit;

  const models = isPlainObject(reviews.models) ? reviews.models : {};
  reviews.models = models;
  for (const tierName of ['review', 'economy', 'synthesis'] as const) {
    const tier = isPlainObject(models[tierName]) ? models[tierName] : undefined;
    if (!tier) continue;
    for (const host of REVIEW_MODEL_HOST_IDS) {
      if (tier[host] === undefined) continue;
      if (isolatedReviewHostPackageName(host)) {
        if (isolatedReviewHostsOnMachine(machine).includes(host as ReviewModelHostId)) continue;
        delete tier[host];
        adjustments.push(`Removed ${tierName} model binding for ${host} because that isolated review host adapter is not installed.`);
        continue;
      }
      if (machine.installedHosts.includes(host as ReviewModelHostId)) continue;
      delete tier[host];
      adjustments.push(`Removed ${tierName} model binding for ${host} because that host is not installed on this machine.`);
    }
  }

  if (reviews.mode === 'isolated' && isolatedReviewHostsOnMachine(machine).length === 0) {
    reviews.mode = 'external';
    adjustments.push('Changed review mode from isolated to external because no isolated review host adapter is installed.');
  } else if (reviews.mode !== undefined && reviews.mode !== null && !isReviewMode(reviews.mode)) {
    reviews.mode = 'external';
    adjustments.push('Changed an invalid review mode to external.');
  }

  if (audit.manualUiAudit === true && !machine.agentBrowserAvailable) {
    audit.manualUiAudit = false;
    adjustments.push('Disabled manual UI audit because agent-browser is not available on this machine.');
  }
  if (gates.qualityControl === true && !machine.aiqAvailable) {
    gates.qualityControl = false;
    adjustments.push('Disabled Quality Control because aiq is not available on this machine.');
  }

  const providers = isPlainObject(record.providers) ? record.providers : {};
  const reviewProvider = isPlainObject(providers.review) ? providers.review : {};
  const publisher = isPlainObject(reviewProvider.publisher) ? reviewProvider.publisher : undefined;
  if (publisher) {
    const githubApp = isPlainObject(publisher.githubApp) ? publisher.githubApp : undefined;
    if (publisher.mode === 'github-app' && typeof githubApp?.privateKeyPath === 'string' && !existsSync(githubApp.privateKeyPath)) {
      adjustments.push(`Publisher app private key path is missing on this machine: ${githubApp.privateKeyPath}.`);
    }
    const token = isPlainObject(publisher.token) ? publisher.token : undefined;
    if (publisher.mode === 'token' && typeof token?.env === 'string' && !process.env[token.env]) {
      adjustments.push(`Publisher token environment variable ${token.env} is not set on this machine.`);
    }
  }
  return adjustments;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
