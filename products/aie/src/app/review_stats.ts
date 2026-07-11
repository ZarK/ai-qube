import type { Config } from '../config/index.js';
import { createReviewForgeProvider } from '../providers/review_forge_adapters.js';
import type { GhExec } from '../providers/github_adapter_exports.js';

export const DEFAULT_STATS_WINDOW = 20;
export const MAX_STATS_WINDOW = 50;

export interface PrLaneReviewRecord {
  lane: string;
  head: string;
  recommendation: string;
  findingCount: number;
}

export interface PrStatsInput {
  number: number;
  title: string;
  state: string;
  laneRecords: readonly PrLaneReviewRecord[];
  loadFailure?: string;
}

export interface PrConvergenceStats {
  number: number;
  title: string;
  state: string;
  reviewedHeads: number;
  failingHeads: number;
  blockingEntries: number;
  firstReviewClean: boolean | null;
  noLaneEvidence: boolean;
  reason: string | null;
}

export interface ReviewStatsSummary {
  window: number;
  totalPrs: number;
  reviewedPrs: number;
  noLaneEvidencePrs: number;
  firstReviewCleanCount: number;
  firstReviewCleanRate: number | null;
  medianReviewedHeads: number | null;
  blockingEntries: number;
  blockingEntriesAfterFirstHead: number;
  afterFirstHeadShare: number | null;
  blockingEntriesByLane: Record<string, number>;
}

