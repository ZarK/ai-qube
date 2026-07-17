import type { ReviewForgePolicy } from '@tjalve/qube-core';
import type { GhExec } from '@tjalve/qube-adapter-github';
import type { ActionPlan, ActionResult } from '../core/action_plan.js';
import { createActionPlan } from '../core/action_plan.js';
import type { ExecutorPolicy } from '../core/policy.js';
import type { ResolveReviewThreadInput, ResolveReviewThreadResult, ReviewItem, ReviewItemKey } from '../core/review_item.js';
import type { ReviewProviderPlanOptions } from './review_provider.js';

import {
  MISSING_REVIEW_FORGE_CAPABILITIES,
  type CurrentReviewForge,
  type ReviewForgeCapabilities,
  type ReviewForgeLaneReviewPublishInput,
  type ReviewForgeLaneReviewPublishResult,
  type ReviewForgeLaneReviewHistory,
  type ReviewForgeLocalReviewPublishInput,
  type ReviewForgeLocalReviewPublishResult,
  type ReviewForgeProvider,
  type ReviewForgeProviderFactory,
  type ReviewForgeProviderId,
  type ReviewForgePullRequest,
  type ReviewForgeRecentPullRequestOptions,
  type ReviewForgeReviewTarget,
  type ReviewForgeSnapshot,
} from './review_forge_provider.js';

export interface ReviewForgeAdapterOptions {
  readonly exec?: GhExec;
  readonly cwd?: string;
  readonly reviewAgents?: readonly string[];
  readonly baseUrl?: string;
  readonly projectId?: string;
  /** GitHub review publisher identity config (secret references only). */
  readonly publisher?: {
    mode: 'user' | 'github-app' | 'token';
    githubApp?: {
      appId: string;
      installationId: string;
      privateKeyPath?: string;
      privateKeyEnv?: string;
      login?: string;
    };
    token?: {
      env: string;
      login?: string;
    };
  } | null;
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
  reviewStats: true,
  findCurrentBranchReview: true,
  planReviewRequests: true,
  applyReviewRequests: true,
  publishLaneReview: true,
  publishLaneReviewInline: true,
  publishLocalReview: true,
  resolveReviewThreads: true,
  ciDiagnostics: true,
});

