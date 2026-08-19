const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { describe, it } = require('node:test');
const { cloneGitRepo } = require('./git_fixture.cjs');
const { execFileSync, spawnSync } = require('node:child_process');
const { cpSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { basename, join } = require('node:path');

const { getDefaults } = require('../../dist/config/index.js');
const { renderAgentPrompt } = require('../../dist/agent_descriptors.js');
const { laneContextLines, promptStack, hash: promptTextHashFromLines, readRouteFaults } = require('../../dist/app/local_review_runner_support.js');
const { buildFixBatch, localReviewEvidenceSha256 } = require('../../dist/local_review_evidence.js');
let createGitHubReviewForgeProvider;
try {
  ({ createGitHubReviewForgeProvider } = require('@tjalve/qube-adapter-github'));
} catch {
  ({ createGitHubReviewForgeProvider } = require('../../../../adapters/github/dist/index.js'));
}
let observeReviewParticipants;
try {
  ({ observeReviewParticipants } = require('@tjalve/qube-core'));
} catch {
  ({ observeReviewParticipants } = require('../../../../packages/qube-core/dist/index.js'));
}
const { parsePrNumber, runPrGate, runPrViewService, formatPrView } = require('../../dist/pr/index.js');
const { buildPrBody, parsePrBodyIssueNumber } = require('../../dist/app/pr_body.js');
const { prReviewPublishFailureMessage, runPrReviewPublishService, runPrReviewPublishWithProvider } = require('../../dist/app/pr_review_publish.js');
const { resolveModelReviewPlan, reviewRouteKey } = require('../../dist/app/local_review_runner.js');
const { runPrThreadResolveService } = require('../../dist/app/pr_thread_resolve.js');
const { stringListFlag } = require('../../dist/runtime_result.js');

const prViewFields = 'number,title,state,url,headRefOid,author,reviewDecision,mergeStateStatus,mergeable,isDraft,reviewRequests,reviews,latestReviews,statusCheckRollup,closingIssuesReferences';

function makeGitRepo() {
  return cloneGitRepo('configured', 'aie-pr-gate-');
}

function binRun(args, cwd = process.cwd()) {
  return spawnSync(process.execPath, [join(process.cwd(), 'bin/run'), ...args], { cwd, encoding: 'utf8' });
}

function writeConfig(repo, config) {
  mkdirSync(join(repo, '.qube', 'aie'), { recursive: true });
  writeFileSync(join(repo, '.qube', 'aie', 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
}

function userReviewRepo() {
  const repo = makeGitRepo();
  writeConfig(repo, {
    version: 1,
    providers: {
      work: { kind: 'github' },
      review: { kind: 'github' },
      repository: { kind: 'local-git' },
      ci: { kind: 'github' },
      layout: { kind: 'local' },
    },
  });
  return repo;
}

function commitTrustedBase(repo, remote = 'origin', branch = 'main') {
  execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'trusted base'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['update-ref', `refs/remotes/${remote}/${branch}`, 'HEAD'], { cwd: repo, stdio: 'ignore' });
}

function trustReviewCommands(repo, remote = 'origin', branch = 'main') {
  writeConfig(repo, { version: 1, policy: { reviews: { adapter: 'local' } } });
  commitTrustedBase(repo, remote, branch);
}

function commitRoutedReviewHead(repo) {
  writeConfig(repo, {
    version: 1,
    policy: {
      reviews: {
        adapter: 'local',
        models: { review: { 'grok-build': { model: 'grok-4.5', effort: null } }, economy: {}, synthesis: {} },
        route: { host: 'grok-build', tier: 'review', timeoutSeconds: 600, maxTurns: 8 },
      },
    },
  });
  execFileSync('git', ['add', '.qube/aie/config.json'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'configure routed review'], { cwd: repo, stdio: 'ignore' });
}

let routedReviewTemplate = null;
// Every routed gate test applies the identical trusted-base and routed-config
// commits to a pristine repository, so they are built once on a template and
// cloned by filesystem copy instead of re-running the git ceremony per test.
function applyRoutedReviewFixture(repo) {
  if (!routedReviewTemplate) {
    routedReviewTemplate = mkdtempSync(join(tmpdir(), 'aie-pr-routed-template-'));
    cpSync(repo, routedReviewTemplate, { recursive: true, force: true });
    trustReviewCommands(routedReviewTemplate);
    commitRoutedReviewHead(routedReviewTemplate);
  }
  cpSync(routedReviewTemplate, repo, { recursive: true, force: true });
}

function writeWorkflow(repo, body) {
  mkdirSync(join(repo, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(repo, '.github', 'workflows', 'ci.yml'), body);
}

function safeRepoSegment(repo) {
  return basename(repo).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'repository';
}

function basePr(overrides = {}) {
  return {
    number: 12,
    title: 'Review me',
    state: 'OPEN',
    url: 'https://github.com/example/repo/pull/12',
    headRefOid: 'abc123',
    reviewDecision: 'REVIEW_REQUIRED',
    mergeStateStatus: 'BLOCKED',
    mergeable: 'MERGEABLE',
    isDraft: false,
    reviewRequests: [],
    reviews: [],
    latestReviews: [],
    comments: [],
    statusCheckRollup: [],
    ...overrides,
  };
}

function qubeReviewRequestComment(head = 'abc123') {
  return {
    author: { login: 'executor' },
    body: `<!-- aie:pr-gate:qubereview:${head} -->\n@QUBEReview review`,
    url: `https://github.com/example/repo/pull/12#issuecomment-qubereview-${head}`,
  };
}

function localReviewComment({ head = 'abc123', recommendation = 'approve', status = 'passed', runId = 'run-1', summary = 'local review summary', findings = '- None recorded.', profile = 'local-standard', issueNumbers = [93], lanes = ['task-record-compliance', 'issue-compliance', 'code-quality', 'tests-quality', 'manual-qa', 'final-gate'] } = {}) {
  const metadata = {
    version: 1,
    head,
    runner: 'local-command',
    host: 'local-command',
    profile,
    runId,
    evidence: '.qube/aie/reviews/93/12/abc123',
    recommendation,
    status,
    issueNumbers,
    lanes,
    inline: 'unsupported',
  };
  return {
    author: { login: 'executor' },
    body: [
      `<!-- qube-local-review:${JSON.stringify(metadata)} -->`,
      '',
      `QUBE local review: ${recommendation}`,
      '',
      'Summary:',
      summary,
      '',
      'Findings:',
      findings,
      '',
      'Metadata:',
      '- inline comments: unsupported by this provider publisher; summary comment used',
    ].join('\n'),
    url: `https://github.com/example/repo/pull/12#issuecomment-${runId}`,
  };
}

function laneReviewComment({ head = 'abc123', lane = 'code-quality', recommendation = 'approve', status = 'passed', runId = 'lane-run-1', summary = 'lane review summary', findings = '- None recorded.', profile = 'local-standard', issueNumber = 93, prNumber = 12, inline, inlineCommentCount, bodyFindingCount, expectedLanes = [lane] } = {}) {
  const metadata = {
    version: 1,
    head,
    lane,
    expectedLanes,
    profile,
    runId,
    issueNumber,
    prNumber,
    host: 'codex',
    recommendation,
    status,
    summary,
    ...(inline ? { inline } : {}),
    ...(typeof inlineCommentCount === 'number' ? { inlineCommentCount } : {}),
    ...(typeof bodyFindingCount === 'number' ? { bodyFindingCount } : {}),
  };
  return {
    author: { login: 'executor' },
    body: [
      `<!-- qube-pr-review:${JSON.stringify(metadata)} -->`,
      '',
      `QUBE review (${lane}): ${recommendation}`,
      '',
      'Summary:',
      summary,
      '',
      'Findings:',
      findings,
    ].join('\n'),
    url: `https://github.com/example/repo/pull/${prNumber}#issuecomment-${runId}`,
  };
}

function promptStackHash(stack) {
  return createHash('sha256').update(JSON.stringify(stack.map(item => ({ id: item.id, sha256: item.sha256, source: item.source })))).digest('hex');
}

function promptTextHash(text) {
  return createHash('sha256').update(text).digest('hex');
}

function promptStackForLane(id) {
  return promptForLane(id).promptStack.map(fragment => ({
    id: fragment.id,
    source: fragment.source,
    sourceCategory: fragment.sourceCategory,
    path: fragment.path,
    sha256: fragment.sha256,
    trust: fragment.trust,
  }));
}

function promptForLane(id, contextLines = [`Run local review lane ${id}.`]) {
  return renderAgentPrompt({
    hostId: 'codex',
    descriptorId: 'qa-reviewer',
    categoryId: 'review',
    laneIds: [id],
    contextLines,
    outputContract: 'Return JSON local review lane evidence for the requested lane, including runnerProvenance for the fresh independent reviewer context. Report admissible blocking findings first, then at most a few high-confidence advisories; a blocker must cite a violated acceptance criterion or a defect introduced by this diff. Include a completeness self-check that states what you inspected and what you did not have capacity to inspect.',
  });
}

function withPromptStackProvenance(provenance, promptStack) {
  return { ...provenance, promptStackHash: promptStackHash(promptStack) };
}

function safeEvidenceSegment(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

function trustedLocalHostProvenancePath(repo, issueNumber, prNumber, headSha, lane) {
  return join(repo, '.git', 'qube', 'aie', 'host-provenance', String(issueNumber), String(prNumber), safeEvidenceSegment(headSha), `${lane}.json`);
}

function writeTestTrustedLocalHostProvenance({ repo, issueNumber, prNumber, headSha, lane, provenance, evidenceSha256 }) {
  const directory = join(repo, '.git', 'qube', 'aie', 'host-provenance', String(issueNumber), String(prNumber), safeEvidenceSegment(headSha));
  mkdirSync(directory, { recursive: true });
  writeFileSync(trustedLocalHostProvenancePath(repo, issueNumber, prNumber, headSha, lane), `${JSON.stringify({
    version: 1,
    issueNumber,
    prNumber,
    headSha,
    lane,
    evidenceSha256,
    runnerKind: 'local-host',
    host: provenance.host,
    freshContext: provenance.freshContext,
    promptOnly: provenance.promptOnly,
    taskId: provenance.taskId,
    sessionId: provenance.sessionId,
    threadId: provenance.threadId,
    promptStackHash: provenance.promptStackHash,
    model: provenance.model ?? null,
    effort: provenance.effort ?? null,
    isolation: provenance.isolation ?? null,
    invocationId: provenance.invocationId ?? null,
    recordedAt: '2026-06-22T00:00:00.000Z',
  }, null, 2)}\n`);
}

function expectedPromptHashForLane(repo, id, issueNumber = 93, prNumber = 12, headSha = 'abc123', options = {}) {
  const evidencePath = join(repo, '.qube', 'aie', 'reviews', String(issueNumber), String(prNumber), headSha, `${id}.json`);
  const publishCommand = options.publishCommand ?? `qube aie pr review publish ${prNumber} --lane ${id} --issue ${issueNumber}`;
  return promptTextHashFromLines(promptStack(id, laneContextLines(id, [issueNumber], prNumber, headSha, [evidencePath], [], repo, publishCommand)).text);
}

async function alignLocalEvidencePromptHashes(repo, config, exec, { issueNumber = 93, prNumber = 12, headSha = 'abc123' } = {}) {
  const result = await runPrGate(config, { prNumber, repoRoot: repo, dryRun: true, exec });
  const directory = join(repo, '.qube', 'aie', 'reviews', String(issueNumber), String(prNumber), headSha);
  for (const lane of result.localReviewRunner.lanes) {
    const path = join(directory, `${lane.lane}.json`);
    if (!existsSync(path)) continue;
    const body = JSON.parse(readFileSync(path, 'utf8'));
    body.runnerProvenance = { ...body.runnerProvenance, promptStackHash: lane.promptStackHash };
    writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
    const provenancePath = trustedLocalHostProvenancePath(repo, issueNumber, prNumber, headSha, lane.lane);
    if (existsSync(provenancePath)) {
      const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'));
      provenance.promptStackHash = lane.promptStackHash;
      provenance.evidenceSha256 = localReviewEvidenceSha256(body);
      writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
    }
  }
}

function localEvidence({ issueNumber = 93, prNumber = 12, headSha = 'abc123', laneStatus = 'passed', summary = 'local review passed', blockers = [], adapter = 'local-host' } = {}) {
  const provenance = {
    runnerKind: adapter,
    host: adapter === 'local-host' ? 'codex' : adapter,
    freshContext: adapter !== 'manual-evidence',
    promptOnly: false,
    taskId: adapter === 'manual-evidence' ? null : 'test-review-task',
    sessionId: null,
    threadId: null,
    promptStackHash: null,
    headSha,
    providerPublishStatus: null,
  };
  const laneProvenance = id => withPromptStackProvenance(provenance, promptStackForLane(id));
  return {
    version: 1,
    issueNumber,
    prNumber,
    headSha,
    profile: 'local-standard',
    adapter,
    reviewer: { id: 'oracle', name: 'oracle', adapterKind: 'local' },
    summary,
    blockers,
    runnerProvenance: withPromptStackProvenance(provenance, [{ id: 'builtin:review-profile:local-standard', source: 'builtin', path: null, sha256: 'test-hash', trust: 'policy' }]),
    promptStack: [{ id: 'builtin:review-profile:local-standard', source: 'builtin', path: null, sha256: 'test-hash', trust: 'policy' }],
    recordedAt: '2026-06-22T00:00:00.000Z',
    lanes: [
      { id: 'task-record-compliance', status: 'passed', severity: 'none', recommendation: 'approve', summary: 'task record reviewed', blockers: [], artifacts: [{ kind: 'json', path: `.qube/aie/reviews/${issueNumber}/${prNumber}/${headSha}/task-record-compliance.json`, sha256: null }], commands: ['qube aie view 93'], surfaces: ['GitHub issue'], promptStack: promptStackForLane('task-record-compliance'), runnerProvenance: laneProvenance('task-record-compliance') },
      { id: 'issue-compliance', status: 'passed', severity: 'none', recommendation: 'approve', summary: 'issue compliance reviewed', blockers: [], artifacts: [{ kind: 'json', path: `.qube/aie/reviews/${issueNumber}/${prNumber}/${headSha}/issue-compliance.json`, sha256: null }], commands: ['qube aie view 93'], surfaces: ['GitHub issue'], promptStack: promptStackForLane('issue-compliance'), runnerProvenance: laneProvenance('issue-compliance') },
      { id: 'code-quality', status: laneStatus, severity: 'none', recommendation: laneStatus === 'passed' ? 'approve' : 'request-changes', summary: 'code quality reviewed', blockers, artifacts: [{ kind: 'json', path: `.qube/aie/reviews/${issueNumber}/${prNumber}/${headSha}/code-quality.json`, sha256: null }], commands: ['pnpm test'], surfaces: [], promptStack: promptStackForLane('code-quality'), runnerProvenance: laneProvenance('code-quality') },
      { id: 'tests-quality', status: 'passed', severity: 'none', recommendation: 'approve', summary: 'tests reviewed', blockers: [], artifacts: [{ kind: 'json', path: `.qube/aie/reviews/${issueNumber}/${prNumber}/${headSha}/tests-quality.json`, sha256: null }], commands: ['pnpm test'], surfaces: ['CLI'], promptStack: promptStackForLane('tests-quality'), runnerProvenance: laneProvenance('tests-quality') },
      { id: 'manual-qa', status: 'passed', severity: 'none', recommendation: 'approve', summary: 'QA reviewed', blockers: [], artifacts: [{ kind: 'json', path: `.qube/aie/reviews/${issueNumber}/${prNumber}/${headSha}/manual-qa.json`, sha256: null }], commands: ['pnpm test'], surfaces: ['CLI'], promptStack: promptStackForLane('manual-qa'), runnerProvenance: laneProvenance('manual-qa') },
      { id: 'final-gate', status: 'passed', severity: 'none', recommendation: 'approve', summary: 'final gate reviewed', blockers: [], artifacts: [{ kind: 'json', path: `.qube/aie/reviews/${issueNumber}/${prNumber}/${headSha}/final-gate.json`, sha256: null }], commands: ['qube aie pr gate 12 --dry-run'], surfaces: ['PR'], promptStack: promptStackForLane('final-gate'), runnerProvenance: laneProvenance('final-gate') },
    ].map(lane => ({
      completeness: `Inspected the ${lane.id} lane scope at this head; nothing was left uninspected.`,
      preconditions: [],
      modelTier: lane.id === 'task-record-compliance' || lane.id === 'docs-instructions' ? 'economy' : 'review',
      ...lane,
    })),
  };
}

function writeLocalEvidence(repo, evidence, options = {}) {
  const issueNumber = evidence.issueNumber;
  const prNumber = evidence.prNumber;
  const headSha = evidence.headSha;
  const directory = join(repo, '.qube', 'aie', 'reviews', String(issueNumber), String(prNumber), headSha);
  mkdirSync(directory, { recursive: true });
  if (typeof evidence === 'string') {
    writeFileSync(join(directory, 'final-gate.json'), evidence);
    return;
  }
  for (const lane of evidence.lanes) {
    const promptStackHash = options.rewritePromptHashes === false
      ? lane.runnerProvenance?.promptStackHash
      : expectedPromptHashForLane(repo, lane.id, issueNumber, prNumber, headSha, options);
    const runnerProvenance = lane.runnerProvenance
      ? { ...lane.runnerProvenance, promptStackHash }
      : lane.runnerProvenance;
    const body = { ...lane, runnerProvenance, version: evidence.version, issueNumber, prNumber, headSha, profile: evidence.profile, adapter: evidence.adapter };
    writeFileSync(join(directory, `${lane.id}.json`), `${JSON.stringify(body, null, 2)}\n`);
    if (evidence.adapter === 'local-host' && options.writeTrustedHostProvenance !== false && runnerProvenance) {
      writeTestTrustedLocalHostProvenance({ repo, issueNumber, prNumber, headSha, lane: lane.id, provenance: runnerProvenance, evidenceSha256: localReviewEvidenceSha256(body) });
    }
  }
}

const STANDARD_LOCAL_REVIEW_LANES = [
  'task-record-compliance',
  'issue-compliance',
  'code-quality',
  'tests-quality',
  'manual-qa',
  'final-gate',
];

function standardReviewLanes(runner = 'manual-evidence', command = null) {
  return STANDARD_LOCAL_REVIEW_LANES.map(id => ({
    id,
    required: 'always',
    match: [],
    severityThreshold: 'high',
    prompt: [],
    tools: [],
    runner,
    command,
  }));
}

function localReviewConfig() {
  const config = getDefaults();
  config.reviewAdapter = 'local';
  config.reviewAgents = [];
  config.localReviewAgents = ['oracle'];
  config.reviewWaitMinutes = 0;
  config.reviewProfile = 'local-standard';
  config.reviewLanes = standardReviewLanes('local-host');
  return config;
}

function approvedLocalPr(overrides = {}) {
  const { comments: overrideComments, ...rest } = overrides;
  const comments = overrideComments ?? [qubeReviewRequestComment(), localReviewComment({ recommendation: 'approve', status: 'passed' })];
  return cleanLocalPr({
    reviewDecision: 'APPROVED',
    comments,
    ...rest,
  });
}

function localCommandConfig(command = 'review-fixture') {
  const config = localReviewConfig();
  config.reviewLanes = standardReviewLanes('local-command', command);
  return config;
}

function localHostConfig(command = 'review-fixture') {
  const config = localReviewConfig();
  config.localReviewAgents = ['codex'];
  config.reviewLanes = standardReviewLanes('local-host', command);
  return config;
}

function readyRouteProbe(host, model) {
  return { host, model, status: 'ready', executable: `${host}-probe`, version: 'probe-test', modelListed: host === 'grok-build' ? true : null, diagnostic: null, resolved: null };
}

function requiredTaskContext() {
  return [
    { kind: 'agents', source: 'AGENTS.md', trust: 'policy', freshness: 'current' },
    { kind: 'issue-body', source: 'https://github.com/example/repo/issues/93', trust: 'untrusted-task-input', freshness: 'current' },
    { kind: 'issue-comment', source: 'https://github.com/example/repo/issues/93#issuecomment-1', trust: 'untrusted-task-input', freshness: 'current' },
    { kind: 'milestone', source: 'https://github.com/example/repo/milestone/1', trust: 'trusted-provider', freshness: 'current' },
    { kind: 'functional-requirement', source: 'docs/spec.md#FR-10-001', trust: 'repo-doc', freshness: 'current' },
    { kind: 'linked-issue', source: 'https://github.com/example/repo/issues/12', trust: 'untrusted-task-input', freshness: 'current' },
    { kind: 'pr-body', source: 'https://github.com/example/repo/pull/12', trust: 'untrusted-task-input', freshness: 'current' },
    { kind: 'pr-comment', source: 'https://github.com/example/repo/pull/12#issuecomment-1', trust: 'untrusted-task-input', freshness: 'current' },
    { kind: 'review-thread', source: 'https://github.com/example/repo/pull/12#discussion_r1', trust: 'untrusted-task-input', freshness: 'current' },
  ];
}

function comprehensiveEvidence({ includeContext = true } = {}) {
  const contextReviewed = includeContext ? requiredTaskContext() : [];
  const provenance = {
    runnerKind: 'local-host',
    host: 'codex',
    freshContext: true,
    promptOnly: false,
    taskId: 'test-review-task',
    sessionId: null,
    threadId: null,
    promptStackHash: null,
    headSha: 'abc123',
    providerPublishStatus: null,
  };
  const laneIds = [
    'task-record-compliance',
    'issue-compliance',
    'code-quality',
    'security',
    'performance',
    'data-database',
    'concurrency-resource',
    'error-observability',
    'tests-quality',
    'api-contract-compatibility',
    'docs-instructions',
    'ui-ux-accessibility',
    'release-ci-supply-chain',
    'manual-qa',
    'final-gate',
  ];
  const profilePromptStack = [{ id: 'builtin:review-profile:local-comprehensive', source: 'builtin', path: null, sha256: 'test-hash', trust: 'policy' }];
  return {
    version: 1,
    issueNumber: 93,
    prNumber: 12,
    headSha: 'abc123',
    profile: 'local-comprehensive',
    adapter: 'local-host',
    reviewer: { id: 'oracle', name: 'oracle', adapterKind: 'local' },
    runnerProvenance: withPromptStackProvenance(provenance, profilePromptStack),
    summary: 'comprehensive local review passed',
    blockers: [],
    contextReviewed,
    promptStack: profilePromptStack,
    recordedAt: '2026-06-22T00:00:00.000Z',
    lanes: laneIds.map(id => ({
      id,
      status: 'passed',
      severity: 'none',
      recommendation: 'approve',
      summary: `${id} reviewed`,
      blockers: [],
      artifacts: [{ kind: 'json', path: `.qube/aie/reviews/93/12/abc123/${id}.json`, sha256: null }],
      commands: ['qube aie pr gate 12 --dry-run'],
      surfaces: ['PR'],
      contextReviewed: id === 'task-record-compliance' ? contextReviewed : [],
      promptStack: promptStackForLane(id),
      toolsUsed: ['rg'],
      completeness: `Inspected the ${id} lane scope at this head; nothing was left uninspected.`,
      preconditions: [],
      runnerProvenance: withPromptStackProvenance(provenance, promptStackForLane(id)),
    })),
  };
}

function cleanLocalPr(overrides = {}) {
  return basePr({
    reviewDecision: 'REVIEW_REQUIRED',
    mergeStateStatus: 'CLEAN',
    mergeable: 'MERGEABLE',
    statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    closingIssuesReferences: [{ number: 93 }],
    ...overrides,
  });
}

function threadResponse(nodes = []) {
  return { data: { repository: { pullRequest: { reviewThreads: { nodes } } } } };
}

function issueCommentsFromPr(pr) {
  return (pr.comments || []).map(comment => ({
    user: comment.author || comment.user || null,
    body: comment.body,
    html_url: comment.url || comment.html_url,
  }));
}

function issueViewKey(number) {
  return `issue view ${number} --json number,title,state,labels,body,milestone,url`;
}

function issuePayload(number, body = '') {
  return {
    number,
    title: `Issue ${number}`,
    body,
    state: 'OPEN',
    labels: [{ name: 'S-InProgress' }],
    milestone: null,
    url: `https://github.com/example/repo/issues/${number}`,
  };
}

function issueViewResponse(args, number, body = '') {
  return args.join(' ') === issueViewKey(number) ? { args, exitCode: 0, stdout: JSON.stringify(issuePayload(number, body)), stderr: '' } : null;
}

function makePrExec(options = {}) {
  const calls = [];
  const events = [];
  const prViews = [...(options.prViews || [basePr()])];
  const reviewComments = options.reviewComments || [];
  const checkRuns = options.checkRuns || [];
  const checkSuites = options.checkSuites || [];
  const workflowRuns = options.workflowRuns || [];
  const workflowRunsById = options.workflowRunsById || {};
  const reviewApiResults = [...(options.reviewApiResults || [])];
  const resolveThreadResults = [...(options.resolveThreadResults || [])];
  const reviewPayloads = [];
  let currentPr = prViews[0];
  let nextCommentId = 900000;
  const threads = [...(options.threads || [])];
  const threadReadResults = [...(options.threadReadResults || [])];
  const observeResolvedThread = (threadId) => {
    if (options.resolveThreadVisible === false) return;
    const index = threads.findIndex(thread => thread.id === threadId);
    if (index === -1) return;
    if (options.resolveThreadPostState === 'missing') threads.splice(index, 1);
    else threads[index] = { ...threads[index], isResolved: true };
  };
  const exec = async (args) => {
    calls.push(args);
    events.push(args.join(' '));
    if (args[0] === 'pr' && args[1] === 'view') {
      const payload = prViews.length > 1 ? prViews.shift() : prViews[0];
      currentPr = payload;
      return { args, exitCode: 0, stdout: JSON.stringify(payload), stderr: '' };
    }
    if (args[0] === 'pr' && args[1] === 'diff') {
      return { args, exitCode: 0, stdout: options.diff ?? 'diff --git a/src/review.ts b/src/review.ts\n--- a/src/review.ts\n+++ b/src/review.ts\n@@ -1,1 +1,3 @@\n export const kept = true;\n+export const changed = true;\n+export const reviewed = true;\n', stderr: '' };
    }
    if (args[0] === 'issue' && args[1] === 'view') {
      const issueNumber = Number(args[2]);
      const body = options.issueBodies?.[issueNumber] ?? '';
      return { args, exitCode: 0, stdout: JSON.stringify(issuePayload(issueNumber, body)), stderr: '' };
    }
    if (args.join(' ') === 'repo view --json nameWithOwner,url') {
      return { args, exitCode: 0, stdout: JSON.stringify({ nameWithOwner: 'example/repo', url: 'https://github.com/example/repo' }), stderr: '' };
    }
    if (args[0] === 'api' && args[1] === 'user') {
      return { args, exitCode: 0, stdout: JSON.stringify({ login: options.currentLogin ?? 'executor' }), stderr: '' };
    }
    if (args[0] === 'api' && args[1] === 'repos/example/repo/pulls/12/comments') {
      return { args, exitCode: 0, stdout: JSON.stringify(reviewComments), stderr: '' };
    }
    if (args[0] === 'api' && args[1] === 'repos/example/repo/issues/12/comments') {
      if (args.includes('--method') && args[args.indexOf('--method') + 1] === 'POST') {
        const inputIndex = args.indexOf('--input');
        const payload = inputIndex >= 0 ? JSON.parse(readFileSync(args[inputIndex + 1], 'utf8')) : {};
        reviewPayloads.push(payload);
        const commentId = ++nextCommentId;
        const url = `https://github.com/example/repo/pull/12#issuecomment-${commentId}`;
        currentPr = {
          ...currentPr,
          comments: [
            ...(currentPr.comments || []),
            { author: { login: options.reviewAuthor ?? 'executor' }, body: payload.body, url, createdAt: new Date().toISOString() },
          ],
        };
        if (prViews.length > 0) prViews[0] = currentPr;
        return { args, exitCode: 0, stdout: JSON.stringify({ id: commentId, html_url: url }), stderr: '' };
      }
      return { args, exitCode: 0, stdout: JSON.stringify(options.issueComments || issueCommentsFromPr(currentPr)), stderr: '' };
    }
    if (args[0] === 'api' && args[1] === 'repos/example/repo/pulls/12/reviews') {
      if (args.includes('--method') && args[args.indexOf('--method') + 1] === 'GET') {
        return { args, exitCode: 0, stdout: JSON.stringify(options.pullReviews || currentPr.reviews || []), stderr: '' };
      }
      const inputIndex = args.indexOf('--input');
      const payloadPath = inputIndex >= 0 ? args[inputIndex + 1] : null;
      const payload = payloadPath ? JSON.parse(readFileSync(payloadPath, 'utf8')) : {};
      reviewPayloads.push(payload);
      const queuedResult = reviewApiResults.shift();
      if (queuedResult) return { args, exitCode: queuedResult.exitCode ?? 1, stdout: queuedResult.stdout ?? '', stderr: queuedResult.stderr ?? '' };
      const state = payload.event === 'APPROVE' ? 'APPROVED' : payload.event === 'REQUEST_CHANGES' ? 'CHANGES_REQUESTED' : 'COMMENTED';
      const url = 'https://github.com/example/repo/pull/12#pullrequestreview-123';
      if (options.reviewVisible !== false) {
        const review = { id: 123, author: { login: options.reviewAuthor ?? 'executor' }, body: payload.body, state, url, commit: { oid: currentPr.headRefOid || 'abc123' } };
        currentPr = {
          ...currentPr,
          reviews: [
            ...(currentPr.reviews || []),
            review,
          ],
          latestReviews: [
            ...(currentPr.latestReviews || []),
            review,
          ],
        };
        if (prViews.length > 0) prViews[0] = currentPr;
      }
      return { args, exitCode: 0, stdout: JSON.stringify({ id: 123, html_url: url }), stderr: '' };
    }
    if (args[0] === 'api' && /^repos\/example\/repo\/pulls\/12\/reviews\/\d+$/.test(args[1]) && args.includes('--method') && args[args.indexOf('--method') + 1] === 'GET') {
      const reviewId = Number(args[1].split('/').at(-1));
      const review = [...(options.pullReviews || []), ...(currentPr.reviews || [])].find(candidate => candidate.id === reviewId);
      return review
        ? { args, exitCode: 0, stdout: JSON.stringify(review), stderr: '' }
        : { args, exitCode: 1, stdout: '', stderr: 'review not visible' };
    }
    if (args[0] === 'api' && /^repos\/example\/repo\/pulls\/12\/reviews\/\d+$/.test(args[1]) && args.includes('--method') && args[args.indexOf('--method') + 1] === 'DELETE') {
      return { args, exitCode: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'api' && /^repos\/example\/repo\/pulls\/12\/reviews\/\d+\/dismissals$/.test(args[1]) && args.includes('--method') && args[args.indexOf('--method') + 1] === 'PUT') {
      const inputIndex = args.indexOf('--input');
      const payload = inputIndex >= 0 ? JSON.parse(readFileSync(args[inputIndex + 1], 'utf8')) : {};
      reviewPayloads.push({ dismiss: args[1], ...payload });
      const reviewId = Number(args[1].split('/')[5]);
      currentPr = {
        ...currentPr,
        reviews: (currentPr.reviews || []).map(review => review.id === reviewId ? { ...review, state: 'DISMISSED' } : review),
        latestReviews: (currentPr.latestReviews || []).map(review => review.id === reviewId ? { ...review, state: 'DISMISSED' } : review),
      };
      if (prViews.length > 0) prViews[0] = currentPr;
      return { args, exitCode: 0, stdout: JSON.stringify({ id: reviewId, state: 'DISMISSED' }), stderr: '' };
    }
    if (args[0] === 'api' && /^repos\/example\/repo\/pulls\/12\/reviews\/\d+$/.test(args[1]) && args.includes('--method') && args[args.indexOf('--method') + 1] === 'PUT') {
      const inputIndex = args.indexOf('--input');
      const payload = inputIndex >= 0 ? JSON.parse(readFileSync(args[inputIndex + 1], 'utf8')) : {};
      reviewPayloads.push({ update: args[1], ...payload });
      const reviewId = Number(args[1].split('/').at(-1));
      currentPr = {
        ...currentPr,
        reviews: (currentPr.reviews || []).map(review => review.id === reviewId ? { ...review, body: payload.body } : review),
        latestReviews: (currentPr.latestReviews || []).map(review => review.id === reviewId ? { ...review, body: payload.body } : review),
      };
      if (prViews.length > 0) prViews[0] = currentPr;
      return { args, exitCode: 0, stdout: JSON.stringify({ id: reviewId, html_url: `https://github.com/example/repo/pull/12#pullrequestreview-${reviewId}` }), stderr: '' };
    }
    if (args[0] === 'api' && /^repos\/example\/repo\/issues\/comments\/\d+$/.test(args[1]) && args.includes('--method') && args[args.indexOf('--method') + 1] === 'PATCH') {
      const inputIndex = args.indexOf('--input');
      const payload = inputIndex >= 0 ? JSON.parse(readFileSync(args[inputIndex + 1], 'utf8')) : {};
      reviewPayloads.push({ update: args[1], ...payload });
      const commentId = args[1].split('/').at(-1);
      currentPr = {
        ...currentPr,
        comments: (currentPr.comments || []).map(comment => {
          const url = comment.url || comment.html_url || '';
          return url.endsWith(`#issuecomment-${commentId}`) ? { ...comment, body: payload.body } : comment;
        }),
      };
      if (prViews.length > 0) prViews[0] = currentPr;
      return { args, exitCode: 0, stdout: JSON.stringify({ id: Number(commentId) }), stderr: '' };
    }
    if (args[0] === 'api' && /^repos\/example\/repo\/issues\/comments\/\d+$/.test(args[1]) && args.includes('--method') && args[args.indexOf('--method') + 1] === 'DELETE') {
      const commentId = args[1].split('/').at(-1);
      currentPr = {
        ...currentPr,
        comments: (currentPr.comments || []).filter(comment => {
          const url = comment.url || comment.html_url || '';
          return !url.endsWith(`#issuecomment-${commentId}`);
        }),
      };
      if (prViews.length > 0) prViews[0] = currentPr;
      return { args, exitCode: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'api' && /^repos\/example\/repo\/commits\/[^/]+\/check-runs$/.test(args[1])) {
      return { args, exitCode: 0, stdout: JSON.stringify({ check_runs: checkRuns }), stderr: '' };
    }
    if (args[0] === 'api' && /^repos\/example\/repo\/commits\/[^/]+\/check-suites$/.test(args[1])) {
      return { args, exitCode: 0, stdout: JSON.stringify({ check_suites: checkSuites }), stderr: '' };
    }
    if (args[0] === 'api' && args[1] === 'repos/example/repo/actions/runs') {
      return { args, exitCode: 0, stdout: JSON.stringify({ workflow_runs: workflowRuns }), stderr: '' };
    }
    if (args[0] === 'api' && /^repos\/example\/repo\/actions\/runs\/\d+$/.test(args[1])) {
      const runId = args[1].split('/').at(-1);
      const run = workflowRunsById[runId];
      return run ? { args, exitCode: 0, stdout: JSON.stringify(run), stderr: '' } : { args, exitCode: 1, stdout: '', stderr: 'workflow run not found' };
    }
    if (args[0] === 'api' && /repos\/example\/repo\/pulls\/12\/comments\/\d+\/replies$/.test(args[1]) && args.includes('POST')) {
      const inputIndex = args.indexOf('--input');
      const payload = inputIndex >= 0 ? JSON.parse(readFileSync(args[inputIndex + 1], 'utf8')) : {};
      reviewPayloads.push({ reply: args[1], ...payload });
      return { args, exitCode: 0, stdout: JSON.stringify({ id: 45, body: payload.body ?? '' }), stderr: '' };
    }
    if (args[0] === 'api' && args[1] === 'graphql') {
      const queryArg = args.find(arg => typeof arg === 'string' && arg.startsWith('query='));
      if (queryArg?.includes('unresolveReviewThread')) {
        const threadIdArg = args.find(arg => typeof arg === 'string' && arg.startsWith('threadId='));
        return { args, exitCode: 0, stdout: JSON.stringify({ data: { unresolveReviewThread: { thread: { id: threadIdArg?.slice('threadId='.length) ?? 'thread-1', isResolved: false } } } }), stderr: '' };
      }
      if (queryArg?.includes('minimizeComment')) {
        return { args, exitCode: 0, stdout: JSON.stringify({ data: { minimizeComment: { minimizedComment: { isMinimized: true } } } }), stderr: '' };
      }
      if (queryArg?.includes('resolveReviewThread')) {
        const threadIdArg = args.find(arg => typeof arg === 'string' && arg.startsWith('threadId='));
        const threadId = threadIdArg?.slice('threadId='.length) ?? 'thread-1';
        const queuedResult = resolveThreadResults.shift();
        if (queuedResult) {
          if ((queuedResult.exitCode ?? 1) === 0) observeResolvedThread(threadId);
          return { args, exitCode: queuedResult.exitCode ?? 1, stdout: queuedResult.stdout ?? '', stderr: queuedResult.stderr ?? '' };
        }
        observeResolvedThread(threadId);
        return { args, exitCode: 0, stdout: JSON.stringify({ data: { resolveReviewThread: { thread: { id: threadId, isResolved: true } } } }), stderr: '' };
      }
      if (queryArg?.includes('nodes(ids: $threadIds)')) {
        const threadIds = args
          .filter(arg => typeof arg === 'string' && arg.startsWith('threadIds[]='))
          .map(arg => arg.slice('threadIds[]='.length));
        const threadReadResult = threadReadResults.shift();
        if (threadReadResult) return { args, exitCode: threadReadResult.exitCode ?? 1, stdout: threadReadResult.stdout ?? '', stderr: threadReadResult.stderr ?? '' };
        return {
          args,
          exitCode: 0,
          stdout: JSON.stringify({ data: { nodes: threadIds.map(threadId => threads.find(thread => thread.id === threadId) ?? null) } }),
          stderr: '',
        };
      }
      if (queryArg?.includes('viewerMergeHeadlineText')) {
        return { args, exitCode: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: options.mergeUiState || {} } } }), stderr: '' };
      }
      const threadReadResult = threadReadResults.shift();
      if (threadReadResult) return { args, exitCode: threadReadResult.exitCode ?? 1, stdout: threadReadResult.stdout ?? '', stderr: threadReadResult.stderr ?? '' };
      return { args, exitCode: 0, stdout: JSON.stringify(threadResponse(threads)), stderr: '' };
    }
    if (args[0] === 'review-fixture') {
      return (options.localCommand ?? fixtureLocalCommand)(args);
    }
    if (args[0] === 'pr' && args[1] === 'edit') {
      return { args, exitCode: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'pr' && args[1] === 'comment') {
      const url = 'https://github.com/example/repo/pull/12#issuecomment-local-review';
      if (options.commentVisible !== false) {
        const body = args[4] ?? '';
        currentPr = {
          ...currentPr,
          comments: [
            ...(currentPr.comments || []),
            { author: { login: options.commentAuthor ?? 'executor' }, body, url },
          ],
        };
        if (prViews.length > 0) prViews[0] = currentPr;
      }
      return { args, exitCode: 0, stdout: url, stderr: '' };
    }
    return { args, exitCode: 1, stdout: '', stderr: `unexpected gh call: ${args.join(' ')}` };
  };
  return { exec, calls, events, reviewPayloads };
}

function fixtureLocalCommand(args) {
  const valueAfter = name => args[args.indexOf(name) + 1];
  const lane = valueAfter('--lane');
  const issueNumber = Number(valueAfter('--issue'));
  const prNumber = Number(valueAfter('--pr'));
  const headSha = valueAfter('--head');
  const runnerKind = valueAfter('--runner-kind') || 'local-command';
  const promptStackHashValue = valueAfter('--prompt-stack-hash');
  const promptStack = promptStackForLane(lane);
  const status = lane === 'code-quality' && args.includes('--fail-code-quality') ? 'failed' : 'passed';
  return {
    args,
    exitCode: 0,
    stdout: JSON.stringify({
      version: 1,
      issueNumber,
      prNumber,
      headSha,
      lane,
      status,
      severity: status === 'failed' ? 'high' : 'none',
      recommendation: status === 'failed' ? 'request-changes' : 'approve',
      summary: status === 'failed' ? 'Fixture local review found code-quality blockers.' : `Fixture local review passed ${lane}.`,
      blockers: status === 'failed' ? ['Fix fixture code-quality finding.'] : [],
      artifacts: [{ kind: 'json', path: `.qube/aie/reviews/${issueNumber}/${prNumber}/${headSha}/${lane}.json`, sha256: null }],
      commands: ['review-fixture'],
      surfaces: ['PR'],
      contextReviewed: [
        { kind: 'issue-body', source: `issue:${issueNumber}`, trust: 'untrusted-task-input', freshness: 'current' },
        { kind: 'pr-body', source: `pr:${prNumber}`, trust: 'untrusted-task-input', freshness: 'current' },
        { kind: 'diff', source: `pr:${prNumber}:diff`, trust: 'untrusted-task-input', freshness: 'current' },
        { kind: 'ci', source: `pr:${prNumber}:checks`, trust: 'trusted-provider', freshness: 'current' },
      ],
      promptStack,
      toolsUsed: runnerKind === 'local-host' ? ['codex', 'local-host'] : ['local-command'],
      completeness: `Inspected the ${lane} lane scope at this head; nothing was left uninspected.`,
      preconditions: [],
      runnerProvenance: {
        runnerKind,
        host: runnerKind === 'local-host' ? 'codex' : 'local-command',
        freshContext: true,
        promptOnly: false,
        taskId: `test-review-task-${lane}`,
        sessionId: null,
        threadId: null,
        promptStackHash: promptStackHashValue,
        headSha,
        providerPublishStatus: null,
      },
    }),
    stderr: '',
  };
}


module.exports = {
  applyRoutedReviewFixture,
  alignLocalEvidencePromptHashes,
  createHash,
  cloneGitRepo,
  execFileSync,
  spawnSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  tmpdir,
  basename,
  join,
  getDefaults,
  renderAgentPrompt,
  laneContextLines,
  readRouteFaults,
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
  prReviewPublishFailureMessage,
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
};
