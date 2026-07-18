import type { GhExec } from '@tjalve/qube-adapter-github';
import type {
  ReviewFinding,
  ReviewForgeLaneReviewHistory as CoreReviewForgeLaneReviewHistory,
  ReviewForgePullRequest as CoreReviewForgePullRequest,
  ReviewForgeRecentPullRequestOptions as CoreReviewForgeRecentPullRequestOptions,
} from '@tjalve/qube-core';
import type { ActionPlan, ActionResult } from '../core/action_plan.js';
import type { ExecutorPolicy } from '../core/policy.js';
import type { ResolveReviewThreadInput, ResolveReviewThreadResult, ReviewItem, ReviewItemKey } from '../core/review_item.js';
import type {
  ReviewLaneReviewPublishInput,
  ReviewLaneReviewPublishResult,
  ReviewProviderPlanOptions,
} from './review_provider.js';

export type ReviewForgeProviderId = 'github' | 'gitlab';

export interface ReviewForgeProviderOptions {
  readonly exec?: GhExec;
  readonly cwd?: string;
}

export type ReviewForgePullRequest = CoreReviewForgePullRequest;
export type ReviewForgeLaneReviewHistory = CoreReviewForgeLaneReviewHistory;

export interface ReviewForgeCiDiagnostic {
  checkName: string;
  status: string;
  reasonCode: string;
  currentHeadSha: string;
  mappedToCurrentHeadCheckRun: boolean;
  mappedToCurrentHeadWorkflowRun: boolean;
  currentHeadSuiteIds: string[];
  currentHeadRunIds: string[];
  staleRunIds: string[];
  workflowDispatchSupported: boolean | null;
  summary: string;
  nextAction: string;
}

export interface ReviewForgeSnapshot {
  item: ReviewItem;
  pr: ReviewForgePullRequest;
  ciDiagnostics: ReviewForgeCiDiagnostic[];
  closingIssueNumbers: number[];
  reviewRequests: string[];
  commentsCount: number;
  reviewsCount: number;
  reviewCommentsCount: number;
  unresolvedThreadsCount: number;
  conversationsCount?: number;
  unavailable: string[];
}

export interface ReviewForgeReviewTarget {
  pr: ReviewForgePullRequest;
  closingIssueNumbers: number[];
}

export type ReviewForgeRecentPullRequestOptions = CoreReviewForgeRecentPullRequestOptions;

export interface CurrentReviewForge {
  item: ReviewItem | null;
  pr: ReviewForgePullRequest | null;
  warning: string | null;
}

export type ReviewForgeLocalReviewRecommendation = 'approve' | 'request-changes' | 'pending' | 'inconclusive';
export type ReviewForgeLocalReviewPublishStatus = 'disabled' | 'pending' | 'planned' | 'published' | 'skipped' | 'failed';

export interface ReviewForgeLocalReviewPublishInput {
  enabled: boolean;
  dryRun: boolean;
  prNumber: number;
  headSha: string;
  profile: string;
  status: string;
  recommendation: ReviewForgeLocalReviewRecommendation;
  runner: string;
  host: string;
  evidencePath: string | null;
  issueNumbers: number[];
  lanes: string[];
  summary: string;
  findings: Array<ReviewFinding | string>;
}

export interface ReviewForgeLocalReviewPublishResult {
  status: ReviewForgeLocalReviewPublishStatus;
  runId: string | null;
  marker: string | null;
  body: string | null;
  url: string | null;
  failure: string | null;
  nextAction: string;
}

export interface ReviewForgeLaneReviewPublishInput extends ReviewLaneReviewPublishInput {}

export interface ReviewForgeLaneReviewPublishResult extends ReviewLaneReviewPublishResult {
  publisher?: ReviewForgePublisherIdentity;
}

export interface ReviewForgePublisherIdentity {
  mode: 'user' | 'github-app' | 'token';
  identityClass: 'user' | 'github-app-installation' | 'fine-grained-token' | 'none';
  login: string | null;
  permissionStatus: 'ok' | 'missing' | 'unknown' | 'same-author' | 'unconfigured' | 'misconfigured';
  formalEventCapability: boolean;
  fallbackReason: string | null;
  publishTransport: 'pull-request-review' | 'issue-comment';
  authSource: 'gh-user' | 'github-app-installation' | 'token-env' | 'none';
}

export interface ReviewForgeProviderCapabilities {
  loadReview: boolean;
  reviewStats: boolean;
  findCurrentBranchReview: boolean;
  planReviewRequests: boolean;
  applyReviewRequests: boolean;
  publishLaneReview?: boolean;
  publishLaneReviewInline?: boolean;
  publishLocalReview?: boolean;
  resolveReviewThreads?: boolean;
}

export interface ReviewForgeProvider {
  readonly id: ReviewForgeProviderId;
  capabilities(): ReviewForgeProviderCapabilities;
  getReviewItem(key: ReviewItemKey): Promise<ReviewItem>;
  findReviewForCurrentBranch(): Promise<ReviewItem | null>;
  findCurrentReview(): Promise<CurrentReviewForge>;
  listRecentPullRequests?(options: ReviewForgeRecentPullRequestOptions): Promise<readonly ReviewForgePullRequest[]>;
  loadLaneReviewHistory?(prNumber: number): Promise<ReviewForgeLaneReviewHistory>;
  loadPullRequestReview(prNumber: number): Promise<ReviewForgeSnapshot>;
  loadPullRequestReviewTarget?(prNumber: number): Promise<ReviewForgeReviewTarget>;
  planReviewRequest(item: ReviewItem, policy: ExecutorPolicy, options?: ReviewProviderPlanOptions): ActionPlan;
  apply(plan: ActionPlan): Promise<ActionResult[]>;
  publishLocalReviewFeedback(item: ReviewItem, input: ReviewForgeLocalReviewPublishInput): Promise<ReviewForgeLocalReviewPublishResult>;
  publishLaneReviewFeedback(item: ReviewItem, input: ReviewForgeLaneReviewPublishInput): Promise<ReviewForgeLaneReviewPublishResult>;
  publishLaneReviewFeedbackForPullRequest?(input: ReviewForgeLaneReviewPublishInput): Promise<ReviewForgeLaneReviewPublishResult>;
  describeReviewPublisher?(prAuthorLogin?: string | null, options?: { mint?: boolean }): Promise<ReviewForgePublisherIdentity>;
  resolveReviewThreads?(input: ResolveReviewThreadInput): Promise<ResolveReviewThreadResult>;
}

export interface ReviewForgeCapabilities {
  loadReview: boolean;
  reviewStats: boolean;
  findCurrentBranchReview: boolean;
  planReviewRequests: boolean;
  applyReviewRequests: boolean;
  publishLaneReview: boolean;
  publishLaneReviewInline: boolean;
  publishLocalReview: boolean;
  resolveReviewThreads: boolean;
  ciDiagnostics: boolean;
}

export const MISSING_REVIEW_FORGE_CAPABILITIES: ReviewForgeCapabilities = Object.freeze({
  loadReview: false,
  reviewStats: false,
  findCurrentBranchReview: false,
  planReviewRequests: false,
  applyReviewRequests: false,
  publishLaneReview: false,
  publishLaneReviewInline: false,
  publishLocalReview: false,
  resolveReviewThreads: false,
  ciDiagnostics: false,
});

export type ReviewForgeProviderFactory = (options: ReviewForgeProviderOptions) => ReviewForgeProvider;
