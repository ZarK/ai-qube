import type { ReviewForgePolicy } from '@tjalve/qube-core';
import type { GhExec } from '../gh.js';
import type { ActionPlan, ActionResult } from '../core/action_plan.js';
import { createActionPlan } from '../core/action_plan.js';
import type { ExecutorPolicy } from '../core/policy.js';
import type { ReviewItem, ReviewItemKey } from '../core/review_item.js';
import type { ReviewProviderPlanOptions } from './review_provider.js';

import {
  MISSING_REVIEW_FORGE_CAPABILITIES,
  type CurrentReviewForge,
  type ReviewForgeCapabilities,
  type ReviewForgeLaneReviewPublishInput,
  type ReviewForgeLaneReviewPublishResult,
  type ReviewForgeLocalReviewPublishInput,
  type ReviewForgeLocalReviewPublishResult,
  type ReviewForgeProvider,
  type ReviewForgeProviderFactory,
  type ReviewForgeProviderId,
  type ReviewForgeSnapshot,
} from './review_forge_provider.js';

export interface ReviewForgeAdapterOptions {
  readonly exec?: GhExec;
  readonly cwd?: string;
}

export interface ReviewForgeAdapterMetadata {
  readonly id: ReviewForgeProviderId;
  readonly packageName: string;
  readonly installed: boolean;
  readonly capabilities: ReviewForgeCapabilities;
  readonly setup: readonly string[];
}

interface ReviewForgeAdapter extends ReviewForgeAdapterMetadata {
  create(options: ReviewForgeAdapterOptions): Promise<ReviewForgeProvider>;
}

const GITHUB_CAPABILITIES: ReviewForgeCapabilities = Object.freeze({
  loadReview: true,
  findCurrentBranchReview: true,
  planReviewRequests: true,
  applyReviewRequests: true,
  publishLaneReview: true,
  publishLocalReview: true,
  ciDiagnostics: true,
});

const ADAPTERS: readonly ReviewForgeAdapter[] = Object.freeze([
  Object.freeze({
    id: 'github',
    packageName: '@tjalve/qube-adapter-github',
    installed: true,
    capabilities: GITHUB_CAPABILITIES,
    setup: Object.freeze([
      'GitHub review-forge support is available through the optional GitHub adapter package.',
      'Authenticate gh for the target repository before running mutating PR review commands.',
    ]),
    create: async (options: ReviewForgeAdapterOptions) => {
      const loaded = await loadOptionalAdapter('@tjalve/qube-adapter-github', 'createGitHubReviewForgeProvider');
      if (loaded) return wrapAdapterReviewForgeProvider(loaded(options) as unknown as LoadedGitHubReviewForgeProvider);
      return new MissingReviewForgeProvider('github', '@tjalve/qube-adapter-github', [
        'Install the optional GitHub review-forge adapter package before selecting providers.review.kind=github.',
        'Authenticate gh for the target repository before running mutating PR review commands.',
      ]);
    },
  }),
]);

async function loadOptionalAdapter(packageName: string, factoryName: string): Promise<ReviewForgeProviderFactory | null> {
  try {
    const imported = await import(packageName);
    const factory = (imported as Record<string, unknown>)[factoryName];
    return typeof factory === 'function' ? factory as ReviewForgeProviderFactory : null;
  } catch (error) {
    if (isModuleMissing(error, packageName)) return null;
    throw error;
  }
}

function isModuleMissing(error: unknown, packageName: string): boolean {
  if (!(error instanceof Error)) return false;
  const code = 'code' in error ? String((error as { code?: unknown }).code) : '';
  return code === 'ERR_MODULE_NOT_FOUND' && error.message.includes(packageName);
}

function adapterFor(id: ReviewForgeProviderId): ReviewForgeAdapter {
  const adapter = ADAPTERS.find(candidate => candidate.id === id);
  if (!adapter) {
    throw new Error(`Unknown review forge adapter "${id}".`);
  }
  return adapter;
}

export function listReviewForgeAdapters(): readonly ReviewForgeAdapterMetadata[] {
  return Object.freeze(ADAPTERS.map(adapter => Object.freeze({
    id: adapter.id,
    packageName: adapter.packageName,
    installed: adapter.installed,
    capabilities: adapter.capabilities,
    setup: adapter.setup,
  })));
}

export function reviewForgeAdapterPackage(id: ReviewForgeProviderId): string {
  return adapterFor(id).packageName;
}

interface LoadedGitHubReviewForgeProvider {
  readonly id: 'github';
  capabilities(): { loadReview: boolean; findCurrentBranchReview: boolean; planReviewRequests: boolean; applyReviewRequests: boolean; publishLaneReview?: boolean };
  getReviewItem(key: ReviewItemKey): Promise<ReviewItem>;
  findReviewForCurrentBranch(): Promise<ReviewItem | null>;
  findCurrentReview(): Promise<CurrentReviewForge>;
  loadPullRequestReview(prNumber: number): Promise<ReviewForgeSnapshot>;
  planReviewRequest(item: ReviewItem, policy: ReviewForgePolicy, options?: ReviewProviderPlanOptions): ActionPlan;
  apply(plan: ActionPlan): Promise<readonly ActionResult[]>;
  publishLocalReviewFeedback(item: ReviewItem, input: ReviewForgeLocalReviewPublishInput): Promise<ReviewForgeLocalReviewPublishResult>;
  publishLaneReviewFeedback(item: ReviewItem, input: ReviewForgeLaneReviewPublishInput): Promise<ReviewForgeLaneReviewPublishResult>;
}

