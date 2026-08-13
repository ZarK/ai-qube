import { createHash } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

import type { Config } from '../config/types.js';
import { createCiProvider, createMissingCiProvider, listCiProviderAdapters } from './ci_provider_adapters.js';
import type { CiCheckStatus, CiProvider, CiProviderCapabilities } from './ci_provider.js';
import { createReviewForgeProvider, listReviewForgeAdapters } from './review_forge_adapters.js';
import type { ReviewForgeCapabilities, ReviewForgeProvider } from './review_forge_provider.js';
import { MISSING_REVIEW_FORGE_CAPABILITIES } from './review_forge_provider.js';
import { createWorkProvider, listWorkProviderAdapters } from './work_provider_adapters.js';
import type { WorkProvider, WorkProviderCapabilities } from './work_provider.js';

export type CompositionSupport = 'supported' | 'unsupported' | 'unknown';
export type CompositionRole = 'work' | 'review' | 'ci';

export interface CapabilityObservation {
  readonly role: CompositionRole;
  readonly id: string;
  readonly support: CompositionSupport;
  readonly reasonCode: string;
  readonly summary: string;
}

export interface CompositionIdentity {
  readonly headSha: string | null;
  readonly configDigest: string;
  readonly fixtureDigest: string | null;
}

export interface ProviderComposition {
  readonly work: { readonly id: string; readonly capabilities: WorkProviderCapabilities };
  readonly review: { readonly id: string; readonly capabilities: ReviewForgeCapabilities };
  readonly ci: { readonly id: string; readonly capabilities: CiProviderCapabilities };
  readonly observations: readonly CapabilityObservation[];
  readonly missing: readonly CapabilityObservation[];
  readonly identity: CompositionIdentity;
  readonly ciCheck: CiCheckStatus | null;
}

export interface ComposeProviderOptions {
  readonly headSha?: string;
  readonly fixtureRoot?: string;
  readonly fixturePath?: string;
  readonly ciCheck?: unknown;
  readonly previousIdentity?: CompositionIdentity;
}

const WORK_CAPABILITY_IDS = [
  'listOpenWork',
  'loadWork',
  'planStatusSync',
  'planLifecycleMutations',
  'applyLifecycleMutations',
  'commentMutations',
  'reviewIntegration',
  'ciMergeStatus',
] as const;

const REVIEW_CAPABILITY_IDS = [
  'loadReview',
  'reviewStats',
  'findCurrentBranchReview',
  'planReviewRequests',
  'applyReviewRequests',
  'publishLaneReview',
  'publishLaneReviewInline',
  'publishLocalReview',
  'resolveReviewThreads',
  'ciDiagnostics',
  'publishRoundReviewSummary',
] as const;

const CI_CAPABILITY_IDS = [
  'readStatus',
  'diagnoseStatus',
  'readArtifacts',
  'triggerRun',
] as const;

export function compositionConfigDigest(config: Pick<Config, 'providers'>): string {
  return createHash('sha256').update(JSON.stringify({
    work: config.providers.work.kind,
    review: config.providers.review.kind,
    ci: config.providers.ci.kind,
    workConnection: config.providers.work.connection ?? null,
    reviewConnection: config.providers.review.connection ?? null,
    ciConnection: config.providers.ci.connection ?? null,
  })).digest('hex');
}

export function bindCompositionIdentity(input: {
  readonly headSha: string | null;
  readonly configDigest: string;
  readonly fixtureDigest?: string | null;
}): CompositionIdentity {
  return Object.freeze({
    headSha: input.headSha,
    configDigest: input.configDigest,
    fixtureDigest: input.fixtureDigest ?? null,
  });
}

export function assertCurrentCompositionIdentity(bound: CompositionIdentity, current: CompositionIdentity): void {
  if (bound.headSha !== current.headSha) {
    throw new Error(`Composition evidence is stale for head ${current.headSha ?? 'unknown'}; bound head was ${bound.headSha ?? 'unknown'}.`);
  }
  if (bound.configDigest !== current.configDigest) {
    throw new Error('Composition evidence is stale for a different provider config digest.');
  }
  if (bound.fixtureDigest !== current.fixtureDigest) {
    throw new Error('Composition evidence is stale for a different fixture digest.');
  }
}

