import { getAgentHostProfileSync } from '../agent_host_adapters.js';
import type { HostModelListing } from '../app/model_catalog.js';
import type { ReviewModelHostId, ReviewModelsPolicy } from '../core/policy.js';
import { REVIEW_MODEL_HOST_IDS } from '../core/policy.js';
import { listReviewAgentAdapters } from '../providers/review_agent_adapters.js';

const INIT_EXTERNAL_REVIEWER_IDS = Object.freeze(['copilot', 'coderabbit', 'cubic'] as const);

export interface InitExternalReviewer {
  readonly id: typeof INIT_EXTERNAL_REVIEWER_IDS[number];
  readonly aliases: readonly string[];
  readonly label: string;
}

export interface InitSelectionResult<T> {
  readonly values: T;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

const EXTERNAL_REVIEWER_LABELS: Readonly<Record<InitExternalReviewer['id'], string>> = Object.freeze({
  copilot: 'GitHub Copilot',
  coderabbit: 'CodeRabbit',
  cubic: 'Cubic',
});

function isInitExternalReviewerId(value: string): value is InitExternalReviewer['id'] {
  return (INIT_EXTERNAL_REVIEWER_IDS as readonly string[]).includes(value);
}

export async function listInitExternalReviewers(): Promise<readonly InitExternalReviewer[]> {
  const registered = await listReviewAgentAdapters('github');
  const byId = new Map(registered.filter(agent => isInitExternalReviewerId(agent.id)).map(agent => [agent.id, agent]));
  return Object.freeze(INIT_EXTERNAL_REVIEWER_IDS.flatMap(id => {
    const agent = byId.get(id);
    if (!agent) return [];
    return [Object.freeze({
      id,
      aliases: Object.freeze([...agent.aliases]),
      label: EXTERNAL_REVIEWER_LABELS[id],
    })];
  }));
}

function normalizedReviewerId(value: string): string {
  return value.trim().replace(/^@/, '').toLowerCase();
}

export function resolveInitExternalReviewers(
  requested: readonly string[],
  registered: readonly InitExternalReviewer[],
  reviewProvider: 'github' | 'gitlab' = 'github',
): InitSelectionResult<readonly string[]> {
  const values: string[] = [];
  const errors: string[] = [];
  for (const raw of requested) {
    const value = normalizedReviewerId(raw);
    const match = registered.find(agent => agent.id === value || agent.aliases.some(alias => alias.toLowerCase() === value));
    if (!match) {
      errors.push(reviewProvider === 'github'
        ? `Review agent "${raw}" is not available for normal GitHub setup. Use copilot, coderabbit, or cubic.`
        : `Review agent "${raw}" is not available for the GitLab review provider.`);
      continue;
    }
    if (!values.includes(match.id)) values.push(match.id);
  }
  return { values: Object.freeze(values), errors: Object.freeze(errors), warnings: Object.freeze([]) };
}

export function resolveInitLocalReviewers(
  requested: readonly string[],
  installedHosts: readonly ReviewModelHostId[],
): InitSelectionResult<readonly string[]> {
  const values: string[] = [];
  const errors: string[] = [];
  for (const raw of requested) {
    const value = raw.trim();
    if (!(REVIEW_MODEL_HOST_IDS as readonly string[]).includes(value)) {
      errors.push(`Local review agent "${raw}" is not a supported agent harness.`);
      continue;
    }
    const host = value as ReviewModelHostId;
    if (!installedHosts.includes(host)) {
      errors.push(`Local review agent "${host}" is not installed for this init run.`);
      continue;
    }
    if (getAgentHostProfileSync(host).review.local.support === 'unsupported') {
      errors.push(`Local review agent "${host}" does not support native review subagents.`);
      continue;
    }
    if (!values.includes(host)) values.push(host);
  }
  return { values: Object.freeze(values), errors: Object.freeze(errors), warnings: Object.freeze([]) };
}

export function resolveInitIsolatedReviewer(
  requested: string,
  selectedHosts: readonly string[],
  installedHosts: readonly ReviewModelHostId[],
): InitSelectionResult<ReviewModelHostId | null> {
  const value = requested.trim();
  if (!(REVIEW_MODEL_HOST_IDS as readonly string[]).includes(value)) {
    return {
      values: null,
      errors: Object.freeze([`Isolated review agent "${requested}" is not a supported agent harness.`]),
      warnings: Object.freeze([]),
    };
  }
  const host = value as ReviewModelHostId;
  if (!selectedHosts.includes(host)) {
    return {
      values: null,
      errors: Object.freeze([`Isolated review agent "${host}" is not selected by --tool for this init run.`]),
      warnings: Object.freeze([]),
    };
  }
  if (!installedHosts.includes(host)) {
    return {
      values: null,
      errors: Object.freeze([`Isolated review agent "${host}" is not installed for this init run.`]),
      warnings: Object.freeze([]),
    };
  }
  if (getAgentHostProfileSync(host).review.isolated.support === 'unsupported') {
    return {
      values: null,
      errors: Object.freeze([`Isolated review agent "${host}" does not support isolated review.`]),
      warnings: Object.freeze([]),
    };
  }
  return { values: host, errors: Object.freeze([]), warnings: Object.freeze([]) };
}

function parseReviewModel(value: string): { host: ReviewModelHostId; model: string } | null {
  const separator = value.indexOf(':');
  if (separator <= 0) return null;
  const host = value.slice(0, separator).trim();
  const model = value.slice(separator + 1).trim();
  if (!(REVIEW_MODEL_HOST_IDS as readonly string[]).includes(host) || model === '') return null;
  return { host: host as ReviewModelHostId, model };
}

export function resolveInitReviewModels(
  requested: readonly string[],
  catalogs: Readonly<Partial<Record<ReviewModelHostId, HostModelListing>>>,
): InitSelectionResult<ReviewModelsPolicy['review']> {
  const values: ReviewModelsPolicy['review'] = {};
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const raw of requested) {
    const parsed = parseReviewModel(raw);
    if (!parsed) {
      errors.push(`Review model "${raw}" must use host:model with codex, claude-code, opencode, grok-build, or cursor.`);
      continue;
    }
    const catalog = catalogs[parsed.host];
    if (!catalog || catalog.status !== 'ready') {
      errors.push(`Review model "${raw}" cannot be validated because the live ${parsed.host} model catalog is unavailable.`);
      continue;
    }
    if (!catalog.models.includes(parsed.model)) {
      errors.push(`Review model "${raw}" is not in the live ${parsed.host} model catalog.`);
      continue;
    }
    values[parsed.host] = { model: parsed.model, effort: null };
  }
  return { values, errors: Object.freeze(errors), warnings: Object.freeze(warnings) };
}
