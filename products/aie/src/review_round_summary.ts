import { createHash } from 'node:crypto';
import {
  DEGRADED_REVIEW_RENDER_PROFILE,
  GITHUB_REVIEW_RENDER_PROFILE,
  classifyReviewLaneState,
  renderInlineReviewComment,
  renderRoundReviewBody,
  renderSuggestionFence as renderSharedSuggestionFence,
  suggestionFenceSafety as sharedSuggestionFenceSafety,
  type ReviewFinding,
  type ReviewDiffIndex,
  type ReviewLaneRenderInput,
  type ReviewPublishTransport,
  type ReviewRepositoryRef,
  type ReviewRoundDeltaInput,
  partitionReviewFindings,
} from '@tjalve/qube-core';
import { redact } from './redact.js';

export type RoundVerdict = 'approve' | 'request-changes' | 'pending' | 'inconclusive';

export interface RoundSummaryLaneInput {
  readonly laneId: string;
  readonly status: string;
  readonly recommendation: RoundVerdict;
  readonly summary: string;
  /** Findings already filtered by cross-lane synthesis (deduped, off-diff-withheld, capped) for this lane. */
  readonly findings: readonly ReviewFinding[];
  readonly preconditions: readonly string[];
  readonly evidenceHeadSha: string;
  readonly carriedForwardFromHeadSha: string | null;
  readonly origin?: 'local' | 'trusted-provider';
  readonly notRunReason?: string | null;
  readonly withheld: { readonly duplicates: number; readonly offDiff: number; readonly byCap: number };
  readonly host?: string;
  readonly model?: string | null;
  readonly effort?: string | null;
  readonly profile?: string;
  readonly evidencePath?: string;
}

