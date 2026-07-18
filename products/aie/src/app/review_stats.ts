import { getDefaults, loadConfig } from '../config/index.js';
import { createCliError, isCliError, renderCliErrorText, type CliErrorShape } from '@tjalve/qube-cli/errors';
import { supportsReviewStats } from '@tjalve/qube-core';
import { createReviewForgeProvider } from '../providers/review_forge_adapters.js';
import type { ReviewForgeProvider, ReviewForgePullRequest } from '../providers/review_forge_provider.js';

export const DEFAULT_REVIEW_STATS_WINDOW = 20;
export const MAX_REVIEW_STATS_WINDOW = 50;
const REVIEW_STATS_LOAD_CONCURRENCY = 4;

type LaneRecommendation = 'approve' | 'request-changes' | 'pending' | 'inconclusive';

interface LaneReviewRecord {
  head: string;
  lane: string;
  recommendation: LaneRecommendation;
  blockingFindingCount: number;
  expectedLanes: string[];
  publishedAt: number;
}

export interface ReviewStatsInput {
  number: number;
  title: string;
  closedAt?: string | null;
  trustedLaneReviews: unknown;
  unavailableReason?: string | null;
}

export interface ReviewStatsPullRequest {
  number: number;
  title: string;
  reviewedHeads: number | null;
  failingHeads: number | null;
  blockingEntries: number | null;
  firstReviewClean: boolean | null;
  noLaneEvidence: boolean;
  noLaneEvidenceReason: string | null;
}

export interface ReviewStatsLaneCount {
  lane: string;
  blockingEntries: number;
}

export interface ReviewStatsSummary {
  pullRequests: number;
  reviewedPullRequests: number;
  noLaneEvidencePullRequests: number;
  firstReviewCleanPullRequests: number;
  firstReviewCleanRate: number | null;
  medianReviewedHeads: number | null;
  blockingEntries: number;
  blockingEntriesAfterFirstHead: number;
  blockingEntriesAfterFirstHeadShare: number | null;
  blockingEntriesByLane: ReviewStatsLaneCount[];
}

export interface ReviewStatsResult {
  ok: true;
  command: 'review stats';
  provider: string;
  window: number;
  pullRequests: ReviewStatsPullRequest[];
  summary: ReviewStatsSummary;
  warnings: string[];
  nextAction: string;
}

export interface ReviewStatsOptions {
  window?: number;
  repoRoot?: string;
}

export interface ReviewStatsFailureResult {
  readonly result: {
    readonly ok: false;
    readonly command: 'review stats';
    readonly error: Omit<CliErrorShape, 'command'>;
  };
  readonly human: string;
  readonly exitCode: number;
}

