'use strict';

const { describe, it } = require('node:test');
const {
  createHash,
  cloneGitRepo,
  execFileSync,
  spawnSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  tmpdir,
  basename,
  join,
  getDefaults,
  renderAgentPrompt,
  laneContextLines,
  promptStack,
  promptTextHashFromLines,
  buildFixBatch,
  localReviewEvidenceSha256,
  parsePrNumber,
  runPrGate,
  runPrViewService,
  formatPrView,
  buildPrBody,
  parsePrBodyIssueNumber,
  runPrReviewPublishService,
  runPrReviewPublishWithProvider,
  resolveModelReviewPlan,
  reviewRouteKey,
  runPrThreadResolveService,
  stringListFlag,
  assert,
  prViewFields,
  STANDARD_LOCAL_REVIEW_LANES,
  createGitHubReviewForgeProvider,
  observeReviewParticipants,
  makeGitRepo,
  userReviewRepo,
  binRun,
  writeConfig,
  commitTrustedBase,
  trustReviewCommands,
  commitRoutedReviewHead,
  writeWorkflow,
  safeRepoSegment,
  basePr,
  qubeReviewRequestComment,
  localReviewComment,
  laneReviewComment,
  promptStackHash,
  promptTextHash,
  promptStackForLane,
  promptForLane,
  withPromptStackProvenance,
  safeEvidenceSegment,
  trustedLocalHostProvenancePath,
  writeTestTrustedLocalHostProvenance,
  expectedPromptHashForLane,
  localEvidence,
  writeLocalEvidence,
  standardReviewLanes,
  localReviewConfig,
  approvedLocalPr,
  localCommandConfig,
  localHostConfig,
  readyRouteProbe,
  requiredTaskContext,
  comprehensiveEvidence,
  cleanLocalPr,
  threadResponse,
  issueCommentsFromPr,
  issueViewKey,
  issuePayload,
  issueViewResponse,
  makePrExec,
  fixtureLocalCommand,
  alignLocalEvidencePromptHashes,
  applyRoutedReviewFixture,
} = require('./support/pr_gate_fixture.cjs');