export function resolveCompositionFixturePath(root: string, relativePath: string): string {
  if (!root || root.trim() === '') {
    throw new Error('Composition fixture root is required.');
  }
  if (!relativePath || relativePath.trim() === '') {
    throw new Error('Composition fixture path is required.');
  }
  if (isAbsolute(relativePath)) {
    throw new Error('Composition fixture path must be relative to the fixture root.');
  }
  const segments = relativePath.split(/[\\/]/u);
  if (segments.some(segment => segment === '..')) {
    throw new Error('Composition fixture path must not include parent-directory segments.');
  }
  const rootResolved = resolve(root);
  const resolved = resolve(rootResolved, relativePath);
  const rel = relative(rootResolved, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('Composition fixture path must stay under the fixture root.');
  }
  if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink()) {
    const realFile = realpathSync(resolved);
    const realRoot = realpathSync(rootResolved);
    const escaped = relative(realRoot, realFile);
    if (escaped.startsWith('..') || isAbsolute(escaped)) {
      throw new Error('Composition fixture path must not escape the fixture root through a symlink.');
    }
  }
  return resolved;
}

export async function composeProviderPermutation(config: Config, options: ComposeProviderOptions = {}): Promise<ProviderComposition> {
  if (options.previousIdentity) {
    const preview = bindCompositionIdentity({
      headSha: options.headSha ?? null,
      configDigest: compositionConfigDigest(config),
      fixtureDigest: options.fixturePath ? createHash('sha256').update(options.fixturePath).digest('hex') : null,
    });
    assertCurrentCompositionIdentity(options.previousIdentity, preview);
  }

  if (options.fixtureRoot && options.fixturePath) {
    resolveCompositionFixturePath(options.fixtureRoot, options.fixturePath);
  }

  const workObserved = await observeWork(config);
  const reviewObserved = await observeReview(config);
  const ciObserved = await observeCi(config, options.headSha);

  let ciCheck: CiCheckStatus | null = null;
  if (options.ciCheck !== undefined) {
    ciCheck = ciObserved.provider.mapCheck(options.ciCheck);
  }

  const observations = [
    ...observeFlags('work', workObserved.id, workObserved.capabilities as unknown as CapabilityFlags, workObserved.present, WORK_CAPABILITY_IDS),
    ...observeFlags('review', reviewObserved.id, reviewObserved.capabilities as unknown as CapabilityFlags, reviewObserved.present, REVIEW_CAPABILITY_IDS),
    ...observeFlags('ci', ciObserved.id, ciObserved.capabilities as unknown as CapabilityFlags, ciObserved.present, CI_CAPABILITY_IDS),
  ];

  const identity = bindCompositionIdentity({
    headSha: options.headSha ?? null,
    configDigest: compositionConfigDigest(config),
    fixtureDigest: options.fixturePath ? createHash('sha256').update(options.fixturePath).digest('hex') : null,
  });

  return {
    work: { id: workObserved.id, capabilities: workObserved.capabilities },
    review: { id: reviewObserved.id, capabilities: reviewObserved.capabilities },
    ci: { id: ciObserved.id, capabilities: ciObserved.capabilities },
    observations,
    missing: observations.filter(item => item.support !== 'supported'),
    identity,
    ciCheck,
  };
}

async function observeWork(config: Config): Promise<{ id: string; capabilities: WorkProviderCapabilities; present: boolean; provider: WorkProvider | null }> {
  const id = config.providers.work.kind;
  const meta = listWorkProviderAdapters().find(adapter => adapter.id === id);
  try {
    const provider = await createWorkProvider(id, {
      ...config.providers.connections[id],
      ...config.providers.work.connection,
      ...(config.providers.work.jira ?? {}),
    });
    const capabilities = provider.capabilities();
    const present = hasAnyTrue(capabilities);
    return { id, capabilities: present ? capabilities : allFalseWork(), present, provider: present ? provider : null };
  } catch {
    return { id, capabilities: meta?.capabilities ?? allFalseWork(), present: Boolean(meta), provider: null };
  }
}

