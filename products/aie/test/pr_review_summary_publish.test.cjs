'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { createGitHubReviewForgeProvider, makePrExec, basePr } = require('./support/pr_gate_fixture.cjs');
const { renderRoundSummaryBody, renderInlineCommentBody } = require('../dist/review_round_summary.js');

function findingAnchor(overrides = {}) {
  return {
    laneId: overrides.laneId ?? 'code-quality',
    anchored: true,
    unanchoredReason: null,
    finding: {
      id: overrides.id ?? 'f1',
      severity: overrides.severity ?? 'advisory',
      message: overrides.message ?? 'Tighten this check.',
      location: overrides.location ?? { path: 'src/a.ts', line: 3, side: 'destination' },
      ...(overrides.confidence !== undefined ? { confidence: overrides.confidence } : {}),
    },
  };
}

function roundInput(overrides = {}) {
  return {
    prNumber: 12,
    issueNumber: 93,
    headSha: overrides.headSha ?? 'abc123',
    round: overrides.round ?? 'round-1',
    expectedLanes: overrides.expectedLanes ?? ['code-quality'],
    lanes: overrides.lanes ?? [{
      laneId: 'code-quality',
      status: 'passed',
      recommendation: 'approve',
      summary: 'Looks fine.',
      findings: [],
      preconditions: [],
      evidenceHeadSha: overrides.headSha ?? 'abc123',
      carriedForwardFromHeadSha: null,
      withheld: { duplicates: 0, offDiff: 0, byCap: 0 },
    }],
  };
}

function publishInputFromRender(render, overrides = {}) {
  const inlineFindings = render.inline.map(anchor => ({ laneId: anchor.laneId, finding: anchor.finding, commentBody: renderInlineCommentBody(anchor) }));
  return {
    dryRun: false,
    prNumber: 12,
    headSha: overrides.headSha ?? 'abc123',
    round: overrides.round ?? 'round-1',
    issueNumber: 93,
    expectedLanes: ['code-quality'],
    verdict: render.verdict,
    body: render.body,
    marker: render.marker,
    inlineFindings,
    unanchoredFindingCount: render.unanchored.length,
    findingDigest: render.findingDigest,
    ...overrides,
  };
}

