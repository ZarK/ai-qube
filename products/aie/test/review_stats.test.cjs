const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
const { describe, it } = require('node:test');

const {
  MAX_REVIEW_STATS_WINDOW,
  computeReviewStats,
  formatReviewStats,
  reviewStatsWindow,
  runReviewStatsWithProvider,
} = require('../dist/app/review_stats.js');
const { getCommandMetadata } = require('../dist/command_metadata.js');

function lane({ head, lane, recommendation = 'approve', status = 'passed', bodyFindingCount = 0, blockingFindingCount = bodyFindingCount, publishedAt = '2026-01-01T00:00:00Z' }) {
  return { head, lane, recommendation, status, bodyFindingCount, blockingFindingCount, publishedAt };
}

function pullRequest(number, title = `PR ${number}`) {
  return {
    number,
    title,
    state: 'MERGED',
    url: `https://example.invalid/pull/${number}`,
    headRefOid: `head-${number}`,
    reviewDecision: 'APPROVED',
    mergeStateStatus: 'CLEAN',
    mergeable: 'MERGEABLE',
    isDraft: false,
  };
}

function providerFixture(entries, options = {}) {
  const calls = { list: [], history: [] };
  const provider = {
    id: options.id ?? 'github',
    capabilities: () => ({ loadReview: true, findCurrentBranchReview: true, planReviewRequests: false, applyReviewRequests: false }),
    listRecentPullRequests: options.unsupported ? undefined : async input => {
      calls.list.push(input);
      return entries.map(entry => entry.pr);
    },
    loadLaneReviewHistory: options.unsupportedHistory ? undefined : async number => {
      calls.history.push(number);
      const entry = entries.find(candidate => candidate.pr.number === number);
      if (!entry || entry.error) throw new Error('fixture load failed');
      return { trustedLaneReviews: entry.laneReviews, unavailableReason: entry.unavailableReason ?? null };
    },
  };
  return { provider, calls };
}

