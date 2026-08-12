import { createHash } from 'node:crypto';
import { type ReviewDiffIndex, type ReviewFinding, partitionReviewFindings } from '@tjalve/qube-core';
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
  readonly withheld: { readonly duplicates: number; readonly offDiff: number; readonly byCap: number };
}

export interface RoundSummaryInput {
  readonly prNumber: number;
  readonly issueNumber: number;
  readonly headSha: string;
  readonly round: string;
  readonly expectedLanes: readonly string[];
  readonly lanes: readonly RoundSummaryLaneInput[];
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

const MAX_SUGGESTION_SPAN_LINES = 40;
const MAX_SUGGESTION_LENGTH = 2000;

// "Safe" here means: line-anchored to the current diff, replaces only
// current-side lines (never a deleted/source line), is a bounded span, and
// cannot smuggle its own fence delimiter to break out of the rendered block.
export function suggestionFenceSafety(anchor: FindingAnchor): SuggestionSafety {
  if (!anchor.anchored) return { safe: false, reason: 'Suggestion is not line-anchored to the current diff.' };
  const suggestion = anchor.finding.suggestion;
  if (!suggestion || suggestion.trim() === '') return { safe: false, reason: 'No suggestion text was recorded.' };
  const location = anchor.finding.location;
  if (!location || typeof location.line !== 'number') return { safe: false, reason: 'Suggestion has no anchored line.' };
  if (location.side === 'source') return { safe: false, reason: 'Suggestions can only replace current-diff lines, not deleted lines.' };
  const span = (location.endLine ?? location.line) - location.line;
  if (span < 0 || span > MAX_SUGGESTION_SPAN_LINES) return { safe: false, reason: `Suggestion spans more than ${MAX_SUGGESTION_SPAN_LINES} lines and is not minimal.` };
  if (suggestion.includes('```')) return { safe: false, reason: 'Suggestion text contains a code fence and cannot be rendered safely.' };
  if (suggestion.length > MAX_SUGGESTION_LENGTH) return { safe: false, reason: `Suggestion exceeds ${MAX_SUGGESTION_LENGTH} characters and is not minimal.` };
  return { safe: true, reason: null };
}

export function renderSuggestionFence(anchor: FindingAnchor): string | null {
  const safety = suggestionFenceSafety(anchor);
  if (!safety.safe) return null;
  return ['```suggestion', sanitizeText((anchor.finding.suggestion ?? '').replace(/\r\n/g, '\n')), '```'].join('\n');
}

/** Full inline review-comment body: finding text plus a safe suggestion fence when one applies. */
export function renderInlineCommentBody(anchor: FindingAnchor): string {
  const confidence = typeof anchor.finding.confidence === 'number' ? ` (confidence ${anchor.finding.confidence.toFixed(2)})` : '';
  const header = `${anchor.finding.severity} [${anchor.laneId}]: ${sanitizeText(anchor.finding.message)}${confidence}`;
  const fence = renderSuggestionFence(anchor);
  return fence ? `${header}\n\n${fence}` : header;
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

function laneVerdictLabel(lane: RoundSummaryLaneInput): string {
  return `${lane.recommendation} (${lane.status})`;
}

export function renderLaneRollupTable(lanes: readonly RoundSummaryLaneInput[], expectedLanes: readonly string[]): string {
  const byLane = new Map(lanes.map(lane => [lane.laneId, lane] as const));
  const rows = expectedLanes.map(laneId => {
    const lane = byLane.get(laneId);
    if (!lane) return `| ${laneId} | missing | — | — | — | — |`;
    const blocking = lane.findings.filter(finding => finding.severity === 'blocking').length;
    const advisory = lane.findings.filter(finding => finding.severity === 'advisory').length;
    const carried = lane.carriedForwardFromHeadSha ? `carried from ${lane.carriedForwardFromHeadSha.slice(0, 12)}` : 'no';
    return `| ${laneId} | ${laneVerdictLabel(lane)} | ${carried} | ${lane.evidenceHeadSha.slice(0, 12)} | ${blocking} | ${advisory} |`;
  });
  return [
    '| Lane | Verdict | Carried forward | Evidence head | Blocking | Advisory |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

export function renderCollapsibleLaneDetails(lanes: readonly RoundSummaryLaneInput[], expectedLanes: readonly string[]): string {
  const byLane = new Map(lanes.map(lane => [lane.laneId, lane] as const));
  return expectedLanes.map(laneId => {
    const lane = byLane.get(laneId);
    if (!lane) {
      return ['<details>', `<summary>${laneId} — missing evidence</summary>`, '', 'No evidence was recorded for this lane at this head.', '', '</details>'].join('\n');
    }
    const findingLines = lane.findings.length === 0
      ? ['- None recorded.']
      : lane.findings.map(finding => `- ${finding.severity}${finding.location ? ` (${finding.location.path}${finding.location.line ? `:${finding.location.line}` : ''})` : ''}: ${sanitizeText(finding.message)}`);
    const withheldTotal = lane.withheld.duplicates + lane.withheld.offDiff + lane.withheld.byCap;
    return [
      '<details>',
      `<summary>${laneId} — ${laneVerdictLabel(lane)}</summary>`,
      '',
      sanitizeText(lane.summary),
      '',
      'Findings:',
      ...findingLines,
      ...(withheldTotal > 0 ? ['', `Synthesis withheld ${withheldTotal} finding(s) from this lane's own report (${lane.withheld.duplicates} duplicate, ${lane.withheld.offDiff} off-diff, ${lane.withheld.byCap} beyond cap); see the lane's own review for detail.`] : []),
      '',
      '</details>',
    ].join('\n');
  }).join('\n\n');
}

function findingLine(anchor: FindingAnchor): string {
  const location = anchor.finding.location ? ` (${anchor.finding.location.path}${anchor.finding.location.line ? `:${anchor.finding.location.line}` : ''})` : '';
  const anchorNote = anchor.anchored ? ' (posted inline)' : ` (unanchored: ${anchor.unanchoredReason})`;
  return `- ${anchor.finding.severity}${location} [${anchor.laneId}]: ${sanitizeText(anchor.finding.message)}${anchorNote}`;
}

export interface RoundSummaryRenderOptions {
  /** Pass `null` when the provider cannot compute a diff index; every finding is then unanchored. */
  readonly diffIndex?: ReviewDiffIndex | null;
  readonly publisherDowngradeReason?: string | null;
  readonly supersededPriorSummaries?: number;
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

  const body = [
    marker,
    '',
    `# QUBE review round summary: ${verdict}`,
    '',
    `Blocking findings (${allBlocking.length}):`,
    ...(allBlocking.length === 0 ? ['- None.'] : allBlocking.map(findingLine)),
    '',
    `Advisory findings (${allAdvisory.length}, ranked):`,
    ...(allAdvisory.length === 0 ? ['- None.'] : allAdvisory.map(findingLine)),
    '',
    'Preconditions observed:',
    ...(preconditions.length === 0 ? ['- None recorded.'] : preconditions.map(precondition => `- ${sanitizeText(precondition)}`)),
    '',
    'Lane rollup:',
    '',
    renderLaneRollupTable(input.lanes, input.expectedLanes),
    '',
    ...(options.publisherDowngradeReason ? [`Publisher downgrade: ${sanitizeText(options.publisherDowngradeReason)}`, ''] : []),
    ...(options.supersededPriorSummaries ? [`This summary superseded ${options.supersededPriorSummaries} prior-head summary comment(s); see history for the replaced verdicts.`, ''] : []),
    '<details>',
    '<summary>Lane details</summary>',
    '',
    renderCollapsibleLaneDetails(input.lanes, input.expectedLanes),
    '',
    '</details>',
    '',
    'Metadata:',
    `- PR: #${input.prNumber}`,
    `- issue: #${input.issueNumber}`,
    `- head: ${input.headSha}`,
    `- round: ${input.round}`,
    `- inline comments: ${inline.length}`,
    `- unanchored findings: ${unanchored.length}`,
    `- finding digest: ${findingDigest}`,
  ].join('\n');

  return { body, marker, verdict, inline, unanchored, blockingCount: allBlocking.length, advisoryCount: allAdvisory.length, findingDigest };
}
