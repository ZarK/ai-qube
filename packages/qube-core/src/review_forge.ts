import type { ActionPlan, ActionResult } from "./index.js";
import type { ResolveReviewThreadInput, ResolveReviewThreadResult, ReviewItem, ReviewItemKey } from "./review_item.js";

export type ReviewForgeAdapterKind = "github" | "remote" | "local" | "mixed" | "shadow";
export type ReviewRequestTrigger = "github-reviewer" | "comment";

export interface ReviewForgePolicy {
  readonly adapter: ReviewForgeAdapterKind;
  readonly reviewers: readonly string[];
  readonly requestText: string;
}

export interface ReviewAgentCommentBody {
  readonly body: string;
  readonly marker: string;
}

export interface ReviewAgentAdapter {
  readonly id: string;
  readonly aliases: readonly string[];
  matches(name: string): boolean;
  triggerFor(name: string): ReviewRequestTrigger;
  commentBodyFor(name: string, policy: ReviewForgePolicy, headSha: string): ReviewAgentCommentBody;
  reviewerMarkerBodyFor(name: string, headSha: string): ReviewAgentCommentBody;
  isCopilotOverview(normalizedText: string, authorLogin?: string | null): boolean;
  isNonActionableSummary(text: string | undefined, authorLogin?: string | null): boolean;
  sanitizeFeedbackText(text: string | undefined): string;
}

export interface ReviewForgeSnapshot {
  readonly item: ReviewItem;
  readonly unavailable: readonly string[];
}

export interface ReviewForgePlanOptions {
  readonly activeLanes?: readonly string[];
}

export interface ReviewForgeCapabilities {
  readonly loadReview: boolean;
  readonly loadReviewSnapshot: boolean;
  readonly findCurrentBranchReview: boolean;
  readonly planReviewRequests: boolean;
  readonly applyReviewRequests: boolean;
  readonly publishLaneReview?: boolean;
  readonly publishLaneReviewInline?: boolean;
  readonly resolveReviewThreads?: boolean;
}

export interface ReviewForgeProvider {
  readonly id: string;
  capabilities(): ReviewForgeCapabilities;
  getReviewItem(key: ReviewItemKey): Promise<ReviewItem>;
  findReviewForCurrentBranch(): Promise<ReviewItem | null>;
  loadReviewSnapshot(key: ReviewItemKey): Promise<ReviewForgeSnapshot>;
  planReviewRequest(item: ReviewItem, policy: ReviewForgePolicy, options?: ReviewForgePlanOptions): ActionPlan;
  apply(plan: ActionPlan): Promise<readonly ActionResult[]>;
  resolveReviewThreads?(input: ResolveReviewThreadInput): Promise<ResolveReviewThreadResult>;
}
