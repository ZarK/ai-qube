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

describe('PR gate service: planning and evidence', { concurrency: 4 }, () => {
  it('maps GitHub PR review state to provider-neutral review items with untrusted feedback', async () => {
    const pr = basePr({
      reviewDecision: 'SOMETHING_NEW',
      mergeStateStatus: 'UNKNOWN',
      mergeable: 'UNKNOWN',
      comments: [{ author: { login: 'reviewer' }, body: 'Please inspect this.', url: 'https://github.com/example/repo/pull/12#issuecomment-1' }],
      statusCheckRollup: [
        { name: 'ci', status: 'COMPLETED', conclusion: 'CANCELLED', completedAt: '2026-01-01T00:00:00.000Z' },
        { name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: '2026-01-01T00:01:00.000Z' },
        { name: 'deploy', status: 'COMPLETED', conclusion: 'STALE', completedAt: '2026-01-01T00:02:00.000Z' },
      ],
    });
    const { exec } = makePrExec({ prViews: [pr] });
    const provider = createGitHubReviewForgeProvider({ exec });

    const snapshot = await provider.loadPullRequestReview(12);

    assert.equal(snapshot.item.reviewDecision, 'unknown');
    assert.equal(snapshot.item.mergeability, 'unknown');
    assert.equal(snapshot.item.feedback[0].trust, 'untrusted');
    assert.equal(snapshot.item.feedback[0].source, 'comment');
    assert.equal(snapshot.item.checks[0].source, 'provider-check');
    assert.equal(snapshot.item.checks[0].trust, 'trusted-provider');
    assert.equal(snapshot.item.checks[0].result, 'passed');
    assert.equal(snapshot.item.checks[0].reasonCode, 'trusted-provider-result');
    assert.equal(snapshot.item.checks[1].result, 'stale');
    assert.equal(snapshot.item.checks[1].reasonCode, 'provider-check-stale');
    assert.equal(snapshot.item.checks[1].stale, true);
    assert.equal(snapshot.pr.reviewDecision, 'SOMETHING_NEW');
  });

  it('reports missing current-head CI runs and recommends a push when workflow dispatch is unavailable', async () => {
    const repo = makeGitRepo();
    writeWorkflow(repo, 'on:\n  pull_request:\n    branches: [main]\n');
    const pr = basePr({
      reviewDecision: 'APPROVED',
      mergeStateStatus: 'BLOCKED',
      statusCheckRollup: [{ name: 'ci-required', status: 'IN_PROGRESS', conclusion: null }],
    });
    const { exec } = makePrExec({ prViews: [pr], checkRuns: [], workflowRuns: [] });

    const result = await runPrViewService({ prNumber: 12, repoRoot: repo, exec });

    assert.equal(result.ciDiagnostics[0].status, 'missing-current-head-run');
    assert.equal(result.ciDiagnostics[0].reasonCode, 'missing-current-head-ci-run');
    assert.equal(result.ciDiagnostics[0].workflowDispatchSupported, false);
    assert.match(result.ciDiagnostics[0].nextAction, /Push a new commit/);
    assert.match(result.nextAction, /Push a new commit/);
  });

  it('recommends workflow_dispatch when no current-head CI run exists and manual dispatch is available', async () => {
    const repo = makeGitRepo();
    writeWorkflow(repo, 'on:\n  workflow_dispatch:\n  pull_request:\n    branches: [main]\n');
    const pr = basePr({
      reviewDecision: 'APPROVED',
      mergeStateStatus: 'BLOCKED',
      statusCheckRollup: [{ name: 'ci-required', status: 'QUEUED', conclusion: null }],
    });
    const { exec } = makePrExec({ prViews: [pr], checkRuns: [], workflowRuns: [] });

    const result = await runPrViewService({ prNumber: 12, repoRoot: repo, exec });

    assert.equal(result.ciDiagnostics[0].status, 'missing-current-head-run');
    assert.equal(result.ciDiagnostics[0].workflowDispatchSupported, true);
    assert.match(result.ciDiagnostics[0].nextAction, /workflow_dispatch/);
  });

  it('does not map unnamed checks through generated fallback names', async () => {
    const repo = makeGitRepo();
    writeWorkflow(repo, 'on:\n  pull_request:\n    branches: [main]\n');
    const pr = basePr({
      reviewDecision: 'APPROVED',
      mergeStateStatus: 'BLOCKED',
      statusCheckRollup: [{ status: 'IN_PROGRESS', conclusion: null }],
    });
    const { exec } = makePrExec({
      prViews: [pr],
      checkRuns: [{ id: 200, name: 'GitHub check 1', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      workflowRuns: [{ id: 100, name: 'GitHub check 1', head_sha: 'abc123', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    });

    const result = await runPrViewService({ prNumber: 12, repoRoot: repo, exec });

    assert.equal(result.ciDiagnostics[0].status, 'missing-current-head-run');
    assert.deepEqual(result.ciDiagnostics[0].currentHeadRunIds, []);
  });

  it('surfaces pending current-head CI guidance in PR view next action', async () => {
    const repo = makeGitRepo();
    writeWorkflow(repo, 'on:\n  pull_request:\n    branches: [main]\n');
    const pr = basePr({
      reviewDecision: 'APPROVED',
      mergeStateStatus: 'BLOCKED',
      statusCheckRollup: [{ name: 'core', status: 'IN_PROGRESS', conclusion: null }],
    });
    const { exec } = makePrExec({
      prViews: [pr],
      checkRuns: [{ id: 200, name: 'core', status: 'IN_PROGRESS', conclusion: null }],
      workflowRuns: [],
    });

    const result = await runPrViewService({ prNumber: 12, repoRoot: repo, exec });

    assert.equal(result.ciDiagnostics[0].status, 'pending-current-head-run');
    assert.equal(result.ciDiagnostics[0].reasonCode, 'current-head-check-run-pending');
    assert.match(result.nextAction, /Wait for the current-head CI run/);
  });

  it('reports unknown CI mapping with a distinct reason code', async () => {
    const repo = makeGitRepo();
    writeWorkflow(repo, 'on:\n  pull_request:\n    branches: [main]\n');
    const pr = basePr({
      reviewDecision: 'APPROVED',
      mergeStateStatus: 'BLOCKED',
      statusCheckRollup: [{ name: 'ci-required', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    });
    const { exec } = makePrExec({ prViews: [pr], checkRuns: [], workflowRuns: [] });

    const result = await runPrViewService({ prNumber: 12, repoRoot: repo, exec });

    assert.equal(result.ciDiagnostics[0].status, 'unknown');
    assert.equal(result.ciDiagnostics[0].reasonCode, 'ci-mapping-unknown');
  });

  it('reports failed current-head CI runs and recommends rerunning failed jobs', async () => {
    const repo = makeGitRepo();
    writeWorkflow(repo, 'on:\n  pull_request:\n    branches: [main]\n');
    const pr = basePr({
      reviewDecision: 'APPROVED',
      mergeStateStatus: 'BLOCKED',
      statusCheckRollup: [{ name: 'core', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/example/repo/actions/runs/100/job/1' }],
    });
    const { exec } = makePrExec({
      prViews: [pr],
      checkRuns: [{ id: 200, name: 'core', status: 'COMPLETED', conclusion: 'FAILURE' }],
      checkSuites: [{ id: 300, head_sha: 'abc123', status: 'COMPLETED', conclusion: 'FAILURE' }],
      workflowRuns: [{ id: 100, name: 'CI', head_sha: 'abc123', status: 'COMPLETED', conclusion: 'FAILURE' }],
    });

    const result = await runPrViewService({ prNumber: 12, repoRoot: repo, exec });

    assert.equal(result.ciDiagnostics[0].status, 'failed-current-head-run');
    assert.equal(result.ciDiagnostics[0].reasonCode, 'current-head-check-run-failed');
    assert.deepEqual(result.ciDiagnostics[0].currentHeadSuiteIds, ['300']);
    assert.deepEqual(result.ciDiagnostics[0].currentHeadRunIds, ['200', '100']);
    assert.match(result.ciDiagnostics[0].nextAction, /Rerun failed jobs/);
  });

  it('reports skipped current-head CI workflows for explicit inspection', async () => {
    const repo = makeGitRepo();
    writeWorkflow(repo, 'on:\n  pull_request:\n    branches: [main]\n');
    const pr = basePr({
      reviewDecision: 'APPROVED',
      mergeStateStatus: 'CLEAN',
      statusCheckRollup: [{ name: 'changes', status: 'COMPLETED', conclusion: 'SKIPPED' }],
    });
    const { exec } = makePrExec({
      prViews: [pr],
      checkRuns: [{ id: 201, name: 'changes', status: 'COMPLETED', conclusion: 'SKIPPED' }],
      workflowRuns: [],
    });

    const result = await runPrViewService({ prNumber: 12, repoRoot: repo, exec });

    assert.equal(result.ciDiagnostics[0].status, 'skipped-current-head-run');
    assert.equal(result.ciDiagnostics[0].reasonCode, 'current-head-check-run-skipped');
    assert.match(result.ciDiagnostics[0].nextAction, /skip condition/);
  });

  it('detects stale old-head workflow runs and avoids claiming they validate the current head', async () => {
    const repo = makeGitRepo();
    writeWorkflow(repo, 'on:\n  pull_request:\n    branches: [main]\n');
    const pr = basePr({
      reviewDecision: 'APPROVED',
      mergeStateStatus: 'BLOCKED',
      statusCheckRollup: [{ name: 'ci-required', status: 'IN_PROGRESS', conclusion: null, detailsUrl: 'https://github.com/example/repo/actions/runs/55/job/1' }],
    });
    const { exec } = makePrExec({
      prViews: [pr],
      checkRuns: [],
      workflowRuns: [],
      workflowRunsById: { 55: { id: 55, name: 'CI', head_sha: 'old123', status: 'COMPLETED', conclusion: 'SUCCESS' } },
    });

    const result = await runPrViewService({ prNumber: 12, repoRoot: repo, exec });

    assert.equal(result.ciDiagnostics[0].status, 'stale-old-head-run');
    assert.equal(result.ciDiagnostics[0].reasonCode, 'stale-old-head-ci-run');
    assert.deepEqual(result.ciDiagnostics[0].staleRunIds, ['55']);
    assert.match(result.ciDiagnostics[0].nextAction, /Do not rerun the stale old-head workflow run/);
  });

  it('redacts invalid review item keys and parser input in errors', async () => {
    const provider = createGitHubReviewForgeProvider({ exec: async args => ({ args, exitCode: 1, stdout: '', stderr: 'unexpected' }) });
    const secret = 'abcDEF1234567890abcDEF1234567890';

    await assert.rejects(() => provider.getReviewItem({ providerId: 'github', id: secret }), error => error.message.includes('[REDACTED]') && !error.message.includes(secret));
    assert.throws(() => parsePrNumber(secret), error => error.message.includes('[REDACTED]') && !error.message.includes(secret));
    assert.throws(() => parsePrBodyIssueNumber(secret), error => error.message.includes('[REDACTED]') && !error.message.includes(secret));
  });

  it('plans reviewer requests, comment triggers, and wait without mutation during dry-run', async () => {
    const config = getDefaults();
    config.reviewAgents = ['@copilot', '@coderabbitai', 'coderabbitai', 'custom-reviewer'];
    config.reviewWaitMinutes = 15;
    config.reviewRequestText = 'Please inspect review-risky changes.';
    const { exec, calls } = makePrExec({ prViews: [basePr()] });

    const result = await runPrGate(config, { prNumber: 12, dryRun: true, exec });

    assert.equal(result.dryRun, true);
    assert.equal(result.waitMinutes, 15);
    assert.equal(result.waited, false);
    assert.equal(result.pr.headSha, 'abc123');
    assert.equal(result.pr.mergeState, 'BLOCKED');
    assert.equal(result.pr.mergeability, 'MERGEABLE');
    assert.equal(result.pr.headRefOid, 'abc123');
    assert.equal(result.pr.mergeStateStatus, 'BLOCKED');
    assert.equal(result.pr.mergeable, 'MERGEABLE');
    assert.equal(result.actions.filter(action => action.status === 'planned').length, 4);
    assert.equal(result.reviewers.filter(reviewer => reviewer.id === 'coderabbitai').length, 1);
    assert.equal(result.actions.filter(action => action.target === '@coderabbitai').length, 1);
    assert.equal(result.reviewers.find(reviewer => reviewer.handle === '@copilot').trigger, 'github-reviewer');
    assert.equal(result.reviewers.find(reviewer => reviewer.handle === '@coderabbitai').trigger, 'comment');
    assert.match(result.actions.find(action => action.target === '@copilot').body, /aie:pr-gate:copilot:abc123/);
    assert.doesNotMatch(result.actions.find(action => action.target === '@copilot').body, /@copilot/);
    assert.match(result.actions.find(action => action.target === '@coderabbitai').body, /@coderabbitai review/);
    assert.match(result.actions.find(action => action.target === '@coderabbitai').body, /aie:pr-gate:coderabbitai:abc123/);
    assert.equal(calls.some(args => args[0] === 'pr' && args[1] === 'edit'), false);
    assert.equal(calls.some(args => args[0] === 'pr' && args[1] === 'comment'), false);
    assert.ok(calls.some(args => args.join(' ') === `pr view 12 --json ${prViewFields}`));
    assert.equal(prViewFields.split(',').includes('comments'), false);
    assert.equal(prViewFields.split(',').includes('reviews'), true);
  });

  it('exposes the implementer self-check on dry-run in JSON and human output', async () => {
    const config = getDefaults();
    const { exec } = makePrExec({ prViews: [basePr()] });

    const result = await runPrGate(config, { prNumber: 12, dryRun: true, exec });

    assert.ok(result.selfCheck, 'expected a self-check on dry-run');
    assert.ok(result.selfCheck.instruction.includes('do not spawn reviewers with known gaps'));
    assert.ok(result.selfCheck.lanes.length > 0);
    for (const lane of result.selfCheck.lanes) {
      assert.equal(typeof lane.lane, 'string');
      assert.ok(lane.digest.length > 0);
      assert.equal(typeof lane.activated, 'boolean');
      assert.ok(lane.reason.length > 0);
    }
    assert.ok(Array.isArray(result.selfCheck.riskCards));

    const { formatPrGate } = require('../dist/pr/index.js');
    const human = formatPrGate(result);
    assert.ok(human.includes('Implementer self-check (before spawning reviewers):'));
    assert.ok(human.includes(result.selfCheck.instruction));
    assert.ok(human.includes(result.selfCheck.lanes[0].digest));
    assert.ok(!formatPrGate({ ...result, selfCheck: null }).includes('Implementer self-check'));
  });

  it('posts a marker-only request comment for the host review participant', async () => {
    const config = getDefaults();
    config.reviewAgents = ['QUBEReview', '@coderabbitai'];
    config.reviewRequestText = 'Please inspect review-risky changes.';
    const { exec } = makePrExec({ prViews: [basePr()] });

    const result = await runPrGate(config, { prNumber: 12, dryRun: true, exec });

    const hostAction = result.actions.find(action => action.target === '@QUBEReview');
    assert.match(hostAction.body, /aie:pr-gate:qubereview:abc123/);
    assert.match(hostAction.body, /Executor recorded a configured PR reviewer request/);
    assert.doesNotMatch(hostAction.body, /@QUBEReview review/);
    assert.doesNotMatch(hostAction.body, /Please inspect review-risky changes/);
    const remoteAction = result.actions.find(action => action.target === '@coderabbitai');
    assert.match(remoteAction.body, /@coderabbitai review/);
    assert.match(remoteAction.body, /Please inspect review-risky changes/);
  });

  it('omits non-actionable provider summaries from PR gate feedback', async () => {
    const config = getDefaults();
    config.reviewAgents = ['@coderabbitai', '@cubic-dev-ai'];
    config.reviewWaitMinutes = 0;
    const pr = basePr({
      reviewDecision: 'APPROVED',
      mergeStateStatus: 'CLEAN',
      latestReviews: [{ author: { login: 'cubic-dev-ai' }, state: 'COMMENTED', body: '**No issues found** across 5 files\n\n<!-- cubic:attribution ignored -->' }],
      comments: [
        { author: { login: 'coderabbitai' }, body: '<!-- review in progress by coderabbit.ai -->\nNo actionable comments were generated.\n<!-- internal state start -->SECRET<!-- internal state end -->', url: 'https://github.com/example/repo/pull/12#issuecomment-1' },
        { author: { login: 'coderabbitai' }, body: '<details>\n<summary>📝 Walkthrough</summary>\n\n## Walkthrough\nGenerated summary only.\n</details>', url: 'https://github.com/example/repo/pull/12#issuecomment-2' },
      ],
    });
    const { exec } = makePrExec({ prViews: [pr] });

    const result = await runPrGate(config, { prNumber: 12, dryRun: true, exec });

    assert.equal(result.status, 'pending');
    assert.equal(result.feedback.length, 0);
    assert.equal(result.counts.comments, 2);
    assert.equal(result.counts.reviews, 1);
    assert.equal(result.actions.find(action => action.kind === 'wait').status, 'skipped');
  });

  it('omits resolved Copilot overview reviews from PR gate feedback', async () => {
    const config = getDefaults();
    config.reviewAgents = ['@copilot'];
    config.reviewWaitMinutes = 0;
    const pr = basePr({
      reviewDecision: 'APPROVED',
      mergeStateStatus: 'CLEAN',
      latestReviews: [
        {
          author: { login: 'copilot-pull-request-reviewer' },
          state: 'COMMENTED',
          body: '## Pull request overview\n\nThis PR changes the CLI surface.\n\n### Reviewed changes\n\nCopilot reviewed 3 out of 3 changed files in this pull request and generated 9 comments.',
        },
      ],
    });
    const { exec } = makePrExec({ prViews: [pr], threads: [[]] });

    const result = await runPrGate(config, { prNumber: 12, dryRun: true, exec });

    assert.equal(result.status, 'pending');
    assert.equal(result.feedback.length, 0);
    assert.equal(result.counts.reviews, 1);
    assert.equal(result.counts.unresolvedThreads, 0);
  });

  it('surfaces feedback for removed review-agent adapters instead of using their classifiers', async () => {
    const config = getDefaults();
    config.reviewAgents = ['@copilot'];
    config.reviewWaitMinutes = 0;
    const pr = basePr({
      reviewDecision: 'APPROVED',
      mergeStateStatus: 'CLEAN',
      comments: [
        { author: { login: 'coderabbitai' }, body: 'No actionable comments were generated.', url: 'https://github.com/example/repo/pull/12#issuecomment-1' },
      ],
    });
    const { exec } = makePrExec({ prViews: [pr] });

    const result = await runPrGate(config, { prNumber: 12, dryRun: true, exec });

    assert.equal(result.status, 'pending');
    assert.equal(result.feedback.length, 1);
    assert.equal(result.feedback[0].author, 'coderabbitai');
  });

  it('keeps non-Copilot overview-shaped reviews as actionable feedback', async () => {
    const config = getDefaults();
    config.reviewAgents = [];
    const pr = basePr({
      reviewDecision: 'APPROVED',
      mergeStateStatus: 'CLEAN',
      latestReviews: [
        {
          author: { login: 'human-reviewer' },
          state: 'COMMENTED',
          body: '## Pull request overview\n\nThis still needs changes.\n\n### Reviewed changes\n\nCopilot reviewed 3 out of 3 changed files in this pull request and generated 9 comments.',
        },
      ],
    });
    const { exec } = makePrExec({ prViews: [pr], threads: [[]] });

    const result = await runPrGate(config, { prNumber: 12, dryRun: true, exec });

    assert.equal(result.feedback.length, 1);
    assert.equal(result.feedback[0].author, 'human-reviewer');
  });

  it('does not wait when no PR reviewers are configured', async () => {
    const config = getDefaults();
    config.reviewAgents = [];
    config.reviewWaitMinutes = 10;
    const waits = [];
    const { exec } = makePrExec({ prViews: [basePr({ reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN' })] });

    const result = await runPrGate(config, { prNumber: 12, exec, sleep: async milliseconds => { waits.push(milliseconds); } });

    assert.deepEqual(waits, []);
    assert.equal(result.waited, false);
    assert.equal(result.actions.find(action => action.kind === 'wait').status, 'skipped');
  });

  it('completes clean PRs without configured reviewers when checks pass', async () => {
    const config = getDefaults();
    config.reviewAgents = [];
    config.reviewWaitMinutes = 10;
    const pr = basePr({
      reviewDecision: '',
      mergeStateStatus: 'CLEAN',
      statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    });
    const { exec } = makePrExec({ prViews: [pr] });

    const result = await runPrGate(config, { prNumber: 12, exec });

    assert.equal(result.status, 'complete');
    assert.match(result.nextAction, /Ship-ready at the current head/);
  });

  it('completes local-only PR gates when provider-visible local review is approved', async () => {
    const repo = makeGitRepo();
    const config = localReviewConfig();
    writeLocalEvidence(repo, localEvidence());
    const { exec, calls } = makePrExec({ prViews: [approvedLocalPr()] });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, dryRun: true, exec });

    assert.equal(result.status, 'complete');
    assert.equal(result.localReview.required, true);
    assert.ok(['passed', 'inconclusive'].includes(result.localReview.status));
    assert.ok(result.reviewers.some(reviewer => reviewer.handle === '@QUBEReview'));
    assert.equal(result.reviewParticipantRollup?.hostLaneExpected, STANDARD_LOCAL_REVIEW_LANES.length);
    assert.equal(result.reviewParticipantRollup?.hostLaneReceived, STANDARD_LOCAL_REVIEW_LANES.length);
    assert.equal(result.actions.some(action => action.kind === 'request-review'), false);
    assert.equal(calls.some(args => args[0] === 'pr' && args[1] === 'comment'), false);
  });

  it('aggregates a ranked cross-lane fix batch in pr gate output', async () => {
    const repo = makeGitRepo();
    const config = localReviewConfig();
    const evidence = localEvidence();
    const codeQuality = evidence.lanes.find(lane => lane.id === 'code-quality');
    assert.ok(codeQuality);
    codeQuality.status = 'needs-work';
    codeQuality.severity = 'high';
    codeQuality.recommendation = 'request-changes';
    codeQuality.blockers = ['Fix the parser crash.'];
    codeQuality.findings = [
      { id: 'finding-a', severity: 'blocking', message: 'Fix the parser crash.', location: { path: 'src/parser.ts', line: 10 } },
      { id: 'finding-b', severity: 'advisory', message: 'Rename the helper.' },
    ];
    writeLocalEvidence(repo, evidence);
    const { exec } = makePrExec({ prViews: [cleanLocalPr()] });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec });

    assert.equal(result.fixBatch.findings.length, 2);
    assert.equal(result.fixBatch.findings[0].severity, 'blocking');
    assert.equal(result.fixBatch.findings[0].message, 'Fix the parser crash.');
    assert.equal(result.fixBatch.findings[1].severity, 'advisory');
    assert.equal(result.fixBatch.findings[0].classification, 'new');
    assert.equal(result.fixBatch.findings[1].classification, 'new');
    assert.equal(result.fixBatch.priorHeadSha, null);
    assert.match(result.fixBatch.summary, /2 open finding/);
  });

  it('classifies findings as new, persisting, and resolved across heads', async () => {
    const repo = makeGitRepo();
    const config = localReviewConfig();
    const priorEvidence = localEvidence({ headSha: 'aaa111' });
    const priorCodeQuality = priorEvidence.lanes.find(lane => lane.id === 'code-quality');
    assert.ok(priorCodeQuality);
    priorCodeQuality.findings = [
      { id: 'finding-a', severity: 'blocking', message: 'Fix the parser crash.', location: { path: 'src/parser.ts', line: 10 } },
      { id: 'finding-b', severity: 'advisory', message: 'Remove the dead code.' },
    ];
    for (const lane of priorEvidence.lanes) lane.recordedAt = '2026-06-20T00:00:00.000Z';
    writeLocalEvidence(repo, priorEvidence);
    const currentEvidence = localEvidence();
    const currentCodeQuality = currentEvidence.lanes.find(lane => lane.id === 'code-quality');
    assert.ok(currentCodeQuality);
    currentCodeQuality.findings = [
      { id: 'finding-a', severity: 'blocking', message: 'Fix the parser crash.', location: { path: 'src/parser.ts', line: 10 } },
      { id: 'finding-c', severity: 'advisory', message: 'Rename the helper.' },
    ];
    writeLocalEvidence(repo, currentEvidence);
    const { exec } = makePrExec({ prViews: [cleanLocalPr()] });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec });

    assert.equal(result.fixBatch.findings.length, 2);
    const persisting = result.fixBatch.findings.find(finding => finding.message === 'Fix the parser crash.');
    assert.ok(persisting);
    assert.equal(persisting.classification, 'persisting');
    const newFinding = result.fixBatch.findings.find(finding => finding.message === 'Rename the helper.');
    assert.ok(newFinding);
    assert.equal(newFinding.classification, 'new');
    assert.equal(result.fixBatch.resolved.length, 1);
    assert.equal(result.fixBatch.resolved[0].message, 'Remove the dead code.');
    assert.equal(result.fixBatch.priorHeadSha, 'aaa111');
  });

  it('accepts id-only prompt stack entries in split lane evidence', async () => {
    const repo = makeGitRepo();
    const config = localReviewConfig();
    const evidence = localEvidence();
    const codeQuality = evidence.lanes.find(lane => lane.id === 'code-quality');
    assert.ok(codeQuality);
    codeQuality.promptStack = ['review-lanes/code-quality', 'review-lanes/final-gate'];
    writeLocalEvidence(repo, evidence);
    const { exec } = makePrExec({ prViews: [approvedLocalPr()] });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, dryRun: true, exec });

    assert.equal(result.status, 'complete');
    assert.equal(result.localReview.status, 'passed');
    assert.ok(result.localReview.evidence[0].promptStack.some(item => item.id === 'review-lanes/code-quality' && item.source === 'evidence'));
    assert.equal(result.localReview.evidence[0].blockers.some(blocker => blocker.includes('code-quality passed without promptStack coverage')), false);
  });

  it('keeps required local gates inconclusive for manual evidence without runner provenance', async () => {
    const repo = makeGitRepo();
    const config = localReviewConfig();
    writeLocalEvidence(repo, localEvidence({ adapter: 'manual-evidence' }));
    const { exec } = makePrExec({ prViews: [cleanLocalPr()] });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, dryRun: true, exec });

    assert.equal(result.status, 'pending');
    assert.equal(result.localReview.status, 'inconclusive');
    assert.match(result.localReview.nextAction, /required AGENTS|Refresh provider-visible local review feedback/);
    assert.ok(result.localReview.evidence[0].blockers.some(blocker => blocker.includes('Manual local review evidence is unverified')));
  });

  it('rejects local-host evidence without independent reviewer provenance', async () => {
    const repo = makeGitRepo();
    const config = localReviewConfig();
    const evidence = localEvidence();
    for (const lane of evidence.lanes) delete lane.runnerProvenance;
    delete evidence.runnerProvenance;
    writeLocalEvidence(repo, evidence, { rewritePromptHashes: false });
    const { exec } = makePrExec({ prViews: [cleanLocalPr()] });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, dryRun: true, exec });

    assert.equal(result.localReview.status, 'inconclusive');
    assert.equal(result.status, 'pending');
    assert.ok(result.localReview.evidence[0].blockers.some(blocker => blocker.includes('without independent reviewer runner provenance')));
  });

  it('validates active focused lanes with the same local-host evidence contract as profile lanes', async () => {
    const repo = makeGitRepo();
    const config = localReviewConfig();
    config.reviewProfile = 'local-focused';
    config.reviewLanes = [
      {
        id: 'security',
        required: 'always',
        match: [],
        severityThreshold: 'high',
        prompt: [],
        tools: [],
        runner: 'local-host',
        command: null,
      },
    ];
    const evidence = localEvidence();
    const baseLane = evidence.lanes.find(lane => lane.id === 'code-quality');
    assert.ok(baseLane);
    evidence.profile = 'local-focused';
    evidence.lanes = [
      {
        ...baseLane,
        id: 'security',
        summary: 'security reviewed',
        artifacts: [{ kind: 'json', path: '.qube/aie/reviews/93/12/abc123/security.json', sha256: null }],
        promptStack: promptStackForLane('security'),
        runnerProvenance: null,
      },
    ];
    writeLocalEvidence(repo, evidence, { rewritePromptHashes: false });
    const { exec } = makePrExec({ prViews: [cleanLocalPr()] });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, dryRun: true, exec });

    assert.equal(result.localReview.requiredLanes.length, 1);
    assert.equal(result.localReview.requiredLanes[0], 'security');
    assert.equal(result.localReview.status, 'inconclusive');
    assert.equal(result.status, 'pending');
    assert.ok(result.localReview.evidence[0].blockers.some(blocker => blocker.includes('security passed without independent reviewer runner provenance')));
  });

  it('rejects local-host evidence with a mismatched prompt stack hash', async () => {
    const repo = makeGitRepo();
    const config = localReviewConfig();
    const evidence = localEvidence();
    for (const lane of evidence.lanes) lane.runnerProvenance = { ...lane.runnerProvenance, promptStackHash: 'not-the-current-qube-prompt-stack' };
    writeLocalEvidence(repo, evidence, { rewritePromptHashes: false });
    const { exec } = makePrExec({ prViews: [cleanLocalPr()] });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, dryRun: true, exec });

    assert.equal(result.localReview.status, 'inconclusive');
    assert.equal(result.status, 'pending');
    assert.ok(result.localReview.evidence[0].blockers.some(blocker => blocker.includes('current QUBE prompt stack')));
  });

  it('rejects prompt-only local-host evidence for required local review gates', async () => {
    const repo = makeGitRepo();
    const config = localReviewConfig();
    const evidence = localEvidence();
    for (const lane of evidence.lanes) lane.runnerProvenance = { ...lane.runnerProvenance, promptOnly: true, freshContext: false, taskId: null };
    writeLocalEvidence(repo, evidence);
    const { exec } = makePrExec({ prViews: [cleanLocalPr()] });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, dryRun: true, exec });

    assert.equal(result.localReview.status, 'inconclusive');
    assert.equal(result.status, 'pending');
    assert.ok(result.localReview.evidence[0].blockers.some(blocker => blocker.includes('prompt-only output')));
    assert.ok(result.localReview.evidence[0].blockers.some(blocker => blocker.includes('fresh independent reviewer context')));
  });

  it('rejects same-session local-host evidence without a separate task, session, or thread id', async () => {
    const repo = makeGitRepo();
    const config = localReviewConfig();
    const evidence = localEvidence();
    for (const lane of evidence.lanes) lane.runnerProvenance = { ...lane.runnerProvenance, freshContext: false, taskId: null, sessionId: null, threadId: null };
    writeLocalEvidence(repo, evidence);
    const { exec } = makePrExec({ prViews: [cleanLocalPr()] });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, dryRun: true, exec });

    assert.equal(result.localReview.status, 'inconclusive');
    assert.equal(result.status, 'pending');
    assert.ok(result.localReview.evidence[0].blockers.some(blocker => blocker.includes('fresh independent reviewer context')));
    assert.ok(result.localReview.evidence[0].blockers.some(blocker => blocker.includes('separate task, session, or thread id')));
  });

  it('keeps local-only PR gates pending when local evidence is missing', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    const { exec } = makePrExec({ prViews: [cleanLocalPr()] });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, dryRun: true, exec });

    assert.equal(result.status, 'pending');
    assert.equal(result.localReview.status, 'missing');
    assert.match(result.nextAction, /QUBEReview|fresh-context review subagents|publish provider-visible|pending until current-head/);
  });

  it('plans local-command lane execution during PR gate dry-run without writing evidence', async () => {
    const repo = makeGitRepo();
    const config = localCommandConfig();
    trustReviewCommands(repo);
    const { exec } = makePrExec({ prViews: [cleanLocalPr()] });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, dryRun: true, exec });

    assert.equal(result.localReviewRunner.status, 'planned');
    assert.equal(result.localReviewRunner.lanes.length, 6);
    assert.ok(result.localReviewRunner.lanes.every(lane => lane.status === 'planned' || lane.lane === 'final-gate'));
    assert.equal(result.localReview.status, 'missing');
    assert.equal(existsSync(join(repo, '.qube', 'aie', 'reviews', '93', '12', 'abc123', 'issue-compliance.json')), false);
  });

  it('reports commandless Codex local-host lanes as pending subagent review work', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    const { exec } = makePrExec({ prViews: [cleanLocalPr()] });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec });

    assert.equal(result.localReviewRunner.codex.independentReviewer, true);
    assert.equal(result.localReviewRunner.codex.promptOnly, false);
    assert.deepEqual(result.localReviewRunner.codex.missingCapabilities, []);
    assert.equal(result.localReviewRunner.status, 'pending');
    assert.equal(result.localReviewRunner.unavailable.length, 0);
    assert.ok(result.localReviewRunner.lanes.some(lane => lane.status === 'pending' && lane.runner === 'local-host'));
    assert.match(result.localReviewRunner.lanes[0].summary, /Codex subagent/);
    assert.match(result.localReviewRunner.lanes[0].evidencePath, /issue-compliance\.json|task-record-compliance\.json/);
    assert.equal(result.localReviewRunner.lanes[0].promptText, '');
    assert.equal(result.localReviewRunner.lanes[0].spawnPrompt, '');
    assert.equal(result.localReviewRunner.lanes[0].spawnContract, null);
    assert.ok(result.localReviewRunner.lanes[0].promptFragmentIds.includes(`review-lanes/${result.localReviewRunner.lanes[0].lane}`));
    assert.equal(result.localReview.status, 'missing');
    assert.equal(result.status, 'pending');
  });

  it('plans commandless Codex local-host lanes during dry-run', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    config.reviewAdapter = 'mixed';
    const { exec } = makePrExec({ prViews: [cleanLocalPr()] });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, dryRun: true, exec });

    assert.equal(result.localReviewRunner.status, 'planned');
    assert.ok(result.localReviewRunner.lanes.every(lane => lane.status === 'planned'));
    assert.ok(result.localReviewRunner.lanes.every(lane => lane.blocker === null));
    assert.ok(result.localReviewRunner.lanes.some(lane => lane.runner === 'local-host'));
    assert.equal(result.localReview.status, 'missing');
    assert.match(result.localReview.evidence[0].path, /\.qube[\\/]aie[\\/]reviews[\\/]93[\\/]12[\\/]abc123/);
    assert.equal(result.localReviewPublish.status, 'disabled');
    assert.equal(result.status, 'pending');
  });

  it('plans isolated model routes without spawning native Codex subagents', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    config.reviewAdapter = 'mixed';
    config.reviewRoute = { host: 'grok', tier: 'review', timeoutSeconds: 600, maxTurns: 8 };
    config.reviewModels.review.grok = { model: 'grok-4.5', effort: null };
    config.reviewLanes.find(lane => lane.id === 'code-quality').route = { host: 'codex', tier: 'review', timeoutSeconds: 900, maxTurns: 1 };
    config.reviewModels.review.codex = { model: 'gpt-5.6-luna', effort: 'high' };
    const { exec } = makePrExec({ prViews: [cleanLocalPr()] });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, dryRun: true, exec, includeLocalReviewPrompts: true });

    assert.equal(result.localReviewRunner.status, 'planned');
    assert.ok(result.localReviewRunner.lanes.every(lane => lane.route));
    assert.ok(result.localReviewRunner.lanes.every(lane => lane.spawnContract === null));
    assert.equal(result.localReviewRunner.lanes.find(lane => lane.lane === 'code-quality').route.host, 'codex');
    assert.equal(result.localReviewRunner.lanes.find(lane => lane.lane === 'code-quality').route.model, 'gpt-5.6-luna');
    assert.equal(result.localReviewRunner.lanes.find(lane => lane.lane === 'code-quality').route.effort, 'high');
    assert.equal(result.localReviewRunner.lanes.find(lane => lane.lane !== 'code-quality').route.host, 'grok');
    assert.equal(result.localReviewRunner.lanes.find(lane => lane.lane !== 'code-quality').route.model, 'grok-4.5');
    assert.ok(result.localReviewRunner.lanes.every(lane => lane.route.isolation === 'read-only'));
    assert.ok(result.localReviewRunner.lanes.every(lane => lane.promptStackHash.length === 64));
  });

  it('does not apply a global model route to non-host lane runners', () => {
    const config = localHostConfig(null);
    config.reviewRoute = { host: 'grok', tier: 'review', timeoutSeconds: 600, maxTurns: 8 };
    config.reviewModels.review.grok = { model: 'grok-4.5', effort: null };
    const lane = config.reviewLanes.find(item => item.id === 'issue-compliance');
    lane.runner = 'local-command';
    lane.command = 'review-fixture';

    assert.equal(resolveModelReviewPlan(config, 'issue-compliance'), null);
    assert.equal(resolveModelReviewPlan(config, 'code-quality').host, 'grok');

    config.reviewLanes = [];
    assert.equal(resolveModelReviewPlan(config, 'issue-compliance').host, 'grok');
  });

  it('reports a failed routed publish batch when the provider rejects lane feedback', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    applyRoutedReviewFixture(repo);
    config.reviewAdapter = 'mixed';
    config.reviewAgents = [];
    config.reviewWaitMinutes = 0;
    config.reviewRoute = { host: 'grok', tier: 'review', timeoutSeconds: 600, maxTurns: 8 };
    config.reviewModels.review.grok = { model: 'grok-4.5', effort: null };
    const fixture = makePrExec({ prViews: [cleanLocalPr()] });
    const exec = async args => {
      // Reject lane-feedback mutations by shape (streaming publishes lanes
      // before the idempotent review-request marker is applied), leaving the
      // request marker itself deliverable.
      const isReviewPost = args[0] === 'api' && args[1] === 'repos/example/repo/pulls/12/reviews' && args.includes('--method') && args[args.indexOf('--method') + 1] === 'POST';
      const isLaneComment = args[0] === 'pr' && args[1] === 'comment' && String(args[4] ?? '').includes('qube-pr-review:');
      if (isReviewPost || isLaneComment) throw new Error('provider rejected the lane mutation');
      return fixture.exec(args);
    };
    const modelRouteProcess = async invocation => {
      const prompt = readFileSync(invocation.promptPath, 'utf8');
      const lane = prompt.match(/Run local review lane ([a-z-]+)\./)?.[1];
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

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec, modelRouteProcess, routeProbe: readyRouteProbe, resolveModelHost: async () => 'grok.exe', resolveModelHead: async () => 'abc123' });

    assert.equal(result.localReviewRunner.status, 'completed');
    assert.equal(result.localReview.status, 'passed');
    assert.equal(result.localReviewPublish.status, 'failed', 'a provider-rejected lane publication must never report a published batch');
    assert.match(String(result.localReviewPublish.failure), /Failed to publish lane review|routed lane publish failed/);
    assert.ok(result.roundSummary, 'a failed lane publish must still attempt the round summary');
    assert.match(String(result.roundSummary.nextAction || result.roundSummary.failure || ''), /issue-compliance|code-quality|Failed lane publish|failed/i);
  });

  it('executes and publishes a complete routed lane batch from the QUBE orchestrator', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    applyRoutedReviewFixture(repo);
    config.reviewAdapter = 'mixed';
    config.reviewAgents = [];
    config.reviewWaitMinutes = 0;
    config.reviewRoute = { host: 'grok', tier: 'review', timeoutSeconds: 600, maxTurns: 8 };
    config.reviewModels.review.grok = { model: 'grok-4.5', effort: null };
    const fixture = makePrExec({ prViews: [cleanLocalPr()] });
    const order = [];
    const exec = async args => {
      if ((args[0] === 'pr' && args[1] === 'comment') || (args[0] === 'api' && args.includes('--method') && args[args.indexOf('--method') + 1] === 'POST')) order.push('provider-mutation');
      return fixture.exec(args);
    };
    const modelRouteProcess = async invocation => {
      order.push('model');
      const prompt = readFileSync(invocation.promptPath, 'utf8');
      const lane = prompt.match(/Run local review lane ([a-z-]+)\./)?.[1];
      assert.ok(lane);
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

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec, modelRouteProcess, routeProbe: readyRouteProbe, resolveModelHost: async () => 'grok.exe', resolveModelHead: async () => 'abc123' });

    assert.equal(result.localReviewRunner.status, 'completed');
    assert.equal(result.localReview.status, 'passed');
    assert.equal(result.localReviewPublish.status, 'published');
    assert.ok(result.localReviewRunner.lanes.every(lane => lane.route?.host === 'grok'));
    assert.ok(result.localReview.evidence[0].lanes.every(lane => lane.runnerProvenance.host === 'grok'));
    const writtenLane = JSON.parse(readFileSync(join(repo, '.qube', 'aie', 'reviews', '93', '12', 'abc123', 'issue-compliance.json'), 'utf8'));
    assert.deepEqual(writtenLane.reviewer, { id: 'grok', name: 'Grok Build', adapterKind: 'local' });
    assert.notEqual(execFileSync('git', ['diff', '--name-only', 'origin/main...HEAD', '--', '.qube/aie/config.json'], { cwd: repo, encoding: 'utf8' }).trim(), '');
    assert.ok(order.filter(entry => entry === 'model').length >= result.localReviewRunner.lanes.length);
    // Streaming publication: a validated lane's mutation may interleave with
    // later model runs, but no mutation can ever precede the first model run.
    assert.ok(order.indexOf('provider-mutation') > order.indexOf('model'));
    // Every gate-published marker must declare the complete active lane set, or
    // convergence stats degrade multi-lane heads as inconsistent expected sets.
    const publishedMarkers = [...fixture.calls.flatMap(call => call.map(String)), ...fixture.reviewPayloads.map(payload => String(payload.body ?? ''))]
      .filter(text => text.includes('qube-pr-review:'))
      .map(text => JSON.parse(text.match(/qube-pr-review:(\{[\s\S]*?\})\s*-->/)[1]));
    const evidenceLanes = [...result.localReview.evidence[0].lanes.map(lane => lane.id)].sort();
    assert.ok(publishedMarkers.length >= evidenceLanes.length, 'the routed batch must publish one marker per lane');
    for (const marker of publishedMarkers) {
      assert.deepEqual(marker.expectedLanes, evidenceLanes, 'every marker must declare the complete validated lane set for the head');
    }
    const publishRecord = JSON.parse(readFileSync(join(repo, '.qube', 'aie', 'reviews', '93', '12', 'abc123', 'publish.json'), 'utf8'));
    assert.equal(publishRecord.status, 'published');
    assert.ok(publishRecord.lanes.length > 0);
    assert.ok(publishRecord.roundSummary);
  });

  it('rechecks local HEAD after disclosure and withholds all provider mutation on drift', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    applyRoutedReviewFixture(repo);
    config.reviewAdapter = 'mixed';
    config.reviewAgents = ['@coderabbitai'];
    config.reviewWaitMinutes = 0;
    config.reviewRoute = { host: 'grok', tier: 'review', timeoutSeconds: 600, maxTurns: 8 };
    config.reviewModels.review.grok = { model: 'grok-4.5', effort: null };
    const fixture = makePrExec({ prViews: [cleanLocalPr()] });
    let localHead = 'abc123';
    const modelRouteProcess = async invocation => {
      const prompt = readFileSync(invocation.promptPath, 'utf8');
      const lane = prompt.match(/Run local review lane ([a-z-]+)\./)?.[1];
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

    const result = await runPrGate(config, {
      prNumber: 12,
      repoRoot: repo,
      exec: fixture.exec,
      modelRouteProcess,
      routeProbe: readyRouteProbe,
      resolveModelHost: async () => 'grok.exe',
      resolveModelHead: async () => localHead,
      onBeforeMutate: async () => { localHead = 'changed-head'; },
    });

    // Disclosure fires at the first validated lane under streaming; drift
    // after it withholds every provider mutation, and the drifted checkout
    // fails the remaining lanes closed (checkout mismatch is fault-exempt).
    assert.equal(result.localReviewRunner.status, 'failed');
    assert.ok(result.localReviewRunner.lanes.some(lane => lane.blocker === 'model-route-checkout-mismatch'));
    assert.equal(result.localReviewPublish.status, 'pending');
    assert.equal(fixture.calls.some(args => args[0] === 'pr' && args[1] === 'edit'), false);
    assert.equal(fixture.calls.some(args => args[0] === 'pr' && args[1] === 'comment'), false);
    assert.equal(fixture.calls.some(args => args[0] === 'api' && args.includes('--method') && args[args.indexOf('--method') + 1] === 'POST'), false);
  });

  it('publishes blocking lane markers at the reviewed head before any fix commit', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    trustReviewCommands(repo);
    config.reviewAdapter = 'mixed';
    config.reviewAgents = [];
    config.reviewWaitMinutes = 0;
    config.reviewRoute = { host: 'grok', tier: 'review', timeoutSeconds: 600, maxTurns: 8 };
    config.reviewModels.review.grok = { model: 'grok-4.5', effort: null };
    const fixture = makePrExec({ prViews: [cleanLocalPr()] });
    const modelRouteProcess = async invocation => {
      const prompt = readFileSync(invocation.promptPath, 'utf8');
      const lane = prompt.match(/Run local review lane ([a-z-]+)\./)?.[1];
      const blocking = lane === 'code-quality';
      const body = {
        issueNumber: 93,
        prNumber: 12,
        headSha: 'abc123',
        lane,
        status: blocking ? 'needs-work' : 'passed',
        severity: blocking ? 'high' : 'none',
        recommendation: blocking ? 'request-changes' : 'approve',
        summary: blocking ? `${lane} found a blocking defect.` : `${lane} routed review passed.`,
        blockers: blocking ? ['Fix the parser crash before merge.'] : [],
        findings: blocking ? [{ id: 'cq-1', severity: 'blocking', message: 'Fix the parser crash before merge.', location: { path: 'src/review.ts', line: 2 } }] : [],
        artifacts: [{ kind: 'command', path: 'command:git diff --check', sha256: null }],
        commands: ['git diff --check'],
        surfaces: ['PR diff'],
        contextReviewed: requiredTaskContext(),
        toolsUsed: ['git'],
        completeness: `Inspected the complete ${lane} scope at the current head.`,
        coverage: ((prompt.match(/Attest coverage for exactly these areas: ([^\n]+?)\. Each coverage entry/) || [])[1] || lane).split(', ').map(area => ({ area, status: blocking ? 'finding' : 'clear' })),
        preconditions: [],
      };
      return { exitCode: 0, stderr: '', timedOut: false, stdinDelivered: true, stdout: JSON.stringify({ text: JSON.stringify(body), sessionId: `session-${lane}` }) };
    };

    const result = await runPrGate(config, {
      prNumber: 12,
      repoRoot: repo,
      exec: fixture.exec,
      modelRouteProcess,
      routeProbe: readyRouteProbe,
      resolveModelHost: async () => 'grok.exe',
      resolveModelHead: async () => 'abc123',
    });

    // The blocking round publishes at its reviewed head: the aggregate gate
    // stays failed while every terminal lane result, approving and blocking,
    // becomes provider-visible before any fix commit.
    assert.notEqual(result.localReview.status, 'passed');
    assert.equal(result.localReviewPublish.status, 'published');
    assert.ok(fixture.calls.some(call => call[0] === 'api' && call[1] === 'repos/example/repo/pulls/12/reviews'), 'blocking lane feedback must reach the provider');
    assert.equal(result.shipReady.ready, false);
  });

  it('publishes a validated blocking lane before slower siblings finish', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    trustReviewCommands(repo);
    config.reviewAdapter = 'mixed';
    config.reviewAgents = [];
    config.reviewWaitMinutes = 0;
    config.reviewRoute = { host: 'grok', tier: 'review', timeoutSeconds: 600, maxTurns: 8 };
    config.reviewModels.review.grok = { model: 'grok-4.5', effort: null };
    const fixture = makePrExec({ prViews: [cleanLocalPr()] });
    const codeQualityPublished = () => fixture.reviewPayloads.some(payload => typeof payload.body === 'string' && payload.body.includes('"lane":"code-quality"'));
    let blockingMarkerSeenBeforeSlowSibling = false;
    const modelRouteProcess = async invocation => {
      const prompt = readFileSync(invocation.promptPath, 'utf8');
      const lane = prompt.match(/Run local review lane ([a-z-]+)\./)?.[1];
      if (lane === 'final-gate') {
        // The slow sibling: wait (bounded) until the blocking lane's marker
        // reached the provider, proving publication happened mid-batch.
        for (let attempt = 0; attempt < 200 && !codeQualityPublished(); attempt += 1) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        blockingMarkerSeenBeforeSlowSibling = codeQualityPublished();
      }
      const blocking = lane === 'code-quality';
      const body = {
        issueNumber: 93,
        prNumber: 12,
        headSha: 'abc123',
        lane,
        status: blocking ? 'needs-work' : 'passed',
        severity: blocking ? 'high' : 'none',
        recommendation: blocking ? 'request-changes' : 'approve',
        summary: blocking ? `${lane} found a blocking defect.` : `${lane} routed review passed.`,
        blockers: blocking ? ['Fix the parser crash before merge.'] : [],
        findings: blocking ? [{ id: 'cq-1', severity: 'blocking', message: 'Fix the parser crash before merge.', location: { path: 'src/review.ts', line: 2 } }] : [],
        artifacts: [{ kind: 'command', path: 'command:git diff --check', sha256: null }],
        commands: ['git diff --check'],
        surfaces: ['PR diff'],
        contextReviewed: requiredTaskContext(),
        toolsUsed: ['git'],
        completeness: `Inspected the complete ${lane} scope at the current head.`,
        coverage: ((prompt.match(/Attest coverage for exactly these areas: ([^\n]+?)\. Each coverage entry/) || [])[1] || lane).split(', ').map(area => ({ area, status: blocking ? 'finding' : 'clear' })),
        preconditions: [],
      };
      return { exitCode: 0, stderr: '', timedOut: false, stdinDelivered: true, stdout: JSON.stringify({ text: JSON.stringify(body), sessionId: `session-${lane}` }) };
    };

    const result = await runPrGate(config, {
      prNumber: 12,
      repoRoot: repo,
      exec: fixture.exec,
      modelRouteProcess,
      routeProbe: readyRouteProbe,
      resolveModelHost: async () => 'grok.exe',
      resolveModelHead: async () => 'abc123',
    });

    assert.equal(blockingMarkerSeenBeforeSlowSibling, true, 'the blocking lane must be provider-visible while slower siblings are still running');
    assert.equal(result.localReviewPublish.status, 'published');
  });

  it('publishes validated lanes while a failed lane leaves the round incomplete', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    trustReviewCommands(repo);
    config.reviewAdapter = 'mixed';
    config.reviewAgents = [];
    config.reviewWaitMinutes = 0;
    config.reviewRoute = { host: 'grok', tier: 'review', timeoutSeconds: 600, maxTurns: 8 };
    config.reviewModels.review.grok = { model: 'grok-4.5', effort: null };
    const fixture = makePrExec({ prViews: [cleanLocalPr()] });
    const modelRouteProcess = async invocation => {
      const prompt = readFileSync(invocation.promptPath, 'utf8');
      const lane = prompt.match(/Run local review lane ([a-z-]+)\./)?.[1];
      if (lane === 'tests-quality') return { exitCode: 1, stderr: 'model unavailable', stdout: '', timedOut: false, stdinDelivered: true };
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

    const result = await runPrGate(config, {
      prNumber: 12,
      repoRoot: repo,
      exec: fixture.exec,
      modelRouteProcess,
      routeProbe: readyRouteProbe,
      resolveModelHost: async () => 'grok.exe',
      resolveModelHead: async () => 'abc123',
    });

    // One flaked lane never withholds the others: every validated lane
    // publishes at this head, the round stays incomplete on the provider
    // record, and ship-ready remains blocked by the missing lane evidence.
    assert.ok(result.localReviewRunner.lanes.some(lane => lane.lane === 'tests-quality' && lane.status === 'failed'));
    assert.equal(result.localReviewPublish.status, 'published');
    assert.ok(fixture.calls.some(call => call[0] === 'api' && call[1] === 'repos/example/repo/pulls/12/reviews'), 'validated lane feedback must reach the provider despite the failed sibling');
    assert.notEqual(result.localReview.status, 'passed');
    assert.equal(result.shipReady.ready, false);
  });

  it('clears a transient streamed publish failure when the batch retry lands the lane', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    trustReviewCommands(repo);
    config.reviewAdapter = 'mixed';
    config.reviewAgents = [];
    config.reviewWaitMinutes = 0;
    config.reviewRoute = { host: 'grok', tier: 'review', timeoutSeconds: 600, maxTurns: 8 };
    config.reviewModels.review.grok = { model: 'grok-4.5', effort: null };
    const fixture = makePrExec({ prViews: [cleanLocalPr()] });
    let laneMutations = 0;
    const exec = async args => {
      const isReviewPost = args[0] === 'api' && args[1] === 'repos/example/repo/pulls/12/reviews' && args.includes('--method') && args[args.indexOf('--method') + 1] === 'POST';
      const isLaneComment = args[0] === 'pr' && args[1] === 'comment' && String(args[4] ?? '').includes('qube-pr-review:');
      if (isReviewPost || isLaneComment) {
        laneMutations += 1;
        // Only the very first streamed lane mutation fails transiently; the
        // batch retry and every other lane publish succeed.
        if (laneMutations === 1) throw new Error('transient provider failure');
      }
      return fixture.exec(args);
    };
    const modelRouteProcess = async invocation => {
      const prompt = readFileSync(invocation.promptPath, 'utf8');
      const lane = prompt.match(/Run local review lane ([a-z-]+)\./)?.[1];
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

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec, modelRouteProcess, routeProbe: readyRouteProbe, resolveModelHost: async () => 'grok.exe', resolveModelHead: async () => 'abc123' });

    // The batch retry is the arbiter: once it lands the lane, the transient
    // streamed failure must not poison the aggregate publish status.
    assert.equal(result.localReviewRunner.status, 'completed');
    assert.equal(result.localReview.status, 'passed');
    assert.equal(result.localReviewPublish.status, 'published');
    assert.ok(!result.unavailable.some(entry => /transient provider failure/.test(entry)), 'a superseded streamed failure must not remain in the unavailable list');
  });

  it('publishes no provider mutation when no routed lane produced terminal evidence', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    trustReviewCommands(repo);
    config.reviewAdapter = 'mixed';
    config.reviewAgents = [];
    config.reviewWaitMinutes = 0;
    config.reviewRoute = { host: 'grok', tier: 'review', timeoutSeconds: 600, maxTurns: 8 };
    config.reviewModels.review.grok = { model: 'grok-4.5', effort: null };
    const fixture = makePrExec({ prViews: [cleanLocalPr()] });
    let modelCalls = 0;

    const result = await runPrGate(config, {
      prNumber: 12,
      repoRoot: repo,
      exec: fixture.exec,
      routeProbe: readyRouteProbe,
      resolveModelHost: async () => 'grok.exe',
      resolveModelHead: async () => 'abc123',
      modelRouteProcess: async () => {
        modelCalls += 1;
        return { exitCode: 1, stderr: 'model unavailable', stdout: '', timedOut: false, stdinDelivered: true };
      },
    });

    assert.ok(modelCalls > 0);
    assert.equal(result.localReviewRunner.status, 'failed');
    assert.equal(result.shipReady.ready, false);
    assert.ok(result.shipReady.reasons.length > 0);
    // Per-lane publish-on-validate: with zero terminal lane evidence there is
    // nothing to publish, and no lane mutation may reach the provider.
    assert.equal(result.localReviewPublish.status, 'skipped');
    assert.match(result.localReviewPublish.nextAction, /No routed lane holds terminal current-head evidence/);
    assert.equal(fixture.calls.some(args => args[0] === 'pr' && args[1] === 'comment'), false);
    assert.equal(fixture.calls.some(args => args[0] === 'api' && args.includes('--method') && args[args.indexOf('--method') + 1] === 'POST'), false);
  });

  it('reuses a complete trusted provider current-head lane set without executing lanes', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    applyRoutedReviewFixture(repo);
    config.reviewAdapter = 'mixed';
    config.reviewAgents = [];
    config.reviewWaitMinutes = 0;
    config.reviewRoute = { host: 'grok', tier: 'review', timeoutSeconds: 600, maxTurns: 8 };
    config.reviewModels.review.grok = { model: 'grok-4.5', effort: null };
    const plan = await runPrGate(config, { prNumber: 12, repoRoot: repo, dryRun: true, exec: makePrExec({ prViews: [cleanLocalPr()] }).exec });
    const profile = plan.localReview.profile;
    const laneIds = [...new Set(plan.localReviewRunner.lanes.map(lane => lane.lane))];
    assert.ok(laneIds.length > 0);
    const comments = laneIds.map(lane => laneReviewComment({ lane, profile, head: 'abc123', issueNumber: 93, prNumber: 12, expectedLanes: laneIds, runId: `reuse-${lane}` }));
    const fixture = makePrExec({ prViews: [cleanLocalPr({ comments, reviewDecision: 'APPROVED' })] });

    const result = await runPrGate(config, {
      prNumber: 12,
      repoRoot: repo,
      exec: fixture.exec,
      resolveModelHost: async () => 'grok.exe',
      resolveModelHead: async () => 'abc123',
      routeProbe: readyRouteProbe,
      modelRouteProcess: async () => { throw new Error('routed lane executed although trusted provider evidence covered the head'); },
    });

    assert.equal(result.localReview.status, 'passed');
    assert.ok(result.localReviewRunner.lanes.every(lane => lane.status === 'skipped' && lane.evidenceSource === 'trusted-provider'));
    assert.ok(result.localReview.evidence[0].lanes.every(lane => lane.origin === 'trusted-provider'));
    assert.ok(result.reviewParticipantRollup);
    assert.equal(result.reviewParticipantRollup.hostLaneReceived, result.reviewParticipantRollup.hostLaneExpected);
    assert.ok(result.reviewParticipantRollup.hostLaneExpected > 0);
    assert.equal(result.shipReady.ready, true);
    assert.equal(result.shipReady.advisoryCount, 0);
    assert.match(result.nextAction, /Ship-ready/);
    assert.equal(result.localReviewPublish.status, 'skipped');
    assert.match(result.localReviewPublish.nextAction, /reused/i);
    assert.ok(result.roundSummary);
    assert.ok(result.roundSummary.status === 'published' || result.roundSummary.status === 'skipped' || result.roundSummary.status === 'failed');
    const publishRecord = JSON.parse(readFileSync(join(repo, '.qube', 'aie', 'reviews', '93', '12', 'abc123', 'publish.json'), 'utf8'));
    assert.ok(['skipped', 'published', 'failed'].includes(publishRecord.status));
    assert.ok(Array.isArray(publishRecord.lanes));
  });

  it('reports a visible round-summary error when no issue number can be resolved', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    applyRoutedReviewFixture(repo);
    config.reviewAdapter = 'mixed';
    config.reviewAgents = [];
    config.reviewWaitMinutes = 0;
    config.reviewRoute = { host: 'grok', tier: 'review', timeoutSeconds: 600, maxTurns: 8 };
    config.reviewModels.review.grok = { model: 'grok-4.5', effort: null };
    const fixture = makePrExec({ prViews: [cleanLocalPr({ closingIssuesReferences: [] })] });
    const modelRouteProcess = async invocation => {
      const prompt = readFileSync(invocation.promptPath, 'utf8');
      const lane = prompt.match(/Run local review lane ([a-z-]+)\./)?.[1];
      const body = {
        issueNumber: 0,
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

    const result = await runPrGate(config, {
      prNumber: 12,
      repoRoot: repo,
      exec: fixture.exec,
      modelRouteProcess,
      routeProbe: readyRouteProbe,
      resolveModelHost: async () => 'grok.exe',
      resolveModelHead: async () => 'abc123',
    });

    assert.ok(result.roundSummary);
    assert.equal(result.roundSummary.status, 'failed');
    assert.match(String(result.roundSummary.failure), /issue number/i);
    const publishRecord = JSON.parse(readFileSync(join(repo, '.qube', 'aie', 'reviews', '0', '12', 'abc123', 'publish.json'), 'utf8'));
    assert.equal(publishRecord.roundSummary.status, 'failed');
  });

  it('reruns every lane when the trusted provider round is missing one', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    applyRoutedReviewFixture(repo);
    config.reviewAdapter = 'mixed';
    config.reviewAgents = [];
    config.reviewWaitMinutes = 0;
    config.reviewRoute = { host: 'grok', tier: 'review', timeoutSeconds: 600, maxTurns: 8 };
    config.reviewModels.review.grok = { model: 'grok-4.5', effort: null };
    const plan = await runPrGate(config, { prNumber: 12, repoRoot: repo, dryRun: true, exec: makePrExec({ prViews: [cleanLocalPr()] }).exec });
    const profile = plan.localReview.profile;
    const laneIds = [...new Set(plan.localReviewRunner.lanes.map(lane => lane.lane))];
    assert.ok(laneIds.length > 1);
    const uncoveredLane = laneIds[0];
    const comments = laneIds.slice(1).map(lane => laneReviewComment({ lane, profile, head: 'abc123', issueNumber: 93, prNumber: 12, expectedLanes: laneIds, runId: `reuse-${lane}` }));

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, dryRun: true, exec: makePrExec({ prViews: [cleanLocalPr({ comments })] }).exec });

    // Fail-closed round completeness: a round missing one declared lane is
    // never read as approved, so no lane from it is reused and every lane
    // plans a fresh run.
    assert.ok(result.localReviewRunner.lanes.every(lane => lane.status === 'planned' && lane.evidenceSource === 'fresh-run'));
    assert.equal((result.localReview.providerReuse?.accepted ?? []).length, 0);
    assert.ok(result.localReview.providerReuse.rejected.some(entry => entry.lane !== uncoveredLane && /incomplete review round/.test(entry.reason)));
  });

  it('never reuses lane review markers from untrusted authors', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    applyRoutedReviewFixture(repo);
    config.reviewAdapter = 'mixed';
    config.reviewAgents = [];
    config.reviewWaitMinutes = 0;
    config.reviewRoute = { host: 'grok', tier: 'review', timeoutSeconds: 600, maxTurns: 8 };
    config.reviewModels.review.grok = { model: 'grok-4.5', effort: null };
    const plan = await runPrGate(config, { prNumber: 12, repoRoot: repo, dryRun: true, exec: makePrExec({ prViews: [cleanLocalPr()] }).exec });
    const profile = plan.localReview.profile;
    const laneIds = [...new Set(plan.localReviewRunner.lanes.map(lane => lane.lane))];
    const comments = laneIds.map(lane => ({
      ...laneReviewComment({ lane, profile, head: 'abc123', issueNumber: 93, prNumber: 12, runId: `forged-${lane}` }),
      author: { login: 'mallory' },
    }));

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, dryRun: true, exec: makePrExec({ prViews: [cleanLocalPr({ comments })] }).exec });

    assert.ok(result.localReviewRunner.lanes.every(lane => lane.status === 'planned' && lane.evidenceSource === 'fresh-run'));
    assert.equal((result.localReview.providerReuse?.accepted ?? []).length, 0);
    assert.notEqual(result.localReview.status, 'passed');
  });

  it('rejects stale-head trusted provider reviews with actionable reasons', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    applyRoutedReviewFixture(repo);
    config.reviewAdapter = 'mixed';
    config.reviewAgents = [];
    config.reviewWaitMinutes = 0;
    config.reviewRoute = { host: 'grok', tier: 'review', timeoutSeconds: 600, maxTurns: 8 };
    config.reviewModels.review.grok = { model: 'grok-4.5', effort: null };
    const plan = await runPrGate(config, { prNumber: 12, repoRoot: repo, dryRun: true, exec: makePrExec({ prViews: [cleanLocalPr()] }).exec });
    const profile = plan.localReview.profile;
    const laneIds = [...new Set(plan.localReviewRunner.lanes.map(lane => lane.lane))];
    const comments = laneIds.map(lane => laneReviewComment({ lane, profile, head: 'def456', issueNumber: 93, prNumber: 12, expectedLanes: laneIds, runId: `stale-${lane}` }));

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, dryRun: true, exec: makePrExec({ prViews: [cleanLocalPr({ comments })] }).exec });

    assert.ok(result.localReviewRunner.lanes.every(lane => lane.status === 'planned' && lane.evidenceSource === 'fresh-run'));
    assert.ok(result.localReview.providerReuse.accepted.length === 0);
    assert.ok(result.localReview.providerReuse.rejected.length > 0);
    assert.ok(result.localReview.providerReuse.rejected.every(entry => /other heads/.test(entry.reason)));
    assert.equal(result.shipReady.ready, false);
  });

  it('rejects profile-incompatible and non-approve trusted provider reviews', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    applyRoutedReviewFixture(repo);
    config.reviewAdapter = 'mixed';
    config.reviewAgents = [];
    config.reviewWaitMinutes = 0;
    config.reviewRoute = { host: 'grok', tier: 'review', timeoutSeconds: 600, maxTurns: 8 };
    config.reviewModels.review.grok = { model: 'grok-4.5', effort: null };
    const plan = await runPrGate(config, { prNumber: 12, repoRoot: repo, dryRun: true, exec: makePrExec({ prViews: [cleanLocalPr()] }).exec });
    const profile = plan.localReview.profile;
    const laneIds = [...new Set(plan.localReviewRunner.lanes.map(lane => lane.lane))];
    assert.ok(laneIds.length > 2);
    const wrongProfileLane = laneIds[0];
    const nonApproveLane = laneIds[1];
    const comments = laneIds.map(lane => laneReviewComment({
      lane,
      profile: lane === wrongProfileLane ? 'local-comprehensive' : profile,
      recommendation: lane === nonApproveLane ? 'request-changes' : 'approve',
      status: lane === nonApproveLane ? 'needs-work' : 'passed',
      head: 'abc123',
      issueNumber: 93,
      prNumber: 12,
      expectedLanes: laneIds,
      runId: `mixed-${lane}`,
    }));

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, dryRun: true, exec: makePrExec({ prViews: [cleanLocalPr({ comments })] }).exec });

    const byLane = new Map(result.localReviewRunner.lanes.map(lane => [lane.lane, lane]));
    assert.equal(byLane.get(wrongProfileLane).status, 'planned');
    assert.equal(byLane.get(nonApproveLane).status, 'planned');
    assert.ok(laneIds.slice(2).every(lane => byLane.get(lane).status === 'skipped' && byLane.get(lane).evidenceSource === 'trusted-provider'));
    const reasons = result.localReview.providerReuse.rejected.map(entry => entry.reason).join(' ');
    assert.match(reasons, /incompatible with the configured profile/);
    assert.match(reasons, /only approve\/passed records are reusable/);
    assert.match(reasons, /local-only fields/);
  });

  it('reuses existing current-head local lane evidence instead of re-executing routed lanes', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    applyRoutedReviewFixture(repo);
    config.reviewAdapter = 'mixed';
    config.reviewAgents = [];
    config.reviewWaitMinutes = 0;
    config.reviewRoute = { host: 'grok', tier: 'review', timeoutSeconds: 600, maxTurns: 8 };
    config.reviewModels.review.grok = { model: 'grok-4.5', effort: null };
    const modelRouteProcess = async invocation => {
      const prompt = readFileSync(invocation.promptPath, 'utf8');
      const lane = prompt.match(/Run local review lane ([a-z-]+)\./)?.[1];
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
    const firstRun = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec: makePrExec({ prViews: [cleanLocalPr()] }).exec, modelRouteProcess, routeProbe: readyRouteProbe, resolveModelHost: async () => 'grok.exe', resolveModelHead: async () => 'abc123' });
    assert.equal(firstRun.localReview.status, 'passed');
    assert.ok(firstRun.localReviewRunner.lanes.every(lane => lane.evidenceSource === 'fresh-run'));

    let secondRunModelCalls = 0;
    const fixture = makePrExec({ prViews: [cleanLocalPr()] });
    const result = await runPrGate(config, {
      prNumber: 12,
      repoRoot: repo,
      exec: fixture.exec,
      resolveModelHost: async () => 'grok.exe',
      resolveModelHead: async () => 'abc123',
      routeProbe: readyRouteProbe,
      modelRouteProcess: async () => { secondRunModelCalls += 1; throw new Error('routed lane executed although current-head local evidence exists'); },
    });

    assert.equal(secondRunModelCalls, 0);
    assert.equal(result.localReview.status, 'passed');
    assert.ok(result.localReviewRunner.lanes.every(lane => lane.status === 'completed' && lane.evidenceSource === 'local'));
    assert.ok(result.localReview.evidence[0].lanes.every(lane => lane.origin === 'local'));
    // Reused local evidence still publishes: a validated lane result without
    // a current provider marker reaches the provider on this run instead of
    // staying local-only.
    assert.equal(result.localReviewPublish.status, 'published');
    assert.match(result.localReviewPublish.nextAction, /routed current-head lane review/i);
  });

  it('re-executes a lane whose local current-head evidence is non-terminal instead of provider-reusing it', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    applyRoutedReviewFixture(repo);
    config.reviewAdapter = 'mixed';
    config.reviewAgents = [];
    config.reviewWaitMinutes = 0;
    config.reviewRoute = { host: 'grok', tier: 'review', timeoutSeconds: 600, maxTurns: 8 };
    config.reviewModels.review.grok = { model: 'grok-4.5', effort: null };
    const plan = await runPrGate(config, { prNumber: 12, repoRoot: repo, dryRun: true, exec: makePrExec({ prViews: [cleanLocalPr()] }).exec });
    const profile = plan.localReview.profile;
    const laneIds = [...new Set(plan.localReviewRunner.lanes.map(lane => lane.lane))];
    assert.ok(laneIds.length > 1);
    const nonTerminalLane = laneIds[0];
    const laneDirectory = join(repo, '.qube', 'aie', 'reviews', '93', '12', 'abc123');
    mkdirSync(laneDirectory, { recursive: true });
    writeFileSync(join(laneDirectory, `${nonTerminalLane}.json`), `${JSON.stringify({ version: 1, issueNumber: 93, prNumber: 12, headSha: 'abc123', lane: nonTerminalLane, status: 'unavailable', summary: 'host fault before verdict' })}\n`);
    const comments = laneIds.map(lane => laneReviewComment({ lane, profile, head: 'abc123', issueNumber: 93, prNumber: 12, expectedLanes: laneIds, runId: `mixed-source-${lane}` }));

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, dryRun: true, exec: makePrExec({ prViews: [cleanLocalPr({ comments })] }).exec });

    const byLane = new Map(result.localReviewRunner.lanes.map(lane => [lane.lane, lane]));
    assert.equal(byLane.get(nonTerminalLane).status, 'planned');
    assert.equal(byLane.get(nonTerminalLane).evidenceSource, 'fresh-run');
    assert.ok(laneIds.slice(1).every(lane => byLane.get(lane).status === 'skipped' && byLane.get(lane).evidenceSource === 'trusted-provider'));
  });

  it('renders issue requirement proof statuses in the dry-run self-check', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    config.reviewAdapter = 'mixed';
    mkdirSync(join(repo, 'test'), { recursive: true });
    writeFileSync(join(repo, 'test', 'probe.test.cjs'), 'assert stale provider metadata rejected with actionable reason\n');
    const criterion = 'Stale provider metadata is rejected with an actionable reason.';
    const prBody = [
      '### Criterion 1: ' + criterion,
      '- Implemented at: `test/probe.test.cjs`',
      '- Proven by: `test/probe.test.cjs`',
    ].join('\n');
    const { exec } = makePrExec({
      prViews: [cleanLocalPr({ body: prBody })],
      issueBodies: { 93: `- [ ] ${criterion}\n- [ ] A requirement with no proof entry anywhere.` },
    });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, dryRun: true, exec });

    assert.ok(result.selfCheck);
    assert.equal(result.selfCheck.requirements.length, 2);
    const byIndex = new Map(result.selfCheck.requirements.map(requirement => [requirement.index, requirement]));
    assert.equal(byIndex.get(1).proof.status, 'proven');
    assert.equal(byIndex.get(2).proof.status, 'unmapped');
    assert.equal(result.selfCheck.requirements[0].proof.status, 'unmapped');
    const formattedLines = require('../dist/app/implementer_self_check.js').formatImplementerSelfCheck(result.selfCheck).join('\n');
    assert.match(formattedLines, /Linked issue requirements \(unproven first\)/);
  });

  it('returns the same ranked fix batch from pr batch as the full gate over partial evidence', async () => {
    const { runPrBatchService } = require('../dist/app/pr_batch.js');
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    config.reviewAdapter = 'mixed';
    const evidence = localEvidence({ laneStatus: 'needs-work', blockers: ['Blocking defect recorded.'] });
    evidence.lanes = evidence.lanes.filter(lane => lane.id === 'code-quality').map(lane => ({
      ...lane,
      severity: 'high',
      findings: [
        { id: 'cq-1', severity: 'blocking', message: 'False success on empty verdicts.', location: { path: 'src/review.ts', line: 4 } },
        { id: 'cq-2', severity: 'advisory', message: 'Duplicate parsing of evidence files.', location: { path: 'src/review.ts', line: 9 } },
      ],
    }));
    writeLocalEvidence(repo, evidence);
    const { exec } = makePrExec({ prViews: [cleanLocalPr()] });

    const gateResult = await runPrGate(config, { prNumber: 12, repoRoot: repo, dryRun: true, exec });
    const batchResult = await runPrBatchService(config, { prNumber: 12, repoRoot: repo, exec });

    assert.deepEqual(batchResult.batch, gateResult.fixBatch);
    assert.equal(batchResult.batch.findings[0].severity, 'blocking');
    assert.ok(batchResult.batch.findings.every(finding => Array.isArray(finding.lanes) && finding.lanes.length > 0));
  });



  it('keeps other lanes and their evidence intact when one routed lane fails', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    applyRoutedReviewFixture(repo);
    config.reviewAdapter = 'mixed';
    config.reviewAgents = [];
    config.reviewWaitMinutes = 0;
    config.reviewConcurrency = 3;
    config.reviewRoute = { host: 'grok', tier: 'review', timeoutSeconds: 600, maxTurns: 8 };
    config.reviewModels.review.grok = { model: 'grok-4.5', effort: null };
    const fixture = makePrExec({ prViews: [cleanLocalPr()] });
    let timedOutLane = null;
    let failedLane = null;
    const modelRouteProcess = async invocation => {
      const prompt = readFileSync(invocation.promptPath, 'utf8');
      const lane = prompt.match(/Run local review lane ([a-z-]+)\./)?.[1];
      if (timedOutLane === null) {
        timedOutLane = lane;
        return { exitCode: 1, stderr: '', stdout: '', timedOut: true, stdinDelivered: true };
      }
      if (failedLane === null) {
        failedLane = lane;
        return { exitCode: 1, stderr: 'host process crashed', stdout: '', timedOut: false, stdinDelivered: true };
      }
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

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec: fixture.exec, modelRouteProcess, routeProbe: readyRouteProbe, resolveModelHost: async () => 'grok.exe', resolveModelHead: async () => 'abc123' });

    assert.equal(result.localReviewRunner.status, 'failed');
    const failed = result.localReviewRunner.lanes.filter(lane => lane.status === 'failed');
    const completed = result.localReviewRunner.lanes.filter(lane => lane.status === 'completed' && lane.route !== null);
    assert.equal(failed.length, 2);
    assert.equal(failed.find(lane => lane.lane === timedOutLane)?.blocker, 'model-route-timeout');
    assert.equal(failed.find(lane => lane.lane === failedLane)?.blocker, 'model-route-process-failed');
    assert.ok(completed.length >= 1);
    for (const lane of completed) {
      const evidence = JSON.parse(readFileSync(join(repo, '.qube', 'aie', 'reviews', '93', '12', 'abc123', `${lane.lane}.json`), 'utf8'));
      assert.equal(evidence.status, 'passed');
      assert.equal(evidence.lane, lane.lane);
    }
    assert.match(result.localReviewRunner.summary, /Local review runner failed 2 lane\(s\)/);
    assert.ok(result.localReviewRunner.summary.includes(timedOutLane) && result.localReviewRunner.summary.includes(failedLane));
  });

  it('blocks the routed batch with probe diagnostics before any model execution', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    applyRoutedReviewFixture(repo);
    config.reviewAdapter = 'mixed';
    config.reviewAgents = [];
    config.reviewWaitMinutes = 0;
    config.reviewRoute = { host: 'grok', tier: 'review', timeoutSeconds: 600, maxTurns: 8 };
    config.reviewModels.review.grok = { model: 'grok-9-missing', effort: null };
    const fixture = makePrExec({ prViews: [cleanLocalPr()] });
    let modelExecutions = 0;
    const modelRouteProcess = async () => {
      modelExecutions += 1;
      return { exitCode: 0, stderr: '', stdout: '', timedOut: false, stdinDelivered: true };
    };
    let probeCalls = 0;
    const routeProbe = (host, model) => {
      probeCalls += 1;
      return { host, model, status: 'blocked', executable: `${host}-probe`, version: 'probe-test', modelListed: false, diagnostic: `Configured review model "${model}" is not in the ${host} catalog (grok-4.5). Update the trusted review model configuration to a listed model.` };
    };

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec: fixture.exec, modelRouteProcess, routeProbe, resolveModelHost: async () => 'grok.exe', resolveModelHead: async () => 'abc123' });

    assert.equal(modelExecutions, 0, 'a blocked probe must prevent all model execution');
    assert.equal(probeCalls, 1, 'one distinct route is probed exactly once per batch');
    assert.equal(result.localReviewRunner.status, 'unavailable');
    const routedLanes = result.localReviewRunner.lanes.filter(lane => lane.route !== null);
    assert.ok(routedLanes.length >= 3);
    for (const lane of routedLanes) {
      assert.equal(lane.status, 'unavailable');
      assert.equal(lane.blocker, 'model-route-probe-blocked');
      assert.match(lane.summary, /grok-9-missing.*not in the grok catalog/);
      assert.match(lane.summary, /Update the trusted review model configuration/);
    }
    assert.ok(result.localReviewRunner.unavailable.length >= routedLanes.length);
  });

  it('fails over a repeatedly faulting lane to the configured fallback route with distinct provenance', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    applyRoutedReviewFixture(repo);
    config.reviewAdapter = 'mixed';
    config.reviewAgents = [];
    config.reviewWaitMinutes = 0;
    config.reviewRoute = { host: 'grok', tier: 'review', timeoutSeconds: 600, maxTurns: 8 };
    config.reviewModels.review.grok = { model: 'grok-4.5', effort: null };
    config.reviewModels.review.codex = { model: 'gpt-fallback-test', effort: 'low' };
    config.reviewFailover = { faults: 2, route: { host: 'codex', tier: 'review', timeoutSeconds: 600, maxTurns: 8 } };
    let faultedLane = null;
    const codexLanes = [];
    const laneBody = lane => ({
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
      preconditions: [],
    });
    const modelRouteProcess = async invocation => {
      if (invocation.schemaPath) {
        const prompt = invocation.stdin ?? '';
        const lane = prompt.match(/Run local review lane ([a-z-]+)\./)?.[1];
        codexLanes.push(lane);
        const body = { ...laneBody(lane), coverage: ((prompt.match(/Attest coverage for exactly these areas: ([^\n]+?)\. Each coverage entry/) || [])[1] || lane).split(', ').map(area => ({ area, status: 'clear' })) };
        const events = [
          JSON.stringify({ type: 'thread.started', thread_id: `codex-thread-${lane}` }),
          JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(body) } }),
        ];
        return { exitCode: 0, stderr: '', timedOut: false, stdinDelivered: true, stdout: events.join('\n') };
      }
      const prompt = readFileSync(invocation.promptPath, 'utf8');
      const lane = prompt.match(/Run local review lane ([a-z-]+)\./)?.[1];
      if (faultedLane === null) faultedLane = lane;
      if (lane === faultedLane) {
        return { exitCode: 1, stderr: 'host session refused the task', stdout: '', timedOut: false, stdinDelivered: true };
      }
      const body = { ...laneBody(lane), coverage: ((prompt.match(/Attest coverage for exactly these areas: ([^\n]+?)\. Each coverage entry/) || [])[1] || lane).split(', ').map(area => ({ area, status: 'clear' })) };
      return { exitCode: 0, stderr: '', timedOut: false, stdinDelivered: true, stdout: JSON.stringify({ text: JSON.stringify(body), sessionId: `session-${lane}` }) };
    };
    const gateOptions = { prNumber: 12, repoRoot: repo, exec: makePrExec({ prViews: [cleanLocalPr()] }).exec, modelRouteProcess, routeProbe: readyRouteProbe, resolveModelHost: async host => (host === 'codex' ? 'codex.exe' : 'grok.exe'), resolveModelHead: async () => 'abc123' };

    const firstRun = await runPrGate(config, gateOptions);
    assert.equal(firstRun.localReviewRunner.status, 'failed');
    const ledgerPath = join(repo, '.git', 'qube', 'aie', 'route-faults', '93', '12.json');
    let ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    assert.equal(ledger.lanes[faultedLane].count, 1);
    assert.equal(codexLanes.length, 0, 'failover must not engage below the fault threshold');

    const secondRun = await runPrGate(config, gateOptions);
    assert.equal(secondRun.localReviewRunner.status, 'failed');
    ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    assert.equal(ledger.lanes[faultedLane].count, 2);
    assert.equal(codexLanes.length, 0, 'the run that reaches the threshold still executes the primary route');

    const thirdRun = await runPrGate(config, gateOptions);
    assert.deepEqual(codexLanes, [faultedLane], 'only the faulted lane fails over to the codex fallback route');
    const failedOver = thirdRun.localReviewRunner.lanes.find(lane => lane.lane === faultedLane);
    assert.equal(failedOver.status, 'completed');
    assert.equal(failedOver.route.host, 'codex');
    assert.match(failedOver.summary, /routed review passed/);
    const evidence = JSON.parse(readFileSync(join(repo, '.qube', 'aie', 'reviews', '93', '12', 'abc123', `${faultedLane}.json`), 'utf8'));
    assert.equal(evidence.runnerProvenance.host, 'codex');
    assert.equal(evidence.runnerProvenance.model, 'gpt-fallback-test');
    assert.equal(evidence.runnerProvenance.routeSource, 'fallback');
    const trustedProvenance = JSON.parse(readFileSync(join(repo, '.git', 'qube', 'aie', 'host-provenance', '93', '12', 'abc123', `${faultedLane}.json`), 'utf8'));
    assert.equal(trustedProvenance.host, 'codex');
    assert.equal(trustedProvenance.routeSource, 'fallback');
    ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    assert.ok(!(faultedLane in ledger.lanes), 'a completed fallback verdict clears the lane fault tally');
    const otherEvidence = JSON.parse(readFileSync(join(repo, '.qube', 'aie', 'reviews', '93', '12', 'abc123', `${thirdRun.localReviewRunner.lanes.filter(lane => lane.route !== null).map(lane => lane.lane).find(lane => lane !== faultedLane)}.json`), 'utf8'));
    assert.equal(otherEvidence.runnerProvenance.routeSource, 'configured');
  });

  it('never triggers failover from a review verdict', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    applyRoutedReviewFixture(repo);
    config.reviewAdapter = 'mixed';
    config.reviewAgents = [];
    config.reviewWaitMinutes = 0;
    config.reviewRoute = { host: 'grok', tier: 'review', timeoutSeconds: 600, maxTurns: 8 };
    config.reviewModels.review.grok = { model: 'grok-4.5', effort: null };
    config.reviewModels.review.codex = { model: 'gpt-fallback-test', effort: 'low' };
    config.reviewFailover = { faults: 1, route: { host: 'codex', tier: 'review', timeoutSeconds: 600, maxTurns: 8 } };
    const hostsUsed = [];
    const modelRouteProcess = async invocation => {
      assert.equal(invocation.schemaPath, null, 'a review verdict must never re-route the lane to the fallback host');
      hostsUsed.push('grok');
      const prompt = readFileSync(invocation.promptPath, 'utf8');
      const lane = prompt.match(/Run local review lane ([a-z-]+)\./)?.[1];
      const areas = ((prompt.match(/Attest coverage for exactly these areas: ([^\n]+?)\. Each coverage entry/) || [])[1] || lane).split(', ');
      const body = {
        issueNumber: 93,
        prNumber: 12,
        headSha: 'abc123',
        lane,
        status: 'needs-work',
        severity: 'high',
        recommendation: 'request-changes',
        summary: `${lane} routed review requests changes.`,
        blockers: ['A real blocking defect that the implementer must fix.'],
        findings: [{ severity: 'blocking', message: 'Observable defect in the changed code.', location: { path: 'src/review.ts', line: 4 } }],
        artifacts: [{ kind: 'command', path: 'command:git diff --check', sha256: null }],
        commands: ['git diff --check'],
        surfaces: ['PR diff'],
        contextReviewed: requiredTaskContext(),
        toolsUsed: ['git'],
        completeness: `Inspected the complete ${lane} scope at the current head.`,
        coverage: areas.map(area => ({ area, status: area === lane ? 'finding' : 'clear' })),
        preconditions: [],
      };
      return { exitCode: 0, stderr: '', timedOut: false, stdinDelivered: true, stdout: JSON.stringify({ text: JSON.stringify(body), sessionId: `session-${lane}` }) };
    };

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec: makePrExec({ prViews: [cleanLocalPr()] }).exec, modelRouteProcess, routeProbe: readyRouteProbe, resolveModelHost: async () => 'grok.exe', resolveModelHead: async () => 'abc123' });

    const routedLanes = result.localReviewRunner.lanes.filter(lane => lane.route !== null);
    assert.ok(routedLanes.length >= 1);
    assert.ok(routedLanes.every(lane => lane.status === 'completed'));
    assert.ok(hostsUsed.length >= 1 && hostsUsed.every(host => host === 'grok'));
    assert.ok(!existsSync(join(repo, '.git', 'qube', 'aie', 'route-faults', '93', '12.json')) || Object.keys(JSON.parse(readFileSync(join(repo, '.git', 'qube', 'aie', 'route-faults', '93', '12.json'), 'utf8')).lanes).length === 0, 'review verdicts must record zero host faults');
    for (const lane of routedLanes) {
      const evidence = JSON.parse(readFileSync(join(repo, '.qube', 'aie', 'reviews', '93', '12', 'abc123', `${lane.lane}.json`), 'utf8'));
      assert.equal(evidence.runnerProvenance.routeSource, 'configured');
    }
  });

  it('publishes a non-empty actionable summary when a routed lane fails without a diagnostic', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    applyRoutedReviewFixture(repo);
    config.reviewAdapter = 'mixed';
    config.reviewAgents = [];
    config.reviewWaitMinutes = 0;
    config.reviewRoute = { host: 'grok', tier: 'review', timeoutSeconds: 600, maxTurns: 8 };
    config.reviewModels.review.grok = { model: 'grok-4.5', effort: null };
    const modelRouteProcess = async () => {
      throw new Error('');
    };

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec: makePrExec({ prViews: [cleanLocalPr()] }).exec, modelRouteProcess, routeProbe: readyRouteProbe, resolveModelHost: async () => 'grok.exe', resolveModelHead: async () => 'abc123' });

    assert.equal(result.localReviewRunner.status, 'failed');
    const failedLanes = result.localReviewRunner.lanes.filter(lane => lane.status === 'failed');
    assert.ok(failedLanes.length >= 1);
    for (const lane of failedLanes) {
      assert.ok(lane.summary.trim() !== '', 'failed lanes must never publish an empty summary');
      assert.match(lane.summary, /Routed model review failed \(model-route-unavailable\)\./);
    }
    assert.match(result.localReviewRunner.summary, /Local review runner failed/);
    assert.ok(failedLanes.every(lane => result.localReviewRunner.summary.includes(lane.lane)));
  });

  it('retries the configured primary route when the fallback probe is blocked', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    applyRoutedReviewFixture(repo);
    config.reviewAdapter = 'mixed';
    config.reviewAgents = [];
    config.reviewWaitMinutes = 0;
    config.reviewRoute = { host: 'grok', tier: 'review', timeoutSeconds: 600, maxTurns: 8 };
    config.reviewModels.review.grok = { model: 'grok-4.5', effort: null };
    config.reviewModels.review.codex = { model: 'gpt-fallback-test', effort: 'low' };
    config.reviewFailover = { faults: 1, route: { host: 'codex', tier: 'review', timeoutSeconds: 600, maxTurns: 8 } };
    let faultedLane = null;
    let failFirst = true;
    const modelRouteProcess = async invocation => {
      assert.equal(invocation.schemaPath, null, 'the blocked codex fallback must never execute');
      const prompt = readFileSync(invocation.promptPath, 'utf8');
      const lane = prompt.match(/Run local review lane ([a-z-]+)\./)?.[1];
      if (failFirst && faultedLane === null) faultedLane = lane;
      if (failFirst && lane === faultedLane) {
        return { exitCode: 1, stderr: 'host process crashed', stdout: '', timedOut: false, stdinDelivered: true };
      }
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
    const routeProbe = (host, model) => (host === 'codex'
      ? { host, model, status: 'blocked', executable: null, version: null, modelListed: null, diagnostic: 'The codex CLI is not resolvable. Install and authenticate the codex CLI on PATH before running routed review lanes.' }
      : readyRouteProbe(host, model));
    const gateOptions = { prNumber: 12, repoRoot: repo, exec: makePrExec({ prViews: [cleanLocalPr()] }).exec, modelRouteProcess, routeProbe, resolveModelHost: async () => 'grok.exe', resolveModelHead: async () => 'abc123' };

    const firstRun = await runPrGate(config, gateOptions);
    assert.equal(firstRun.localReviewRunner.status, 'failed');
    failFirst = false;

    const secondRun = await runPrGate(config, gateOptions);
    const recovered = secondRun.localReviewRunner.lanes.find(lane => lane.lane === faultedLane);
    assert.equal(recovered.status, 'completed');
    assert.equal(recovered.route.host, 'grok', 'a blocked fallback probe must retry the configured primary route');
    const evidence = JSON.parse(readFileSync(join(repo, '.qube', 'aie', 'reviews', '93', '12', 'abc123', `${faultedLane}.json`), 'utf8'));
    assert.equal(evidence.runnerProvenance.host, 'grok');
    assert.equal(evidence.runnerProvenance.routeSource, 'configured');
    const ledger = JSON.parse(readFileSync(join(repo, '.git', 'qube', 'aie', 'route-faults', '93', '12.json'), 'utf8'));
    assert.ok(!(faultedLane in ledger.lanes), 'the recovered primary verdict clears the fault tally');
  });

  it('marks a lane unavailable only when both the fallback and primary probes are blocked', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    applyRoutedReviewFixture(repo);
    config.reviewAdapter = 'mixed';
    config.reviewAgents = [];
    config.reviewWaitMinutes = 0;
    config.reviewRoute = { host: 'grok', tier: 'review', timeoutSeconds: 600, maxTurns: 8 };
    config.reviewModels.review.grok = { model: 'grok-4.5', effort: null };
    config.reviewModels.review.codex = { model: 'gpt-fallback-test', effort: 'low' };
    config.reviewFailover = { faults: 1, route: { host: 'codex', tier: 'review', timeoutSeconds: 600, maxTurns: 8 } };
    const primaryRouteKey = reviewRouteKey({ host: 'grok', tier: 'review', model: 'grok-4.5', effort: null, isolation: 'read-only', timeoutSeconds: 600, maxTurns: 8, substitution: null });
    mkdirSync(join(repo, '.git', 'qube', 'aie', 'route-faults', '93'), { recursive: true });
    writeFileSync(join(repo, '.git', 'qube', 'aie', 'route-faults', '93', '12.json'), `${JSON.stringify({ version: 1, lanes: { 'issue-compliance': { count: 3, routeKey: primaryRouteKey, lastReasonCode: 'model-route-process-failed', lastAt: '2026-01-01T00:00:00Z' }, 'code-quality': { count: 3, routeKey: primaryRouteKey, lastReasonCode: 'model-route-process-failed', lastAt: '2026-01-01T00:00:00Z' }, performance: { count: 3, routeKey: primaryRouteKey, lastReasonCode: 'model-route-process-failed', lastAt: '2026-01-01T00:00:00Z' } } })}\n`);
    let modelExecutions = 0;
    const modelRouteProcess = async () => {
      modelExecutions += 1;
      return { exitCode: 0, stderr: '', stdout: '', timedOut: false, stdinDelivered: true };
    };
    const routeProbe = (host, model) => ({ host, model, status: 'blocked', executable: null, version: null, modelListed: null, diagnostic: `The ${host} CLI is not resolvable. Install and authenticate the ${host} CLI on PATH before running routed review lanes.` });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec: makePrExec({ prViews: [cleanLocalPr()] }).exec, modelRouteProcess, routeProbe, resolveModelHost: async () => 'grok.exe', resolveModelHead: async () => 'abc123' });

    assert.equal(modelExecutions, 0);
    assert.equal(result.localReviewRunner.status, 'unavailable');
    const routedLanes = result.localReviewRunner.lanes.filter(lane => lane.route !== null);
    assert.ok(routedLanes.length >= 3);
    assert.ok(routedLanes.every(lane => lane.status === 'unavailable' && lane.blocker === 'model-route-probe-blocked'));
  });

  it('restarts the fault tally when the primary route configuration changes', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    applyRoutedReviewFixture(repo);
    config.reviewAdapter = 'mixed';
    config.reviewAgents = [];
    config.reviewWaitMinutes = 0;
    config.reviewRoute = { host: 'grok', tier: 'review', timeoutSeconds: 600, maxTurns: 8 };
    config.reviewModels.review.grok = { model: 'grok-4.5', effort: null };
    config.reviewModels.review.codex = { model: 'gpt-fallback-test', effort: 'low' };
    config.reviewFailover = { faults: 1, route: { host: 'codex', tier: 'review', timeoutSeconds: 600, maxTurns: 8 } };
    mkdirSync(join(repo, '.git', 'qube', 'aie', 'route-faults', '93'), { recursive: true });
    writeFileSync(join(repo, '.git', 'qube', 'aie', 'route-faults', '93', '12.json'), `${JSON.stringify({ version: 1, lanes: { 'issue-compliance': { count: 5, routeKey: 'stale-route-identity', lastReasonCode: 'model-route-process-failed', lastAt: '2026-01-01T00:00:00Z' }, 'code-quality': { count: 5, routeKey: 'stale-route-identity', lastReasonCode: 'model-route-process-failed', lastAt: '2026-01-01T00:00:00Z' }, performance: { count: 5, routeKey: 'stale-route-identity', lastReasonCode: 'model-route-process-failed', lastAt: '2026-01-01T00:00:00Z' } } })}\n`);
    const modelRouteProcess = async invocation => {
      assert.equal(invocation.schemaPath, null, 'a changed primary route must be retested before failover engages');
      const prompt = readFileSync(invocation.promptPath, 'utf8');
      const lane = prompt.match(/Run local review lane ([a-z-]+)\./)?.[1];
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

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec: makePrExec({ prViews: [cleanLocalPr()] }).exec, modelRouteProcess, routeProbe: readyRouteProbe, resolveModelHost: async () => 'grok.exe', resolveModelHead: async () => 'abc123' });

    const routedLanes = result.localReviewRunner.lanes.filter(lane => lane.route !== null);
    assert.ok(routedLanes.length >= 3);
    assert.ok(routedLanes.every(lane => lane.status === 'completed' && lane.route.host === 'grok'));
  });

});
