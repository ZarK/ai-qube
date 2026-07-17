import type { LocalReviewLaneId, LocalReviewProfile } from './local_review_evidence.js';

export interface TrustedProviderLane {
  head: string;
  lane: LocalReviewLaneId;
  profile: LocalReviewProfile;
  runId: string;
  issueNumber: number;
  prNumber: number;
  host: string;
  recommendation: 'approve';
  status: 'passed';
  summary: string;
  findingDigest: string | null;
  author: string | null;
  url: string | null;
}

export interface ProviderLaneRejection {
  lane: string;
  reason: string;
}

export interface ProviderLaneReuse {
  accepted: TrustedProviderLane[];
  rejected: ProviderLaneRejection[];
  summary: string;
}

const RECOMMENDATION_VOCABULARY = new Set(['approve', 'request-changes', 'pending', 'inconclusive']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

// Full findings and severity detail are recorded only in local lane evidence
// files; provider markers carry verdict-level state. Reuse therefore accepts
// only approving passed records, and every other verdict names the local-only
// fields a rerun would restore.
const LOCAL_ONLY_FIELDS = 'findings, severities, prompt stack, and runner provenance';

export function readTrustedProviderLanes(trustedLaneReviews: unknown, input: {
  headSha: string;
  prNumber: number;
  profile: LocalReviewProfile;
  requiredLanes: readonly LocalReviewLaneId[];
}): ProviderLaneReuse {
  const accepted: TrustedProviderLane[] = [];
  const rejected: ProviderLaneRejection[] = [];
  const records = Array.isArray(trustedLaneReviews) ? trustedLaneReviews : [];
  const staleHeadsByLane = new Map<string, Set<string>>();
  const currentHeadByLane = new Map<string, Record<string, unknown>>();

  for (const value of records) {
    if (!isRecord(value)) continue;
    const lane = nonEmptyString(value.lane);
    const head = nonEmptyString(value.head);
    if (!lane || !head) continue;
    if (head !== input.headSha) {
      const heads = staleHeadsByLane.get(lane) ?? new Set<string>();
      heads.add(head);
      staleHeadsByLane.set(lane, heads);
      continue;
    }
    currentHeadByLane.set(lane, value);
  }

  for (const laneId of input.requiredLanes) {
    const record = currentHeadByLane.get(laneId);
    if (!record) {
      const staleHeads = staleHeadsByLane.get(laneId);
      if (staleHeads && staleHeads.size > 0) {
        rejected.push({ lane: laneId, reason: `Trusted provider reviews for ${laneId} exist only for other heads (${[...staleHeads].map(head => head.slice(0, 12)).join(', ')}); no current-head review is available for reuse.` });
      }
      continue;
    }
    const profile = nonEmptyString(record.profile);
    if (profile !== input.profile) {
      rejected.push({ lane: laneId, reason: `Trusted provider review for ${laneId} was produced under profile ${profile ?? 'unknown'}, which is incompatible with the configured profile ${input.profile}.` });
      continue;
    }
    const prNumber = positiveInteger(record.prNumber);
    if (prNumber !== input.prNumber) {
      rejected.push({ lane: laneId, reason: `Trusted provider review for ${laneId} references PR #${prNumber ?? 'unknown'} instead of PR #${input.prNumber}.` });
      continue;
    }
    const recommendation = nonEmptyString(record.recommendation);
    const status = nonEmptyString(record.status);
    if (!recommendation || !RECOMMENDATION_VOCABULARY.has(recommendation) || !status) {
      rejected.push({ lane: laneId, reason: `Trusted provider review for ${laneId} carries an unrecognized verdict (recommendation=${recommendation ?? 'missing'}, status=${status ?? 'missing'}).` });
      continue;
    }
    if (recommendation !== 'approve' || status !== 'passed') {
      rejected.push({ lane: laneId, reason: `Trusted provider review for ${laneId} is ${recommendation}/${status}; only approve/passed records are reusable because ${LOCAL_ONLY_FIELDS} are local-only fields, so the lane must rerun.` });
      continue;
    }
    const runId = nonEmptyString(record.runId);
    const issueNumber = positiveInteger(record.issueNumber);
    const host = nonEmptyString(record.host);
    const summary = nonEmptyString(record.summary);
    if (!runId || !issueNumber || !host || !summary) {
      rejected.push({ lane: laneId, reason: `Trusted provider review for ${laneId} is missing required marker fields (runId, issueNumber, host, or summary).` });
      continue;
    }
    accepted.push({
      head: input.headSha,
      lane: laneId,
      profile: input.profile,
      runId,
      issueNumber,
      prNumber: input.prNumber,
      host,
      recommendation: 'approve',
      status: 'passed',
      summary,
      findingDigest: nonEmptyString(record.findingDigest),
      author: nonEmptyString(record.author),
      url: nonEmptyString(record.url),
    });
  }

  const missing = input.requiredLanes.filter(laneId => !accepted.some(lane => lane.lane === laneId) && !rejected.some(entry => entry.lane === laneId));
  const parts: string[] = [];
  if (accepted.length > 0) parts.push(`${accepted.length} trusted current-head provider lane review(s) available for reuse: ${accepted.map(lane => lane.lane).join(', ')}.`);
  if (rejected.length > 0) parts.push(`${rejected.length} provider record(s) rejected for reuse.`);
  if (missing.length > 0) parts.push(`No trusted provider review found for: ${missing.join(', ')}.`);
  if (parts.length === 0) parts.push('No trusted provider lane reviews were available.');
  return { accepted, rejected, summary: parts.join(' ') };
}

export function acceptedProviderLane(reuse: ProviderLaneReuse | undefined, laneId: LocalReviewLaneId, issueNumber: number): TrustedProviderLane | null {
  if (!reuse) return null;
  return reuse.accepted.find(lane => lane.lane === laneId && lane.issueNumber === issueNumber) ?? null;
}
