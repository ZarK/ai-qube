'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { createGitHubReviewForgeProvider, makePrExec, basePr } = require('./support/pr_gate_fixture.cjs');
const { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { reviewRepositoryFromPullRequestUrl, loadPriorRoundDelta, MAX_PRIOR_REVIEW_HEADS } = require('../dist/app/pr_review_summary_publish.js');
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
      location: overrides.location ?? { path: 'src/review.ts', line: 3, side: 'destination' },
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

function manyLineDiff(path, count) {
  const added = Array.from({ length: count }, (_, index) => `+export const n${index + 1} = ${index + 1};`);
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -0,0 +1,${count} @@`,
    ...added,
  ].join('\n');
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

describe('reviewRepositoryFromPullRequestUrl', () => {
  it('parses owner and name from a GitHub pull request URL', () => {
    assert.deepEqual(reviewRepositoryFromPullRequestUrl('https://github.com/ZarK/ai-qube/pull/527'), { owner: 'ZarK', name: 'ai-qube' });
    assert.equal(reviewRepositoryFromPullRequestUrl('https://gitlab.com/group/project/-/merge_requests/1'), undefined);
  });
});

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

  it('updates a same-round review whose marker predates findingDigest instead of posting a duplicate', async () => {
    const render = renderRoundSummaryBody(roundInput(), { diffIndex: null });
    const legacyBody = render.body.replace(/,"findingDigest":"[^"]*"/, '');
    assert.doesNotMatch(legacyBody, /findingDigest/);
    const existingReview = { id: 555, author: { login: 'executor' }, body: legacyBody, state: 'COMMENTED', url: 'https://github.com/example/repo/pull/12#pullrequestreview-555', commit: { oid: 'abc123' } };
    const fixture = makePrExec({ prViews: [basePr({ reviews: [existingReview], latestReviews: [existingReview] })], pullReviews: [existingReview] });
    const provider = createGitHubReviewForgeProvider({ exec: fixture.exec });

    const result = await provider.publishRoundReviewSummary(publishInputFromRender(render));

    assert.equal(result.status, 'published');
    const updatePut = fixture.events.find(event => event.startsWith('api repos/example/repo/pulls/12/reviews/555 --method PUT'));
    assert.ok(updatePut, 'expected a PUT to refresh the legacy same-round review');
    const createPost = fixture.events.find(event => event.startsWith('api repos/example/repo/pulls/12/reviews --method POST'));
    assert.equal(createPost, undefined, 'a legacy same-round marker must not create a second review');
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
    const input = roundInput();
    const render = renderRoundSummaryBody(input, { diffIndex: null, transport: 'review-api' });
    const degraded = renderRoundSummaryBody(input, { diffIndex: null, transport: 'issue-comment', profile: 'degraded' });
    const fixture = makePrExec({ prViews: [basePr({ author: { login: 'executor' } })] });
    const provider = createGitHubReviewForgeProvider({ exec: fixture.exec });

    const result = await provider.publishRoundReviewSummary(publishInputFromRender(render, { issueCommentBody: degraded.body }));

    assert.equal(result.status, 'published');
    assert.equal(result.publishKind, 'issue-comment');
    assert.ok(result.publisherDowngradeReason);
    assert.equal(result.body, degraded.body);
    assert.match(result.body, /issue-comment transport/);
    assert.doesNotMatch(result.body, /posted inline/);
    assert.doesNotMatch(result.body, /\[!NOTE\]/);
    assert.notEqual(result.body, render.body);
    const commentPost = fixture.events.find(event => event.startsWith('api repos/example/repo/issues/12/comments --method POST'));
    assert.ok(commentPost, 'expected a POST to create the issue comment fallback');
    const reviewPost = fixture.events.find(event => event.startsWith('api repos/example/repo/pulls/12/reviews --method POST'));
    assert.equal(reviewPost, undefined, 'fallback must not create a formal review event');
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

  it('fails the round publish when a later inline-comment chunk fails', async () => {
    const findings = Array.from({ length: 21 }, (_, index) => ({
      id: `f${index + 1}`,
      severity: 'advisory',
      message: `Finding ${index + 1}.`,
      location: { path: 'src/a.ts', line: index + 1, side: 'destination' },
    }));
    const render = renderRoundSummaryBody(roundInput({
      lanes: [{
        laneId: 'code-quality',
        status: 'passed',
        recommendation: 'approve',
        summary: 'ok',
        findings,
        preconditions: [],
        evidenceHeadSha: 'abc123',
        carriedForwardFromHeadSha: null,
        withheld: { duplicates: 0, offDiff: 0, byCap: 0 },
      }],
    }), { diffIndex: { hasLine: () => true } });
    const fixture = makePrExec({ prViews: [basePr()], diff: manyLineDiff('src/a.ts', 21) });
    let reviewPosts = 0;
    const exec = async (args) => {
      if (args[0] === 'api' && args[1] === 'repos/example/repo/pulls/12/reviews' && args.includes('POST')) {
        reviewPosts += 1;
        if (reviewPosts > 1) return { args, exitCode: 1, stdout: '', stderr: 'chunk rejected' };
      }
      return fixture.exec(args);
    };
    const provider = createGitHubReviewForgeProvider({ exec });

    const result = await provider.publishRoundReviewSummary(publishInputFromRender(render));

    assert.equal(result.status, 'failed');
    assert.match(String(result.failure), /chunk rejected/);
  });

  it('chunks inline comments past 20 and keeps the verdict on the primary event', async () => {
    const findings = Array.from({ length: 21 }, (_, index) => ({
      id: `f${index + 1}`,
      severity: 'advisory',
      message: `Finding ${index + 1}.`,
      location: { path: 'src/a.ts', line: index + 1, side: 'destination' },
    }));
    const render = renderRoundSummaryBody(roundInput({
      lanes: [{
        laneId: 'code-quality',
        status: 'passed',
        recommendation: 'approve',
        summary: 'ok',
        findings,
        preconditions: [],
        evidenceHeadSha: 'abc123',
        carriedForwardFromHeadSha: null,
        withheld: { duplicates: 0, offDiff: 0, byCap: 0 },
      }],
    }), { diffIndex: { hasLine: () => true } });
    const fixture = makePrExec({ prViews: [basePr()], diff: manyLineDiff('src/a.ts', 21) });
    const provider = createGitHubReviewForgeProvider({ exec: fixture.exec });

    const result = await provider.publishRoundReviewSummary(publishInputFromRender(render));

    assert.equal(result.status, 'published');
    const reviewPosts = fixture.reviewPayloads.filter(payload => Array.isArray(payload.comments));
    assert.ok(reviewPosts.length >= 2, 'expected a chunked second review call');
    assert.equal(reviewPosts[0].event, 'APPROVE');
    assert.ok(reviewPosts[0].comments.length <= 20);
    assert.ok(reviewPosts.slice(1).every(payload => payload.event === 'COMMENT'));
  });

  it('creates one status comment and updates it in place on the next publish', async () => {
    const render = renderRoundSummaryBody(roundInput(), { diffIndex: null });
    const fixture = makePrExec({ prViews: [basePr()] });
    const provider = createGitHubReviewForgeProvider({ exec: fixture.exec });

    const first = await provider.publishRoundReviewSummary(publishInputFromRender(render));
    const second = await provider.publishRoundReviewSummary(publishInputFromRender(render));

    assert.equal(first.status, 'published');
    assert.ok(second.status === 'published' || second.status === 'skipped');
    const creates = fixture.events.filter(event => event.startsWith('api repos/example/repo/issues/12/comments --method POST') && fixture.reviewPayloads.some(payload => String(payload.body ?? '').includes('qube-pr-status')));
    const updates = fixture.events.filter(event => /api repos\/example\/repo\/issues\/comments\/\d+ --method PATCH/.test(event));
    assert.equal(creates.length, 1, 'the first run must create exactly one status comment');
    assert.ok(updates.length >= 1, 'the second run must update the status comment in place');
    const statusBodies = fixture.reviewPayloads.map(payload => String(payload.body ?? '')).filter(body => body.includes('qube-pr-status'));
    assert.ok(statusBodies.some(body => body.includes('Round history') && body.includes('abc123')));
    const lastStatus = statusBodies.at(-1) ?? '';
    assert.match(lastStatus, /"rounds":\[\{"head":"abc123","verdict":"/);
  });

  it('parses nested status-comment rounds instead of truncating at the first brace', async () => {
    const existing = {
      author: { login: 'executor' },
      body: '<!-- qube-pr-status:{"version":1,"prNumber":12,"rounds":[{"head":"old111","verdict":"approve"}]} -->\nReview status: approve.\n',
      url: 'https://github.com/example/repo/pull/12#issuecomment-91',
    };
    const fixture = makePrExec({ prViews: [basePr({ headRefOid: 'new222', comments: [existing] })] });
    const provider = createGitHubReviewForgeProvider({ exec: fixture.exec });
    const render = renderRoundSummaryBody(roundInput({ headSha: 'new222', round: 'round-new' }), { diffIndex: null });
    await provider.publishRoundReviewSummary(publishInputFromRender(render, { headSha: 'new222', round: 'round-new' }));
    const statusBodies = fixture.reviewPayloads.map(payload => String(payload.body ?? '')).filter(body => body.includes('qube-pr-status'));
    const lastStatus = statusBodies.at(-1) ?? '';
    assert.match(lastStatus, /old111/);
    assert.match(lastStatus, /new222/);
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

describe('loadPriorRoundDelta', () => {
  function writeLane(repo, issueNumber, prNumber, head, findings) {
    const dir = join(repo, '.qube', 'aie', 'reviews', String(issueNumber), String(prNumber), head);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'code-quality.json'), JSON.stringify({ findings }), 'utf8');
  }

  it('reads only the newest prior head and skips an oversized sibling set', () => {
    const repo = mkdtempSync(join(tmpdir(), 'aie-prior-round-'));
    try {
      const current = 'cccccccccccccccccccccccccccccccccccccccc';
      const older = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const newer = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      writeLane(repo, 93, 12, older, [{ id: 'old', severity: 'advisory', message: 'Older finding.' }]);
      writeLane(repo, 93, 12, newer, [{ id: 'new', severity: 'advisory', message: 'Newer finding.' }]);
      writeLane(repo, 93, 12, current, []);
      utimesSync(join(repo, '.qube', 'aie', 'reviews', '93', '12', older), 1_700_000_000, 1_700_000_000);
      utimesSync(join(repo, '.qube', 'aie', 'reviews', '93', '12', newer), 1_700_000_100, 1_700_000_100);
      const selected = loadPriorRoundDelta(repo, 93, 12, current, ['code-quality']);
      assert.equal(selected.priorHeadSha, newer);
      assert.equal(selected.priorFindingKeys.length, 1);

      for (let index = 0; index < MAX_PRIOR_REVIEW_HEADS; index += 1) {
        writeLane(repo, 93, 12, `${String(index).padStart(40, 'd')}`, []);
      }
      assert.equal(loadPriorRoundDelta(repo, 93, 12, current, ['code-quality']), undefined);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
