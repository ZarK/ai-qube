import type { ActionPlan, ActionResult } from '../core/action_plan';
import type { ExecutorPolicy } from '../core/policy';
import type { ReviewItem, ReviewItemKey } from '../core/review_item';

export interface ReviewProviderCapabilities {
  loadReview: boolean;
  findCurrentBranchReview: boolean;
  planReviewRequests: boolean;
  applyReviewRequests: boolean;
}

export interface ReviewProvider {
  readonly id: 'github';
  capabilities(): ReviewProviderCapabilities;
  getReviewItem(key: ReviewItemKey): Promise<ReviewItem>;
  findReviewForCurrentBranch(): Promise<ReviewItem | null>;
  planReviewRequest(item: ReviewItem, policy: ExecutorPolicy): ActionPlan;
  apply(plan: ActionPlan): Promise<ActionResult[]>;
}