describe('review convergence stats', () => {
  const mixedInputs = [
    {
      number: 100,
      title: 'Clean first head then one failing head',
      trustedLaneReviews: [
        lane({ head: 'a', lane: 'issue-compliance' }),
        lane({ head: 'b', lane: 'issue-compliance', recommendation: 'request-changes', status: 'needs-work', bodyFindingCount: 2 }),
      ],
    },
    {
      number: 102,
      title: 'Three reviewed heads',
      trustedLaneReviews: [
        lane({ head: 'a', lane: 'code-quality', recommendation: 'request-changes', status: 'failed', bodyFindingCount: 2 }),
        lane({ head: 'a', lane: 'issue-compliance' }),
        lane({ head: 'b', lane: 'code-quality', recommendation: 'request-changes', status: 'failed', bodyFindingCount: 1 }),
        lane({ head: 'b', lane: 'performance', recommendation: 'request-changes', status: 'needs-work', bodyFindingCount: 2 }),
        lane({ head: 'c', lane: 'code-quality' }),
      ],
    },
    { number: 103, title: 'No lane evidence', trustedLaneReviews: [] },
    {
      number: 101,
      title: 'Clean first review',
      trustedLaneReviews: [
        lane({ head: 'a', lane: 'code-quality' }),
        lane({ head: 'a', lane: 'issue-compliance' }),
      ],
    },
  ];

  it('computes per-PR and rolling values for clean, multi-head, and no-evidence PRs', () => {
    const result = computeReviewStats(mixedInputs);

    assert.deepEqual(result.pullRequests.map(pr => pr.number), [103, 102, 101, 100]);
    assert.deepEqual(result.pullRequests[1], {
      number: 102,
      title: 'Three reviewed heads',
      reviewedHeads: 3,
      failingHeads: 2,
      blockingEntries: 5,
      blockingEntriesEstimated: false,
      firstReviewClean: false,
      noLaneEvidence: false,
      noLaneEvidenceReason: null,
    });
    assert.deepEqual(result.pullRequests[0], {
      number: 103,
      title: 'No lane evidence',
      reviewedHeads: null,
      failingHeads: null,
      blockingEntries: null,
      blockingEntriesEstimated: null,
      firstReviewClean: null,
      noLaneEvidence: true,
      noLaneEvidenceReason: 'No trusted QUBE lane review metadata was found.',
    });
    assert.deepEqual(result.summary, {
      pullRequests: 4,
      reviewedPullRequests: 3,
      noLaneEvidencePullRequests: 1,
      firstReviewCleanPullRequests: 2,
      firstReviewCleanRate: 2 / 3,
      medianReviewedHeads: 2,
      blockingEntries: 7,
      blockingEntriesAfterFirstHead: 5,
      blockingEntriesAfterFirstHeadShare: 5 / 7,
      blockingEntriesByLane: [
        { lane: 'code-quality', blockingEntries: 3 },
        { lane: 'issue-compliance', blockingEntries: 2 },
        { lane: 'performance', blockingEntries: 2 },
      ],
      estimatedBlockingEntriesPullRequests: 0,
    });
  });

  it('is deterministic for identical fixture input', () => {
    assert.deepEqual(computeReviewStats(mixedInputs), computeReviewStats(mixedInputs));
  });

  it('degrades malformed metadata to no lane evidence with a reason', () => {
    const result = computeReviewStats([{
      number: 104,
      title: 'Malformed metadata',
      trustedLaneReviews: [{ head: 'abc', lane: 'code-quality', recommendation: 'request-changes', bodyFindingCount: 1 }],
    }]);

    assert.equal(result.pullRequests[0].noLaneEvidence, true);
    assert.equal(result.pullRequests[0].reviewedHeads, null);
    assert.match(result.pullRequests[0].noLaneEvidenceReason, /missing a valid head, lane, recommendation, status, or publication time/);
    assert.equal(result.summary.reviewedPullRequests, 0);
    assert.equal(result.summary.firstReviewCleanRate, null);
  });

  it('uses one bounded listing request and degrades an individual load failure', async () => {
    const entries = [
      { pr: pullRequest(202), laneReviews: [lane({ head: 'a', lane: 'code-quality' })] },
      { pr: pullRequest(201), error: true },
    ];
    const fixture = providerFixture(entries);
    const result = await runReviewStatsWithProvider(fixture.provider, { window: 2 });

    assert.deepEqual(fixture.calls.list, [{ limit: 2 }]);
    assert.deepEqual(fixture.calls.history, [202, 201]);
    assert.equal(result.pullRequests[1].noLaneEvidence, true);
    assert.match(result.pullRequests[1].noLaneEvidenceReason, /could not be loaded/);
    assert.equal(result.summary.reviewedPullRequests, 1);
  });

  it('bounds concurrent per-PR review loads while preserving deterministic output order', async () => {
    let activeLoads = 0;
    let maximumActiveLoads = 0;
    const prs = [406, 405, 404, 403, 402, 401].map(number => pullRequest(number));
    const provider = {
      id: 'github',
      listRecentPullRequests: async () => prs,
      loadLaneReviewHistory: async number => {
        activeLoads += 1;
        maximumActiveLoads = Math.max(maximumActiveLoads, activeLoads);
        await new Promise(resolve => setTimeout(resolve, 5));
        activeLoads -= 1;
        return { trustedLaneReviews: [lane({ head: `head-${number}`, lane: 'code-quality' })], unavailableReason: null };
      },
    };

    const result = await runReviewStatsWithProvider(provider, { window: 6 });

    assert.equal(maximumActiveLoads, 4);
    assert.deepEqual(result.pullRequests.map(pr => pr.number), [406, 405, 404, 403, 402, 401]);
  });

  it('rejects unsupported providers and windows beyond the hard cap', async () => {
    assert.equal(reviewStatsWindow(undefined), 20);
    assert.throws(() => reviewStatsWindow(0), /positive integer/);
    assert.throws(() => reviewStatsWindow(MAX_REVIEW_STATS_WINDOW + 1), /cannot exceed 50.*--window 50/);

    const fixture = providerFixture([], { id: 'gitlab', unsupported: true });
    await assert.rejects(() => runReviewStatsWithProvider(fixture.provider, { window: 20 }), /not supported by the configured gitlab review provider/);
  });

  it('renders every JSON result field in human output from the same structure', async () => {
    const fixture = providerFixture([{ pr: pullRequest(300, 'Visible stats'), laneReviews: [lane({ head: 'a', lane: 'code-quality' })] }]);
    const result = await runReviewStatsWithProvider(fixture.provider, { window: 1 });
    const human = formatReviewStats(result);

    assert.match(human, /#300 \| Visible stats \| 1 \| 0 \| 0 \| no \| yes \| present/);
    assert.match(human, /Pull requests: 1/);
    assert.match(human, /Reviewed pull requests: 1/);
    assert.match(human, /First-review-clean: 1\/1 \(100\.0%\)/);
    assert.match(human, /Median reviewed heads: 1/);
    assert.match(human, /legacy estimated blocking counts: 0/);
    assert.match(human, /Blocking entries after first head: 0\/0 \(n\/a\)/);
    assert.match(human, new RegExp(`provider=${result.provider}`));
    assert.match(human, new RegExp(`Next action: ${result.nextAction.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  });

  it('uses provider publication time for the first reviewed head and rejects invalid state pairs', () => {
    const chronological = computeReviewStats([{
      number: 301,
      title: 'Chronological history',
      trustedLaneReviews: [
        lane({ head: 'later', lane: 'code-quality', recommendation: 'request-changes', status: 'failed', bodyFindingCount: 1, publishedAt: '2026-02-02T00:00:00Z' }),
        lane({ head: 'first', lane: 'code-quality', publishedAt: '2026-02-01T00:00:00Z' }),
      ],
    }]);
    assert.equal(chronological.pullRequests[0].firstReviewClean, true);
    assert.equal(chronological.summary.blockingEntriesAfterFirstHead, 1);

    const invalid = computeReviewStats([{
      number: 302,
      title: 'Invalid state pair',
      trustedLaneReviews: [lane({ head: 'a', lane: 'code-quality', recommendation: 'request-changes', status: 'passed' })],
    }]);
    assert.equal(invalid.pullRequests[0].noLaneEvidence, true);
    assert.match(invalid.pullRequests[0].noLaneEvidenceReason, /invalid recommendation and status combination/);
  });

  it('does not report an incomplete first head as clean', () => {
    const result = computeReviewStats([{
      number: 303,
      title: 'Incomplete first head',
      trustedLaneReviews: [lane({
        head: 'a',
        lane: 'code-quality',
        recommendation: 'pending',
        status: 'pending',
      })],
    }]);

    assert.equal(result.pullRequests[0].firstReviewClean, false);
    assert.equal(result.pullRequests[0].failingHeads, 0);
  });

  it('marks legacy request-changes body counts as estimates', async () => {
    const legacy = lane({ head: 'a', lane: 'code-quality', recommendation: 'request-changes', status: 'failed', bodyFindingCount: 2 });
    delete legacy.blockingFindingCount;
    const fixture = providerFixture([{ pr: pullRequest(303), laneReviews: [legacy] }]);
    const result = await runReviewStatsWithProvider(fixture.provider, { window: 1 });

    assert.equal(result.pullRequests[0].blockingEntries, 2);
    assert.equal(result.pullRequests[0].blockingEntriesEstimated, true);
    assert.equal(result.summary.estimatedBlockingEntriesPullRequests, 1);
    assert.match(result.warnings.join(' '), /legacy request-changes body finding count/);
  });

  it('registers the read-only JSON command and bounded window flag', () => {
    const command = getCommandMetadata('review stats');
    const windowFlag = command.flagDetails.find(flag => flag.name === '--window');

    assert.equal(command.supportsJson, true);
    assert.deepEqual(command.mutationTargets, []);
    assert.equal(windowFlag.default, 20);
    assert.match(windowFlag.description, /maximum 50/);
  });

  it('enforces the hard cap through the executable JSON command path', () => {
    const run = spawnSync(process.execPath, [join(process.cwd(), 'bin', 'run'), 'review', 'stats', '--window', '51', '--json'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    const result = JSON.parse(run.stdout);

    assert.equal(run.status, 1);
    assert.equal(result.ok, false);
    assert.equal(result.command, 'review stats');
    assert.match(result.error, /cannot exceed 50.*--window 50/);
  });
});