export function reviewStatsFailure(error: unknown): ReviewStatsFailureResult {
  const failure: CliErrorShape = isCliError(error) ? error : createCliError({
    command: 'review stats',
    kind: 'review-stats-provider-read-failed',
    operation: 'load review convergence statistics',
    likelyCause: error instanceof Error ? error.message : String(error),
    suggestedNextAction: 'Verify the configured review provider and rerun with `--window 20 --json`.',
    category: 'external',
  });
  return {
    result: {
      ok: false,
      command: 'review stats',
      error: {
        kind: failure.kind,
        operation: failure.operation,
        likelyCause: failure.likelyCause,
        suggestedNextAction: failure.suggestedNextAction,
        category: failure.category,
        exitCode: failure.exitCode,
      },
    },
    human: renderCliErrorText(failure),
    exitCode: failure.exitCode,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isLaneRecommendation(value: unknown): value is LaneRecommendation {
  return value === 'approve' || value === 'request-changes' || value === 'pending' || value === 'inconclusive';
}

function validRecommendationStatus(recommendation: LaneRecommendation, status: string): boolean {
  if (recommendation === 'approve') return status === 'passed';
  if (recommendation === 'request-changes') return status === 'failed' || status === 'needs-work';
  if (recommendation === 'pending') return status === 'pending' || status === 'missing' || status === 'stale';
  return status === 'inconclusive' || status === 'unavailable' || status === 'malformed';
}

function validTimestamp(value: unknown): value is string {
  return nonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function laneNames(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || !value.every(nonEmptyString)) return null;
  const lanes = value.map(lane => lane.trim());
  if (lanes.some((lane, index) => lane !== value[index] || /[\u0000-\u001f\u007f]/.test(lane)) || new Set(lanes).size !== lanes.length) return null;
  return lanes.sort();
}

function parseLaneReviews(value: unknown): { records: LaneReviewRecord[]; reason: null } | { records: null; reason: string } {
  if (value === undefined || value === null) {
    return { records: null, reason: 'No trusted QUBE lane review metadata was found.' };
  }
  if (!Array.isArray(value)) {
    return { records: null, reason: 'Trusted QUBE lane review metadata was malformed: expected an array.' };
  }
  if (value.length === 0) {
    return { records: null, reason: 'No trusted QUBE lane review metadata was found.' };
  }

  const records: LaneReviewRecord[] = [];
  for (const [index, candidate] of value.entries()) {
    if (!isRecord(candidate)) {
      return { records: null, reason: `Trusted QUBE lane review metadata record ${index + 1} was malformed.` };
    }
    if (!nonEmptyString(candidate.head) || !nonEmptyString(candidate.lane) || candidate.lane !== candidate.lane.trim() || !isLaneRecommendation(candidate.recommendation) || !nonEmptyString(candidate.status) || !validTimestamp(candidate.publishedAt)) {
      return { records: null, reason: `Trusted QUBE lane review metadata record ${index + 1} was missing a valid head, lane, recommendation, status, or publication time.` };
    }
    const expectedLanes = laneNames(candidate.expectedLanes);
    if (!expectedLanes) {
      // Older lane markers predate the expected-lane-set and severity-aware
      // counts; without them exact convergence values cannot be computed, so
      // the pull request degrades with a reason instead of fabricated zeros.
      return { records: null, reason: `Trusted QUBE lane review metadata record ${index + 1} predates the expected-lane-set metadata; convergence stats cover reviews published after severity-aware lane markers.` };
    }
    if (!expectedLanes.includes(candidate.lane)) {
      return { records: null, reason: `Trusted QUBE lane review metadata record ${index + 1} declared lane ${candidate.lane} outside its expected lane set.` };
    }
    if (!validRecommendationStatus(candidate.recommendation, candidate.status)) {
      return { records: null, reason: `Trusted QUBE lane review metadata record ${index + 1} had an invalid recommendation and status combination.` };
    }
    const bodyFindingCount = candidate.bodyFindingCount;
    if (bodyFindingCount !== null && bodyFindingCount !== undefined && !nonNegativeInteger(bodyFindingCount)) {
      return { records: null, reason: `Trusted QUBE lane review metadata record ${index + 1} had an invalid bodyFindingCount.` };
    }
    const blockingFindingCount = candidate.blockingFindingCount;
    if (blockingFindingCount !== null && blockingFindingCount !== undefined && !nonNegativeInteger(blockingFindingCount)) {
      return { records: null, reason: `Trusted QUBE lane review metadata record ${index + 1} had an invalid blockingFindingCount.` };
    }
    const exactCount = nonNegativeInteger(blockingFindingCount) ? blockingFindingCount : null;
    if (candidate.recommendation === 'request-changes' && exactCount === null) {
      return { records: null, reason: `Trusted QUBE lane review metadata record ${index + 1} did not provide an exact severity-aware blocking finding count.` };
    }
    if (candidate.recommendation !== 'request-changes' && exactCount !== null && exactCount > 0) {
      return { records: null, reason: `Trusted QUBE lane review metadata record ${index + 1} contradicted its recommendation with a positive blocking finding count.` };
    }
    records.push({
      head: candidate.head,
      lane: candidate.lane,
      recommendation: candidate.recommendation,
      blockingFindingCount: candidate.recommendation === 'request-changes' ? exactCount ?? 0 : 0,
      expectedLanes,
      publishedAt: Date.parse(candidate.publishedAt),
    });
  }
  const headsByTimestamp = new Map<number, Set<string>>();
  for (const record of records) {
    const heads = headsByTimestamp.get(record.publishedAt) ?? new Set<string>();
    heads.add(record.head);
    headsByTimestamp.set(record.publishedAt, heads);
  }
  if ([...headsByTimestamp.values()].some(heads => heads.size > 1)) {
    return { records: null, reason: 'Trusted QUBE lane review metadata had ambiguous publication order because different heads shared the same timestamp.' };
  }
  records.sort((left, right) => left.publishedAt - right.publishedAt || left.lane.localeCompare(right.lane));
  return { records, reason: null };
}

function incompleteLaneReason(records: readonly LaneReviewRecord[]): string | null {
  for (const head of new Set(records.map(record => record.head))) {
    const headRecords = records.filter(record => record.head === head);
    const expectedSets = new Set(headRecords.map(record => record.expectedLanes.join('\0')));
    if (expectedSets.size !== 1) return `Trusted QUBE lane review metadata for head ${head} declared inconsistent expected lane sets.`;
    const expected = headRecords[0].expectedLanes;
    const observed = new Set(headRecords.map(record => record.lane));
    const missing = expected.filter(lane => !observed.has(lane));
    if (missing.length > 0) return `Trusted QUBE lane review metadata for head ${head} was incomplete; missing expected lane(s): ${missing.join(', ')}.`;
    const unexpected = [...observed].filter(lane => !expected.includes(lane));
    if (unexpected.length > 0) return `Trusted QUBE lane review metadata for head ${head} contained unexpected lane(s): ${unexpected.join(', ')}.`;
  }
  return null;
}

function noLaneEvidence(input: ReviewStatsInput, reason: string): ReviewStatsPullRequest {
  return {
    number: input.number,
    title: input.title,
    reviewedHeads: null,
    failingHeads: null,
    blockingEntries: null,
    firstReviewClean: null,
    noLaneEvidence: true,
    noLaneEvidenceReason: reason,
  };
}

function summarizePullRequest(input: ReviewStatsInput): {
  pullRequest: ReviewStatsPullRequest;
  blockingAfterFirstHead: number;
  laneCounts: Map<string, number>;
} {
  if (input.unavailableReason) {
    return { pullRequest: noLaneEvidence(input, input.unavailableReason), blockingAfterFirstHead: 0, laneCounts: new Map() };
  }
  const parsed = parseLaneReviews(input.trustedLaneReviews);
  if (!parsed.records) {
    return { pullRequest: noLaneEvidence(input, parsed.reason), blockingAfterFirstHead: 0, laneCounts: new Map() };
  }
  const incompleteReason = incompleteLaneReason(parsed.records);
  if (incompleteReason) {
    return { pullRequest: noLaneEvidence(input, incompleteReason), blockingAfterFirstHead: 0, laneCounts: new Map() };
  }

  const reviewedHeads = [...new Set(parsed.records.map(record => record.head))];
  const firstHead = reviewedHeads[0];
  const firstHeadRecords = parsed.records.filter(record => record.head === firstHead);
  const failingHeads = new Set(parsed.records.filter(record => record.recommendation === 'request-changes').map(record => record.head));
  const blockingRecords = parsed.records.filter(record => record.recommendation === 'request-changes');
  const laneCounts = new Map<string, number>();
  let blockingEntries = 0;
  let blockingAfterFirstHead = 0;
  for (const record of blockingRecords) {
    blockingEntries += record.blockingFindingCount;
    if (record.head !== firstHead) blockingAfterFirstHead += record.blockingFindingCount;
    if (record.blockingFindingCount > 0) laneCounts.set(record.lane, (laneCounts.get(record.lane) ?? 0) + record.blockingFindingCount);
  }

  return {
    pullRequest: {
      number: input.number,
      title: input.title,
      reviewedHeads: reviewedHeads.length,
      failingHeads: failingHeads.size,
      blockingEntries,
      firstReviewClean: firstHeadRecords.every(record => record.recommendation === 'approve'),
      noLaneEvidence: false,
      noLaneEvidenceReason: null,
    },
    blockingAfterFirstHead,
    laneCounts,
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function computeReviewStats(inputs: readonly ReviewStatsInput[]): Pick<ReviewStatsResult, 'pullRequests' | 'summary'> {
  const orderedInputs = [...inputs].sort((left, right) => {
    const leftClosedAt = left.closedAt ?? '';
    const rightClosedAt = right.closedAt ?? '';
    if (leftClosedAt !== '' || rightClosedAt !== '') return (Date.parse(rightClosedAt) || 0) - (Date.parse(leftClosedAt) || 0) || right.number - left.number;
    return right.number - left.number;
  });
  const summaries = orderedInputs.map(summarizePullRequest);
  const pullRequests = summaries.map(summary => summary.pullRequest);
  const reviewed = pullRequests.filter(pullRequest => !pullRequest.noLaneEvidence);
  const firstReviewCleanPullRequests = reviewed.filter(pullRequest => pullRequest.firstReviewClean === true).length;
  const blockingEntries = reviewed.reduce((total, pullRequest) => total + (pullRequest.blockingEntries ?? 0), 0);
  const blockingEntriesAfterFirstHead = summaries.reduce((total, summary) => total + summary.blockingAfterFirstHead, 0);
  const laneTotals = new Map<string, number>();
  for (const summary of summaries) {
    for (const [lane, count] of summary.laneCounts) laneTotals.set(lane, (laneTotals.get(lane) ?? 0) + count);
  }

  return {
    pullRequests,
    summary: {
      pullRequests: pullRequests.length,
      reviewedPullRequests: reviewed.length,
      noLaneEvidencePullRequests: pullRequests.length - reviewed.length,
      firstReviewCleanPullRequests,
      firstReviewCleanRate: reviewed.length === 0 ? null : firstReviewCleanPullRequests / reviewed.length,
      medianReviewedHeads: median(reviewed.map(pullRequest => pullRequest.reviewedHeads as number)),
      blockingEntries,
      blockingEntriesAfterFirstHead,
      blockingEntriesAfterFirstHeadShare: blockingEntries === 0 ? null : blockingEntriesAfterFirstHead / blockingEntries,
      blockingEntriesByLane: [...laneTotals.entries()]
        .map(([lane, count]) => ({ lane, blockingEntries: count }))
        .sort((left, right) => left.lane.localeCompare(right.lane)),
    },
  };
}

export function reviewStatsWindow(value: number | undefined): number {
  const window = value ?? DEFAULT_REVIEW_STATS_WINDOW;
  if (!Number.isSafeInteger(window) || window < 1) {
    throw createCliError({ command: 'review stats', kind: 'invalid-review-stats-window', operation: 'validate review stats window', likelyCause: 'Review stats window must be a positive integer.', suggestedNextAction: 'Use `--window 20` or another integer from 1 to 50.', category: 'validation' });
  }
  if (window > MAX_REVIEW_STATS_WINDOW) {
    throw createCliError({ command: 'review stats', kind: 'invalid-review-stats-window', operation: 'validate review stats window', likelyCause: `Review stats window cannot exceed ${MAX_REVIEW_STATS_WINDOW}.`, suggestedNextAction: `Use \`--window ${MAX_REVIEW_STATS_WINDOW}\` or a smaller value.`, category: 'validation' });
  }
  return window;
}

function inputFromHistory(pr: ReviewForgePullRequest, history: Awaited<ReturnType<NonNullable<ReviewForgeProvider['loadLaneReviewHistory']>>>): ReviewStatsInput {
  return {
    number: pr.number,
    title: pr.title,
    closedAt: pr.closedAt,
    trustedLaneReviews: history.trustedLaneReviews,
    unavailableReason: history.unavailableReason,
  };
}

async function loadReviewStatsInput(provider: ReviewForgeProvider, pr: ReviewForgePullRequest): Promise<ReviewStatsInput> {
  try {
    const history = await provider.loadLaneReviewHistory!(pr.number);
    return inputFromHistory(pr, history);
  } catch {
    return {
      number: pr.number,
      title: pr.title,
      closedAt: pr.closedAt,
      trustedLaneReviews: null,
      unavailableReason: 'Trusted lane review metadata could not be loaded from the configured review provider.',
    };
  }
}

export async function runReviewStatsWithProvider(provider: ReviewForgeProvider, options: Pick<ReviewStatsOptions, 'window'> = {}): Promise<ReviewStatsResult> {
  const window = reviewStatsWindow(options.window);
  if (!supportsReviewStats(provider)) {
    throw createCliError({ command: 'review stats', kind: 'review-stats-unsupported', operation: 'load review convergence statistics', likelyCause: `The configured ${provider.id} review provider does not declare the complete review stats capability.`, suggestedNextAction: 'Select a provider with bounded recent pull request listing and lane review history support.', category: 'validation' });
  }
  const listedPullRequests = await provider.listRecentPullRequests({ limit: window });
  const seen = new Set<number>();
  const recentPullRequests = listedPullRequests.filter(pr => {
    if (seen.has(pr.number)) return false;
    seen.add(pr.number);
    return true;
  }).slice(0, window);
  const inputs: ReviewStatsInput[] = [];
  for (let start = 0; start < recentPullRequests.length; start += REVIEW_STATS_LOAD_CONCURRENCY) {
    const batch = recentPullRequests.slice(start, start + REVIEW_STATS_LOAD_CONCURRENCY);
    inputs.push(...await Promise.all(batch.map(pr => loadReviewStatsInput(provider, pr))));
  }
  const computed = computeReviewStats(inputs);
  return {
    ok: true,
    command: 'review stats',
    provider: provider.id,
    window,
    ...computed,
    warnings: [
      'Only structured QUBE lane review metadata trusted by the configured provider is counted; all other PR content is ignored.',
    ],
    nextAction: 'Compare this bounded window with an earlier run after guidance changes, and use the lane breakdown to target remaining first-pass findings.',
  };
}

export async function runReviewStats(options: ReviewStatsOptions = {}): Promise<ReviewStatsResult> {
  const window = reviewStatsWindow(options.window);
  const root = options.repoRoot ?? process.cwd();
  const config = await loadConfig(root) ?? getDefaults();
  const provider = await createReviewForgeProvider(config.providers.review.kind, {
    cwd: root,
    reviewAgents: config.reviewAgents,
    publisher: config.providers.review.publisher ?? null,
    ...config.providers.connections[config.providers.review.kind],
    ...config.providers.review.connection,
  });
  return runReviewStatsWithProvider(provider, { window });
}

function percent(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function cell(value: number | boolean | null): string {
  if (value === null) return '-';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value);
}

function tableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/[\u0000-\u001f\u007f]+/g, ' ');
}

export function formatReviewStats(result: ReviewStatsResult): string {
  const lines = [`Review convergence stats (latest ${result.window} merged or closed PRs; provider=${result.provider})`];
  lines.push('PR | Title | Reviewed heads | Failing heads | Blocking entries | First review clean | Lane evidence');
  for (const pr of result.pullRequests) {
    lines.push(`#${pr.number} | ${tableCell(pr.title)} | ${cell(pr.reviewedHeads)} | ${cell(pr.failingHeads)} | ${cell(pr.blockingEntries)} | ${cell(pr.firstReviewClean)} | ${pr.noLaneEvidence ? `none: ${tableCell(pr.noLaneEvidenceReason ?? 'unknown')}` : 'present'}`);
  }
  lines.push('', 'Rolling summary:');
  lines.push(`- Pull requests: ${result.summary.pullRequests}`);
  lines.push(`- Reviewed pull requests: ${result.summary.reviewedPullRequests}`);
  lines.push(`- No lane evidence: ${result.summary.noLaneEvidencePullRequests}`);
  lines.push(`- First-review-clean: ${result.summary.firstReviewCleanPullRequests}/${result.summary.reviewedPullRequests} (${percent(result.summary.firstReviewCleanRate)})`);
  lines.push(`- Median reviewed heads: ${result.summary.medianReviewedHeads ?? 'n/a'}`);
  lines.push(`- Blocking entries: ${result.summary.blockingEntries}`);
  lines.push(`- Blocking entries after first head: ${result.summary.blockingEntriesAfterFirstHead}/${result.summary.blockingEntries} (${percent(result.summary.blockingEntriesAfterFirstHeadShare)})`);
  lines.push('- Blocking entries by lane:');
  if (result.summary.blockingEntriesByLane.length === 0) lines.push('  - none');
  for (const lane of result.summary.blockingEntriesByLane) lines.push(`  - ${tableCell(lane.lane)}: ${lane.blockingEntries}`);
  for (const warning of result.warnings) lines.push(`Warning: ${warning}`);
  lines.push(`Next action: ${result.nextAction}`);
  return lines.join('\n');
}
