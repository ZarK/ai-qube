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

function lane({ head, lane, recommendation = 'approve', status = 'passed', bodyFindingCount = 0 }) {
  return { head, lane, recommendation, status, bodyFindingCount };
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

function snapshot(pr, trustedLaneReviews, unavailable = []) {
  return {
    item: { trustedMetadata: { trustedLaneReviews } },
    pr,
    ciDiagnostics: [],
    closingIssueNumbers: [],
    reviewRequests: [],
    commentsCount: 0,
    reviewsCount: 0,
    reviewCommentsCount: 0,
    unresolvedThreadsCount: 0,
    unavailable,
  };
}

function providerFixture(entries, options = {}) {
  const calls = { list: [], load: [] };
  const provider = {
    id: options.id ?? 'github',
    capabilities: () => ({ loadReview: true, findCurrentBranchReview: true, planReviewRequests: false, applyReviewRequests: false }),
    listRecentPullRequests: options.unsupported ? undefined : async input => {
      calls.list.push(input);
      return entries.map(entry => entry.pr);
    },
    loadPullRequestReview: async number => {
      calls.load.push(number);
      const entry = entries.find(candidate => candidate.pr.number === number);
      if (!entry || entry.error) throw new Error('fixture load failed');
      return snapshot(entry.pr, entry.laneReviews, entry.unavailable);
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
    assert.match(result.pullRequests[0].noLaneEvidenceReason, /missing a valid head, lane, recommendation, or status/);
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
    assert.deepEqual(fixture.calls.load, [202, 201]);
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
      loadPullRequestReview: async number => {
        activeLoads += 1;
        maximumActiveLoads = Math.max(maximumActiveLoads, activeLoads);
        await new Promise(resolve => setTimeout(resolve, 5));
        activeLoads -= 1;
        const pr = prs.find(candidate => candidate.number === number);
        return snapshot(pr, [lane({ head: `head-${number}`, lane: 'code-quality' })]);
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

    assert.match(human, /#300 \| Visible stats \| 1 \| 0 \| 0 \| yes \| present/);
    assert.match(human, /Pull requests: 1/);
    assert.match(human, /Reviewed pull requests: 1/);
    assert.match(human, /First-review-clean: 1\/1 \(100\.0%\)/);
    assert.match(human, /Median reviewed heads: 1/);
    assert.match(human, /Blocking entries after first head: 0\/0 \(n\/a\)/);
    assert.match(human, new RegExp(`provider=${result.provider}`));
    assert.match(human, new RegExp(`Next action: ${result.nextAction.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
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
