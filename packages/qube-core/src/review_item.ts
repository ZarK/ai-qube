import type { GateEvidence } from "./gate_evidence.js";
import { normalizeGateEvidence } from "./gate_evidence.js";
import type { JsonObject } from "./json_value.js";
import type { ProviderResourceKind, ProviderSource } from "./provider_source.js";
import type { WorkItemKey } from "./work_item_key.js";
import { uniqueWorkItemKeys } from "./work_item_key.js";

export type ReviewState = "open" | "closed" | "merged" | "draft" | "unknown";
export type ReviewDecision = "approved" | "changes-requested" | "review-required" | "commented" | "none" | "unknown";
export type Mergeability = "mergeable" | "blocked" | "conflicting" | "unknown";
export type ReviewFeedbackSource = "review" | "comment" | "review-comment" | "thread" | "provider";
export type FeedbackTrust = "untrusted" | "trusted-provider";

export interface ReviewItemKey {
  readonly providerId: string;
  readonly id: string;
}

export interface ReviewFeedback {
  readonly source: ReviewFeedbackSource;
  readonly author: string;
  readonly summary: string;
  readonly url: string | null;
  readonly state: string | null;
  readonly trust: FeedbackTrust;
}

export type ReviewMergeBlockReason =
  | "unresolved-review-thread"
  | "review-required"
  | "changes-requested"
  | "checks-pending"
  | "checks-failed"
  | "draft"
  | "merge-state-blocked"
  | "conflict"
  | "unknown";

export interface ReviewMergeBlock {
  readonly reason: ReviewMergeBlockReason;
  readonly summary: string;
  readonly url: string | null;
}

export interface ReviewConversation {
  readonly providerId: string;
  readonly id: string;
  readonly resolved: boolean;
  readonly outdated: boolean;
  readonly viewerCanResolve: boolean;
  readonly path: string | null;
  readonly line: number | null;
  readonly originalLine: number | null;
  readonly author: string;
  readonly summary: string;
  readonly url: string | null;
}

export interface ResolveReviewThreadInput {
  readonly prNumber: number;
  readonly threadIds: readonly string[];
  readonly dryRun: boolean;
}

export interface ResolveReviewThreadResult {
  readonly status: "planned" | "resolved" | "skipped" | "failed";
  readonly prNumber: number;
  readonly resolvedThreadIds: readonly string[];
  readonly skippedThreadIds: readonly string[];
  readonly failedThreadIds: readonly string[];
  readonly nextAction: string;
}

export interface ReviewItem {
  readonly key: ReviewItemKey;
  readonly displayId: string;
  readonly title: string;
  readonly url: string | null;
  readonly sourceRef: string;
  readonly targetRef: string;
  readonly linkedWorkItems: readonly WorkItemKey[];
  readonly state: ReviewState;
  readonly reviewDecision: ReviewDecision;
  readonly mergeability: Mergeability;
  readonly feedback: readonly ReviewFeedback[];
  readonly mergeBlockers: readonly ReviewMergeBlock[];
  readonly conversations: readonly ReviewConversation[];
  readonly checks: readonly GateEvidence[];
  readonly trustedMetadata: JsonObject;
  readonly source: ProviderSource;
}

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized === "") throw new Error(`${field} must be a non-empty string.`);
  return normalized;
}

export function normalizeReviewItemKey(providerId: string, id: string): ReviewItemKey {
  return { providerId: nonEmpty(providerId, "providerId"), id: nonEmpty(id, "id") };
}

export function normalizeReviewFeedback(
  input: Omit<ReviewFeedback, "trust"> & { trust?: FeedbackTrust },
): ReviewFeedback {
  return {
    ...input,
    author: nonEmpty(input.author, "author"),
    summary: nonEmpty(input.summary, "summary"),
    trust: input.trust ?? "untrusted",
  };
}

function normalizeReviewMergeBlock(input: ReviewMergeBlock): ReviewMergeBlock {
  return {
    reason: input.reason,
    summary: nonEmpty(input.summary, "mergeBlock.summary"),
    url: input.url,
  };
}

function normalizeReviewConversation(input: ReviewConversation): ReviewConversation {
  return {
    providerId: nonEmpty(input.providerId, "conversation.providerId"),
    id: nonEmpty(input.id, "conversation.id"),
    resolved: input.resolved,
    outdated: input.outdated,
    viewerCanResolve: input.viewerCanResolve,
    path: input.path,
    line: input.line,
    originalLine: input.originalLine,
    author: nonEmpty(input.author, "conversation.author"),
    summary: nonEmpty(input.summary, "conversation.summary"),
    url: input.url,
  };
}

export function normalizeReviewItem(
  input: Omit<ReviewItem, "linkedWorkItems" | "feedback" | "mergeBlockers" | "conversations" | "checks" | "trustedMetadata"> & {
    readonly linkedWorkItems?: readonly WorkItemKey[];
    readonly feedback?: ReadonlyArray<Omit<ReviewFeedback, "trust"> & { trust?: FeedbackTrust }>;
    readonly mergeBlockers?: readonly ReviewMergeBlock[];
    readonly conversations?: readonly ReviewConversation[];
    readonly checks?: readonly GateEvidence[];
    readonly trustedMetadata?: JsonObject;
  },
): ReviewItem {
  return {
    ...input,
    key: normalizeReviewItemKey(input.key.providerId, input.key.id),
    displayId: nonEmpty(input.displayId, "displayId"),
    title: nonEmpty(input.title, "title"),
    sourceRef: nonEmpty(input.sourceRef, "sourceRef"),
    targetRef: nonEmpty(input.targetRef, "targetRef"),
    linkedWorkItems: uniqueWorkItemKeys(input.linkedWorkItems ?? []),
    feedback: (input.feedback ?? []).map(normalizeReviewFeedback),
    mergeBlockers: (input.mergeBlockers ?? []).map(normalizeReviewMergeBlock),
    conversations: (input.conversations ?? []).map(normalizeReviewConversation),
    checks: (input.checks ?? []).map(normalizeGateEvidence),
    trustedMetadata: input.trustedMetadata ?? {},
  };
}