const GITLAB_CAPABILITIES: ReviewForgeCapabilities = Object.freeze({
  loadReview: true,
  reviewStats: false,
  findCurrentBranchReview: true,
  planReviewRequests: true,
  applyReviewRequests: true,
  publishLaneReview: true,
  publishLaneReviewInline: false,
  publishLocalReview: false,
  resolveReviewThreads: true,
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
      if (loaded) return wrapAdapterReviewForgeProvider(loaded(options) as unknown as LoadedReviewForgeProvider);
      return new MissingReviewForgeProvider('github', '@tjalve/qube-adapter-github', [
        'Install the optional GitHub review-forge adapter package before selecting providers.review.kind=github.',
        'Authenticate gh for the target repository before running mutating PR review commands.',
      ]);
    },
  }),
  Object.freeze({
    id: 'gitlab',
    packageName: '@tjalve/qube-adapter-gitlab',
    installed: true,
    capabilities: GITLAB_CAPABILITIES,
    setup: Object.freeze([
      'GitLab review-forge support is available through the optional GitLab adapter package.',
      'Set GITLAB_TOKEN, GITLAB_PROJECT_ID, and optional GITLAB_BASE_URL before reading or mutating GitLab merge request review state.',
    ]),
    create: async (options: ReviewForgeAdapterOptions) => {
      const loaded = await loadOptionalAdapter('@tjalve/qube-adapter-gitlab', 'createGitLabReviewForgeProvider');
      if (loaded) return wrapAdapterReviewForgeProvider(loaded(options) as unknown as LoadedReviewForgeProvider);
      return new MissingReviewForgeProvider('gitlab', '@tjalve/qube-adapter-gitlab', [
        'Install the optional GitLab adapter package before selecting providers.review.kind=gitlab.',
        'Set GITLAB_TOKEN, GITLAB_PROJECT_ID, and optional GITLAB_BASE_URL before running GitLab merge request review commands.',
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

interface LoadedReviewForgeProvider {
  readonly id: ReviewForgeProviderId;
  capabilities(): { loadReview: boolean; findCurrentBranchReview: boolean; planReviewRequests: boolean; applyReviewRequests: boolean; publishLaneReview?: boolean; publishLaneReviewInline?: boolean; publishLocalReview?: boolean; resolveReviewThreads?: boolean };
  getReviewItem(key: ReviewItemKey): Promise<ReviewItem>;
  findReviewForCurrentBranch(): Promise<ReviewItem | null>;
  findCurrentReview(): Promise<CurrentReviewForge>;
  listRecentPullRequests?(options: ReviewForgeRecentPullRequestOptions): Promise<ReviewForgePullRequest[]>;
  loadLaneReviewHistory?(prNumber: number): Promise<ReviewForgeLaneReviewHistory>;
  loadPullRequestReview(prNumber: number): Promise<ReviewForgeSnapshot>;
  loadPullRequestReviewTarget?(prNumber: number): Promise<ReviewForgeReviewTarget>;
  planReviewRequest(item: ReviewItem, policy: ReviewForgePolicy, options?: ReviewProviderPlanOptions): ActionPlan;
  apply(plan: ActionPlan): Promise<readonly ActionResult[]>;
  publishLocalReviewFeedback?(item: ReviewItem, input: ReviewForgeLocalReviewPublishInput): Promise<ReviewForgeLocalReviewPublishResult>;
  publishLaneReviewFeedback(item: ReviewItem, input: ReviewForgeLaneReviewPublishInput): Promise<ReviewForgeLaneReviewPublishResult>;
  publishLaneReviewFeedbackForPullRequest?(input: ReviewForgeLaneReviewPublishInput): Promise<ReviewForgeLaneReviewPublishResult>;
  describeReviewPublisher?(prAuthorLogin?: string | null, options?: { mint?: boolean }): Promise<import('./review_forge_provider.js').ReviewForgePublisherIdentity>;
  resolveReviewThreads?(input: ResolveReviewThreadInput): Promise<ResolveReviewThreadResult>;
}

function toReviewForgePolicy(policy: ExecutorPolicy): ReviewForgePolicy {
  return {
    adapter: policy.reviews.adapter,
    reviewers: policy.reviews.reviewers,
    requestText: policy.reviews.requestText,
  };
}

function wrapAdapterReviewForgeProvider(provider: LoadedReviewForgeProvider): ReviewForgeProvider {
  const capabilities = provider.capabilities();
  return {
    id: provider.id,
    capabilities: () => ({
      loadReview: capabilities.loadReview,
      reviewStats: typeof provider.listRecentPullRequests === 'function' && typeof provider.loadLaneReviewHistory === 'function',
      findCurrentBranchReview: capabilities.findCurrentBranchReview,
      planReviewRequests: capabilities.planReviewRequests,
      applyReviewRequests: capabilities.applyReviewRequests,
      publishLaneReview: capabilities.publishLaneReview ?? true,
      publishLaneReviewInline: capabilities.publishLaneReviewInline ?? false,
      publishLocalReview: capabilities.publishLocalReview ?? typeof provider.publishLocalReviewFeedback === 'function',
      resolveReviewThreads: capabilities.resolveReviewThreads ?? false,
      ciDiagnostics: true,
    }),
    getReviewItem: (key) => provider.getReviewItem(key),
    findReviewForCurrentBranch: () => provider.findReviewForCurrentBranch(),
    findCurrentReview: () => provider.findCurrentReview(),
    listRecentPullRequests: provider.listRecentPullRequests
      ? (options) => provider.listRecentPullRequests!(options)
      : undefined,
    loadLaneReviewHistory: provider.loadLaneReviewHistory
      ? (prNumber) => provider.loadLaneReviewHistory!(prNumber)
      : undefined,
    loadPullRequestReview: (prNumber) => provider.loadPullRequestReview(prNumber),
    loadPullRequestReviewTarget: provider.loadPullRequestReviewTarget
      ? (prNumber) => provider.loadPullRequestReviewTarget!(prNumber)
      : undefined,
    planReviewRequest: (item, policy, options) => provider.planReviewRequest(item, toReviewForgePolicy(policy), options),
    apply: async (plan) => [...await provider.apply(plan)],
    publishLocalReviewFeedback: (item, input) => {
      if (provider.publishLocalReviewFeedback) return provider.publishLocalReviewFeedback(item, input);
      return Promise.resolve({
        status: 'disabled',
        runId: null,
        marker: null,
        body: null,
        url: null,
        failure: `${provider.id} review forge does not support local review feedback publishing.`,
        nextAction: 'Use per-lane review publishing when the adapter supports publishLaneReview, or select a review provider with publishLocalReview support.',
      });
    },
    publishLaneReviewFeedback: (item, input) => provider.publishLaneReviewFeedback(item, input),
    publishLaneReviewFeedbackForPullRequest: provider.publishLaneReviewFeedbackForPullRequest
      ? (input) => provider.publishLaneReviewFeedbackForPullRequest!(input)
      : undefined,
    describeReviewPublisher: provider.describeReviewPublisher
      ? (prAuthorLogin, options) => provider.describeReviewPublisher!(prAuthorLogin, options)
      : undefined,
    resolveReviewThreads: provider.resolveReviewThreads
      ? (input) => provider.resolveReviewThreads!(input)
      : undefined,
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
      reviewStats: MISSING_REVIEW_FORGE_CAPABILITIES.reviewStats,
      findCurrentBranchReview: MISSING_REVIEW_FORGE_CAPABILITIES.findCurrentBranchReview,
      planReviewRequests: MISSING_REVIEW_FORGE_CAPABILITIES.planReviewRequests,
      applyReviewRequests: MISSING_REVIEW_FORGE_CAPABILITIES.applyReviewRequests,
      publishLaneReview: MISSING_REVIEW_FORGE_CAPABILITIES.publishLaneReview,
      publishLaneReviewInline: MISSING_REVIEW_FORGE_CAPABILITIES.publishLaneReviewInline,
      resolveReviewThreads: MISSING_REVIEW_FORGE_CAPABILITIES.resolveReviewThreads,
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

  async loadPullRequestReviewTarget(_prNumber: number): Promise<ReviewForgeReviewTarget> {
    throw this.error('load pull request review target');
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

  async publishLaneReviewFeedbackForPullRequest(_input: ReviewForgeLaneReviewPublishInput): Promise<ReviewForgeLaneReviewPublishResult> {
    throw this.error('publish lane review feedback');
  }

  async resolveReviewThreads(_input: ResolveReviewThreadInput): Promise<ResolveReviewThreadResult> {
    throw this.error('resolve review threads');
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
