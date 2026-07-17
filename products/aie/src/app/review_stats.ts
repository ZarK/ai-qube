import { getDefaults, loadConfig } from '../config/index.js';
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
  bodyFindingCount: number;
}

export interface ReviewStatsInput {
  number: number;
  title: string;
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
    if (!nonEmptyString(candidate.head) || !nonEmptyString(candidate.lane) || !isLaneRecommendation(candidate.recommendation) || !nonEmptyString(candidate.status)) {
      return { records: null, reason: `Trusted QUBE lane review metadata record ${index + 1} was missing a valid head, lane, recommendation, or status.` };
    }
    const bodyFindingCount = candidate.bodyFindingCount;
    if (bodyFindingCount !== null && bodyFindingCount !== undefined && !nonNegativeInteger(bodyFindingCount)) {
      return { records: null, reason: `Trusted QUBE lane review metadata record ${index + 1} had an invalid bodyFindingCount.` };
    }
    if (candidate.recommendation === 'request-changes' && !nonNegativeInteger(bodyFindingCount)) {
      return { records: null, reason: `Trusted QUBE lane review metadata record ${index + 1} did not provide a valid blocking finding count.` };
    }
    records.push({
      head: candidate.head,
      lane: candidate.lane,
      recommendation: candidate.recommendation,
      bodyFindingCount: nonNegativeInteger(bodyFindingCount) ? bodyFindingCount : 0,
    });
  }
  return { records, reason: null };
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

  const reviewedHeads = [...new Set(parsed.records.map(record => record.head))];
  const firstHead = reviewedHeads[0];
  const failingHeads = new Set(parsed.records.filter(record => record.recommendation === 'request-changes').map(record => record.head));
  const blockingRecords = parsed.records.filter(record => record.recommendation === 'request-changes');
  const laneCounts = new Map<string, number>();
  let blockingEntries = 0;
  let blockingAfterFirstHead = 0;
  for (const record of blockingRecords) {
    blockingEntries += record.bodyFindingCount;
    if (record.head !== firstHead) blockingAfterFirstHead += record.bodyFindingCount;
    if (record.bodyFindingCount > 0) laneCounts.set(record.lane, (laneCounts.get(record.lane) ?? 0) + record.bodyFindingCount);
  }

  return {
    pullRequest: {
      number: input.number,
      title: input.title,
      reviewedHeads: reviewedHeads.length,
      failingHeads: failingHeads.size,
      blockingEntries,
      firstReviewClean: !failingHeads.has(firstHead),
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
  const orderedInputs = [...inputs].sort((left, right) => right.number - left.number);
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
    throw new Error('Review stats window must be a positive integer. Use `--window 20`.');
  }
  if (window > MAX_REVIEW_STATS_WINDOW) {
    throw new Error(`Review stats window cannot exceed ${MAX_REVIEW_STATS_WINDOW}. Use \`--window ${MAX_REVIEW_STATS_WINDOW}\` or a smaller value.`);
  }
  return window;
}

function unavailableReason(unavailable: readonly string[]): string | null {
  return unavailable.some(reason => /PR issue comments unavailable/i.test(reason))
    ? 'Trusted lane review metadata was unavailable from the configured review provider.'
    : null;
}

function inputFromSnapshot(pr: ReviewForgePullRequest, snapshot: Awaited<ReturnType<ReviewForgeProvider['loadPullRequestReview']>>): ReviewStatsInput {
  const trustedLaneReviews = snapshot.item.trustedMetadata.trustedLaneReviews;
  return {
    number: pr.number,
    title: pr.title,
    trustedLaneReviews,
    unavailableReason: Array.isArray(trustedLaneReviews) && trustedLaneReviews.length > 0 ? null : unavailableReason(snapshot.unavailable),
  };
}

async function loadReviewStatsInput(provider: ReviewForgeProvider, pr: ReviewForgePullRequest): Promise<ReviewStatsInput> {
  try {
    const snapshot = await provider.loadPullRequestReview(pr.number);
    return inputFromSnapshot(pr, snapshot);
  } catch {
    return {
      number: pr.number,
      title: pr.title,
      trustedLaneReviews: null,
      unavailableReason: 'Trusted lane review metadata could not be loaded from the configured review provider.',
    };
  }
}

export async function runReviewStatsWithProvider(provider: ReviewForgeProvider, options: Pick<ReviewStatsOptions, 'window'> = {}): Promise<ReviewStatsResult> {
  const window = reviewStatsWindow(options.window);
  if (!provider.listRecentPullRequests) {
    throw new Error(`Review stats are not supported by the configured ${provider.id} review provider. Select a provider with bounded recent pull request listing support.`);
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
    warnings: ['Only structured QUBE lane review metadata trusted by the configured provider is counted; all other PR content is ignored.'],
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

export function formatReviewStats(result: ReviewStatsResult): string {
  const lines = [`Review convergence stats (latest ${result.window} merged or closed PRs; provider=${result.provider})`];
  lines.push('PR | Title | Reviewed heads | Failing heads | Blocking entries | First review clean | Lane evidence');
  for (const pr of result.pullRequests) {
    lines.push(`#${pr.number} | ${pr.title} | ${cell(pr.reviewedHeads)} | ${cell(pr.failingHeads)} | ${cell(pr.blockingEntries)} | ${cell(pr.firstReviewClean)} | ${pr.noLaneEvidence ? `none: ${pr.noLaneEvidenceReason}` : 'present'}`);
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
  for (const lane of result.summary.blockingEntriesByLane) lines.push(`  - ${lane.lane}: ${lane.blockingEntries}`);
  for (const warning of result.warnings) lines.push(`Warning: ${warning}`);
  lines.push(`Next action: ${result.nextAction}`);
  return lines.join('\n');
}
