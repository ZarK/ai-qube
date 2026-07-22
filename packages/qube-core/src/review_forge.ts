import type { ActionPlan, ActionResult } from "./action_plan.js";
import type { ResolveReviewThreadInput, ResolveReviewThreadResult, ReviewItem, ReviewItemKey } from "./review_item.js";

export type ReviewForgeAdapterKind = "github" | "remote" | "local" | "mixed" | "shadow";
export type ReviewAdapterKind = ReviewForgeAdapterKind;
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
  readonly reviewStats?: boolean;
  readonly findCurrentBranchReview: boolean;
  readonly planReviewRequests: boolean;
  readonly applyReviewRequests: boolean;
  readonly publishLaneReview?: boolean;
  readonly publishLaneReviewInline?: boolean;
  readonly publishLocalReview?: boolean;
  readonly resolveReviewThreads?: boolean;
  readonly ciDiagnostics?: boolean;
}

export interface ReviewForgePullRequest {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly url: string;
  readonly headRefOid: string;
  readonly authorLogin?: string | null;
  readonly reviewDecision: string;
  readonly mergeStateStatus: string;
  readonly mergeable: string;
  readonly isDraft: boolean;
  readonly closedAt?: string | null;
}

export interface ReviewForgeRecentPullRequestOptions {
  readonly limit: number;
}

export interface ReviewForgeLaneReviewHistory {
  readonly trustedLaneReviews: unknown;
  readonly unavailableReason: string | null;
}

export type ReviewFindingSeverity = "blocking" | "advisory";
export type ReviewFindingSide = "source" | "destination";

export interface ReviewFindingLocation {
  readonly path: string;
  readonly line?: number;
  readonly endLine?: number;
  readonly side?: ReviewFindingSide;
}

export interface ReviewFinding {
  readonly id: string;
  readonly severity: ReviewFindingSeverity;
  readonly location?: ReviewFindingLocation;
  readonly message: string;
  readonly suggestion?: string;
  readonly confidence?: number;
}

export interface ReviewDiffIndex {
  hasLine(path: string, line: number, side?: ReviewFindingSide): boolean;
}

export interface PartitionedReviewFindings {
  readonly inline: readonly ReviewFinding[];
  readonly body: readonly ReviewFinding[];
}

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized === "") throw new Error(`${field} must be a non-empty string.`);
  return normalized;
}

