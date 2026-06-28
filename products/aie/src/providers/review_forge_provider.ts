import type { GhExec } from '../gh.js';
import type { ActionPlan, ActionResult } from '../core/action_plan.js';
import type { ExecutorPolicy } from '../core/policy.js';
import type { ReviewItem, ReviewItemKey } from '../core/review_item.js';
import type {
  ReviewLaneReviewPublishInput,
  ReviewLaneReviewPublishResult,
  ReviewProviderPlanOptions,
} from './review_provider.js';

export type ReviewForgeProviderId = 'github';

export interface ReviewForgeProviderOptions {
  readonly exec?: GhExec;
  readonly cwd?: string;
}

export interface ReviewForgePullRequest {
  number: number;
  title: string;
  state: string;
  url: string;
  headRefOid: string;
  reviewDecision: string;
  mergeStateStatus: string;
  mergeable: string;
  isDraft: boolean;
}

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
  unavailable: string[];
}

export interface ReviewForgeReviewTarget {
  pr: ReviewForgePullRequest;
  closingIssueNumbers: number[];
}

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
  findings: string[];
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

export interface ReviewForgeLaneReviewPublishResult extends ReviewLaneReviewPublishResult {}

export interface ReviewForgeProviderCapabilities {
  loadReview: boolean;
  findCurrentBranchReview: boolean;
  planReviewRequests: boolean;
  applyReviewRequests: boolean;
  publishLaneReview?: boolean;
  publishLocalReview?: boolean;
}

export interface ReviewForgeProvider {
  readonly id: ReviewForgeProviderId;
  capabilities(): ReviewForgeProviderCapabilities;
  getReviewItem(key: ReviewItemKey): Promise<ReviewItem>;
  findReviewForCurrentBranch(): Promise<ReviewItem | null>;
  findCurrentReview(): Promise<CurrentReviewForge>;
  loadPullRequestReview(prNumber: number): Promise<ReviewForgeSnapshot>;
  loadPullRequestReviewTarget?(prNumber: number): Promise<ReviewForgeReviewTarget>;
  planReviewRequest(item: ReviewItem, policy: ExecutorPolicy, options?: ReviewProviderPlanOptions): ActionPlan;
  apply(plan: ActionPlan): Promise<ActionResult[]>;
  publishLocalReviewFeedback(item: ReviewItem, input: ReviewForgeLocalReviewPublishInput): Promise<ReviewForgeLocalReviewPublishResult>;
  publishLaneReviewFeedback(item: ReviewItem, input: ReviewForgeLaneReviewPublishInput): Promise<ReviewForgeLaneReviewPublishResult>;
  publishLaneReviewFeedbackForPullRequest?(input: ReviewForgeLaneReviewPublishInput): Promise<ReviewForgeLaneReviewPublishResult>;
}

export interface ReviewForgeCapabilities {
  loadReview: boolean;
  findCurrentBranchReview: boolean;
  planReviewRequests: boolean;
  applyReviewRequests: boolean;
  publishLaneReview: boolean;
  publishLocalReview: boolean;
  ciDiagnostics: boolean;
}

export const MISSING_REVIEW_FORGE_CAPABILITIES: ReviewForgeCapabilities = Object.freeze({
  loadReview: false,
  findCurrentBranchReview: false,
  planReviewRequests: false,
  applyReviewRequests: false,
  publishLaneReview: false,
  publishLocalReview: false,
  ciDiagnostics: false,
});

export type ReviewForgeProviderFactory = (options: ReviewForgeProviderOptions) => ReviewForgeProvider;