describe('PR body service', { concurrency: 4 }, () => {
  it('emits concise PR view state with sanitized feedback', async () => {
    const repo = makeGitRepo();
    const config = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', '.qube', 'aie', 'config.json'), 'utf8'));
    config.policy.reviews.agents = ['coderabbitai'];
    writeConfig(repo, config);
    const pr = basePr({
      reviewDecision: 'CHANGES_REQUESTED',
      mergeStateStatus: 'BLOCKED',
      latestReviews: [{ author: { login: 'reviewer' }, state: 'CHANGES_REQUESTED', body: 'Please fix the parser.', url: 'https://github.com/example/repo/pull/12#pullrequestreview-1' }],
      comments: [{ author: { login: 'coderabbitai' }, body: 'No actionable comments were generated.\n<!-- internal state start -->SECRET<!-- internal state end -->', url: 'https://github.com/example/repo/pull/12#issuecomment-1' }],
    });
    const { exec } = makePrExec({ prViews: [pr] });

    const result = await runPrViewService({ prNumber: 12, exec, repoRoot: repo });

    assert.equal(result.command, 'pr view');
    assert.equal(result.pr.number, 12);
    assert.equal(result.reviewDecision, 'changes-requested');
    assert.equal(result.feedback.length, 1);
    assert.equal(result.feedback[0].source, 'review');
    assert.match(result.feedback[0].summary, /Please fix the parser/);
    assert.doesNotMatch(JSON.stringify(result), /SECRET|internal state/);
  });

  it('emits merge blockers and review thread ids in PR view JSON', async () => {
    const pr = basePr({
      reviewDecision: '',
      mergeStateStatus: 'BLOCKED',
      mergeable: 'MERGEABLE',
    });
    const threads = [{
      id: 'PRRT_view_1',
      isResolved: false,
      viewerCanResolve: true,
      comments: { nodes: [{ author: { login: 'reviewer' }, body: 'Resolve this conversation.', url: 'https://github.com/example/repo/pull/12#discussion_r5', path: 'src/review.ts', line: 3, originalLine: 3 }] },
    }];
    const { exec } = makePrExec({ prViews: [pr], threads });

    const result = await runPrViewService({ prNumber: 12, exec });

    assert.equal(result.mergeability, 'blocked');
    assert.equal(result.counts.reviewThreads, 1);
    assert.equal(result.mergeBlockers[0].reason, 'unresolved-review-thread');
    assert.equal(result.reviewThreads[0].id, 'PRRT_view_1');
    assert.equal(result.reviewThreads[0].path, 'src/review.ts');
    assert.match(result.nextAction, /pr thread resolve/);
  });

  it('cites GitHub merge UI conversation blockers even when thread reads are empty', async () => {
    const pr = basePr({
      reviewDecision: '',
      mergeStateStatus: 'BLOCKED',
      mergeable: 'MERGEABLE',
    });
    const mergeUiState = {
      viewerMergeHeadlineText: 'Merging is blocked',
      viewerMergeBodyText: 'A conversation must be resolved before this pull request can be merged.',
      viewerCannotUpdateReasons: [],
    };
    const { exec } = makePrExec({ prViews: [pr], threads: [], mergeUiState });

    const result = await runPrViewService({ prNumber: 12, exec });

    assert.equal(result.mergeability, 'blocked');
    assert.equal(result.counts.reviewThreads, 0);
    assert.equal(result.mergeBlockers[0].reason, 'unresolved-review-thread');
    assert.match(result.mergeBlockers[0].summary, /A conversation must be resolved before this pull request can be merged/);
    assert.match(result.nextAction, /pr thread resolve/);
  });

  it('skips other authors on --all and resolves only publisher-authored threads', async () => {
    const threads = [
      { id: 'PRRT_other_1', isResolved: false, viewerCanResolve: true, comments: { nodes: [{ author: { login: 'reviewer' }, body: 'Human note.', url: 'https://github.com/example/repo/pull/12#discussion_r6' }] } },
      { id: 'PRRT_bot_1', isResolved: false, viewerCanResolve: true, comments: { nodes: [{ author: { login: 'executor' }, body: 'Bot finding.', url: 'https://github.com/example/repo/pull/12#discussion_r8' }] } },
    ];
    const fixture = makePrExec({ prViews: [cleanLocalPr({ mergeStateStatus: 'BLOCKED' })], threads });

    const skipped = await runPrThreadResolveService({
      prNumber: 12, threadIds: [], all: true, dryRun: false, exec: fixture.exec, publisherLogin: 'executor',
    });
    assert.equal(skipped.status, 'resolved');
    assert.deepEqual(skipped.resolvedThreadIds, ['PRRT_bot_1']);
    assert.ok(skipped.skippedThreadIds.includes('PRRT_other_1'));
    assert.match(skipped.nextAction, /--include-other-authors/);
    assert.equal(fixture.calls.filter(call => call[0] === 'api' && call[1] === 'graphql' && call.some(arg => String(arg).includes('resolveReviewThread'))).length, 1);

    const othersOnly = await runPrThreadResolveService({
      prNumber: 12, threadIds: [], all: true, dryRun: false, exec: fixture.exec, publisherLogin: 'qube-review[bot]',
    });
    assert.equal(othersOnly.status, 'skipped');
    assert.deepEqual(othersOnly.resolvedThreadIds, []);
    assert.ok(othersOnly.skippedThreadIds.includes('PRRT_other_1'));
    assert.match(othersOnly.nextAction, /other identities/);
  });

  it('resolves other authors only when --include-other-authors is set', async () => {
    const threads = [
      { id: 'PRRT_resolve_1', isResolved: false, viewerCanResolve: true, comments: { nodes: [{ author: { login: 'reviewer' }, body: 'Addressed.', url: 'https://github.com/example/repo/pull/12#discussion_r6' }] } },
      { id: 'PRRT_unowned_1', isResolved: false, viewerCanResolve: false, comments: { nodes: [{ author: { login: 'reviewer' }, body: 'Cannot resolve.', url: 'https://github.com/example/repo/pull/12#discussion_r7' }] } },
    ];
    const fixture = makePrExec({ prViews: [cleanLocalPr({ mergeStateStatus: 'BLOCKED' })], threads });

    const result = await runPrThreadResolveService({
      prNumber: 12, threadIds: [], all: true, includeOtherAuthors: true, dryRun: false, exec: fixture.exec,
    });

    assert.equal(result.status, 'resolved');
    assert.deepEqual(result.resolvedThreadIds, ['PRRT_resolve_1']);
    assert.equal(fixture.calls.filter(call => call[0] === 'api' && call[1] === 'graphql' && call.some(arg => String(arg).includes('resolveReviewThread'))).length, 1);
  });

  it('resolves a GitHub App thread when the API omits the bot suffix', async () => {
    const threads = [
      { id: 'PRRT_bot_1', isResolved: false, viewerCanResolve: true, comments: { nodes: [{ author: { login: 'qube-review' }, body: 'Addressed bot finding.', url: 'https://github.com/example/repo/pull/12#discussion_r8' }] } },
    ];
    const fixture = makePrExec({ prViews: [cleanLocalPr({ mergeStateStatus: 'BLOCKED' })], threads });

    const result = await runPrThreadResolveService({
      prNumber: 12, threadIds: [], all: true, dryRun: false, exec: fixture.exec, publisherLogin: 'qube-review[bot]',
    });

    assert.equal(result.status, 'resolved');
    assert.deepEqual(result.resolvedThreadIds, ['PRRT_bot_1']);
    assert.deepEqual(result.skippedThreadIds, []);
  });

  it('retains the configured publisher login when live identity resolution returns no login', async () => {
    const repo = makeGitRepo();
    const config = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', '.qube', 'aie', 'config.json'), 'utf8'));
    config.providers.review.publisher = {
      mode: 'token',
      token: { env: 'QUBE_TEST_MISSING_REVIEW_TOKEN', login: 'qube-review[bot]' },
    };
    writeConfig(repo, config);
    const threads = [
      { id: 'PRRT_bot_1', isResolved: false, viewerCanResolve: true, comments: { nodes: [{ author: { login: 'qube-review' }, body: 'Addressed bot finding.', url: 'https://github.com/example/repo/pull/12#discussion_r8' }] } },
    ];
    const fixture = makePrExec({ prViews: [cleanLocalPr({ mergeStateStatus: 'BLOCKED' })], threads });

    const result = await runPrThreadResolveService({
      prNumber: 12, threadIds: [], all: true, dryRun: false, exec: fixture.exec, repoRoot: repo,
    });

    assert.equal(result.status, 'resolved');
    assert.deepEqual(result.resolvedThreadIds, ['PRRT_bot_1']);
    assert.deepEqual(result.skippedThreadIds, []);
  });

  it('skips explicit review thread ids that are not unresolved viewer-resolvable threads on the selected PR', async () => {
    const threads = [
      { id: 'PRRT_resolve_1', isResolved: false, viewerCanResolve: true, comments: { nodes: [{ author: { login: 'reviewer' }, body: 'Addressed.', url: 'https://github.com/example/repo/pull/12#discussion_r6' }] } },
      { id: 'PRRT_unowned_1', isResolved: false, viewerCanResolve: false, comments: { nodes: [{ author: { login: 'reviewer' }, body: 'Cannot resolve.', url: 'https://github.com/example/repo/pull/12#discussion_r7' }] } },
    ];
    const fixture = makePrExec({ prViews: [cleanLocalPr({ mergeStateStatus: 'BLOCKED' })], threads });

    const result = await runPrThreadResolveService({ prNumber: 12, threadIds: ['PRRT_resolve_1', 'PRRT_foreign_1', 'PRRT_unowned_1'], all: false, dryRun: false, exec: fixture.exec });

    assert.equal(result.status, 'resolved');
    assert.deepEqual(result.resolvedThreadIds, ['PRRT_resolve_1']);
    assert.deepEqual(result.skippedThreadIds, ['PRRT_foreign_1', 'PRRT_unowned_1']);
    const mutations = fixture.calls.filter(call => call[0] === 'api' && call[1] === 'graphql' && call.some(arg => String(arg).includes('resolveReviewThread')));
    assert.equal(mutations.length, 1);
    assert.ok(mutations[0].some(arg => String(arg) === 'threadId=PRRT_resolve_1'));
  });

  it('reports failed review thread resolve mutations without throwing', async () => {
    const threads = [
      { id: 'PRRT_resolve_fail', isResolved: false, viewerCanResolve: true, comments: { nodes: [{ author: { login: 'reviewer' }, body: 'Addressed.', url: 'https://github.com/example/repo/pull/12#discussion_r6' }] } },
    ];
    const fixture = makePrExec({
      prViews: [cleanLocalPr({ mergeStateStatus: 'BLOCKED' })],
      threads,
      resolveThreadResults: [{ exitCode: 1, stdout: '', stderr: 'GraphQL mutation failed' }],
    });

    const result = await runPrThreadResolveService({ prNumber: 12, threadIds: [], all: true, includeOtherAuthors: true, dryRun: false, exec: fixture.exec });

    assert.equal(result.status, 'failed');
    assert.deepEqual(result.resolvedThreadIds, []);
    assert.deepEqual(result.failedThreadIds, ['PRRT_resolve_fail']);
  });

  it('fails before mutation when GitHub thread resolution exceeds its hard bound', async () => {
    const threads = Array.from({ length: 101 }, (_, index) => ({
      id: `PRRT_bounded_${index}`,
      isResolved: false,
      viewerCanResolve: true,
      comments: { nodes: [{ author: { login: 'reviewer' }, body: 'Addressed.', url: `https://github.com/example/repo/pull/12#discussion_r${index}` }] },
    }));
    const fixture = makePrExec({ prViews: [cleanLocalPr({ mergeStateStatus: 'BLOCKED' })], threads });

    const result = await runPrThreadResolveService({ prNumber: 12, threadIds: [], all: true, includeOtherAuthors: true, dryRun: false, exec: fixture.exec });

    assert.equal(result.status, 'failed');
    assert.equal(result.resolvedThreadIds.length, 0);
    assert.equal(result.failedThreadIds.length, 101);
    assert.match(result.nextAction, /bounded mutation limit of 100/);
    assert.match(result.nextAction, /no review thread was mutated/i);
    const mutations = fixture.calls.filter(call => call[0] === 'api' && call[1] === 'graphql' && call.some(arg => String(arg).includes('resolveReviewThread')));
    assert.equal(mutations.length, 0);
  });

  it('runs GitHub thread mutations with fixed concurrency and stable result order', async () => {
    const threads = Array.from({ length: 10 }, (_, index) => ({
      id: `PRRT_concurrent_${index}`,
      isResolved: false,
      viewerCanResolve: true,
      comments: { nodes: [{ author: { login: 'reviewer' }, body: 'Addressed.', url: `https://github.com/example/repo/pull/12#discussion_c${index}` }] },
    }));
    const fixture = makePrExec({ prViews: [cleanLocalPr({ mergeStateStatus: 'BLOCKED' })], threads });
    let activeMutations = 0;
    let maxActiveMutations = 0;
    const exec = async args => {
      if (args[0] === 'api' && args[1] === 'graphql' && args.some(arg => String(arg).includes('mutation($threadId: ID!) { resolveReviewThread'))) {
        activeMutations += 1;
        maxActiveMutations = Math.max(maxActiveMutations, activeMutations);
        await new Promise(resolve => setTimeout(resolve, 10));
        const result = await fixture.exec(args);
        activeMutations -= 1;
        return result;
      }
      return fixture.exec(args);
    };

    const result = await runPrThreadResolveService({ prNumber: 12, threadIds: [], all: true, includeOtherAuthors: true, dryRun: false, exec });

    assert.equal(result.status, 'resolved');
    assert.equal(maxActiveMutations, 4);
    assert.deepEqual(result.resolvedThreadIds, threads.map(thread => thread.id));
  });

  it('fails when the bounded provider reload does not confirm the exact thread as resolved', async () => {
    const threads = [
      { id: 'PRRT_still_open', isResolved: false, viewerCanResolve: true, comments: { nodes: [{ author: { login: 'reviewer' }, body: 'Addressed.', url: 'https://github.com/example/repo/pull/12#discussion_r9' }] } },
    ];
    const fixture = makePrExec({
      prViews: [cleanLocalPr({ mergeStateStatus: 'BLOCKED' })],
      threads,
      resolveThreadVisible: false,
    });

    const result = await runPrThreadResolveService({ prNumber: 12, threadIds: ['PRRT_still_open'], all: false, dryRun: false, exec: fixture.exec });

    assert.equal(result.status, 'failed');
    assert.deepEqual(result.resolvedThreadIds, []);
    assert.deepEqual(result.failedThreadIds, ['PRRT_still_open']);
    assert.match(result.nextAction, /bounded post-mutation read/);
    const listReads = fixture.calls.filter(call => call[0] === 'api' && call[1] === 'graphql' && call.some(arg => String(arg).includes('reviewThreads')));
    const exactReads = fixture.calls.filter(call => call[0] === 'api' && call[1] === 'graphql' && call.some(arg => String(arg).includes('nodes(ids: $threadIds)')));
    assert.equal(listReads.length, 1, 'selection requires one pre-mutation thread read');
    assert.equal(exactReads.length, 1, 'reconciliation requires one exact bounded post-mutation read');
  });

  it('fails when the exact resolved thread is missing from the bounded provider reload', async () => {
    const threads = [
      { id: 'PRRT_missing_after_mutation', isResolved: false, viewerCanResolve: true, comments: { nodes: [{ author: { login: 'reviewer' }, body: 'Addressed.', url: 'https://github.com/example/repo/pull/12#discussion_r10' }] } },
    ];
    const fixture = makePrExec({
      prViews: [cleanLocalPr({ mergeStateStatus: 'BLOCKED' })],
      threads,
      resolveThreadPostState: 'missing',
    });

    const result = await runPrThreadResolveService({ prNumber: 12, threadIds: ['PRRT_missing_after_mutation'], all: false, dryRun: false, exec: fixture.exec });

    assert.equal(result.status, 'failed');
    assert.deepEqual(result.resolvedThreadIds, []);
    assert.deepEqual(result.failedThreadIds, ['PRRT_missing_after_mutation']);
  });

  it('parses comma-separated repeated review thread flags', () => {
    const threadIds = stringListFlag({ args: {}, flags: { thread: ['PRRT_one, PRRT_two', 'PRRT_three'] } }, 'thread');

    assert.deepEqual(threadIds, ['PRRT_one', 'PRRT_two', 'PRRT_three']);
  });

  it('emits trusted lane review counts and URLs in PR view JSON without replaying stale general review feedback', async () => {
    const laneBody = laneReviewComment({
      recommendation: 'approve',
      status: 'passed',
      runId: 'lane-review-api',
      summary: 'lane passed',
      inline: 'review-api',
      inlineCommentCount: 2,
      bodyFindingCount: 1,
    }).body;
    const pr = basePr({
      reviewDecision: 'UNKNOWN',
      mergeStateStatus: 'CLEAN',
      reviews: [
        { id: 1, author: { login: 'reviewer' }, state: 'COMMENTED', body: 'Old stale general note.', url: 'https://github.com/example/repo/pull/12#pullrequestreview-1', commit: { oid: 'old-head' } },
        { id: 2, author: { login: 'executor' }, state: 'COMMENTED', body: laneBody, url: 'https://github.com/example/repo/pull/12#pullrequestreview-2', commit: { oid: 'abc123' } },
      ],
      latestReviews: [],
    });
    const repo = userReviewRepo();
    const { exec } = makePrExec({ prViews: [pr] });

    const result = await runPrViewService({ prNumber: 12, repoRoot: repo, exec });

    assert.equal(result.feedback.length, 0);
    assert.equal(result.laneReviews.length, 1);
    assert.equal(result.laneReviews[0].lane, 'code-quality');
    assert.equal(result.laneReviews[0].inline, 'review-api');
    assert.equal(result.laneReviews[0].inlineCommentCount, 2);
    assert.equal(result.laneReviews[0].bodyFindingCount, 1);
    assert.equal(result.laneReviews[0].reviewUrl, 'https://github.com/example/repo/pull/12#pullrequestreview-2');
  });

  it('surfaces the current provider-visible round summary pointer in PR view JSON and text', async () => {
    const marker = `<!-- qube-pr-review-summary:${JSON.stringify({ version: 1, head: 'abc123', round: 'round-1', prNumber: 12, findingDigest: 'digest1' })} -->`;
    const pr = basePr({
      comments: [{ author: { login: 'executor' }, body: `${marker}\n\n# QUBE review round summary: approve`, url: 'https://github.com/example/repo/pull/12#issuecomment-9', createdAt: '2026-01-01T00:00:00Z' }],
    });
    const repo = userReviewRepo();
    const { exec } = makePrExec({ prViews: [pr] });

    const result = await runPrViewService({ prNumber: 12, repoRoot: repo, exec });

    assert.deepEqual(result.roundSummary, { head: 'abc123', round: 'round-1', url: 'https://github.com/example/repo/pull/12#issuecomment-9', stale: false });
    assert.match(formatPrView(result), /Round summary: head=abc123; round=round-1; stale=no; https:\/\/github\.com\/example\/repo\/pull\/12#issuecomment-9/);
  });

  it('drafts issue-closing PR text with gate, UI audit, review, and readiness state', async () => {
    const repo = makeGitRepo();
    const home = mkdtempSync(join(tmpdir(), 'aie-pr-body-home-'));
    mkdirSync(join(repo, '.qube', 'aie', 'gates'), { recursive: true });
    mkdirSync(join(repo, '.qube', 'aie', 'reviews'), { recursive: true });
    const auditDirectory = join(home, '.qube', 'verification', safeRepoSegment(repo), '93');
    const screenshotsDirectory = join(auditDirectory, 'screenshots');
    mkdirSync(screenshotsDirectory, { recursive: true });
    writeFileSync(join(repo, '.qube', 'aie', 'gates', 'unit.json'), JSON.stringify({ status: 'passed', summary: 'node test passed' }));
    writeFileSync(join(repo, '.qube', 'aie', 'reviews', '93.json'), JSON.stringify({ status: 'passed', summary: 'oracle found no blockers' }));
    writeFileSync(join(auditDirectory, 'browser-observation.md'), 'opened the real running app with agent-browser\n');
    writeFileSync(join(auditDirectory, 'notes.md'), 'audited running app visual state\n');
    writeFileSync(join(screenshotsDirectory, 'settings.png'), 'fake image bytes\n');
    const config = getDefaults();
    config.reviewAgents = ['@copilot', 'review-bot'];
    config.gates = [
      { name: 'unit', kind: 'unit', command: 'npm test', stage: 'pre-pr', required: true, timeoutSeconds: 600, workingDirectory: '.', env: {}, externalService: false },
      { name: 'pack', kind: 'build', command: 'npm run pack:check', stage: 'pre-merge', required: true, timeoutSeconds: 600, workingDirectory: '.', env: {}, externalService: false },
    ];
    const exec = async args => {
      const issue = issueViewResponse(args, 93);
      if (issue) return issue;
      if (args.join(' ') === 'pr view --json number,title,state,url,reviewDecision,mergeStateStatus,mergeable,isDraft') {
        return { args, exitCode: 0, stdout: JSON.stringify({ number: 44, title: 'Ship issue 93', state: 'OPEN', url: 'https://github.com/example/repo/pull/44', reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE', isDraft: false }), stderr: '' };
      }
      if (args[0] === 'pr' && args[1] === 'view' && args[2] === '44') {
        return { args, exitCode: 0, stdout: JSON.stringify(basePr({ number: 44, title: 'Ship issue 93', url: 'https://github.com/example/repo/pull/44', reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE' })), stderr: '' };
      }
      if (args.join(' ') === 'repo view --json nameWithOwner,url') {
        return { args, exitCode: 0, stdout: JSON.stringify({ nameWithOwner: 'example/repo', url: 'https://github.com/example/repo' }), stderr: '' };
      }
      if (args[0] === 'api' && args[1] === 'repos/example/repo/issues/44/comments') {
        return { args, exitCode: 0, stdout: JSON.stringify([]), stderr: '' };
      }
      if (args[0] === 'api' && args[1] === 'repos/example/repo/pulls/44/comments') {
        return { args, exitCode: 0, stdout: JSON.stringify([]), stderr: '' };
      }
      if (args[0] === 'api' && args[1] === 'graphql') {
        return { args, exitCode: 0, stdout: JSON.stringify(threadResponse()), stderr: '' };
      }
      return { args, exitCode: 1, stdout: '', stderr: `unexpected gh call: ${args.join(' ')}` };
    };

    const result = await buildPrBody(config, { issueNumber: 93, repoRoot: repo, homeDirectory: home, exec });

    assert.equal(result.command, 'pr body');
    assert.match(result.body, /Closes #93/);
    assert.match(result.body, /passed: unit/);
    assert.match(result.body, /missing: pack/);
    assert.match(result.body, /Manual UI audit: visual-analysis-recorded/);
    assert.match(result.body, /Review-agent gate: passed/);
    assert.match(result.body, /PR reviewer @copilot/);
    assert.match(result.body, /PR reviewer @review-bot/);
    assert.match(result.body, /Recommended next command:/);
    assert.match(result.body, /Default merge strategy when policy permits: squash merge/);
    assert.equal(result.pullRequest.number, 44);
    assert.equal(result.readiness.status, 'pending');
    assert.equal(result.gates.lines[0].source, 'configured-gate');
    assert.equal(result.gates.lines[0].trust, 'agent-reported');
    assert.equal(result.gates.lines[0].reasonCode, 'agent-reported-result');
    assert.equal(result.gates.lines[0].verified, false);
    assert.equal(result.gates.lines[1].state, 'missing');
    assert.ok(result.readiness.pending.some(item => item.includes('pack')));
    assert.ok(result.readiness.pending.some(item => item.includes('@copilot')));
    assert.ok(result.readiness.pendingDetails.some(item => item.reasonCode === 'missing-evidence' && item.source === 'configured-gate'));
    assert.ok(result.readiness.pendingDetails.some(item => item.reasonCode === 'pr-review-pending' && item.source === 'pr-review-gate'));
  });

  it('includes local review-agent, QA, and final gate readiness in PR body output', async () => {
    const repo = makeGitRepo();
    const config = localReviewConfig();
    config.manualUiAudit = false;
    writeLocalEvidence(repo, localEvidence({ issueNumber: 103 }));
    const currentPr = { number: 12, title: 'Local review PR', state: 'OPEN', url: 'https://github.com/example/repo/pull/12', reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE', isDraft: false };
    const pr = approvedLocalPr({ closingIssuesReferences: [{ number: 103 }] });
    const { exec } = makePrExec({ prViews: [pr], issueBodies: { 103: '' } });
    const wrappedExec = async args => {
      if (args.join(' ') === 'pr view --json number,title,state,url,reviewDecision,mergeStateStatus,mergeable,isDraft') return { args, exitCode: 0, stdout: JSON.stringify(currentPr), stderr: '' };
      return exec(args);
    };

    const result = await buildPrBody(config, { issueNumber: 103, repoRoot: repo, exec: wrappedExec });

    assert.match(result.body, /Local review agents:/);
    assert.match(result.body, /local review evidence:/);
    assert.match(result.body, /PR reviewer @QUBEReview/);
    assert.match(result.body, /manual-qa|final-gate/);
    assert.doesNotMatch(result.body, /\.qube\/aie\/reviews/);
    assert.doesNotMatch(result.body, /\.qube\\aie\\reviews/);
    assert.doesNotMatch(result.body, new RegExp(repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(result.readiness.status, 'ready');
    assert.equal(result.readiness.pending.some(item => item.includes('provider-visible')), false);
  });

  it('does not require issue-level UI audit or review gate when PR-local review supersedes them', async () => {
    const repo = makeGitRepo();
    const config = localReviewConfig();
    writeLocalEvidence(repo, localEvidence({ issueNumber: 105 }));
    const currentPr = { number: 12, title: 'Local review PR', state: 'OPEN', url: 'https://github.com/example/repo/pull/12', reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE', isDraft: false };
    const pr = approvedLocalPr({ closingIssuesReferences: [{ number: 105 }] });
    const { exec } = makePrExec({ prViews: [pr], issueBodies: { 105: '' } });
    const wrappedExec = async args => {
      if (args.join(' ') === 'pr view --json number,title,state,url,reviewDecision,mergeStateStatus,mergeable,isDraft') return { args, exitCode: 0, stdout: JSON.stringify(currentPr), stderr: '' };
      return exec(args);
    };

    const result = await buildPrBody(config, { issueNumber: 105, repoRoot: repo, exec: wrappedExec });

    assert.equal(result.readiness.status, 'ready');
    assert.match(result.body, /Manual UI audit: not applicable/);
    assert.match(result.body, /Review-agent gate: superseded by PR-local review agents/);
    assert.doesNotMatch(result.body, /Create browser-observation/);
    assert.doesNotMatch(result.body, /Review-agent gate: pending/);
    assert.equal(result.readiness.pendingDetails.some(item => item.source === 'manual-audit'), false);
    assert.equal(result.readiness.pendingDetails.some(item => item.source === 'review-agent' && item.reasonCode === 'review-not-recorded'), false);
  });

  it('uses local review reason codes in PR body readiness', async () => {
    const repo = makeGitRepo();
    const config = localReviewConfig();
    config.manualUiAudit = false;
    writeLocalEvidence(repo, localEvidence({ issueNumber: 104, laneStatus: 'needs-work', summary: 'local review needs work', blockers: ['Fix review finding'] }));
    const currentPr = { number: 12, title: 'Local review PR', state: 'OPEN', url: 'https://github.com/example/repo/pull/12', reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE', isDraft: false };
    const pr = cleanLocalPr({ closingIssuesReferences: [{ number: 104 }] });
    const { exec } = makePrExec({ prViews: [pr], issueBodies: { 104: '' } });
    const wrappedExec = async args => {
      if (args.join(' ') === 'pr view --json number,title,state,url,reviewDecision,mergeStateStatus,mergeable,isDraft') return { args, exitCode: 0, stdout: JSON.stringify(currentPr), stderr: '' };
      return exec(args);
    };

    const result = await buildPrBody(config, { issueNumber: 104, repoRoot: repo, exec: wrappedExec });

    assert.equal(result.readiness.status, 'blocked');
    assert.ok(result.readiness.blockerDetails.some(item => item.reasonCode === 'local-review-failed'));
    assert.equal(result.readiness.pendingDetails.some(item => item.reasonCode === 'pr-review-pending' && item.source === 'github-pr'), false);
  });

  it('blocks PR body readiness when the issue checklist is unchecked', async () => {
    const repo = makeGitRepo();
    mkdirSync(join(repo, '.qube', 'aie', 'reviews'), { recursive: true });
    writeFileSync(join(repo, '.qube', 'aie', 'reviews', '93.json'), JSON.stringify({ status: 'passed', summary: 'review passed' }));
    const config = getDefaults();
    config.manualUiAudit = false;
    config.reviewAgents = [];
    const exec = async args => {
      const issue = issueViewResponse(args, 93, '- [x] Done\n- [ ] Acceptance B');
      if (issue) return issue;
      return { args, exitCode: 1, stdout: '', stderr: 'no pull requests found for branch' };
    };

    const result = await buildPrBody(config, { issueNumber: 93, repoRoot: repo, exec });

    assert.equal(result.issueChecklist.checklist.unchecked, 1);
    assert.equal(result.readiness.status, 'blocked');
    assert.ok(result.readiness.blockerDetails.some(item => item.reasonCode === 'issue-checklist-unchecked'));
    assert.match(result.body, /Issue checklist: 1\/2 checked/);
  });

  it('renders one criterion-to-proof scaffold entry per checklist criterion', async () => {
    const repo = makeGitRepo();
    mkdirSync(join(repo, '.qube', 'aie', 'reviews'), { recursive: true });
    writeFileSync(join(repo, '.qube', 'aie', 'reviews', '93.json'), JSON.stringify({ status: 'passed', summary: 'review passed' }));
    const config = getDefaults();
    config.manualUiAudit = false;
    config.reviewAgents = [];
    const singleExec = async args => {
      const issue = issueViewResponse(args, 93, '- [ ] Renders the scaffold for each criterion.');
      if (issue) return issue;
      return { args, exitCode: 1, stdout: '', stderr: 'no pull requests found for branch' };
    };

    const single = await buildPrBody(config, { issueNumber: 93, repoRoot: repo, exec: singleExec });

    assert.match(single.body, /## Criterion-to-proof map/);
    assert.match(single.body, /Fill every entry before opening the PR\. Update entries when review fixes move code or tests\./);
    assert.match(single.body, /### Criterion 1: Renders the scaffold for each criterion\./);
    assert.match(single.body, /- Implemented at: \[UNFILLED: list the file paths and symbols where this behavior lives\]/);
    assert.match(single.body, /- Proven by: \[UNFILLED: name the test file and test whose assertions fail if this behavior regresses\]/);
    assert.match(single.body, /- Negative case: \[UNFILLED: name the counterexample test, or state why none applies\]/);
    assert.equal((single.body.match(/\[UNFILLED:/g) || []).length, 3);
    const mapIndex = single.body.indexOf('## Criterion-to-proof map');
    assert.ok(mapIndex > single.body.indexOf('## Summary'));
    assert.ok(mapIndex < single.body.indexOf('## Verification'));

    const manyBody = Array.from({ length: 12 }, (_, index) => `- [${index % 2 ? 'x' : ' '}] Criterion body ${index + 1}.`).join('\n');
    const manyExec = async args => {
      const issue = issueViewResponse(args, 93, manyBody);
      if (issue) return issue;
      return { args, exitCode: 1, stdout: '', stderr: 'no pull requests found for branch' };
    };

    const many = await buildPrBody(config, { issueNumber: 93, repoRoot: repo, exec: manyExec });

    assert.equal((many.body.match(/### Criterion /g) || []).length, 12);
    assert.equal((many.body.match(/\[UNFILLED:/g) || []).length, 36);
    assert.match(many.body, /### Criterion 12: Criterion body 12\./);
  });

  it('renders no scaffold section or placeholder debris without checklist criteria', async () => {
    const repo = makeGitRepo();
    mkdirSync(join(repo, '.qube', 'aie', 'reviews'), { recursive: true });
    writeFileSync(join(repo, '.qube', 'aie', 'reviews', '93.json'), JSON.stringify({ status: 'passed', summary: 'review passed' }));
    const config = getDefaults();
    config.manualUiAudit = false;
    config.reviewAgents = [];
    const exec = async args => {
      const issue = issueViewResponse(args, 93);
      if (issue) return issue;
      return { args, exitCode: 1, stdout: '', stderr: 'no pull requests found for branch' };
    };

    const result = await buildPrBody(config, { issueNumber: 93, repoRoot: repo, exec });

    assert.doesNotMatch(result.body, /Criterion-to-proof/);
    assert.doesNotMatch(result.body, /\[UNFILLED/);
  });

  it('directs the issue-compliance lane to verify the criterion-to-proof map', () => {
    const stack = promptStack('codex', 'issue-compliance', []);
    assert.match(stack.text, /Criterion-to-proof map entries left \[UNFILLED\], pointing at the wrong location, or naming a test that mirrors the implementation instead of asserting the criterion\./);
    assert.match(stack.text, /Negative-case coverage: does a named counterexample test exist, or is there a concrete stated reason none applies\./);
  });

  it('does not report ready while GitHub merge state is still blocked', async () => {
    const repo = makeGitRepo();
    mkdirSync(join(repo, '.qube', 'aie', 'reviews'), { recursive: true });
    writeFileSync(join(repo, '.qube', 'aie', 'reviews', '95.json'), JSON.stringify({ status: 'passed', summary: 'review passed' }));
    const config = getDefaults();
    config.manualUiAudit = false;
    config.reviewAgents = [];
    const exec = async args => {
      const issue = issueViewResponse(args, 95);
      if (issue) return issue;
      if (args.join(' ') === 'pr view --json number,title,state,url,reviewDecision,mergeStateStatus,mergeable,isDraft') {
        return { args, exitCode: 0, stdout: JSON.stringify({ number: 45, title: 'Blocked merge', state: 'OPEN', url: 'https://github.com/example/repo/pull/45', reviewDecision: 'APPROVED', mergeStateStatus: 'BLOCKED', mergeable: 'MERGEABLE', isDraft: false }), stderr: '' };
      }
      if (args[0] === 'pr' && args[1] === 'view' && args[2] === '45') {
        return { args, exitCode: 0, stdout: JSON.stringify(basePr({ number: 45, title: 'Blocked merge', url: 'https://github.com/example/repo/pull/45', reviewDecision: 'APPROVED', mergeStateStatus: 'BLOCKED', mergeable: 'MERGEABLE' })), stderr: '' };
      }
      if (args.join(' ') === 'repo view --json nameWithOwner,url') {
        return { args, exitCode: 0, stdout: JSON.stringify({ nameWithOwner: 'example/repo', url: 'https://github.com/example/repo' }), stderr: '' };
      }
      if (args[0] === 'api' && args[1] === 'repos/example/repo/issues/45/comments') {
        return { args, exitCode: 0, stdout: JSON.stringify([]), stderr: '' };
      }
      if (args[0] === 'api' && args[1] === 'repos/example/repo/pulls/45/comments') {
        return { args, exitCode: 0, stdout: JSON.stringify([]), stderr: '' };
      }
      if (args[0] === 'api' && args[1] === 'graphql') {
        return { args, exitCode: 0, stdout: JSON.stringify(threadResponse()), stderr: '' };
      }
      return { args, exitCode: 1, stdout: '', stderr: `unexpected gh call: ${args.join(' ')}` };
    };

    const result = await buildPrBody(config, { issueNumber: 95, repoRoot: repo, exec });

    assert.equal(result.readiness.status, 'pending');
    assert.ok(result.readiness.pending.some(item => item.includes('merge state BLOCKED')));
    assert.match(result.body, /GitHub state: review=APPROVED; merge=BLOCKED/);
  });

  it('includes missing current-head CI diagnostics in PR body readiness', async () => {
    const repo = makeGitRepo();
    writeWorkflow(repo, 'on:\n  pull_request:\n    branches: [main]\n');
    mkdirSync(join(repo, '.qube', 'aie', 'reviews'), { recursive: true });
    writeFileSync(join(repo, '.qube', 'aie', 'reviews', '102.json'), JSON.stringify({ status: 'passed', summary: 'review passed' }));
    const config = getDefaults();
    config.manualUiAudit = false;
    config.reviewAgents = [];
    const currentPr = { number: 12, title: 'Missing CI', state: 'OPEN', url: 'https://github.com/example/repo/pull/12', reviewDecision: 'APPROVED', mergeStateStatus: 'BLOCKED', mergeable: 'MERGEABLE', isDraft: false };
    const pr = basePr({
      title: 'Missing CI',
      reviewDecision: 'APPROVED',
      mergeStateStatus: 'BLOCKED',
      statusCheckRollup: [{ name: 'ci-required', status: 'IN_PROGRESS', conclusion: null }],
    });
    const exec = async args => {
      const issue = issueViewResponse(args, 102);
      if (issue) return issue;
      if (args.join(' ') === 'pr view --json number,title,state,url,reviewDecision,mergeStateStatus,mergeable,isDraft') return { args, exitCode: 0, stdout: JSON.stringify(currentPr), stderr: '' };
      if (args.join(' ') === `pr view 12 --json ${prViewFields}`) return { args, exitCode: 0, stdout: JSON.stringify(pr), stderr: '' };
      if (args.join(' ') === 'repo view --json nameWithOwner,url') return { args, exitCode: 0, stdout: JSON.stringify({ nameWithOwner: 'example/repo', url: 'https://github.com/example/repo' }), stderr: '' };
      if (args.join(' ') === 'api user') return { args, exitCode: 0, stdout: JSON.stringify({ login: 'executor' }), stderr: '' };
      if (args[0] === 'api' && args[1] === 'repos/example/repo/issues/12/comments') return { args, exitCode: 0, stdout: JSON.stringify([]), stderr: '' };
      if (args[0] === 'api' && args[1] === 'repos/example/repo/pulls/12/comments') return { args, exitCode: 0, stdout: JSON.stringify([]), stderr: '' };
      if (args[0] === 'api' && args[1] === 'repos/example/repo/commits/abc123/check-runs') return { args, exitCode: 0, stdout: JSON.stringify({ check_runs: [] }), stderr: '' };
      if (args[0] === 'api' && args[1] === 'repos/example/repo/commits/abc123/check-suites') return { args, exitCode: 0, stdout: JSON.stringify({ check_suites: [] }), stderr: '' };
      if (args[0] === 'api' && args[1] === 'repos/example/repo/actions/runs') return { args, exitCode: 0, stdout: JSON.stringify({ workflow_runs: [] }), stderr: '' };
      if (args[0] === 'api' && args[1] === 'graphql') return { args, exitCode: 0, stdout: JSON.stringify(threadResponse()), stderr: '' };
      return { args, exitCode: 1, stdout: '', stderr: `unexpected gh call: ${args.join(' ')}` };
    };

    const result = await buildPrBody(config, { issueNumber: 102, repoRoot: repo, exec });

    assert.equal(result.readiness.status, 'pending');
    assert.ok(result.readiness.pendingDetails.some(item => item.reasonCode === 'missing-current-head-ci-run'));
    assert.match(result.body, /PR CI diagnostics/);
    assert.match(result.body, /Push a new commit/);
  });

  it('blocks PR body readiness for draft pull requests', async () => {
    const repo = makeGitRepo();
    mkdirSync(join(repo, '.qube', 'aie', 'reviews'), { recursive: true });
    writeFileSync(join(repo, '.qube', 'aie', 'reviews', '96.json'), JSON.stringify({ status: 'passed', summary: 'review passed' }));
    const config = getDefaults();
    config.manualUiAudit = false;
    config.reviewAgents = [];
    const exec = async args => {
      const issue = issueViewResponse(args, 96);
      if (issue) return issue;
      if (args.join(' ') === 'pr view --json number,title,state,url,reviewDecision,mergeStateStatus,mergeable,isDraft') {
        return { args, exitCode: 0, stdout: JSON.stringify({ number: 46, title: 'Draft PR', state: 'OPEN', url: 'https://github.com/example/repo/pull/46', reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE', isDraft: true }), stderr: '' };
      }
      if (args[0] === 'pr' && args[1] === 'view' && args[2] === '46') {
        return { args, exitCode: 0, stdout: JSON.stringify(basePr({ number: 46, title: 'Draft PR', url: 'https://github.com/example/repo/pull/46', reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE', isDraft: true })), stderr: '' };
      }
      if (args.join(' ') === 'repo view --json nameWithOwner,url') return { args, exitCode: 0, stdout: JSON.stringify({ nameWithOwner: 'example/repo', url: 'https://github.com/example/repo' }), stderr: '' };
      if (args[0] === 'api' && args[1] === 'repos/example/repo/issues/46/comments') return { args, exitCode: 0, stdout: JSON.stringify([]), stderr: '' };
      if (args[0] === 'api' && args[1] === 'repos/example/repo/pulls/46/comments') return { args, exitCode: 0, stdout: JSON.stringify([]), stderr: '' };
      if (args[0] === 'api' && args[1] === 'graphql') return { args, exitCode: 0, stdout: JSON.stringify(threadResponse()), stderr: '' };
      return { args, exitCode: 1, stdout: '', stderr: `unexpected gh call: ${args.join(' ')}` };
    };

    const result = await buildPrBody(config, { issueNumber: 96, repoRoot: repo, exec });

    assert.equal(result.readiness.status, 'blocked');
    assert.ok(result.readiness.blockerDetails.some(item => item.reasonCode === 'pull-request-draft'));
    assert.match(result.body, /draft=yes/);
    assert.match(result.body, /Pull request is still a draft/);
  });

  it('blocks readiness when GitHub has requested PR changes', async () => {
    const repo = makeGitRepo();
    mkdirSync(join(repo, '.qube', 'aie', 'reviews'), { recursive: true });
    writeFileSync(join(repo, '.qube', 'aie', 'reviews', '99.json'), JSON.stringify({ status: 'passed', summary: 'review passed' }));
    const config = getDefaults();
    config.manualUiAudit = false;
    config.reviewAgents = [];
    const exec = async args => {
      const issue = issueViewResponse(args, 99);
      if (issue) return issue;
      if (args.join(' ') === 'pr view --json number,title,state,url,reviewDecision,mergeStateStatus,mergeable,isDraft') {
        return { args, exitCode: 0, stdout: JSON.stringify({ number: 49, title: 'Needs changes', state: 'OPEN', url: 'https://github.com/example/repo/pull/49', reviewDecision: 'CHANGES_REQUESTED', mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE', isDraft: false }), stderr: '' };
      }
      if (args[0] === 'pr' && args[1] === 'view' && args[2] === '49') {
        return { args, exitCode: 0, stdout: JSON.stringify(basePr({ number: 49, title: 'Needs changes', url: 'https://github.com/example/repo/pull/49', reviewDecision: 'CHANGES_REQUESTED', mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE' })), stderr: '' };
      }
      if (args.join(' ') === 'repo view --json nameWithOwner,url') return { args, exitCode: 0, stdout: JSON.stringify({ nameWithOwner: 'example/repo', url: 'https://github.com/example/repo' }), stderr: '' };
      if (args.join(' ') === 'api user') return { args, exitCode: 0, stdout: JSON.stringify({ login: 'executor' }), stderr: '' };
      if (args[0] === 'api' && args[1] === 'repos/example/repo/issues/49/comments') return { args, exitCode: 0, stdout: JSON.stringify([]), stderr: '' };
      if (args[0] === 'api' && args[1] === 'repos/example/repo/pulls/49/comments') return { args, exitCode: 0, stdout: JSON.stringify([]), stderr: '' };
      if (args[0] === 'api' && args[1] === 'graphql') return { args, exitCode: 0, stdout: JSON.stringify(threadResponse()), stderr: '' };
      return { args, exitCode: 1, stdout: '', stderr: `unexpected gh call: ${args.join(' ')}` };
    };

    const result = await buildPrBody(config, { issueNumber: 99, repoRoot: repo, exec });

    assert.equal(result.readiness.status, 'blocked');
    assert.ok(result.readiness.blockerDetails.some(item => item.reasonCode === 'pr-review-blocked' && item.source === 'github-pr'));
    assert.equal(result.readiness.pendingDetails.some(item => item.reasonCode === 'pr-review-pending' && item.source === 'github-pr'), false);
    assert.match(result.body, /GitHub review state is CHANGES_REQUESTED/);
  });

  it('keeps stale local review lane evidence pending in readiness details', async () => {
    const repo = makeGitRepo();
    const config = localReviewConfig();
    config.manualUiAudit = false;
    writeLocalEvidence(repo, localEvidence({ issueNumber: 98, headSha: 'oldsha' }));
    const pr = cleanLocalPr({ closingIssuesReferences: [{ number: 98 }] });
    const { exec } = makePrExec({ prViews: [pr], issueBodies: { 98: '' } });

    const result = await buildPrBody(config, { issueNumber: 98, repoRoot: repo, exec });

    assert.equal(result.prReviewGate.result.localReview.status, 'stale');
    assert.equal(result.readiness.status, 'pending');
    assert.ok(result.readiness.pendingDetails.some(item => item.reasonCode === 'local-review-stale' && item.source === 'review-agent'));
  });

  it('keeps readiness pending when PR review-gate inspection is unavailable', async () => {
    const repo = makeGitRepo();
    mkdirSync(join(repo, '.qube', 'aie', 'reviews'), { recursive: true });
    writeFileSync(join(repo, '.qube', 'aie', 'reviews', '96.json'), JSON.stringify({ status: 'passed', summary: 'review passed' }));
    const config = getDefaults();
    config.manualUiAudit = false;
    config.reviewAgents = [];
    const exec = async args => {
      const issue = issueViewResponse(args, 96);
      if (issue) return issue;
      if (args.join(' ') === 'pr view --json number,title,state,url,reviewDecision,mergeStateStatus,mergeable,isDraft') {
        return { args, exitCode: 0, stdout: JSON.stringify({ number: 46, title: 'Inspection failure', state: 'OPEN', url: 'https://github.com/example/repo/pull/46', reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE', isDraft: false }), stderr: '' };
      }
      if (args[0] === 'pr' && args[1] === 'view' && args[2] === '46') {
        return { args, exitCode: 1, stdout: '', stderr: 'permission denied ghp_abcdEFGH1234567890abcdEFGH1234567890abcd' };
      }
      return { args, exitCode: 1, stdout: '', stderr: `unexpected gh call: ${args.join(' ')}` };
    };

    const result = await buildPrBody(config, { issueNumber: 96, repoRoot: repo, exec });

    assert.equal(result.readiness.status, 'pending');
    assert.ok(result.readiness.pending.some(item => item.includes('collect PR review-gate state')));
    assert.ok(result.warnings.some(item => item.includes('PR review-gate state unavailable')));
    assert.equal(result.warnings.some(item => item.includes('ghp_abcd')), false);
  });

  it('keeps readiness pending while PR review gate remains pending', async () => {
    const repo = makeGitRepo();
    mkdirSync(join(repo, '.qube', 'aie', 'reviews'), { recursive: true });
    writeFileSync(join(repo, '.qube', 'aie', 'reviews', '97.json'), JSON.stringify({ status: 'passed', summary: 'review passed' }));
    const config = getDefaults();
    config.manualUiAudit = false;
    config.reviewAgents = [];
    const exec = async args => {
      const issue = issueViewResponse(args, 97);
      if (issue) return issue;
      if (args.join(' ') === 'pr view --json number,title,state,url,reviewDecision,mergeStateStatus,mergeable,isDraft') return { args, exitCode: 0, stdout: JSON.stringify({ number: 47, title: 'Pending reviews', state: 'OPEN', url: 'https://github.com/example/repo/pull/47', reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE', isDraft: false }), stderr: '' };
      if (args[0] === 'pr' && args[1] === 'view' && args[2] === '47') return { args, exitCode: 0, stdout: JSON.stringify(basePr({ number: 47, title: 'Pending reviews', url: 'https://github.com/example/repo/pull/47', reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE' })), stderr: '' };
      if (args.join(' ') === 'repo view --json nameWithOwner,url') return { args, exitCode: 0, stdout: JSON.stringify({ nameWithOwner: 'example/repo', url: 'https://github.com/example/repo' }), stderr: '' };
      if (args.join(' ') === 'api user') return { args, exitCode: 0, stdout: JSON.stringify({ login: 'executor' }), stderr: '' };
      if (args[0] === 'api' && args[1] === 'repos/example/repo/issues/47/comments') return { args, exitCode: 0, stdout: JSON.stringify([]), stderr: '' };
      if (args[0] === 'api' && args[1] === 'repos/example/repo/pulls/47/comments') return { args, exitCode: 0, stdout: JSON.stringify([]), stderr: '' };
      if (args[0] === 'api' && args[1] === 'graphql') return { args, exitCode: 0, stdout: JSON.stringify(threadResponse()), stderr: '' };
      return { args, exitCode: 1, stdout: '', stderr: `unexpected gh call: ${args.join(' ')}` };
    };

    const result = await buildPrBody(config, { issueNumber: 97, repoRoot: repo, exec });

    assert.equal(result.readiness.status, 'pending');
    assert.ok(result.readiness.pending.some(item => item.includes('pending PR review requirements')));
  });

  it('reports blockers without requiring an existing current-branch pull request', async () => {
    const repo = makeGitRepo();
    mkdirSync(join(repo, '.qube', 'aie', 'gates'), { recursive: true });
    writeFileSync(join(repo, '.qube', 'aie', 'gates', 'typecheck.json'), JSON.stringify({ status: 'failed', summary: 'type error' }));
    const config = getDefaults();
    config.manualUiAudit = false;
    config.gates = [{ name: 'typecheck', kind: 'typecheck', command: 'npm run typecheck', stage: 'pre-pr', required: true, timeoutSeconds: 600, workingDirectory: '.', env: {}, externalService: false }];
    const exec = async args => issueViewResponse(args, 94) ?? { args, exitCode: 1, stdout: '', stderr: 'no pull requests found for branch' };

    const result = await buildPrBody(config, { issueNumber: 94, repoRoot: repo, exec });

    assert.equal(result.pullRequest, null);
    assert.equal(result.readiness.status, 'blocked');
    assert.ok(result.readiness.blockers.some(item => item.includes('typecheck')));
    assert.match(result.body, /Pull request: not detected/);
    assert.match(result.body, /Closes #94/);
  });

  it('recommends a non-draft pull request when no current PR exists', async () => {
    const repo = makeGitRepo();
    mkdirSync(join(repo, '.qube', 'aie', 'reviews'), { recursive: true });
    writeFileSync(join(repo, '.qube', 'aie', 'reviews', '98.json'), JSON.stringify({ status: 'passed', summary: 'review passed' }));
    const config = getDefaults();
    config.manualUiAudit = false;
    config.reviewAgents = [];
    const exec = async args => issueViewResponse(args, 98) ?? { args, exitCode: 1, stdout: '', stderr: 'no pull requests found for branch' };

    const result = await buildPrBody(config, { issueNumber: 98, repoRoot: repo, exec });

    assert.equal(result.pullRequest, null);
    assert.equal(result.readiness.status, 'pending');
    assert.equal(result.readiness.nextCommand, 'Create a non-draft, ready-for-review pull request with this body, then run `aie pr gate <pr>` before merge.');
    assert.ok(result.readiness.pending.some(item => item.includes('non-draft, ready-for-review pull request')));
    assert.match(result.body, /Create a non-draft, ready-for-review pull request/);
  });
});

describe('PR gate CLI and metadata', { concurrency: 4 }, () => {
  it('shows PR gate help forms without mutation', () => {
    const repo = makeGitRepo();
    const topic = binRun(['pr', 'help'], repo);
    const viewSuffix = binRun(['pr', 'view', 'help'], repo);
    const viewPrefix = binRun(['help', 'pr', 'view'], repo);
    const suffix = binRun(['pr', 'gate', 'help'], repo);
    const prefix = binRun(['help', 'pr', 'gate'], repo);
    const flag = binRun(['pr', 'gate', '--help'], repo);
    const bodySuffix = binRun(['pr', 'body', 'help'], repo);
    const bodyPrefix = binRun(['help', 'pr', 'body'], repo);
    const bodyFlag = binRun(['pr', 'body', '--help'], repo);

    assert.equal(topic.status, 0);
    assert.match(topic.stdout, /pr view/);
    assert.match(topic.stdout, /pr gate/);
    assert.match(topic.stdout, /pr body/);
    assert.equal(viewSuffix.status, 0);
    assert.match(viewSuffix.stdout, /concise PR state/i);
    assert.equal(viewPrefix.status, 0);
    assert.match(viewPrefix.stdout, /pr view/i);
    assert.equal(suffix.status, 0);
    assert.match(suffix.stdout, /PR review gate/i);
    assert.equal(prefix.status, 0);
    assert.match(prefix.stdout, /pr gate/i);
    assert.equal(flag.status, 0);
    assert.match(flag.stdout, /--dry-run/);
    assert.equal(bodySuffix.status, 0);
    assert.match(bodySuffix.stdout, /PR body/i);
    assert.equal(bodyPrefix.status, 0);
    assert.match(bodyPrefix.stdout, /pr body/i);
    assert.equal(bodyFlag.status, 0);
    assert.match(bodyFlag.stdout, /merge-readiness/i);
  });

  it('emits a read-only PR body draft with issue closure text', () => {
    const repo = makeGitRepo();

    const result = binRun(['pr', 'body', '93', '--json'], repo);
    const parsed = JSON.parse(result.stdout);

    assert.equal(result.status, 0);
    assert.equal(parsed.command, 'pr body');
    assert.equal(parsed.issue, 93);
    assert.match(parsed.body, /Closes #93/);
    assert.match(parsed.body, /Manual UI audit:/);
    assert.match(parsed.body, /Review-agent gate:/);
    assert.match(parsed.body, /squash merge/);
    assert.equal(parsed.readiness.mergeStrategy, 'squash');
    assert.equal(Array.isArray(parsed.readiness.pendingDetails), true);
    assert.ok(parsed.readiness.pendingDetails.every(item => typeof item.reasonCode === 'string'));
  });

  it('fails PR gate commands on malformed trusted config before GitHub access', () => {
    const repo = makeGitRepo();
    writeConfig(repo, { version: 1, reviewWaitMinutes: '10' });

    const result = binRun(['pr', 'gate', '12', '--json'], repo);
    const parsed = JSON.parse(result.stdout);

    assert.notEqual(result.status, 0);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.command, 'pr gate');
    assert.ok(parsed.errors.some(error => error.path === 'reviewWaitMinutes'));
  });

  it('fails PR body commands on malformed trusted config before GitHub access', () => {
    const repo = makeGitRepo();
    writeConfig(repo, { version: 1, manualUiAudit: 'yes' });

    const result = binRun(['pr', 'body', '93', '--json'], repo);
    const parsed = JSON.parse(result.stdout);

    assert.notEqual(result.status, 0);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.command, 'pr body');
    assert.ok(parsed.errors.some(error => error.path === 'manualUiAudit'));
  });

  it('publishes PR gate commands in schema metadata', () => {
    const result = binRun(['schema', '--json']);
    const parsed = JSON.parse(result.stdout);
    const pr = parsed.commands.find(command => command.name === 'pr');
    const view = parsed.commands.find(command => command.name === 'pr view');
    const body = parsed.commands.find(command => command.name === 'pr body');
    const gate = parsed.commands.find(command => command.name === 'pr gate');
    const publish = parsed.commands.find(command => command.name === 'pr review publish');

    assert.equal(result.status, 0);
    assert.equal(pr.mutation.mutates, false);
    assert.equal(view.mutation.mutates, false);
    assert.deepEqual(view.mutation.categories, []);
    assert.equal(view.interactions.json, true);
    assert.equal(view.dryRun.supported, false);
    assert.equal(view.flags.find(flag => flag.name === 'json').type, 'boolean');
    assert.equal(body.mutation.mutates, false);
    assert.deepEqual(body.mutation.categories, []);
    assert.equal(body.interactions.json, true);
    assert.equal(body.dryRun.supported, false);
    assert.equal(body.flags.find(flag => flag.name === 'json').type, 'boolean');
    assert.equal(gate.mutation.mutates, true);
    assert.deepEqual(gate.mutation.categories, ['github']);
    assert.equal(gate.interactions.json, true);
    assert.equal(gate.dryRun.supported, true);
    assert.equal(gate.flags.find(flag => flag.name === 'dry-run').type, 'boolean');
    assert.equal(publish.mutation.mutates, true);
    assert.deepEqual(publish.mutation.categories, ['github']);
    assert.equal(publish.interactions.json, true);
    assert.equal(publish.dryRun.supported, true);
    assert.equal(publish.flags.find(flag => flag.name === 'lane').type, 'string');
    assert.equal(publish.flags.find(flag => flag.name === 'issue').type, 'integer');
    assert.equal(publish.flags.find(flag => flag.name === 'dry-run').type, 'boolean');
  });
});

// Wall-clock assertions need an uncontended event loop, so this timing suite
// runs serially after the concurrent gate suites complete.
describe('PR gate routed concurrency timing', () => {
  it('overlaps routed lanes under the global bound with per-host caps and deterministic order', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    applyRoutedReviewFixture(repo);
    config.reviewAdapter = 'mixed';
    config.reviewAgents = [];
    config.reviewWaitMinutes = 0;
    config.reviewConcurrency = 3;
    config.reviewRoute = { host: 'grok-build', tier: 'review', timeoutSeconds: 600, maxTurns: 8 };
    config.reviewModels.review['grok-build'] = { model: 'grok-4.5', effort: null };
    const fixture = makePrExec({ prViews: [cleanLocalPr()] });
    let active = 0;
    let maxActive = 0;
    const laneStarts = [];
    const laneCompletions = [];
    const laneWindows = [];
    const promptPaths = new Set();
    const modelRouteProcess = async invocation => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      promptPaths.add(invocation.promptPath);
      const prompt = readFileSync(invocation.promptPath, 'utf8');
      const lane = prompt.match(/Run local review lane ([a-z-]+)\./)?.[1];
      laneStarts.push(lane);
      const startedAt = Date.now();
      await new Promise(resolve => setTimeout(resolve, laneStarts.length === 1 ? 600 : 100));
      laneWindows.push({ startedAt, endedAt: Date.now() });
      laneCompletions.push(lane);
      active -= 1;
      const body = {
        issueNumber: 93,
        prNumber: 12,
        headSha: 'abc123',
        lane,
        status: 'passed',
        severity: 'none',
        recommendation: 'approve',
        summary: `${lane} routed review passed.`,
        blockers: [],
        findings: [],
        artifacts: [{ kind: 'command', path: 'command:git diff --check', sha256: null }],
        commands: ['git diff --check'],
        surfaces: ['PR diff'],
        contextReviewed: requiredTaskContext(),
        toolsUsed: ['git'],
        completeness: `Inspected the complete ${lane} scope at the current head.`,
        coverage: ((prompt.match(/Attest coverage for exactly these areas: ([^\n]+?)\. Each coverage entry/) || [])[1] || lane).split(', ').map(area => ({ area, status: 'clear' })),
        preconditions: [],
      };
      return { exitCode: 0, stderr: '', timedOut: false, stdinDelivered: true, stdout: JSON.stringify({ text: JSON.stringify(body), sessionId: `session-${lane}` }) };
    };

    const plan = await runPrGate(config, { prNumber: 12, repoRoot: repo, dryRun: true, exec: makePrExec({ prViews: [cleanLocalPr()] }).exec });
    const plannedOrder = plan.localReviewRunner.lanes.filter(lane => lane.route !== null).map(lane => lane.lane);
    assert.ok(plannedOrder.length >= 3, `expected at least three routed lanes, saw ${plannedOrder.length}`);

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec: fixture.exec, modelRouteProcess, routeProbe: readyRouteProbe, resolveModelHost: async () => 'grok.exe', resolveModelHead: async () => 'abc123' });

    assert.equal(result.localReviewRunner.status, 'completed');
    assert.ok(maxActive >= 2, `expected overlapping execution, saw maxActive=${maxActive}`);
    assert.ok(maxActive <= 2, `per-host cap must hold two grok sessions, saw maxActive=${maxActive}`);
    const batchElapsed = Math.max(...laneWindows.map(window => window.endedAt)) - Math.min(...laneWindows.map(window => window.startedAt));
    const serialWallClock = laneWindows.reduce((total, window) => total + (window.endedAt - window.startedAt), 0);
    const slowestLane = Math.max(...laneWindows.map(window => window.endedAt - window.startedAt));
    assert.ok(batchElapsed < serialWallClock, `overlapped batch must beat serial lane time: elapsed=${batchElapsed}ms serial=${serialWallClock}ms`);
    // The margin scales with the measured fastest lane so machine load inflates
    // the bound together with the measurement; a serialized pool still exceeds
    // this bound because it pays every lane in sequence. Streamed per-lane
    // publication interleaves provider work with the in-process fake lanes,
    // so the bound carries a per-lane allowance for that overhead (real lane
    // processes run out-of-process and do not observe it).
    const fastestLane = Math.min(...laneWindows.map(window => window.endedAt - window.startedAt));
    const streamedPublishAllowance = 250 * laneWindows.length;
    assert.ok(batchElapsed <= slowestLane + Math.max(250, fastestLane) + streamedPublishAllowance, `batch wall clock must approximate the slowest lane: elapsed=${batchElapsed}ms slowest=${slowestLane}ms fastest=${fastestLane}ms`);
    assert.equal(promptPaths.size, laneStarts.length, 'every concurrent invocation must use a distinct private prompt file');
    // The slow planning-first lane completes last, so completion order genuinely
    // scrambles relative to planning order before the determinism assertion runs.
    assert.notDeepEqual(laneCompletions, plannedOrder);
    const executedLanes = result.localReviewRunner.lanes.filter(lane => lane.route !== null).map(lane => lane.lane);
    assert.deepEqual(executedLanes, plannedOrder);
    assert.ok(result.localReviewRunner.lanes.every(lane => lane.status === 'completed'));
    for (const lane of executedLanes) {
      const evidence = JSON.parse(readFileSync(join(repo, '.qube', 'aie', 'reviews', '93', '12', 'abc123', `${lane}.json`), 'utf8'));
      assert.equal(evidence.lane, lane);
      assert.equal(evidence.status, 'passed');
    }
  });
});