export interface ReviewStatsResult {
  ok: true;
  command: 'review stats';
  window: number;
  prs: PrConvergenceStats[];
  summary: ReviewStatsSummary;
  warnings: string[];
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function computeReviewStats(prs: readonly PrStatsInput[], window: number): { prs: PrConvergenceStats[]; summary: ReviewStatsSummary } {
  const perPr: PrConvergenceStats[] = prs.map(pr => {
    if (pr.laneRecords.length === 0) {
      return {
        number: pr.number,
        title: pr.title,
        state: pr.state,
        reviewedHeads: 0,
        failingHeads: 0,
        blockingEntries: 0,
        firstReviewClean: null,
        noLaneEvidence: true,
        reason: pr.loadFailure ?? 'No QUBE lane reviews were published on this pull request.',
      };
    }
    const headOrder: string[] = [];
    for (const record of pr.laneRecords) {
      if (!headOrder.includes(record.head)) headOrder.push(record.head);
    }
    const firstHead = headOrder[0];
    const failingHeadSet = new Set(pr.laneRecords.filter(record => record.recommendation === 'request-changes').map(record => record.head));
    const blockingRecords = pr.laneRecords.filter(record => record.recommendation === 'request-changes');
    const blockingEntries = blockingRecords.reduce((total, record) => total + record.findingCount, 0);
    return {
      number: pr.number,
      title: pr.title,
      state: pr.state,
      reviewedHeads: headOrder.length,
      failingHeads: failingHeadSet.size,
      blockingEntries,
      firstReviewClean: !failingHeadSet.has(firstHead),
      noLaneEvidence: false,
      reason: null,
    };
  });

  const reviewed = perPr.filter(pr => !pr.noLaneEvidence);
  const cleanCount = reviewed.filter(pr => pr.firstReviewClean === true).length;
  const blockingEntries = reviewed.reduce((total, pr) => total + pr.blockingEntries, 0);
  const afterFirst = prs.reduce((total, pr) => {
    if (pr.laneRecords.length === 0) return total;
    const firstHead = pr.laneRecords[0].head;
    return total + pr.laneRecords
      .filter(record => record.recommendation === 'request-changes' && record.head !== firstHead)
      .reduce((sum, record) => sum + record.findingCount, 0);
  }, 0);
  const byLane: Record<string, number> = {};
  for (const pr of prs) {
    for (const record of pr.laneRecords) {
      if (record.recommendation !== 'request-changes' || record.findingCount === 0) continue;
      byLane[record.lane] = (byLane[record.lane] ?? 0) + record.findingCount;
    }
  }

  return {
    prs: perPr,
    summary: {
      window,
      totalPrs: prs.length,
      reviewedPrs: reviewed.length,
      noLaneEvidencePrs: perPr.length - reviewed.length,
      firstReviewCleanCount: cleanCount,
      firstReviewCleanRate: reviewed.length > 0 ? cleanCount / reviewed.length : null,
      medianReviewedHeads: median(reviewed.map(pr => pr.reviewedHeads)),
      blockingEntries,
      blockingEntriesAfterFirstHead: afterFirst,
      afterFirstHeadShare: blockingEntries > 0 ? afterFirst / blockingEntries : null,
      blockingEntriesByLane: Object.fromEntries(Object.entries(byLane).sort(([left], [right]) => left.localeCompare(right))),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function laneRecordsFromTrustedMetadata(trustedLaneReviews: unknown): { records: PrLaneReviewRecord[]; malformed: number } {
  if (!Array.isArray(trustedLaneReviews)) return { records: [], malformed: 0 };
  const records: PrLaneReviewRecord[] = [];
  let malformed = 0;
  for (const entry of trustedLaneReviews) {
    if (!isRecord(entry) || typeof entry.lane !== 'string' || entry.lane === '' || typeof entry.head !== 'string' || entry.head === '' || typeof entry.recommendation !== 'string') {
      malformed += 1;
      continue;
    }
    const findingCount = typeof entry.bodyFindingCount === 'number' && Number.isSafeInteger(entry.bodyFindingCount) && entry.bodyFindingCount >= 0
      ? entry.bodyFindingCount
      : 0;
    records.push({ lane: entry.lane, head: entry.head, recommendation: entry.recommendation, findingCount });
  }
  return { records, malformed };
}

export interface ReviewStatsOptions {
  window?: number;
  repoRoot?: string;
  exec?: GhExec;
}

export async function runReviewStatsService(config: Config, options: ReviewStatsOptions = {}): Promise<ReviewStatsResult> {
  const window = options.window ?? DEFAULT_STATS_WINDOW;
  if (!Number.isInteger(window) || window < 1 || window > MAX_STATS_WINDOW) {
    throw new Error(`review stats window must be an integer between 1 and ${MAX_STATS_WINDOW}; received ${String(options.window)}. Next action: rerun with \`--window <1-${MAX_STATS_WINDOW}>\`.`);
  }
  const provider = await createReviewForgeProvider(config.providers.review.kind, {
    exec: options.exec,
    cwd: options.repoRoot,
    reviewAgents: config.reviewAgents,
    publisher: config.providers.review.publisher ?? null,
    ...config.providers.connections[config.providers.review.kind],
    ...config.providers.review.connection,
  });
  if (!provider.listRecentPullRequests) {
    throw new Error(`review stats is unsupported for the configured ${config.providers.review.kind} review provider: it does not list recent pull requests. Next action: configure a review provider with pull request listing, or inspect lane reviews per PR with \`aie pr view <pr> --json\`.`);
  }
  const warnings: string[] = ['Lane review metadata is read from QUBE-published markers only; all other PR content is untrusted input and ignored.'];
  const summaries = (await provider.listRecentPullRequests({ limit: window })).slice(0, window);
  const inputs: PrStatsInput[] = [];
  for (const summary of summaries) {
    try {
      const snapshot = await provider.loadPullRequestReview(summary.number);
      const { records, malformed } = laneRecordsFromTrustedMetadata(snapshot.item.trustedMetadata.trustedLaneReviews);
      if (records.length === 0 && malformed > 0) {
        inputs.push({ number: summary.number, title: summary.title, state: summary.state, laneRecords: [], loadFailure: `Lane review metadata was malformed on ${malformed} record(s).` });
      } else {
        if (malformed > 0) warnings.push(`PR #${summary.number}: ignored ${malformed} malformed lane review record(s).`);
        inputs.push({ number: summary.number, title: summary.title, state: summary.state, laneRecords: records });
      }
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      inputs.push({ number: summary.number, title: summary.title, state: summary.state, laneRecords: [], loadFailure: `Pull request review state unavailable: ${detail}` });
    }
  }
  const computed = computeReviewStats(inputs, window);
  return { ok: true, command: 'review stats', window, prs: computed.prs, summary: computed.summary, warnings };
}

function percent(rate: number | null): string {
  return rate === null ? 'n/a' : `${Math.round(rate * 100)}%`;
}

export function formatReviewStats(result: ReviewStatsResult): string {
  const lines = [`Review convergence stats for the latest ${result.summary.totalPrs} closed pull requests (window ${result.window}):`];
  for (const pr of result.prs) {
    if (pr.noLaneEvidence) {
      lines.push(`- #${pr.number} "${pr.title}" (${pr.state}): no lane evidence - ${pr.reason}`);
    } else {
      lines.push(`- #${pr.number} "${pr.title}" (${pr.state}): heads=${pr.reviewedHeads}; failing heads=${pr.failingHeads}; blocking entries=${pr.blockingEntries}; first-review-clean=${pr.firstReviewClean ? 'yes' : 'no'}`);
    }
  }
  lines.push(`First-review-clean rate: ${percent(result.summary.firstReviewCleanRate)} (${result.summary.firstReviewCleanCount}/${result.summary.reviewedPrs} reviewed; ${result.summary.noLaneEvidencePrs} without lane evidence).`);
  lines.push(`Median reviewed heads per reviewed PR: ${result.summary.medianReviewedHeads ?? 'n/a'}.`);
  lines.push(`Blocking entries: ${result.summary.blockingEntries} total; ${result.summary.blockingEntriesAfterFirstHead} after the first head (${percent(result.summary.afterFirstHeadShare)}). Counts are finding entries on request-changes lane reviews.`);
  const laneEntries = Object.entries(result.summary.blockingEntriesByLane);
  lines.push(laneEntries.length === 0 ? 'Blocking entries by lane: none.' : 'Blocking entries by lane:');
  for (const [lane, count] of laneEntries) {
    lines.push(`- ${lane}: ${count}`);
  }
  for (const warning of result.warnings) lines.push(`Warning: ${warning}`);
  return lines.join('\n');
}