describe('GitHub round summary publish', () => {
  it('creates a formal pull request review with inline comments on first publish', async () => {
    const anchored = findingAnchor({ id: 'anchored-1' });
    const render = renderRoundSummaryBody(roundInput({ lanes: [{ laneId: 'code-quality', status: 'passed', recommendation: 'approve', summary: 'ok', findings: [anchored.finding], preconditions: [], evidenceHeadSha: 'abc123', carriedForwardFromHeadSha: null, withheld: { duplicates: 0, offDiff: 0, byCap: 0 } }] }), { diffIndex: { hasLine: () => true } });
    const fixture = makePrExec({ prViews: [basePr()] });
    const provider = createGitHubReviewForgeProvider({ exec: fixture.exec });

    const result = await provider.publishRoundReviewSummary(publishInputFromRender(render));

    assert.equal(result.status, 'published');
    assert.equal(result.publishKind, 'pull-request-review');
    assert.equal(result.inlineCommentCount, 1);
    assert.equal(result.supersededPriorSummaries, 0);
    assert.ok(result.summaryUrl);
    const reviewPost = fixture.events.find(event => event.startsWith('api repos/example/repo/pulls/12/reviews --method POST'));
    assert.ok(reviewPost, 'expected a POST to create the pull request review');
  });

  it('skip-matches an unchanged same-round republish', async () => {
    const render = renderRoundSummaryBody(roundInput(), { diffIndex: null });
    const publishedReview = { id: 555, author: { login: 'executor' }, body: render.body, state: 'COMMENTED', url: 'https://github.com/example/repo/pull/12#pullrequestreview-555', commit: { oid: 'abc123' } };
    const fixture = makePrExec({ prViews: [basePr({ reviews: [publishedReview], latestReviews: [publishedReview] })], pullReviews: [publishedReview] });
    const provider = createGitHubReviewForgeProvider({ exec: fixture.exec });

    const result = await provider.publishRoundReviewSummary(publishInputFromRender(render));

    assert.equal(result.status, 'skipped');
    const reviewPost = fixture.events.find(event => event.startsWith('api repos/example/repo/pulls/12/reviews --method POST'));
    assert.equal(reviewPost, undefined, 'a skip-matched republish must not create a new review');
  });

  it('updates an existing same-round marker in place when its content changes', async () => {
    const firstRender = renderRoundSummaryBody(roundInput(), { diffIndex: null });
    const existingReview = { id: 555, author: { login: 'executor' }, body: firstRender.body, state: 'COMMENTED', url: 'https://github.com/example/repo/pull/12#pullrequestreview-555', commit: { oid: 'abc123' } };
    const fixture = makePrExec({ prViews: [basePr({ reviews: [existingReview], latestReviews: [existingReview] })], pullReviews: [existingReview] });
    const provider = createGitHubReviewForgeProvider({ exec: fixture.exec });

    const changedRender = renderRoundSummaryBody(roundInput({ lanes: [{ laneId: 'code-quality', status: 'failed', recommendation: 'request-changes', summary: 'Now blocking.', findings: [{ id: 'b1', severity: 'blocking', message: 'New blocker.' }], preconditions: [], evidenceHeadSha: 'abc123', carriedForwardFromHeadSha: null, withheld: { duplicates: 0, offDiff: 0, byCap: 0 } }] }), { diffIndex: null });

    const result = await provider.publishRoundReviewSummary(publishInputFromRender(changedRender));

    assert.equal(result.status, 'published');
    const updatePut = fixture.events.find(event => event.startsWith('api repos/example/repo/pulls/12/reviews/555 --method PUT'));
    assert.ok(updatePut, 'expected a PUT to update the existing same-round review');
    const createPost = fixture.events.find(event => event.startsWith('api repos/example/repo/pulls/12/reviews --method POST'));
    assert.equal(createPost, undefined, 'an update-in-place must not also create a second review');
  });

  it('supersedes a live prior-head summary with a tombstone when publishing a new head', async () => {
    const priorRender = renderRoundSummaryBody(roundInput({ headSha: 'prior111', round: 'round-prior' }), { diffIndex: null });
    const priorReview = { id: 777, author: { login: 'executor' }, body: priorRender.body, state: 'COMMENTED', url: 'https://github.com/example/repo/pull/12#pullrequestreview-777', commit: { oid: 'prior111' } };
    const fixture = makePrExec({ prViews: [basePr({ headRefOid: 'new222', reviews: [priorReview], latestReviews: [priorReview] })], pullReviews: [priorReview] });
    const provider = createGitHubReviewForgeProvider({ exec: fixture.exec });

    const newRender = renderRoundSummaryBody(roundInput({ headSha: 'new222', round: 'round-new' }), { diffIndex: null });
    const result = await provider.publishRoundReviewSummary(publishInputFromRender(newRender, { headSha: 'new222', round: 'round-new' }));

    assert.equal(result.status, 'published');
    assert.equal(result.supersededPriorSummaries, 1);
    const tombstonePut = fixture.events.find(event => event.startsWith('api repos/example/repo/pulls/12/reviews/777 --method PUT'));
    assert.ok(tombstonePut, 'expected the prior-head review to be tombstoned via PUT');
  });

  it('degrades to an issue comment when the publisher identity is the pull request author', async () => {
    const render = renderRoundSummaryBody(roundInput(), { diffIndex: null });
    const fixture = makePrExec({ prViews: [basePr({ author: { login: 'executor' } })] });
    const provider = createGitHubReviewForgeProvider({ exec: fixture.exec });

    const result = await provider.publishRoundReviewSummary(publishInputFromRender(render));

    assert.equal(result.status, 'published');
    assert.equal(result.publishKind, 'issue-comment');
    assert.ok(result.publisherDowngradeReason);
    const commentPost = fixture.events.find(event => event.startsWith('api repos/example/repo/issues/12/comments --method POST'));
    assert.ok(commentPost, 'expected a POST to create the issue comment fallback');
  });

  it('dismisses prior-head request-changes reviews when a new head publishes', async () => {
    const priorReview = {
      id: 888,
      author: { login: 'executor' },
      body: 'prior request-changes',
      state: 'CHANGES_REQUESTED',
      url: 'https://github.com/example/repo/pull/12#pullrequestreview-888',
      commit: { oid: 'prior111' },
    };
    const fixture = makePrExec({
      prViews: [basePr({ headRefOid: 'new222', reviews: [priorReview], latestReviews: [priorReview] })],
      pullReviews: [priorReview],
    });
    const provider = createGitHubReviewForgeProvider({ exec: fixture.exec });
    const newRender = renderRoundSummaryBody(roundInput({ headSha: 'new222', round: 'round-new' }), { diffIndex: null });

    const result = await provider.publishRoundReviewSummary(publishInputFromRender(newRender, { headSha: 'new222', round: 'round-new' }));

    assert.equal(result.status, 'published');
    const dismissal = fixture.events.find(event => event.includes('/reviews/888/dismissals') && event.includes('--method PUT'));
    assert.ok(dismissal, 'expected the prior-head request-changes review to be dismissed');
    const payload = fixture.reviewPayloads.find(entry => entry.dismiss);
    assert.match(String(payload?.message ?? ''), /Superseded by head new222/);
  });

  it('still publishes the current-head summary when prior-head dismissal fails', async () => {
    const priorReview = {
      id: 888,
      author: { login: 'executor' },
      body: 'prior request-changes',
      state: 'CHANGES_REQUESTED',
      url: 'https://github.com/example/repo/pull/12#pullrequestreview-888',
      commit: { oid: 'prior111' },
    };
    const fixture = makePrExec({
      prViews: [basePr({ headRefOid: 'new222', reviews: [priorReview], latestReviews: [priorReview] })],
      pullReviews: [priorReview],
    });
    const exec = async (args) => {
      if (typeof args[1] === 'string' && args[1].includes('/reviews/888/dismissals')) {
        return { args, exitCode: 1, stdout: '', stderr: 'dismissal unavailable' };
      }
      return fixture.exec(args);
    };
    const provider = createGitHubReviewForgeProvider({ exec });
    const newRender = renderRoundSummaryBody(roundInput({ headSha: 'new222', round: 'round-new' }), { diffIndex: null });

    const result = await provider.publishRoundReviewSummary(publishInputFromRender(newRender, { headSha: 'new222', round: 'round-new' }));

    assert.equal(result.status, 'published');
    const reviewPost = fixture.events.find(event => event.startsWith('api repos/example/repo/pulls/12/reviews --method POST'));
    assert.ok(reviewPost, 'the current-head summary must still publish when dismissal fails');
  });

  it('fails closed when the prior-review list fetch throws', async () => {
    const fixture = makePrExec({ prViews: [basePr()] });
    const exec = async (args) => {
      if (args[0] === 'api' && args[1] === 'repos/example/repo/pulls/12/reviews' && args.includes('--method') && args[args.indexOf('--method') + 1] === 'GET') {
        throw new Error('review list unavailable');
      }
      return fixture.exec(args);
    };
    const provider = createGitHubReviewForgeProvider({ exec });
    const render = renderRoundSummaryBody(roundInput(), { diffIndex: null });

    const result = await provider.publishRoundReviewSummary(publishInputFromRender(render));

    assert.equal(result.status, 'failed');
    assert.match(String(result.failure), /review list unavailable/);
    const reviewPost = fixture.events.find(event => event.startsWith('api repos/example/repo/pulls/12/reviews --method POST'));
    assert.equal(reviewPost, undefined, 'a failed prior-review fetch must not create a review');
  });

  it('reports a planned dry run without mutating GitHub', async () => {
    const render = renderRoundSummaryBody(roundInput(), { diffIndex: null });
    const fixture = makePrExec({ prViews: [basePr()] });
    const provider = createGitHubReviewForgeProvider({ exec: fixture.exec });

    const result = await provider.publishRoundReviewSummary(publishInputFromRender(render, { dryRun: true }));

    assert.equal(result.status, 'planned');
    const mutatingCall = fixture.events.find(event => event.includes('--method POST') || event.includes('--method PUT') || event.includes('--method PATCH'));
    assert.equal(mutatingCall, undefined, 'a dry run must not mutate GitHub');
  });
});

