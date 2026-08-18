import type { ReviewModelHostId, ReviewModelTierId, ReviewModelsPolicy } from './policy.js';
import { resolveReviewModelTier } from '../app/local_review_runner_support.js';

export const MODEL_ROUTE_CLASSES = Object.freeze([
  'mechanical-implementation',
  'exploration-investigation',
  'independent-review',
  'synthesis-judgment',
] as const);

export type ModelRouteClass = (typeof MODEL_ROUTE_CLASSES)[number];
export const DELEGATED_MODEL_ROUTE_CLASSES = Object.freeze([
  'mechanical-implementation',
  'exploration-investigation',
  'synthesis-judgment',
] as const);
export type DelegatedModelRouteClass = (typeof DELEGATED_MODEL_ROUTE_CLASSES)[number];

export const MODEL_ROUTING_HOSTS = Object.freeze(['codex', 'claude-code', 'opencode', 'grok-build', 'cursor'] as const);
export type ModelRoutingHostId = (typeof MODEL_ROUTING_HOSTS)[number];
export type ModelRoutingTransport = 'cli' | 'host';

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const CATALOG_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export interface ModelCatalogEntry {
  readonly id: string;
  readonly host: ModelRoutingHostId;
  readonly transport: ModelRoutingTransport;
  readonly costRank: number;
  readonly notes: string;
}

export interface DelegatedModelRouteBinding {
  readonly preferred: string;
  readonly fallback: readonly string[];
}

export interface IndependentReviewRouteBinding {
  readonly reviewTier: ReviewModelTierId;
}

export interface ModelRoutingPolicy {
  readonly primary: string;
  readonly catalog: readonly ModelCatalogEntry[];
  readonly routes: {
    readonly 'mechanical-implementation': DelegatedModelRouteBinding;
    readonly 'exploration-investigation': DelegatedModelRouteBinding;
    readonly 'independent-review': IndependentReviewRouteBinding;
    readonly 'synthesis-judgment': DelegatedModelRouteBinding;
  };
}

export interface ModelRoutingSubstitution {
  readonly from: string;
  readonly to: string;
  readonly reason: string;
}

export interface ResolvedDelegatedRoute {
  readonly routeClass: DelegatedModelRouteClass;
  readonly preferred: string;
  readonly selected: ModelCatalogEntry;
  readonly chain: readonly string[];
  readonly substitutions: readonly ModelRoutingSubstitution[];
}

export interface ResolvedIndependentReviewRoute {
  readonly routeClass: 'independent-review';
  readonly reviewTier: ReviewModelTierId;
  readonly host: ReviewModelHostId | null;
  readonly model: string | null;
  readonly effort: string | null;
  readonly substitution: string | null;
}

export interface ModelRoutingResolution {
  readonly primary: ModelCatalogEntry;
  readonly catalog: readonly ModelCatalogEntry[];
  readonly routes: {
    readonly 'mechanical-implementation': ResolvedDelegatedRoute;
    readonly 'exploration-investigation': ResolvedDelegatedRoute;
    readonly 'independent-review': ResolvedIndependentReviewRoute;
    readonly 'synthesis-judgment': ResolvedDelegatedRoute;
  };
  readonly substitutions: readonly ModelRoutingSubstitution[];
}

export interface ModelRoutingSelectionInput {
  readonly primaryHost: ModelRoutingHostId;
  readonly primaryModel: string;
  readonly mechanical?: { readonly host: ModelRoutingHostId; readonly model: string };
  readonly exploration?: { readonly host: ModelRoutingHostId; readonly model: string };
  readonly synthesis?: { readonly host: ModelRoutingHostId; readonly model: string };
  readonly independentReviewTier?: ReviewModelTierId;
}

export function isModelRoutingHost(value: string): value is ModelRoutingHostId {
  return (MODEL_ROUTING_HOSTS as readonly string[]).includes(value);
}

export function isModelRouteClass(value: string): value is ModelRouteClass {
  return (MODEL_ROUTE_CLASSES as readonly string[]).includes(value);
}

export function isDelegatedModelRouteClass(value: string): value is DelegatedModelRouteClass {
  return (DELEGATED_MODEL_ROUTE_CLASSES as readonly string[]).includes(value);
}

export function defaultModelRoutingPolicy(): ModelRoutingPolicy {
  return {
    primary: 'primary',
    catalog: [
      {
        id: 'primary',
        host: 'claude-code',
        transport: 'host',
        costRank: 3,
        notes: 'Primary host model. Fallback target for every delegated route class.',
      },
    ],
    routes: {
      'mechanical-implementation': { preferred: 'primary', fallback: ['primary'] },
      'exploration-investigation': { preferred: 'primary', fallback: ['primary'] },
      'independent-review': { reviewTier: 'review' },
      'synthesis-judgment': { preferred: 'primary', fallback: ['primary'] },
    },
  };
}

