const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
const { describe, it } = require('node:test');

const {
  MAX_REVIEW_STATS_WINDOW,
  computeReviewStats,
  formatReviewStats,
  reviewStatsFailure,
  reviewStatsWindow,
  runReviewStatsWithProvider,
} = require('../dist/app/review_stats.js');
const { getCommandMetadata } = require('../dist/command_metadata.js');
const { listReviewForgeAdapters } = require('../dist/providers/review_forge_adapters.js');

function lane({ head, lane, expectedLanes = [lane], recommendation = 'approve', status = 'passed', bodyFindingCount = 0, blockingFindingCount = bodyFindingCount, publishedAt = '2026-01-01T00:00:00Z' }) {
  return { head, lane, expectedLanes, recommendation, status, bodyFindingCount, blockingFindingCount, publishedAt };
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
    capabilities: () => ({ loadReview: true, reviewStats: options.reviewStats ?? true, findCurrentBranchReview: true, planReviewRequests: false, applyReviewRequests: false }),
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
        lane({ head: 'a', lane: 'issue-compliance', publishedAt: '2026-01-01T00:00:00Z' }),
        lane({ head: 'b', lane: 'issue-compliance', recommendation: 'request-changes', status: 'needs-work', bodyFindingCount: 2, publishedAt: '2026-01-02T00:00:00Z' }),
      ],
    },
    {
      number: 102,
      title: 'Three reviewed heads',
      trustedLaneReviews: [
        lane({ head: 'a', lane: 'code-quality', expectedLanes: ['code-quality', 'issue-compliance'], recommendation: 'request-changes', status: 'failed', bodyFindingCount: 2, publishedAt: '2026-01-01T00:00:00Z' }),
        lane({ head: 'a', lane: 'issue-compliance', expectedLanes: ['code-quality', 'issue-compliance'], publishedAt: '2026-01-01T00:00:00Z' }),
        lane({ head: 'b', lane: 'code-quality', expectedLanes: ['code-quality', 'performance'], recommendation: 'request-changes', status: 'failed', bodyFindingCount: 1, publishedAt: '2026-01-02T00:00:00Z' }),
        lane({ head: 'b', lane: 'performance', expectedLanes: ['code-quality', 'performance'], recommendation: 'request-changes', status: 'needs-work', bodyFindingCount: 2, publishedAt: '2026-01-02T00:00:00Z' }),
        lane({ head: 'c', lane: 'code-quality', publishedAt: '2026-01-03T00:00:00Z' }),
      ],
    },
    { number: 103, title: 'No lane evidence', trustedLaneReviews: [] },
    {
      number: 101,
      title: 'Clean first review',
      trustedLaneReviews: [
        lane({ head: 'a', lane: 'code-quality', expectedLanes: ['code-quality', 'issue-compliance'] }),
        lane({ head: 'a', lane: 'issue-compliance', expectedLanes: ['code-quality', 'issue-compliance'] }),
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
    assert.match(result.pullRequests[0].noLaneEvidenceReason, /missing a valid head, lane, expected lane set, recommendation, status, or publication time/);
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
      capabilities: () => ({ reviewStats: true }),
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
    assert.throws(() => reviewStatsWindow(MAX_REVIEW_STATS_WINDOW + 1), error => {
      assert.equal(error.kind, 'invalid-review-stats-window');
      assert.match(error.likelyCause, /cannot exceed 50/);
      assert.match(error.suggestedNextAction, /--window 50/);
      return true;
    });

    const fixture = providerFixture([], { id: 'gitlab', unsupported: true, reviewStats: false });
    await assert.rejects(() => runReviewStatsWithProvider(fixture.provider, { window: 20 }), error => error.kind === 'review-stats-unsupported' && /gitlab/.test(error.likelyCause));

    const mismatch = providerFixture([], { id: 'github', reviewStats: false });
    await assert.rejects(() => runReviewStatsWithProvider(mismatch.provider, { window: 20 }), error => error.kind === 'review-stats-unsupported' && /complete review stats capability/.test(error.likelyCause));
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

  it('preserves earlier same-head failures and orders offset timestamps chronologically', () => {
    const sameHead = computeReviewStats([{
      number: 305,
      title: 'Repeated lane verdict',
      trustedLaneReviews: [
        lane({ head: 'a', lane: 'code-quality', recommendation: 'request-changes', status: 'failed', blockingFindingCount: 1, publishedAt: '2026-02-01T00:00:00Z' }),
        lane({ head: 'a', lane: 'code-quality', publishedAt: '2026-02-01T01:00:00Z' }),
      ],
    }]);
    assert.equal(sameHead.pullRequests[0].failingHeads, 1);
    assert.equal(sameHead.pullRequests[0].blockingEntries, 1);
    assert.equal(sameHead.pullRequests[0].firstReviewClean, false);

    const offsets = computeReviewStats([{
      number: 306,
      title: 'Offset chronology',
      trustedLaneReviews: [
        lane({ head: 'later', lane: 'code-quality', recommendation: 'request-changes', status: 'failed', blockingFindingCount: 1, publishedAt: '2026-02-01T00:30:00Z' }),
        lane({ head: 'first', lane: 'code-quality', publishedAt: '2026-02-01T02:00:00+02:00' }),
      ],
    }]);
    assert.equal(offsets.pullRequests[0].firstReviewClean, true);
    assert.equal(offsets.summary.blockingEntriesAfterFirstHead, 1);
  });

  it('does not report an incomplete first head as clean', () => {
    const result = computeReviewStats([{
      number: 303,
      title: 'Incomplete first head',
      trustedLaneReviews: [lane({
        head: 'a',
        lane: 'code-quality',
        expectedLanes: ['code-quality', 'issue-compliance'],
      })],
    }]);

    assert.equal(result.pullRequests[0].noLaneEvidence, true);
    assert.equal(result.pullRequests[0].firstReviewClean, null);
    assert.match(result.pullRequests[0].noLaneEvidenceReason, /missing expected lane.*issue-compliance/);
  });

  it('rejects observed lanes outside the declared expected lane set', () => {
    const result = computeReviewStats([{
      number: 307,
      title: 'Unexpected lane',
      trustedLaneReviews: [
        lane({ head: 'a', lane: 'code-quality', expectedLanes: ['code-quality'] }),
        lane({ head: 'a', lane: 'issue-compliance', expectedLanes: ['code-quality'] }),
      ],
    }]);

    assert.equal(result.pullRequests[0].noLaneEvidence, true);
    assert.match(result.pullRequests[0].noLaneEvidenceReason, /lane issue-compliance outside its expected lane set/);
  });

  it('degrades ambiguous cross-head timestamps instead of choosing an arbitrary first head', () => {
    const result = computeReviewStats([{
      number: 308,
      title: 'Ambiguous chronology',
      trustedLaneReviews: [
        lane({ head: 'clean', lane: 'code-quality', publishedAt: '2026-02-01T00:00:00Z' }),
        lane({ head: 'failed', lane: 'code-quality', recommendation: 'request-changes', status: 'failed', blockingFindingCount: 1, publishedAt: '2026-02-01T00:00:00Z' }),
      ],
    }]);

    assert.equal(result.pullRequests[0].noLaneEvidence, true);
    assert.match(result.pullRequests[0].noLaneEvidenceReason, /ambiguous publication order/);
  });

  it('keeps legacy body counts out of exact blocking metrics', async () => {
    const legacy = lane({ head: 'a', lane: 'code-quality', recommendation: 'request-changes', status: 'failed', bodyFindingCount: 2 });
    delete legacy.blockingFindingCount;
    const fixture = providerFixture([{ pr: pullRequest(303), laneReviews: [legacy] }]);
    const result = await runReviewStatsWithProvider(fixture.provider, { window: 1 });

    assert.equal(result.pullRequests[0].noLaneEvidence, true);
    assert.equal(result.pullRequests[0].blockingEntries, null);
    assert.match(result.pullRequests[0].noLaneEvidenceReason, /exact severity-aware blocking finding count/);
  });

  it('rejects approve metadata that carries blocking findings', () => {
    const result = computeReviewStats([{
      number: 304,
      title: 'Contradictory approval',
      trustedLaneReviews: [lane({ head: 'a', lane: 'code-quality', blockingFindingCount: 2 })],
    }]);

    assert.equal(result.pullRequests[0].noLaneEvidence, true);
    assert.match(result.pullRequests[0].noLaneEvidenceReason, /contradicted its recommendation/);
  });

  it('registers the read-only JSON command and bounded window flag', () => {
    const command = getCommandMetadata('review stats');
    const windowFlag = command.flagDetails.find(flag => flag.name === '--window');

    assert.equal(command.supportsJson, true);
    assert.deepEqual(command.mutationTargets, []);
    assert.equal(windowFlag.default, 20);
    assert.match(windowFlag.description, /maximum 50/);
    const adapters = listReviewForgeAdapters();
    assert.equal(adapters.find(adapter => adapter.id === 'github').capabilities.reviewStats, true);
    assert.equal(adapters.find(adapter => adapter.id === 'gitlab').capabilities.reviewStats, false);
  });

  it('enforces the hard cap through the executable JSON command path', () => {
    const productRoot = join(__dirname, '..');
    const run = spawnSync(process.execPath, [join(productRoot, 'bin', 'run'), 'review', 'stats', '--window', '51', '--json'], {
      cwd: productRoot,
      encoding: 'utf8',
    });
    const result = JSON.parse(run.stdout);

    assert.equal(run.status, 3);
    assert.equal(result.ok, false);
    assert.equal(result.command, 'review stats');
    assert.equal(result.error.kind, 'invalid-review-stats-window');
    assert.equal(result.error.operation, 'validate review stats window');
    assert.match(result.error.likelyCause, /cannot exceed 50/);
    assert.match(result.error.suggestedNextAction, /--window 50/);
    assert.equal(result.error.category, 'validation');
    assert.equal(result.error.exitCode, 3);
  });

  it('uses the stable structured error shape for unsupported providers and provider reads', async () => {
    const unsupported = providerFixture([], { id: 'gitlab', reviewStats: false });
    const unsupportedError = await runReviewStatsWithProvider(unsupported.provider, { window: 1 }).catch(error => error);
    const unsupportedFailure = reviewStatsFailure(unsupportedError);
    assert.deepEqual(Object.keys(unsupportedFailure.result.error).sort(), ['category', 'exitCode', 'kind', 'likelyCause', 'operation', 'suggestedNextAction']);
    assert.equal(unsupportedFailure.result.error.kind, 'review-stats-unsupported');
    assert.equal(unsupportedFailure.result.error.category, 'validation');
    assert.equal(unsupportedFailure.result.error.exitCode, 3);

    const providerFailure = reviewStatsFailure(new Error('provider unavailable'));
    assert.deepEqual(Object.keys(providerFailure.result.error).sort(), ['category', 'exitCode', 'kind', 'likelyCause', 'operation', 'suggestedNextAction']);
    assert.equal(providerFailure.result.error.kind, 'review-stats-provider-read-failed');
    assert.equal(providerFailure.result.error.category, 'external');
    assert.equal(providerFailure.result.error.exitCode, 4);
    assert.match(providerFailure.result.error.likelyCause, /provider unavailable/);
  });

  it('sanitizes provider-derived text in human tables and lane breakdowns', () => {
    const result = computeReviewStats([{
      number: 309,
      title: 'Unsafe | title',
      trustedLaneReviews: null,
      unavailableReason: 'missing\nFake row\t| injected',
    }]);
    result.summary.blockingEntriesByLane = [{ lane: 'code|quality', blockingEntries: 1 }];
    const human = formatReviewStats({
      ok: true,
      command: 'review stats',
      provider: 'github',
      window: 1,
      ...result,
      warnings: [],
      nextAction: 'done',
    });
    assert.match(human, /Unsafe \\| title/);
    assert.match(human, /missing Fake row \\| injected/);
    assert.match(human, /code\\\|quality: 1/);
    assert.doesNotMatch(human, /\nFake row/);
  });
});
