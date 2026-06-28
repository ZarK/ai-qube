import type { ActionPlan, ActionResult } from '../core/action_plan.js';
import type { ExecutorPolicy } from '../core/policy.js';
import type { ReviewItem, ReviewItemKey } from '../core/review_item.js';

export interface ReviewProviderCapabilities {
  loadReview: boolean;
  findCurrentBranchReview: boolean;
  planReviewRequests: boolean;
  applyReviewRequests: boolean;
  publishLaneReview?: boolean;
}

export interface ReviewLaneReviewPublishInput {
  dryRun: boolean;
  prNumber: number;
  headSha: string;
  lane: string;
  profile: string;
  status: string;
  recommendation: 'approve' | 'request-changes' | 'pending' | 'inconclusive';
  host: string;
  issueNumber: number;
  summary: string;
  findings: string[];
  evidencePath: string | null;
}

export interface ReviewLaneReviewPublishResult {
  status: 'disabled' | 'pending' | 'planned' | 'published' | 'skipped' | 'failed';
  runId: string | null;
  marker: string | null;
  body: string | null;
  url: string | null;
  failure: string | null;
  nextAction: string;
}

export interface ReviewProviderPlanOptions {
  activeLanes?: readonly string[];
}

export interface ReviewProvider {
  readonly id: string;
  capabilities(): ReviewProviderCapabilities;
  getReviewItem(key: ReviewItemKey): Promise<ReviewItem>;
  findReviewForCurrentBranch(): Promise<ReviewItem | null>;
  planReviewRequest(item: ReviewItem, policy: ExecutorPolicy, options?: ReviewProviderPlanOptions): ActionPlan;
  apply(plan: ActionPlan): Promise<ActionResult[]>;
  publishLaneReviewFeedback?(item: ReviewItem, input: ReviewLaneReviewPublishInput): Promise<ReviewLaneReviewPublishResult>;
}
