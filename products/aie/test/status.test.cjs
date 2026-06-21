const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const { buildStatus } = require('../dist/app/status_service.js');
const { getDefaults } = require('../dist/config/index.js');
const { configToExecutorPolicy } = require('../dist/config_policy.js');
const { normalizeReviewItem } = require('../dist/core/review_item.js');
const { normalizeWorkItem } = require('../dist/core/work_item.js');
const { formatStatusHuman } = require('../dist/renderers/status_renderer.js');

function binRun(args, cwd = process.cwd()) {
  return spawnSync(process.execPath, [join(process.cwd(), 'bin/run'), ...args], { cwd, encoding: 'utf8' });
}

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'aie-status-'));
}

function makeConfig(overrides = {}) {
  const config = structuredClone(getDefaults());
  Object.assign(config, overrides);
  return config;
}

function makeWork(number, title, labels, options = {}) {
  return normalizeWorkItem({
    key: { providerId: 'github', id: String(number) },
    displayId: `#${number}`,
    title,
    body: options.body ?? '',
    url: `https://github.com/example/repo/issues/${number}`,
    state: options.state ?? 'open',
    status: labels.includes('S-InProgress') ? 'in-progress' : labels.includes('S-Ready') ? 'ready' : labels.includes('S-Blocked') ? 'blocked' : 'unknown',
    priority: labels.includes('P2-High') ? 'high' : 'none',
    tags: labels,
    assignees: [],
    project: null,
    blockers: (options.blockers ?? []).map(id => ({ providerId: 'github', id: String(id) })),
    blockedBy: [],
    sequence: null,
    checklist: { total: 0, completed: 0 },
    trustedMetadata: { githubIssueNumber: number },
    source: { providerId: 'github', resourceKind: 'work-item', resourceId: String(number), url: `https://github.com/example/repo/issues/${number}`, metadata: { githubIssueNumber: number } },
  });
}

function makeReview(number, options = {}) {
  return normalizeReviewItem({
    key: { providerId: 'github', id: String(number) },
    displayId: `#${number}`,
    title: options.title ?? `PR ${number}`,
    url: `https://github.com/example/repo/pull/${number}`,
    sourceRef: options.sourceRef ?? 'head-sha',
    targetRef: 'main',
    state: options.state ?? 'open',
    reviewDecision: options.reviewDecision ?? 'none',
    mergeability: options.mergeability ?? 'unknown',
    feedback: options.feedback ?? [],
    checks: options.checks ?? [],
    trustedMetadata: { number, headRefOid: 'head-sha', reviewRequests: [], comments: [], latestReviews: [], trustedMarkerAuthor: null },
    source: { providerId: 'github', resourceKind: 'review-item', resourceId: String(number), url: `https://github.com/example/repo/pull/${number}`, metadata: { number } },
  });
}

function makeRepoState(root, overrides = {}) {
  return {
    root,
    remotes: [{ name: 'origin', url: 'https://github.com/example/repo.git' }],
    baseRef: { name: 'main', kind: 'branch', revision: 'base', remoteName: 'origin', remoteRevision: 'base', upToDate: true, error: null },
    activeRef: { name: overrides.branch ?? 'main', kind: 'branch', revision: 'head' },
    dirty: { dirty: false, paths: [], error: null },
    worktree: { linked: false, gitDir: '.git', error: null },
    projectRoots: [{ path: '.', kind: 'package' }],
    packageManagers: [{ kind: 'npm', manifestPath: 'package.json', lockfilePath: 'package-lock.json' }],
    ciSignals: [],
    generatedPathSignals: [],
    warnings: [],
    ...overrides,
  };
}