export interface RoundSummaryInput {
  readonly prNumber: number;
  readonly issueNumber: number;
  readonly headSha: string;
  readonly round: string;
  readonly expectedLanes: readonly string[];
  readonly lanes: readonly RoundSummaryLaneInput[];
  readonly roundOrdinal?: number;
  readonly repository?: ReviewRepositoryRef;
  readonly priorRound?: ReviewRoundDeltaInput;
  readonly rerunCommand?: string;
  readonly transport?: ReviewPublishTransport;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeText(value: string): string {
  return redact(value).trim();
}

// Verdict priority mirrors the severity a reviewer would react to first: any
// lane still requesting changes makes the round blocking regardless of how
// many other lanes approved.
const ROUND_VERDICT_PRIORITY: readonly RoundVerdict[] = ['request-changes', 'pending', 'inconclusive', 'approve'];

export function deriveRoundVerdict(lanes: readonly RoundSummaryLaneInput[]): RoundVerdict {
  if (lanes.length === 0) return 'pending';
  const present = new Set(lanes.map(lane => lane.recommendation));
  return ROUND_VERDICT_PRIORITY.find(candidate => present.has(candidate)) ?? 'pending';
}

export function collectRoundPreconditions(lanes: readonly RoundSummaryLaneInput[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const lane of lanes) {
    for (const precondition of lane.preconditions) {
      const normalized = precondition.trim();
      if (normalized === '' || seen.has(normalized)) continue;
      seen.add(normalized);
      ordered.push(normalized);
    }
  }
  return ordered;
}

export interface FindingAnchor {
  readonly laneId: string;
  readonly finding: ReviewFinding;
  readonly anchored: boolean;
  readonly unanchoredReason: string | null;
}

const NO_LOCATION_REASON = 'This finding has no recorded file/line location.';
const OFF_DIFF_REASON = 'The recorded location is not part of the current diff.';
const NO_DIFF_INDEX_REASON = 'The review provider could not anchor findings to the current diff.';

// Only `undefined` disables anchoring (the provider genuinely cannot compute
// a diff index); a caller that observed the diff must always pass a real
// ReviewDiffIndex, even an empty one, so an unanchorable finding gets the
// correct off-diff reason instead of a blanket provider-unavailable reason.
export function partitionRoundFindings(lanes: readonly RoundSummaryLaneInput[], diffIndex: ReviewDiffIndex | null): { inline: FindingAnchor[]; unanchored: FindingAnchor[] } {
  const inline: FindingAnchor[] = [];
  const unanchored: FindingAnchor[] = [];
  for (const lane of lanes) {
    if (diffIndex === null) {
      for (const finding of lane.findings) unanchored.push({ laneId: lane.laneId, finding, anchored: false, unanchoredReason: NO_DIFF_INDEX_REASON });
      continue;
    }
    const partitioned = partitionReviewFindings(lane.findings, diffIndex);
    for (const finding of partitioned.inline) inline.push({ laneId: lane.laneId, finding, anchored: true, unanchoredReason: null });
    for (const finding of partitioned.body) {
      unanchored.push({ laneId: lane.laneId, finding, anchored: false, unanchoredReason: finding.location ? OFF_DIFF_REASON : NO_LOCATION_REASON });
    }
  }
  return { inline, unanchored };
}

function confidenceRank(finding: ReviewFinding): number {
  return typeof finding.confidence === 'number' ? finding.confidence : -1;
}

export function rankFindingAnchors(anchors: readonly FindingAnchor[], expectedLanes: readonly string[]): { blocking: FindingAnchor[]; advisory: FindingAnchor[] } {
  const laneRank = (laneId: string): number => {
    const index = expectedLanes.indexOf(laneId);
    return index >= 0 ? index : expectedLanes.length;
  };
  const blocking = anchors.filter(anchor => anchor.finding.severity === 'blocking');
  const advisory = [...anchors.filter(anchor => anchor.finding.severity === 'advisory')].sort((left, right) => {
    const byConfidence = confidenceRank(right.finding) - confidenceRank(left.finding);
    if (byConfidence !== 0) return byConfidence;
    const byLane = laneRank(left.laneId) - laneRank(right.laneId);
    if (byLane !== 0) return byLane;
    return left.finding.message.localeCompare(right.finding.message);
  });
  return { blocking, advisory };
}

export interface SuggestionSafety {
  readonly safe: boolean;
  readonly reason: string | null;
}

export function suggestionFenceSafety(anchor: FindingAnchor): SuggestionSafety {
  return sharedSuggestionFenceSafety(anchor);
}

export function renderSuggestionFence(anchor: FindingAnchor): string | null {
  return renderSharedSuggestionFence(anchor, { ...GITHUB_REVIEW_RENDER_PROFILE, sanitizeText });
}

/** Full inline review-comment body: finding text plus a safe suggestion fence when one applies. */
export function renderInlineCommentBody(anchor: FindingAnchor): string {
  return renderInlineReviewComment(anchor, { ...GITHUB_REVIEW_RENDER_PROFILE, sanitizeText });
}

export const ROUND_SUMMARY_MARKER_PREFIX = 'qube-pr-review-summary';

export interface RoundSummaryMarkerMetadata {
  readonly version: 1;
  readonly head: string;
  readonly round: string;
  readonly prNumber: number;
  readonly issueNumber: number;
  readonly verdict: RoundVerdict;
  readonly expectedLanes: readonly string[];
  /** A superseded marker preserves a replaced round's verdict for history readers; live read paths ignore it. */
  readonly superseded?: boolean;
  readonly inlineCommentCount: number;
  readonly unanchoredFindingCount: number;
  readonly blockingFindingCount: number;
  readonly advisoryFindingCount: number;
  readonly findingDigest: string;
}

export function roundSummaryMarker(metadata: RoundSummaryMarkerMetadata): string {
  return `<!-- ${ROUND_SUMMARY_MARKER_PREFIX}:${JSON.stringify(metadata)} -->`;
}

export function parseRoundSummaryMarker(body: string | undefined): RoundSummaryMarkerMetadata | null {
  const match = (body ?? '').match(/<!--\s*qube-pr-review-summary:(\{[\s\S]*?\})\s*-->/);
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(match[1]);
    if (!isRecord(parsed)) return null;
    if (parsed.version !== 1) return null;
    if (typeof parsed.head !== 'string' || parsed.head.trim() === '') return null;
    if (typeof parsed.round !== 'string' || parsed.round.trim() === '') return null;
    if (typeof parsed.prNumber !== 'number' || !Number.isSafeInteger(parsed.prNumber) || parsed.prNumber <= 0) return null;
    if (typeof parsed.issueNumber !== 'number' || !Number.isSafeInteger(parsed.issueNumber) || parsed.issueNumber <= 0) return null;
    if (parsed.verdict !== 'approve' && parsed.verdict !== 'request-changes' && parsed.verdict !== 'pending' && parsed.verdict !== 'inconclusive') return null;
    if (!Array.isArray(parsed.expectedLanes) || parsed.expectedLanes.length === 0 || !parsed.expectedLanes.every(lane => typeof lane === 'string' && lane.trim() !== '')) return null;
    if (typeof parsed.findingDigest !== 'string' || parsed.findingDigest.trim() === '') return null;
    return {
      version: 1,
      head: parsed.head,
      round: parsed.round,
      prNumber: parsed.prNumber,
      issueNumber: parsed.issueNumber,
      verdict: parsed.verdict,
      expectedLanes: [...parsed.expectedLanes] as string[],
      ...(parsed.superseded === true ? { superseded: true as const } : {}),
      inlineCommentCount: typeof parsed.inlineCommentCount === 'number' && Number.isSafeInteger(parsed.inlineCommentCount) ? parsed.inlineCommentCount : 0,
      unanchoredFindingCount: typeof parsed.unanchoredFindingCount === 'number' && Number.isSafeInteger(parsed.unanchoredFindingCount) ? parsed.unanchoredFindingCount : 0,
      blockingFindingCount: typeof parsed.blockingFindingCount === 'number' && Number.isSafeInteger(parsed.blockingFindingCount) ? parsed.blockingFindingCount : 0,
      advisoryFindingCount: typeof parsed.advisoryFindingCount === 'number' && Number.isSafeInteger(parsed.advisoryFindingCount) ? parsed.advisoryFindingCount : 0,
      findingDigest: parsed.findingDigest,
    };
  } catch {
    return null;
  }
}

