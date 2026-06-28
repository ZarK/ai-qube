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

export function normalizeReviewItem(
  input: Omit<ReviewItem, "linkedWorkItems" | "feedback" | "checks" | "trustedMetadata"> & {
    readonly linkedWorkItems?: readonly WorkItemKey[];
    readonly feedback?: ReadonlyArray<Omit<ReviewFeedback, "trust"> & { trust?: FeedbackTrust }>;
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
    checks: (input.checks ?? []).map(normalizeGateEvidence),
    trustedMetadata: input.trustedMetadata ?? {},
  };
}