function makeContext(input = {}) {
  const root = input.root ?? makeRoot();
  const config = input.config ?? makeConfig();
  const policy = configToExecutorPolicy(config);
  const repoState = input.repoState === undefined ? makeRepoState(root, input.repoOverrides) : input.repoState;
  const workItems = input.workItems ?? [];
  const review = input.review ?? { item: null, pr: null, warning: 'Current-branch PR state unavailable: no pull request' };
  return {
    configLoad: input.configLoad ?? { root, path: join(root, '.qube', 'aie', 'config.json'), present: false, ok: true, errors: [], config },
    config,
    policy,
    workProvider: {
      id: 'github',
      capabilities: () => ({ listOpenWork: true, loadWork: true, planStatusSync: true, planLifecycleMutations: true, applyLifecycleMutations: true }),
      listOpenWorkItems: async () => workItems,
    },
    repositoryProvider: {
      id: 'local-git',
      capabilities: () => ({ inspectRepository: true, inspectBranch: true, planBranchActions: true, applyBranchActions: true }),
      inspect: async () => repoState,
      inspectBranch: async item => ({ branchName: `issue/${item.key.id}-${item.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`, currentBranch: repoState?.activeRef?.name ?? null, matches: false, exists: false, validName: true, validationError: null, repoState }),
    },
    reviewProvider: {
      id: 'github',
      capabilities: () => ({ loadReview: true, findCurrentBranchReview: true, planReviewRequests: true, applyReviewRequests: true }),
    },
    readCurrentReview: async () => review,
    now: () => new Date('2026-05-17T00:00:00.000Z'),
  };
}