export function cloneModelRoutingPolicy(policy: ModelRoutingPolicy): ModelRoutingPolicy {
  return {
    primary: policy.primary,
    catalog: policy.catalog.map(entry => ({ ...entry })),
    routes: {
      'mechanical-implementation': {
        preferred: policy.routes['mechanical-implementation'].preferred,
        fallback: [...policy.routes['mechanical-implementation'].fallback],
      },
      'exploration-investigation': {
        preferred: policy.routes['exploration-investigation'].preferred,
        fallback: [...policy.routes['exploration-investigation'].fallback],
      },
      'independent-review': { reviewTier: policy.routes['independent-review'].reviewTier },
      'synthesis-judgment': {
        preferred: policy.routes['synthesis-judgment'].preferred,
        fallback: [...policy.routes['synthesis-judgment'].fallback],
      },
    },
  };
}

export function catalogIdFor(host: ModelRoutingHostId, model: string): string {
  return `${host}:${model}`;
}

export function buildModelRoutingFromSelections(input: ModelRoutingSelectionInput): ModelRoutingPolicy {
  const catalog = new Map<string, ModelCatalogEntry>();
  const primaryId = catalogIdFor(input.primaryHost, input.primaryModel);
  catalog.set(primaryId, {
    id: primaryId,
    host: input.primaryHost,
    transport: input.primaryHost === 'claude-code' ? 'host' : 'cli',
    costRank: 3,
    notes: 'Primary host model. Fallback target for every delegated route class.',
  });
  function addCheaper(selection: { host: ModelRoutingHostId; model: string } | undefined, notes: string, costRank: number): string {
    if (!selection) return primaryId;
    const id = catalogIdFor(selection.host, selection.model);
    if (!catalog.has(id)) {
      catalog.set(id, {
        id,
        host: selection.host,
        transport: selection.host === input.primaryHost ? 'host' : 'cli',
        costRank,
        notes,
      });
    }
    return id;
  }
  const mechanical = addCheaper(input.mechanical, 'Preferred model for mechanical implementation.', 1);
  const exploration = addCheaper(input.exploration, 'Preferred model for exploration and investigation.', 2);
  const synthesis = addCheaper(input.synthesis, 'Preferred model for synthesis and judgment.', 3);
  return {
    primary: primaryId,
    catalog: [...catalog.values()],
    routes: {
      'mechanical-implementation': { preferred: mechanical, fallback: uniqueChain(mechanical, primaryId) },
      'exploration-investigation': { preferred: exploration, fallback: uniqueChain(exploration, primaryId) },
      'independent-review': { reviewTier: input.independentReviewTier ?? 'review' },
      'synthesis-judgment': { preferred: synthesis, fallback: uniqueChain(synthesis, primaryId) },
    },
  };
}

function uniqueChain(preferred: string, primary: string): readonly string[] {
  return preferred === primary ? [primary] : [preferred, primary];
}

export function hostedCatalogIds(policy: ModelRoutingPolicy, host: ModelRoutingHostId): readonly string[] {
  return policy.catalog.filter(entry => entry.host === host).map(entry => entry.id);
}

export function delegatedHosts(policy: ModelRoutingPolicy): readonly ModelRoutingHostId[] {
  const primary = policy.catalog.find(entry => entry.id === policy.primary);
  const hosts = new Set<ModelRoutingHostId>();
  for (const routeClass of DELEGATED_MODEL_ROUTE_CLASSES) {
    const preferred = policy.catalog.find(entry => entry.id === policy.routes[routeClass].preferred);
    if (preferred && primary && preferred.host !== primary.host) hosts.add(preferred.host);
    for (const fallbackId of policy.routes[routeClass].fallback) {
      const fallback = policy.catalog.find(entry => entry.id === fallbackId);
      if (fallback && primary && fallback.host !== primary.host) hosts.add(fallback.host);
    }
  }
  return [...hosts];
}

export function resolveModelRouting(
  policy: ModelRoutingPolicy,
  reviewModels: ReviewModelsPolicy,
  installedHosts: readonly ModelRoutingHostId[],
): ModelRoutingResolution {
  const catalogById = new Map(policy.catalog.map(entry => [entry.id, entry]));
  const primary = catalogById.get(policy.primary);
  if (!primary) {
    throw new Error(`modelRouting.primary ${policy.primary} is missing from the catalog.`);
  }
  const installed = new Set(installedHosts);
  const substitutions: ModelRoutingSubstitution[] = [];
  const mechanical = resolveDelegatedRoute(policy, 'mechanical-implementation', catalogById, installed, substitutions);
  const exploration = resolveDelegatedRoute(policy, 'exploration-investigation', catalogById, installed, substitutions);
  const synthesis = resolveDelegatedRoute(policy, 'synthesis-judgment', catalogById, installed, substitutions);
  const independent = resolveIndependentReviewRoute(policy, reviewModels, installed);
  if (independent.substitution) {
    substitutions.push({
      from: `reviewModels.${independent.reviewTier}`,
      to: independent.model ?? 'host-default',
      reason: independent.substitution,
    });
  }
  return {
    primary,
    catalog: policy.catalog,
    routes: {
      'mechanical-implementation': mechanical,
      'exploration-investigation': exploration,
      'independent-review': independent,
      'synthesis-judgment': synthesis,
    },
    substitutions,
  };
}