describe('GitHub lane review publish fail-closed', () => {
  function lanePublishInput(overrides = {}) {
    return {
      dryRun: false,
      prNumber: 12,
      headSha: 'abc123',
      lane: 'issue-compliance',
      expectedLanes: ['issue-compliance'],
      round: 'round-1',
      profile: 'local-focused',
      status: 'passed',
      recommendation: 'approve',
      host: 'codex',
      issueNumber: 93,
      summary: 'ok',
      findings: [],
      completeness: 'inspected',
      evidencePath: '.qube/aie/reviews/93/12/abc123/issue-compliance.json',
      ...overrides,
    };
  }

  it('fails closed when github-app identity cannot resolve the bot login', async () => {
    const fixture = makePrExec({ prViews: [basePr()] });
    const provider = createGitHubReviewForgeProvider({
      exec: fixture.exec,
      publisher: {
        mode: 'github-app',
        githubApp: { appId: '99', installationId: '1001', privateKeyPath: 'C:\\missing\\review-app.pem' },
      },
    });

    const result = await provider.publishLaneReviewFeedbackForPullRequest(lanePublishInput());

    assert.equal(result.status, 'failed');
    assert.match(String(result.failure), /bot login|private key|unresolved/i);
    const reviewPost = fixture.events.find(event => event.startsWith('api repos/example/repo/pulls/12/reviews --method POST'));
    assert.equal(reviewPost, undefined);
  });

  it('fails closed when the prior-review list fetch throws during lane publish', async () => {
    const fixture = makePrExec({ prViews: [basePr()] });
    const exec = async (args) => {
      if (args[0] === 'api' && args[1] === 'repos/example/repo/pulls/12/reviews' && args.includes('--method') && args[args.indexOf('--method') + 1] === 'GET') {
        throw new Error('review list unavailable');
      }
      return fixture.exec(args);
    };
    const provider = createGitHubReviewForgeProvider({ exec });

    const result = await provider.publishLaneReviewFeedbackForPullRequest(lanePublishInput());

    assert.equal(result.status, 'failed');
    assert.match(String(result.failure), /review list unavailable/);
    const reviewPost = fixture.events.find(event => event.startsWith('api repos/example/repo/pulls/12/reviews --method POST'));
    assert.equal(reviewPost, undefined);
  });

  it('skip-matches a second same-head lane publish instead of creating another review', async () => {
    const fixture = makePrExec({ prViews: [basePr()] });
    const provider = createGitHubReviewForgeProvider({ exec: fixture.exec });
    const input = lanePublishInput();

    const first = await provider.publishLaneReviewFeedbackForPullRequest(input);
    const second = await provider.publishLaneReviewFeedbackForPullRequest(input);

    assert.equal(first.status, 'published');
    assert.ok(second.status === 'skipped' || second.status === 'published');
    const reviewPosts = fixture.events.filter(event => event.startsWith('api repos/example/repo/pulls/12/reviews --method POST'));
    assert.equal(reviewPosts.length, 1, 'two same-head publishes must not create a second review event');
  });
});