async function observeReview(config: Config): Promise<{ id: string; capabilities: ReviewForgeCapabilities; present: boolean; provider: ReviewForgeProvider | null }> {
  const id = config.providers.review.kind;
  const meta = listReviewForgeAdapters().find(adapter => adapter.id === id);
  try {
    const provider = await createReviewForgeProvider(id, {
      ...config.providers.connections[id],
      ...config.providers.review.connection,
      publisher: config.providers.review.publisher ?? null,
    });
    const capabilities = normalizeReviewCapabilities(provider.capabilities());
    const present = hasAnyTrue(capabilities);
    return { id, capabilities: present ? capabilities : MISSING_REVIEW_FORGE_CAPABILITIES, present, provider: present ? provider : null };
  } catch {
    return { id, capabilities: normalizeReviewCapabilities(meta?.capabilities), present: Boolean(meta), provider: null };
  }
}

async function observeCi(config: Config, headSha?: string): Promise<{ id: string; capabilities: CiProviderCapabilities; present: boolean; provider: CiProvider }> {
  const id = config.providers.ci.kind;
  const meta = listCiProviderAdapters().find(adapter => adapter.id === id);
  try {
    const provider = await createCiProvider(id, {
      ...config.providers.connections[id],
      ...config.providers.ci.connection,
      headSha,
    });
    const capabilities = provider.capabilities();
    const present = hasAnyTrue(capabilities);
    return {
      id,
      capabilities: present ? capabilities : provider.capabilities(),
      present,
      provider: present ? provider : createMissingCiProvider(id, meta?.packageName ?? `missing-${id}`, meta?.setup ?? []),
    };
  } catch {
    const fallback = createMissingCiProvider(id, meta?.packageName ?? `missing-${id}`, meta?.setup ?? []);
    return { id, capabilities: meta?.capabilities ?? fallback.capabilities(), present: Boolean(meta), provider: fallback };
  }
}

type CapabilityFlags = Readonly<Record<string, boolean | undefined>>;

function observeFlags(
  role: CompositionRole,
  providerId: string,
  capabilities: CapabilityFlags,
  present: boolean,
  ids: readonly string[],
): CapabilityObservation[] {
  return ids.map(id => {
    const enabled = capabilities[id] === true;
    if (enabled) {
      return {
        role,
        id,
        support: 'supported',
        reasonCode: `${role}-capability-supported`,
        summary: `${providerId} ${role} capability ${id} is supported.`,
      };
    }
    if (!present) {
      return {
        role,
        id,
        support: 'unknown',
        reasonCode: `${role}-adapter-unknown`,
        summary: `${providerId} ${role} capability ${id} is unknown because the selected adapter is not installed.`,
      };
    }
    return {
      role,
      id,
      support: 'unsupported',
      reasonCode: `${role}-capability-unsupported`,
      summary: `${providerId} ${role} capability ${id} is unsupported.`,
    };
  });
}

function normalizeReviewCapabilities(value: { readonly [key: string]: boolean | undefined } | Partial<ReviewForgeCapabilities> | undefined): ReviewForgeCapabilities {
  const source = value ?? {};
  return {
    loadReview: source.loadReview === true,
    reviewStats: source.reviewStats === true,
    findCurrentBranchReview: source.findCurrentBranchReview === true,
    planReviewRequests: source.planReviewRequests === true,
    applyReviewRequests: source.applyReviewRequests === true,
    publishLaneReview: source.publishLaneReview === true,
    publishLaneReviewInline: source.publishLaneReviewInline === true,
    publishLocalReview: source.publishLocalReview === true,
    resolveReviewThreads: source.resolveReviewThreads === true,
    ciDiagnostics: source.ciDiagnostics === true,
    publishRoundReviewSummary: source.publishRoundReviewSummary === true,
  };
}

function hasAnyTrue(capabilities: object): boolean {
  return Object.values(capabilities).some(value => value === true);
}

function allFalseWork(): WorkProviderCapabilities {
  return {
    listOpenWork: false,
    loadWork: false,
    planStatusSync: false,
    planLifecycleMutations: false,
    applyLifecycleMutations: false,
    commentMutations: false,
    reviewIntegration: false,
    ciMergeStatus: false,
  };
}

export function compositionUsesSelectedKinds(composition: ProviderComposition, config: Config): boolean {
  return composition.work.id === config.providers.work.kind
    && composition.review.id === config.providers.review.kind
    && composition.ci.id === config.providers.ci.kind;
}