function stableFindingId(input: Omit<ReviewFinding, "id"> & { id?: string }): string {
  const base = [
    input.severity,
    input.location?.path ?? "",
    input.location?.line ?? "",
    input.location?.endLine ?? "",
    input.location?.side ?? "",
    input.message,
  ].join("\0");
  let hash = 0;
  for (let index = 0; index < base.length; index += 1) {
    hash = Math.imul(31, hash) + base.charCodeAt(index) | 0;
  }
  return `finding-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validConfidence(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function normalizeReviewFinding(input: Omit<ReviewFinding, "id"> & { readonly id?: string }): ReviewFinding {
  const message = nonEmpty(input.message, "message");
  const severity = input.severity === "blocking" ? "blocking" : "advisory";
  let location: ReviewFindingLocation | undefined;
  if (input.location) {
    const path = nonEmpty(input.location.path, "location.path");
    const line = positiveInteger(input.location.line) ? input.location.line : undefined;
    const endLine = positiveInteger(input.location.endLine) ? input.location.endLine : undefined;
    const side = input.location.side === "source" ? "source" : "destination";
    location = { path, ...(line ? { line } : {}), ...(endLine ? { endLine } : {}), side };
  }
  const suggestion = typeof input.suggestion === "string" && input.suggestion.trim() !== "" ? input.suggestion.trim() : undefined;
  const confidence = validConfidence(input.confidence) ? input.confidence : undefined;
  return {
    id: typeof input.id === "string" && input.id.trim() !== "" ? input.id.trim() : stableFindingId({ severity, location, message, suggestion }),
    severity,
    ...(location ? { location } : {}),
    message,
    ...(suggestion ? { suggestion } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
  };
}

export function partitionReviewFindings(findings: readonly ReviewFinding[], diffIndex: ReviewDiffIndex): PartitionedReviewFindings {
  const inline: ReviewFinding[] = [];
  const body: ReviewFinding[] = [];
  for (const finding of findings.map(normalizeReviewFinding)) {
    const location = finding.location;
    const line = location?.line;
    if (location && typeof line === "number" && diffIndex.hasLine(location.path, line, location.side ?? "destination")) {
      inline.push(finding);
    } else {
      body.push(finding);
    }
  }
  return { inline, body };
}

export interface ReviewLaneReviewPublishInput {
  readonly dryRun: boolean;
  readonly prNumber: number;
  readonly headSha: string;
  readonly lane: string;
  readonly expectedLanes: readonly string[];
  readonly profile: string;
  readonly status: string;
  readonly recommendation: "approve" | "request-changes" | "pending" | "inconclusive";
  readonly host: string;
  readonly issueNumber: number;
  readonly summary: string;
  readonly findings: readonly (ReviewFinding | string)[];
  readonly completeness: string | null;
  readonly evidencePath: string | null;
}

export interface ReviewLaneReviewPublishResult {
  readonly status: "disabled" | "pending" | "planned" | "published" | "skipped" | "failed";
  readonly runId: string | null;
  readonly marker: string | null;
  readonly body: string | null;
  readonly url: string | null;
  readonly publishKind?: "issue-comment" | "pull-request-review";
  readonly inlineCommentCount?: number;
  readonly bodyFindingCount?: number;
  readonly reviewUrl?: string | null;
  readonly inlineCommentUrls?: readonly string[];
  readonly failure: string | null;
  readonly nextAction: string;
}

export interface ReviewForgeProvider {
  readonly id: string;
  capabilities(): ReviewForgeCapabilities;
  getReviewItem(key: ReviewItemKey): Promise<ReviewItem>;
  findReviewForCurrentBranch(): Promise<ReviewItem | null>;
  loadReviewSnapshot(key: ReviewItemKey): Promise<ReviewForgeSnapshot>;
  listRecentPullRequests?(options: ReviewForgeRecentPullRequestOptions): Promise<readonly ReviewForgePullRequest[]>;
  loadLaneReviewHistory?(prNumber: number): Promise<ReviewForgeLaneReviewHistory>;
  planReviewRequest(item: ReviewItem, policy: ReviewForgePolicy, options?: ReviewForgePlanOptions): ActionPlan;
  apply(plan: ActionPlan): Promise<readonly ActionResult[]>;
  publishLaneReviewFeedback?(item: ReviewItem, input: ReviewLaneReviewPublishInput): Promise<ReviewLaneReviewPublishResult>;
  resolveReviewThreads?(input: ResolveReviewThreadInput): Promise<ResolveReviewThreadResult>;
}

export interface ReviewForgeStatsCapability {
  capabilities(): ReviewForgeCapabilities & { readonly reviewStats: true };
  listRecentPullRequests(options: ReviewForgeRecentPullRequestOptions): Promise<readonly ReviewForgePullRequest[]>;
  loadLaneReviewHistory(prNumber: number): Promise<ReviewForgeLaneReviewHistory>;
}

export interface ReviewForgeStatsProvider extends ReviewForgeProvider {
  capabilities(): ReviewForgeCapabilities & { readonly reviewStats: true };
  listRecentPullRequests(options: ReviewForgeRecentPullRequestOptions): Promise<readonly ReviewForgePullRequest[]>;
  loadLaneReviewHistory(prNumber: number): Promise<ReviewForgeLaneReviewHistory>;
}

export function supportsReviewStats<T extends {
  capabilities(): { readonly reviewStats?: boolean };
  readonly listRecentPullRequests?: unknown;
  readonly loadLaneReviewHistory?: unknown;
}>(provider: T): provider is T & ReviewForgeStatsCapability {
  return provider.capabilities().reviewStats === true
    && typeof provider.listRecentPullRequests === "function"
    && typeof provider.loadLaneReviewHistory === "function";
}
