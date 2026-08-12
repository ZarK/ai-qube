import type { ReviewItem } from '@tjalve/qube-core';
import type { ReviewSourceConfig } from './config/index.js';
import { participantReviewerId } from './core/review_participant.js';

export type ProviderFindingTrust = 'trusted-provider' | 'untrusted';

export interface ProviderReviewFinding {
  readonly sourceId: string;
  readonly reviewerHandle: string;
  readonly trust: ProviderFindingTrust;
  readonly severity: 'blocking' | 'advisory';
  readonly message: string;
  readonly location: { path: string; line: number | null } | null;
  readonly url: string | null;
}

function reviewerSources(sources: readonly ReviewSourceConfig[]): ReadonlyMap<string, ReviewSourceConfig> {
  const byReviewerId = new Map<string, ReviewSourceConfig>();
  for (const source of sources) {
    if (!source.enabled || source.identity !== 'reviewer') continue;
    for (const name of source.expected) {
      const id = participantReviewerId(name);
      // First configured source wins an author id collision; every downstream
      // consumer reads one deterministic attribution per reviewer.
      if (!byReviewerId.has(id)) byReviewerId.set(id, source);
    }
  }
  return byReviewerId;
}

function trustFor(source: ReviewSourceConfig): ProviderFindingTrust {
  return source.markers === 'trusted' ? 'trusted-provider' : 'untrusted';
}

const MAX_FINDING_MESSAGE_LENGTH = 2000;

// External reviewer text is untrusted task input: collapsing it to a single
// line strips any multi-line prompt structure (fake headers, code fences,
// role markers) an author could shape to look like instructions, and bounding
// its length keeps one oversized comment from dominating the fix batch or a
// downstream prompt. The text itself is never parsed for directives; it is
// carried through as opaque finding data.
function sanitizeFindingMessage(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_FINDING_MESSAGE_LENGTH ? `${collapsed.slice(0, MAX_FINDING_MESSAGE_LENGTH)}...` : collapsed;
}

/**
 * Reads provider-visible feedback from configured `identity: 'reviewer'`
 * review sources at the current head into normalized findings for fix-batch
 * aggregation, ship-ready checks, and advisory triage. Only feedback and
 * unresolved conversations authored by a configured reviewer are ingested;
 * unrecognized commenters never enter the fix loop. Severity mirrors the
 * provider's own merge-blocking signal: an unresolved review conversation or
 * a CHANGES_REQUESTED review is blocking, everything else is advisory. This
 * is untrusted task input distinct from the trusted structured lane markers
 * `identity: 'lane'` sources already carry through the review participant
 * model; local evidence remains the source of truth for lane findings.
 */
export function ingestProviderReviewFindings(item: ReviewItem, sources: readonly ReviewSourceConfig[]): ProviderReviewFinding[] {
  const byReviewerId = reviewerSources(sources);
  if (byReviewerId.size === 0) return [];
  const findings: ProviderReviewFinding[] = [];
  const seen = new Set<string>();
  const push = (finding: ProviderReviewFinding, dedupeKey: string) => {
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    findings.push(finding);
  };

  for (const entry of item.feedback) {
    if (entry.source !== 'review' && entry.source !== 'comment') continue;
    const source = byReviewerId.get(participantReviewerId(entry.author));
    if (!source) continue;
    const severity = entry.state === 'CHANGES_REQUESTED' ? 'blocking' : 'advisory';
    push({
      sourceId: source.id,
      reviewerHandle: entry.author,
      trust: trustFor(source),
      severity,
      message: sanitizeFindingMessage(entry.summary),
      location: null,
      url: entry.url,
    }, `${source.id}|${severity}|${entry.summary}|${entry.url ?? ''}`);
  }

  for (const conversation of item.conversations) {
    if (conversation.resolved || conversation.outdated) continue;
    const source = byReviewerId.get(participantReviewerId(conversation.author));
    if (!source) continue;
    push({
      sourceId: source.id,
      reviewerHandle: conversation.author,
      trust: trustFor(source),
      severity: 'blocking',
      message: sanitizeFindingMessage(conversation.summary),
      location: conversation.path ? { path: conversation.path, line: conversation.line } : null,
      url: conversation.url,
    }, `${source.id}|blocking|${conversation.summary}|${conversation.path ?? ''}|${conversation.line ?? ''}`);
  }

  return findings;
}
