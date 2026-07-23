import type { LocalReviewLaneId, LocalReviewProfile } from './local_review_evidence.js';
import { normalizedRoundLanes, reviewRoundId } from './review_round.js';

export interface TrustedProviderLane {
  head: string;
  lane: LocalReviewLaneId;
  profile: LocalReviewProfile;
  runId: string;
  round: string;
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
  issueNumber: number | null;
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

function declaredExpectedLanes(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every(item => typeof item === 'string' && item.trim() !== '')) return null;
  return normalizedRoundLanes(value as string[]);
}

interface RoundMembership {
  roundId: string | null;
  expectedLanes: string[] | null;
}

interface RoundBucket {
  lanes: Set<string>;
  expectedLanes: string[] | null;
  consistent: boolean;
}

export function readTrustedProviderLanes(trustedLaneReviews: unknown, input: {
  headSha: string;
  prNumber: number;
  profile: LocalReviewProfile;
  requiredLanes: readonly LocalReviewLaneId[];
  issueNumbers: readonly number[];
}): ProviderLaneReuse {
  const accepted: TrustedProviderLane[] = [];
  const rejected: ProviderLaneRejection[] = [];
  const records = Array.isArray(trustedLaneReviews) ? trustedLaneReviews : [];
  const staleHeadsByLane = new Map<string, Set<string>>();
  const currentHeadByLaneIssue = new Map<string, Record<string, unknown>>();
  const roundByLaneIssue = new Map<string, RoundMembership>();
  const roundBuckets = new Map<string, RoundBucket>();

  for (const value of records) {
    if (!isRecord(value)) continue;
    // Superseded markers preserve replaced verdicts for history readers;
    // they are never live state and can never seed reuse or completeness.
    if (value.superseded === true) continue;
    const lane = nonEmptyString(value.lane);
    const head = nonEmptyString(value.head);
    if (!lane || !head) continue;
    if (head !== input.headSha) {
      const heads = staleHeadsByLane.get(lane) ?? new Set<string>();
      heads.add(head);
      staleHeadsByLane.set(lane, heads);
      continue;
    }
    const issueNumber = positiveInteger(value.issueNumber);
    if (issueNumber === null) continue;
    currentHeadByLaneIssue.set(`${lane}#${issueNumber}`, value);
    // Round membership: an explicit round id wins; markers that predate the
    // round field but declared an expected lane set derive the same
    // deterministic id the publisher would have minted. A record with neither
    // belongs to no decidable round and can never be reused.
    const expectedLanes = declaredExpectedLanes(value.expectedLanes);
    const roundId = nonEmptyString(value.round)
      ?? (expectedLanes ? reviewRoundId({ prNumber: input.prNumber, headSha: input.headSha, expectedLanes, issueNumber }) : null);
    roundByLaneIssue.set(`${lane}#${issueNumber}`, { roundId, expectedLanes });
    if (roundId === null) continue;
    const bucketKey = `${issueNumber}#${roundId}`;
    const bucket = roundBuckets.get(bucketKey) ?? { lanes: new Set<string>(), expectedLanes, consistent: true };
    bucket.lanes.add(lane);
    if ((bucket.expectedLanes === null) !== (expectedLanes === null)
      || (bucket.expectedLanes !== null && expectedLanes !== null && bucket.expectedLanes.join('\0') !== expectedLanes.join('\0'))) {
      bucket.consistent = false;
    }
    if (bucket.expectedLanes === null && expectedLanes !== null) bucket.expectedLanes = expectedLanes;
    roundBuckets.set(bucketKey, bucket);
  }

  for (const laneId of input.requiredLanes) {
    for (const gateIssueNumber of input.issueNumbers) {
      const record = currentHeadByLaneIssue.get(`${laneId}#${gateIssueNumber}`);
      const laneLabel = input.issueNumbers.length > 1 ? `${laneId} (issue #${gateIssueNumber})` : laneId;
      if (!record) {
        const staleHeads = staleHeadsByLane.get(laneId);
        if (staleHeads && staleHeads.size > 0) {
          rejected.push({ lane: laneId, issueNumber: gateIssueNumber, reason: `Trusted provider reviews for ${laneLabel} exist only for other heads (${[...staleHeads].map(head => head.slice(0, 12)).join(', ')}); no current-head review is available for reuse.` });
        }
        continue;
      }
      if (record.stale === true) {
        rejected.push({ lane: laneId, issueNumber: gateIssueNumber, reason: `Trusted provider review for ${laneLabel} is explicitly marked stale by the provider adapter; stale-marked evidence is never reused even when its head field matches.` });
        continue;
      }
      const profile = nonEmptyString(record.profile);
      if (profile !== input.profile) {
        rejected.push({ lane: laneId, issueNumber: gateIssueNumber, reason: `Trusted provider review for ${laneLabel} was produced under profile ${profile ?? 'unknown'}, which is incompatible with the configured profile ${input.profile}.` });
        continue;
      }
      const prNumber = positiveInteger(record.prNumber);
      if (prNumber !== input.prNumber) {
        rejected.push({ lane: laneId, issueNumber: gateIssueNumber, reason: `Trusted provider review for ${laneLabel} references PR #${prNumber ?? 'unknown'} instead of PR #${input.prNumber}.` });
        continue;
      }
      const recommendation = nonEmptyString(record.recommendation);
      const status = nonEmptyString(record.status);
      if (!recommendation || !RECOMMENDATION_VOCABULARY.has(recommendation) || !status) {
        rejected.push({ lane: laneId, issueNumber: gateIssueNumber, reason: `Trusted provider review for ${laneLabel} carries an unrecognized verdict (recommendation=${recommendation ?? 'missing'}, status=${status ?? 'missing'}).` });
        continue;
      }
      if (recommendation !== 'approve' || status !== 'passed') {
        rejected.push({ lane: laneId, issueNumber: gateIssueNumber, reason: `Trusted provider review for ${laneLabel} is ${recommendation}/${status}; only approve/passed records are reusable because ${LOCAL_ONLY_FIELDS} are local-only fields, so the lane must rerun.` });
        continue;
      }
      const runId = nonEmptyString(record.runId);
      const host = nonEmptyString(record.host);
      const summary = nonEmptyString(record.summary);
      if (!runId || !host || !summary) {
        rejected.push({ lane: laneId, issueNumber: gateIssueNumber, reason: `Trusted provider review for ${laneLabel} is missing required marker fields (runId, host, or summary).` });
        continue;
      }
      // Fail-closed round completeness: a partially published round can never
      // be read as an approved head. Every lane the round declared must have a
      // same-round record at this head before any of its lanes are reusable.
      const membership = roundByLaneIssue.get(`${laneId}#${gateIssueNumber}`);
      if (!membership || membership.roundId === null) {
        rejected.push({ lane: laneId, issueNumber: gateIssueNumber, reason: `Trusted provider review for ${laneLabel} carries no round grouping (round id or expected lane set), so round completeness is undecidable; the lane must rerun.` });
        continue;
      }
      const bucket = roundBuckets.get(`${gateIssueNumber}#${membership.roundId}`);
      if (!bucket || !bucket.consistent) {
        rejected.push({ lane: laneId, issueNumber: gateIssueNumber, reason: `Trusted provider review for ${laneLabel} belongs to a review round whose records disagree on the declared expected lane set; an inconsistent round is never reusable.` });
        continue;
      }
      if (bucket.expectedLanes === null) {
        rejected.push({ lane: laneId, issueNumber: gateIssueNumber, reason: `Trusted provider review for ${laneLabel} belongs to a round that declares no expected lane set, so completeness is undecidable; the lane must rerun.` });
        continue;
      }
      const missingRoundLanes = bucket.expectedLanes.filter(roundLane => !bucket.lanes.has(roundLane));
      if (missingRoundLanes.length > 0) {
        rejected.push({ lane: laneId, issueNumber: gateIssueNumber, reason: `Trusted provider review for ${laneLabel} belongs to an incomplete review round (${bucket.lanes.size} of ${bucket.expectedLanes.length} declared lanes published at this head; missing: ${missingRoundLanes.join(', ')}); a partial round is never read as approved.` });
        continue;
      }
      // The round's declared lane set must equal the currently required set:
      // an under- or over-declared round was reviewed under a different lane
      // configuration and can never stand in for the active one.
      const requiredSet = normalizedRoundLanes(input.requiredLanes as readonly string[]);
      if (bucket.expectedLanes.join('\0') !== requiredSet.join('\0')) {
        rejected.push({ lane: laneId, issueNumber: gateIssueNumber, reason: `Trusted provider review for ${laneLabel} belongs to a round declaring lanes [${bucket.expectedLanes.join(', ')}], which does not equal the required lane set [${requiredSet.join(', ')}]; the lane must rerun under the active configuration.` });
        continue;
      }
      accepted.push({
        head: input.headSha,
        lane: laneId,
        profile: input.profile,
        runId,
        round: membership.roundId,
        issueNumber: gateIssueNumber,
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
  }

  const missing = input.requiredLanes.flatMap(laneId => input.issueNumbers
    .filter(issueNumber => !accepted.some(lane => lane.lane === laneId && lane.issueNumber === issueNumber) && !rejected.some(entry => entry.lane === laneId && entry.issueNumber === issueNumber))
    .map(issueNumber => input.issueNumbers.length > 1 ? `${laneId} (issue #${issueNumber})` : laneId));
  const parts: string[] = [];
  if (accepted.length > 0) parts.push(`${accepted.length} trusted current-head provider lane review(s) available for reuse: ${[...new Set(accepted.map(lane => input.issueNumbers.length > 1 ? `${lane.lane} (issue #${lane.issueNumber})` : lane.lane))].join(', ')}.`);
  if (rejected.length > 0) parts.push(`${rejected.length} provider record(s) rejected for reuse.`);
  if (missing.length > 0) parts.push(`No trusted provider review found for: ${missing.join(', ')}.`);
  if (parts.length === 0) parts.push('No trusted provider lane reviews were available.');
  return { accepted, rejected, summary: parts.join(' ') };
}

export function acceptedProviderLane(reuse: ProviderLaneReuse | undefined, laneId: LocalReviewLaneId, issueNumber: number): TrustedProviderLane | null {
  if (!reuse) return null;
  return reuse.accepted.find(lane => lane.lane === laneId && lane.issueNumber === issueNumber) ?? null;
}