function toReviewForgePolicy(policy: ExecutorPolicy): ReviewForgePolicy {
  return {
    adapter: policy.reviews.adapter,
    reviewers: policy.reviews.reviewers,
    requestText: policy.reviews.requestText,
  };
}

function wrapAdapterReviewForgeProvider(provider: LoadedGitHubReviewForgeProvider): ReviewForgeProvider {
  return {
    id: 'github',
    capabilities: () => ({
      loadReview: provider.capabilities().loadReview,
      findCurrentBranchReview: provider.capabilities().findCurrentBranchReview,
      planReviewRequests: provider.capabilities().planReviewRequests,
      applyReviewRequests: provider.capabilities().applyReviewRequests,
      publishLaneReview: provider.capabilities().publishLaneReview ?? true,
      publishLocalReview: true,
    }),
    getReviewItem: (key) => provider.getReviewItem(key),
    findReviewForCurrentBranch: () => provider.findReviewForCurrentBranch(),
    findCurrentReview: () => provider.findCurrentReview(),
    loadPullRequestReview: (prNumber) => provider.loadPullRequestReview(prNumber),
    planReviewRequest: (item, policy, options) => provider.planReviewRequest(item, toReviewForgePolicy(policy), options),
    apply: async (plan) => [...await provider.apply(plan)],
    publishLocalReviewFeedback: (item, input) => provider.publishLocalReviewFeedback(item, input),
    publishLaneReviewFeedback: (item, input) => provider.publishLaneReviewFeedback(item, input),
  };
}

export async function createReviewForgeProvider(id: ReviewForgeProviderId, options: ReviewForgeAdapterOptions = {}): Promise<ReviewForgeProvider> {
  return adapterFor(id).create(options);
}

class MissingReviewForgeProvider implements ReviewForgeProvider {
  readonly id: ReviewForgeProviderId;

  constructor(id: ReviewForgeProviderId, private readonly packageName: string, private readonly setup: readonly string[]) {
    this.id = id;
  }

  capabilities() {
    return {
      loadReview: MISSING_REVIEW_FORGE_CAPABILITIES.loadReview,
      findCurrentBranchReview: MISSING_REVIEW_FORGE_CAPABILITIES.findCurrentBranchReview,
      planReviewRequests: MISSING_REVIEW_FORGE_CAPABILITIES.planReviewRequests,
      applyReviewRequests: MISSING_REVIEW_FORGE_CAPABILITIES.applyReviewRequests,
      publishLaneReview: MISSING_REVIEW_FORGE_CAPABILITIES.publishLaneReview,
    };
  }

  async getReviewItem(_key: ReviewItemKey): Promise<ReviewItem> {
    throw this.error('load review item');
  }

  async findReviewForCurrentBranch(): Promise<ReviewItem | null> {
    throw this.error('find current branch review');
  }

  async findCurrentReview(): Promise<CurrentReviewForge> {
    throw this.error('find current review');
  }

  async loadPullRequestReview(_prNumber: number): Promise<ReviewForgeSnapshot> {
    throw this.error('load pull request review');
  }

  planReviewRequest(_item: ReviewItem, _policy: ExecutorPolicy): ActionPlan {
    return this.emptyPlan('review-request');
  }

  async apply(_plan: ActionPlan): Promise<ActionResult[]> {
    throw this.error('apply review forge mutation');
  }

  async publishLocalReviewFeedback(_item: ReviewItem, _input: ReviewForgeLocalReviewPublishInput): Promise<ReviewForgeLocalReviewPublishResult> {
    throw this.error('publish local review feedback');
  }

  async publishLaneReviewFeedback(_item: ReviewItem, _input: ReviewForgeLaneReviewPublishInput): Promise<ReviewForgeLaneReviewPublishResult> {
    throw this.error('publish lane review feedback');
  }

  private emptyPlan(command: string): ActionPlan {
    return createActionPlan({
      id: `${this.id}:${command}:adapter-missing`,
      purpose: this.message(command),
      dryRun: true,
      actions: [],
    });
  }

  private error(operation: string): Error {
    return new Error(this.message(operation));
  }

  private message(operation: string): string {
    return [
      `Cannot ${operation} with the ${this.id} review forge because optional adapter ${this.packageName} is not installed.`,
      ...this.setup,
      `Run qube install --review-forge ${this.id} --yes --dry-run to review the adapter-backed install plan.`,
    ].join(' ');
  }
}

export { MissingReviewForgeProvider };