describe('status service', () => {
  it('reports ready work and recommends starting the next issue', async () => {
    const result = await buildStatus(makeContext({ workItems: [makeWork(76, 'Status command', ['S-Ready', 'P2-High'])] }));

    assert.equal(result.ok, true);
    assert.equal(result.decision.state, 'continue');
    assert.deepEqual(result.decision.reasonCodes, ['start-next-work']);
    assert.equal(result.decision.nextCommand, 'aie start next');
    assert.equal(result.queue.nextWork.number, 76);
    assert.equal(result.providers.work.id, 'github');
    assert.equal(result.providers.repository.id, 'local-git');
  });

  it('reports active work and recommends continuing implementation when no PR is available', async () => {
    const result = await buildStatus(makeContext({ workItems: [makeWork(76, 'Status command', ['S-InProgress'])] }));

    assert.deepEqual(result.decision.reasonCodes, ['continue-active-work']);
    assert.equal(result.queue.activeWork[0].number, 76);
    assert.equal(result.review.state, 'none');
    assert.match(formatStatusHuman(result), /Next: aie branch check 76/);
  });

  it('reports blocked work without selecting it as next work', async () => {
    const blocker = makeWork(75, 'Blocker', ['S-InProgress']);
    const blocked = makeWork(76, 'Blocked status', ['S-Ready'], { blockers: [75] });

    const result = await buildStatus(makeContext({ workItems: [blocked, blocker] }));

    assert.equal(result.queue.blockedWork.some(item => item.number === 76), true);
    assert.deepEqual(result.queue.blockedWork.find(item => item.number === 76).openBlockers, [75]);
    assert.equal(result.queue.activeWork[0].number, 75);
  });

  it('stops for a dirty checkout before continuing active work', async () => {
    const repoState = makeRepoState(makeRoot(), { dirty: { dirty: true, paths: ['src/status.ts'], error: null } });
    const result = await buildStatus(makeContext({ repoState, workItems: [makeWork(76, 'Status command', ['S-InProgress'])] }));

    assert.deepEqual(result.decision.reasonCodes, ['dirty-checkout']);
    assert.equal(result.decision.nextCommand, 'git status');
  });

  it('stops for linked worktrees when policy disables them', async () => {
    const config = makeConfig({ noWorktree: true });
    const repoState = makeRepoState(makeRoot(), { worktree: { linked: true, gitDir: '.git/worktrees/status', error: null } });
    const result = await buildStatus(makeContext({ config, repoState, workItems: [makeWork(76, 'Status command', ['S-InProgress'])] }));

    assert.deepEqual(result.decision.reasonCodes, ['linked-worktree']);
    assert.equal(result.decision.nextCommand, 'aie doctor --json');
  });

  it('waits on an open pull request before starting new work', async () => {
    const result = await buildStatus(makeContext({
      workItems: [makeWork(77, 'Next issue', ['S-Ready'])],
      review: { item: makeReview(90, { state: 'open' }), pr: null, warning: null },
    }));

    assert.deepEqual(result.decision.reasonCodes, ['open-review-before-new-work']);
    assert.equal(result.decision.nextCommand, 'aie pr gate 90 --json');
  });

  it('reports merged review state as ready for issue completion', async () => {
    const result = await buildStatus(makeContext({
      workItems: [makeWork(76, 'Status command', ['S-InProgress'])],
      review: { item: makeReview(90, { state: 'merged', reviewDecision: 'approved', mergeability: 'mergeable' }), pr: null, warning: null },
    }));

    assert.deepEqual(result.decision.reasonCodes, ['active-work-complete']);
    assert.equal(result.decision.nextCommand, 'aie complete 76');
  });

  it('reports configured gate evidence as pending before shipping', async () => {
    const config = makeConfig({ gates: [{ name: 'Unit tests', kind: 'unit', command: 'npm test', stage: 'pre-merge', required: true, timeoutSeconds: 120, workingDirectory: '.', env: {}, externalService: false }] });
    const result = await buildStatus(makeContext({
      config,
      workItems: [makeWork(76, 'Status command', ['S-InProgress'])],
      review: { item: makeReview(90, { state: 'open', reviewDecision: 'approved', mergeability: 'mergeable' }), pr: null, warning: null },
    }));

    assert.deepEqual(result.decision.reasonCodes, ['pending-gates']);
    assert.equal(result.gates.requiredBlocking, 1);
    assert.equal(result.gates.result.summary.notRecorded, 1);
  });

  it('reports missing review-agent evidence as pending review', async () => {
    const result = await buildStatus(makeContext({
      workItems: [makeWork(76, 'Status command', ['S-InProgress'])],
      review: { item: makeReview(90, { state: 'open', reviewDecision: 'approved', mergeability: 'mergeable' }), pr: null, warning: null },
    }));

    assert.deepEqual(result.decision.reasonCodes, ['pending-review']);
    assert.equal(result.reviewGate.evidence.status, 'unknown');
    assert.equal(result.reviewGate.evidence.source, 'not-recorded');
  });

  it('reports approved review and recorded review evidence as ready to ship', async () => {
    const root = makeRoot();
    mkdirSync(join(root, '.qube', 'aie', 'reviews'), { recursive: true });
    writeFileSync(join(root, '.qube', 'aie', 'reviews', '76.json'), JSON.stringify({ status: 'passed', summary: 'Review found no blockers.' }));
    const result = await buildStatus(makeContext({
      root,
      workItems: [makeWork(76, 'Status command', ['S-InProgress'])],
      review: { item: makeReview(90, { state: 'open', reviewDecision: 'approved', mergeability: 'mergeable' }), pr: null, warning: null },
    }));

    assert.deepEqual(result.decision.reasonCodes, ['ready-to-ship']);
    assert.equal(result.decision.nextCommand, 'aie pr gate 90 --json');
  });

  it('distinguishes no-ready-work from queue-empty while stopping cleanly', async () => {
    const empty = await buildStatus(makeContext({ workItems: [] }));
    const blocked = await buildStatus(makeContext({ workItems: [makeWork(76, 'Blocked', ['S-Blocked'], { blockers: [76] })] }));

    assert.deepEqual(empty.decision.reasonCodes, ['no-ready-work']);
    assert.equal(empty.queue.summary.total, 0);
    assert.deepEqual(blocked.decision.reasonCodes, ['no-ready-work']);
    assert.equal(blocked.queue.summary.blocked, 1);
  });

  it('makes invalid config explicit and avoids loading provider state', async () => {
    const root = makeRoot();
    const config = makeConfig();
    const result = await buildStatus(makeContext({
      config,
      configLoad: { root, path: join(root, '.qube', 'aie', 'config.json'), present: true, ok: false, errors: [{ kind: 'invalid', path: 'version', message: 'version must be current' }] },
    }));

    assert.equal(result.ok, false);
    assert.deepEqual(result.decision.reasonCodes, ['config-invalid']);
    assert.equal(result.review.state, 'unavailable');
  });
});

describe('status command metadata', () => {
  it('publishes registry-backed schema metadata', () => {
    const { getCommandMetadata } = require('../dist/command_metadata.js');
    const schema = JSON.parse(binRun(['schema', '--json']).stdout);
    const metadata = getCommandMetadata('status');
    const command = schema.commands.find(command => command.name === 'status');

    assert.ok(metadata.description.includes('trusted continuation state'));
    assert.ok(command.description.includes('trusted continuation state'));
    assert.equal(metadata.mutates, false);
    assert.equal(metadata.supportsJson, true);
    assert.ok(metadata.externalServices.includes('github'));
    assert.ok(metadata.stableErrorKinds.includes('review-state-unavailable'));
  });
});