export interface RoundSummaryMarkerRecord {
  readonly metadata: RoundSummaryMarkerMetadata;
  readonly id: string;
}

export interface RoundSummarySupersessionPlan {
  /** A live marker for the exact current head+round; update it in place instead of creating a second one. */
  readonly sameRoundRecord: RoundSummaryMarkerRecord | null;
  /** Live markers from other heads of the same PR; tombstone each so exactly one live round summary remains. */
  readonly priorHeadRecords: readonly RoundSummaryMarkerRecord[];
}

export function planRoundSummarySupersession(existing: readonly RoundSummaryMarkerRecord[], current: { readonly prNumber: number; readonly headSha: string; readonly round: string }): RoundSummarySupersessionPlan {
  const live = existing.filter(record => record.metadata.superseded !== true && record.metadata.prNumber === current.prNumber);
  const sameRoundRecord = live.find(record => record.metadata.head === current.headSha && record.metadata.round === current.round) ?? null;
  const priorHeadRecords = live.filter(record => record.metadata.head !== current.headSha);
  return { sameRoundRecord, priorHeadRecords };
}

function findingDigestEntry(anchor: FindingAnchor): unknown {
  return {
    lane: anchor.laneId,
    id: anchor.finding.id,
    severity: anchor.finding.severity,
    location: anchor.finding.location ?? null,
    message: sanitizeText(anchor.finding.message),
    suggestion: anchor.finding.suggestion ? sanitizeText(anchor.finding.suggestion) : null,
    confidence: typeof anchor.finding.confidence === 'number' ? anchor.finding.confidence : null,
    anchored: anchor.anchored,
  };
}

export function computeRoundFindingDigest(inline: readonly FindingAnchor[], unanchored: readonly FindingAnchor[], preconditions: readonly string[]): string {
  return createHash('sha256')
    .update(JSON.stringify({
      inline: inline.map(findingDigestEntry),
      unanchored: unanchored.map(findingDigestEntry),
      preconditions,
    }))
    .digest('hex')
    .slice(0, 16);
}

function toLaneRenderInput(lane: RoundSummaryLaneInput): ReviewLaneRenderInput {
  return {
    laneId: lane.laneId,
    status: lane.status,
    recommendation: lane.recommendation,
    summary: lane.summary,
    findings: lane.findings,
    preconditions: lane.preconditions,
    evidenceHeadSha: lane.evidenceHeadSha,
    carriedForwardFromHeadSha: lane.carriedForwardFromHeadSha,
    origin: lane.origin,
    notRunReason: lane.notRunReason,
    withheld: lane.withheld,
    host: lane.host,
    model: lane.model,
    effort: lane.effort,
    profile: lane.profile,
    evidencePath: lane.evidencePath,
  };
}

