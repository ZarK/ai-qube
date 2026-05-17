import type { GateEvidence } from './gate_evidence';
import { normalizeGateEvidence } from './gate_evidence';
import type { JsonObject } from './json_value';
import type { ProviderSource } from './provider_source';
import type { WorkItemKey } from './work_item';
import { uniqueWorkItemKeys } from './work_item';

export type ReviewState = 'open' | 'closed' | 'merged' | 'draft' | 'unknown';
export type ReviewDecision = 'approved' | 'changes-requested' | 'review-required' | 'commented' | 'none' | 'unknown';
export type Mergeability = 'mergeable' | 'blocked' | 'conflicting' | 'unknown';
export type ReviewFeedbackSource = 'review' | 'comment' | 'review-comment' | 'thread' | 'provider';
export type FeedbackTrust = 'untrusted' | 'trusted-provider';

export interface ReviewItemKey {
  providerId: string;
  id: string;
}

export interface ReviewFeedback {
  source: ReviewFeedbackSource;
  author: string;
  summary: string;
  url: string | null;
  state: string | null;
  trust: FeedbackTrust;
}

export interface ReviewItem {
  key: ReviewItemKey;
  displayId: string;
  title: string;
  url: string | null;
  sourceRef: string;
  targetRef: string;
  linkedWorkItems: WorkItemKey[];
  state: ReviewState;
  reviewDecision: ReviewDecision;
  mergeability: Mergeability;
  feedback: ReviewFeedback[];
  checks: GateEvidence[];
  trustedMetadata: JsonObject;
  source: ProviderSource;
}

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized === '') throw new Error(`${field} must be a non-empty string.`);
  return normalized;
}

export function normalizeReviewItemKey(providerId: string, id: string): ReviewItemKey {
  return { providerId: nonEmpty(providerId, 'providerId'), id: nonEmpty(id, 'id') };
}

export function normalizeReviewFeedback(input: Omit<ReviewFeedback, 'trust'> & { trust?: FeedbackTrust }): ReviewFeedback {
  return {
    ...input,
    author: nonEmpty(input.author, 'author'),
    summary: nonEmpty(input.summary, 'summary'),
    trust: input.trust ?? 'untrusted',
  };
}

export function normalizeReviewItem(input: Omit<ReviewItem, 'linkedWorkItems' | 'feedback' | 'checks' | 'trustedMetadata'> & {
  linkedWorkItems?: WorkItemKey[];
  feedback?: Array<Omit<ReviewFeedback, 'trust'> & { trust?: FeedbackTrust }>;
  checks?: GateEvidence[];
  trustedMetadata?: JsonObject;
}): ReviewItem {
  return {
    ...input,
    key: normalizeReviewItemKey(input.key.providerId, input.key.id),
    displayId: nonEmpty(input.displayId, 'displayId'),
    title: nonEmpty(input.title, 'title'),
    sourceRef: nonEmpty(input.sourceRef, 'sourceRef'),
    targetRef: nonEmpty(input.targetRef, 'targetRef'),
    linkedWorkItems: uniqueWorkItemKeys(input.linkedWorkItems ?? []),
    feedback: (input.feedback ?? []).map(normalizeReviewFeedback),
    checks: (input.checks ?? []).map(normalizeGateEvidence),
    trustedMetadata: input.trustedMetadata ?? {},
  };
}