function resolveDelegatedRoute(
  policy: ModelRoutingPolicy,
  routeClass: DelegatedModelRouteClass,
  catalogById: Map<string, ModelCatalogEntry>,
  installed: Set<ModelRoutingHostId>,
  substitutions: ModelRoutingSubstitution[],
): ResolvedDelegatedRoute {
  const binding = policy.routes[routeClass];
  const chain = [binding.preferred, ...binding.fallback.filter(id => id !== binding.preferred)];
  let selected = catalogById.get(binding.preferred);
  if (!selected) {
    throw new Error(`modelRouting.routes.${routeClass}.preferred ${binding.preferred} is missing from the catalog.`);
  }
  const routeSubstitutions: ModelRoutingSubstitution[] = [];
  for (const candidateId of chain) {
    const candidate = catalogById.get(candidateId);
    if (!candidate) continue;
    if (installed.has(candidate.host)) {
      if (candidate.id !== selected.id) {
        const substitution = {
          from: selected.id,
          to: candidate.id,
          reason: `Host ${selected.host} is not installed; ${routeClass} fell back to ${candidate.id}.`,
        };
        routeSubstitutions.push(substitution);
        substitutions.push(substitution);
      }
      selected = candidate;
      return {
        routeClass,
        preferred: binding.preferred,
        selected,
        chain,
        substitutions: routeSubstitutions,
      };
    }
  }
  const substitution = {
    from: binding.preferred,
    to: policy.primary,
    reason: `No installed host remained on the ${routeClass} chain; the primary model was substituted.`,
  };
  routeSubstitutions.push(substitution);
  substitutions.push(substitution);
  return {
    routeClass,
    preferred: binding.preferred,
    selected: catalogById.get(policy.primary) ?? selected,
    chain,
    substitutions: routeSubstitutions,
  };
}

function resolveIndependentReviewRoute(
  policy: ModelRoutingPolicy,
  reviewModels: ReviewModelsPolicy,
  installed: Set<ModelRoutingHostId>,
): ResolvedIndependentReviewRoute {
  const reviewTier = policy.routes['independent-review'].reviewTier;
  const host = firstInstalledReviewHost(installed);
  if (!host) {
    return {
      routeClass: 'independent-review',
      reviewTier,
      host: null,
      model: null,
      effort: null,
      substitution: `No installed review host is available for the ${reviewTier} reviewModels tier.`,
    };
  }
  const resolved = resolveReviewModelTier(reviewModels, reviewTier, host);
  return {
    routeClass: 'independent-review',
    reviewTier,
    host,
    model: resolved.model,
    effort: resolved.effort,
    substitution: resolved.substitution,
  };
}

function firstInstalledReviewHost(installed: Set<ModelRoutingHostId>): ReviewModelHostId | null {
  for (const host of MODEL_ROUTING_HOSTS) {
    if (installed.has(host)) return host;
  }
  return null;
}

export const MODEL_ROUTING_HOST_COMMANDS: Readonly<Record<ModelRoutingHostId, readonly string[]>> = Object.freeze({
  codex: Object.freeze(['codex']),
  'claude-code': Object.freeze(['claude']),
  opencode: Object.freeze(['opencode']),
  'grok-build': Object.freeze(['grok']),
  cursor: Object.freeze(['cursor-agent', 'agent']),
});

export function detectInstalledRoutingHosts(
  lookup: (command: string) => boolean,
): readonly ModelRoutingHostId[] {
  const installed: ModelRoutingHostId[] = [];
  for (const host of MODEL_ROUTING_HOSTS) {
    if (MODEL_ROUTING_HOST_COMMANDS[host].some(lookup)) installed.push(host);
  }
  return installed;
}

export function assertInstalledRoutingHost(
  host: ModelRoutingHostId,
  installedHosts: readonly ModelRoutingHostId[],
): void {
  if (!installedHosts.includes(host)) {
    throw new Error(`Host CLI for ${host} is not installed. Install and authenticate that host, or choose an installed host.`);
  }
}

export function isValidCatalogId(value: string): boolean {
  return CATALOG_ID_PATTERN.test(value);
}

export function isValidModelId(value: string): boolean {
  return MODEL_ID_PATTERN.test(value);
}

export function parseHostModel(value: string): { host: ModelRoutingHostId; model: string } | null {
  const trimmed = value.trim();
  const separator = trimmed.indexOf(':');
  if (separator <= 0 || separator === trimmed.length - 1) return null;
  const host = trimmed.slice(0, separator);
  const model = trimmed.slice(separator + 1).trim();
  if (!isModelRoutingHost(host) || !isValidModelId(model)) return null;
  return { host, model };
}