export interface RoundSummaryRenderOptions {
  /** Pass `null` when the provider cannot compute a diff index; every finding is then unanchored. */
  readonly diffIndex?: ReviewDiffIndex | null;
  readonly publisherDowngradeReason?: string | null;
  readonly supersededPriorSummaries?: number;
  readonly transport?: ReviewPublishTransport;
  readonly profile?: 'github' | 'degraded';
}

export interface RoundSummaryRender {
  readonly body: string;
  readonly marker: string;
  readonly verdict: RoundVerdict;
  readonly inline: readonly FindingAnchor[];
  readonly unanchored: readonly FindingAnchor[];
  readonly blockingCount: number;
  readonly advisoryCount: number;
  readonly findingDigest: string;
}

export function renderRoundSummaryBody(input: RoundSummaryInput, options: RoundSummaryRenderOptions = {}): RoundSummaryRender {
  const verdict = deriveRoundVerdict(input.lanes);
  const preconditions = collectRoundPreconditions(input.lanes);
  const diffIndex = options.diffIndex ?? null;
  const { inline, unanchored } = partitionRoundFindings(input.lanes, diffIndex);
  const rankedInline = rankFindingAnchors(inline, input.expectedLanes);
  const rankedUnanchored = rankFindingAnchors(unanchored, input.expectedLanes);
  const allBlocking = [...rankedInline.blocking, ...rankedUnanchored.blocking];
  const allAdvisory = [...rankedInline.advisory, ...rankedUnanchored.advisory];
  const findingDigest = computeRoundFindingDigest(inline, unanchored, preconditions);
  const transport = options.transport ?? input.transport ?? (options.publisherDowngradeReason ? 'issue-comment' : 'review-api');
  const profile = options.profile === 'degraded' || transport === 'issue-comment'
    ? { ...DEGRADED_REVIEW_RENDER_PROFILE, sanitizeText }
    : { ...GITHUB_REVIEW_RENDER_PROFILE, sanitizeText };

  const metadata: RoundSummaryMarkerMetadata = {
    version: 1,
    head: input.headSha,
    round: input.round,
    prNumber: input.prNumber,
    issueNumber: input.issueNumber,
    verdict,
    expectedLanes: [...input.expectedLanes].sort(),
    inlineCommentCount: inline.length,
    unanchoredFindingCount: unanchored.length,
    blockingFindingCount: allBlocking.length,
    advisoryFindingCount: allAdvisory.length,
    findingDigest,
  };
  const marker = roundSummaryMarker(metadata);
  const expectedLanes = [...input.expectedLanes];
  const renderedLanes = expectedLanes.map(laneId => {
    const lane = input.lanes.find(entry => entry.laneId === laneId);
    return lane
      ? toLaneRenderInput(lane)
      : toLaneRenderInput({
        laneId,
        status: 'missing',
        recommendation: 'pending',
        summary: '',
        findings: [],
        preconditions: [],
        evidenceHeadSha: input.headSha,
        carriedForwardFromHeadSha: null,
        notRunReason: 'no evidence at this head',
        withheld: { duplicates: 0, offDiff: 0, byCap: 0 },
      });
  });
  const rendered = renderRoundReviewBody({
    marker,
    verdict,
    headSha: input.headSha,
    expectedLanes,
    lanes: renderedLanes,
    findings: [...allBlocking, ...allAdvisory],
    transport,
    roundOrdinal: input.roundOrdinal,
    repository: input.repository,
    priorRound: input.priorRound,
    rerunCommand: input.rerunCommand ?? `aie pr gate ${input.prNumber}`,
    publisherDowngradeReason: options.publisherDowngradeReason ?? null,
  }, profile);

  return { body: rendered.body, marker, verdict, inline, unanchored, blockingCount: allBlocking.length, advisoryCount: allAdvisory.length, findingDigest };
}

export { classifyReviewLaneState };
