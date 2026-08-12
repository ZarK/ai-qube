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
