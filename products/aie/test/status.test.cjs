const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
require('./support/compile_cache.cjs');
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const { buildStatus } = require('../dist/app/status_service.js');
const { getDefaults } = require('../dist/config/index.js');
const { configToExecutorPolicy } = require('../dist/config_policy.js');
const { normalizeReviewItem } = require('../dist/core/review_item.js');
const { normalizeWorkItem } = require('../dist/core/work_item.js');
const { listOpenPullRequests } = require('../dist/repo/index.js');
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

function makeJiraWork(id, title, status) {
  return normalizeWorkItem({
    key: { providerId: 'jira', id },
    displayId: id,
    title,
    body: '',
    url: `https://jira.example.com/browse/${id}`,
    state: 'open',
    status,
    priority: 'none',
    tags: [],
    assignees: [],
    project: null,
    blockers: [],
    blockedBy: [],
    sequence: null,
    checklist: { total: 0, completed: 0 },
    trustedMetadata: { jiraKey: id },
    source: { providerId: 'jira', resourceKind: 'work-item', resourceId: id, url: `https://jira.example.com/browse/${id}`, metadata: { jiraKey: id } },
  });
}

function makeReview(number, options = {}) {
  const providerId = options.providerId ?? 'github';
  const url = providerId === 'gitlab' ? `https://gitlab.example.com/example/repo/-/merge_requests/${number}` : `https://github.com/example/repo/pull/${number}`;
  return normalizeReviewItem({
    key: { providerId, id: String(number) },
    displayId: `${providerId === 'gitlab' ? '!' : '#'}${number}`,
    title: options.title ?? `PR ${number}`,
    url,
    sourceRef: options.sourceRef ?? 'head-sha',
    targetRef: 'main',
    state: options.state ?? 'open',
    reviewDecision: options.reviewDecision ?? 'none',
    mergeability: options.mergeability ?? 'unknown',
    feedback: options.feedback ?? [],
    checks: options.checks ?? [],
    trustedMetadata: { number, headRefOid: 'head-sha', reviewRequests: [], comments: [], latestReviews: [], trustedMarkerAuthor: null },
    source: { providerId, resourceKind: 'review-item', resourceId: String(number), url, metadata: { number } },
  });
}

function makePullRequest(number, options = {}) {
  return {
    number,
    title: `Pull request ${number}`,
    author: { login: options.login ?? 'maintainer', is_bot: options.isBot ?? false },
    isDraft: options.isDraft ?? false,
    url: `https://github.com/example/repo/pull/${number}`,
    headRefName: options.headRefName ?? 'other-branch',
  };
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
      id: input.workProviderId ?? 'github',
      capabilities: () => input.workProviderCapabilities ?? ({ listOpenWork: true, loadWork: true, planStatusSync: true, planLifecycleMutations: true, applyLifecycleMutations: true, commentMutations: true, reviewIntegration: true, ciMergeStatus: true }),
      listOpenWorkItems: async () => workItems,
    },
    repositoryProvider: {
      id: 'local-git',
      capabilities: () => ({ inspectRepository: true, inspectBranch: true, planBranchActions: true, applyBranchActions: true }),
      inspect: async () => repoState,
      inspectBranch: async item => ({ branchName: `issue/${item.key.id}-${item.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`, currentBranch: repoState?.activeRef?.name ?? null, matches: false, exists: false, validName: true, validationError: null, repoState }),
    },
    reviewProvider: {
      id: config.providers.review.kind,
      capabilities: () => ({ loadReview: true, findCurrentBranchReview: true, planReviewRequests: true, applyReviewRequests: true }),
    },
    readCurrentReview: async () => review,
    readOpenPullRequests: () => listOpenPullRequests(config, {
      exec: async args => {
        assert.deepEqual(args, ['pr', 'list', '--state', 'open', '--json', 'number,title,author,isDraft,url,headRefName', '--limit', '1000']);
        if (input.pullRequestError) throw new Error(input.pullRequestError);
        return { args, exitCode: 0, stdout: JSON.stringify(input.pullRequests ?? []), stderr: '' };
      },
    }),
    now: () => new Date('2026-05-17T00:00:00.000Z'),
  };
}

describe('status service', () => {
  it('reports ready work and recommends starting the next issue', async () => {
    const result = await buildStatus(makeContext({ workItems: [makeWork(76, 'Status command', ['S-Ready', 'P2-High'])] }));

    assert.equal(result.ok, true);
    assert.equal(result.decision.state, 'continue');
    assert.deepEqual(result.decision.reasonCodes, ['start-next-work']);
    assert.deepEqual(result.openPullRequests, []);
    assert.deepEqual(result.blockingPullRequests, []);
    assert.equal(result.decision.nextCommand, 'aie start next');
    assert.equal(result.queue.nextWork.number, 76);
    assert.equal(result.providers.work.id, 'github');
    assert.equal(result.providers.repository.id, 'local-git');
    assert.equal(result.schemaVersion, 1);
    const policy = result.states.find(state => state.kind === 'continuation-policy');
    const queue = result.states.find(state => state.kind === 'work-queue');
    assert.deepEqual(policy.allowedModes, ['continue', 'repair', 'wait', 'stop']);
    assert.equal(queue.readyItems[0].id, '76');
    assert.deepEqual(queue.readyItems[0].nextAction.argv, ['aie', 'start', 'next']);
  });

  it('does not expose ready work to Umpire when Continuous Shipping is off', async () => {
    const config = makeConfig({ autonomousMode: false });
    const result = await buildStatus(makeContext({ config, workItems: [makeWork(76, 'Manual shipping', ['S-Ready'])] }));

    const policy = result.states.find(state => state.kind === 'continuation-policy');
    const queue = result.states.find(state => state.kind === 'work-queue');
    assert.deepEqual(policy.allowedModes, ['stop']);
    assert.deepEqual(queue.readyItems, []);
  });

  it('reports ready Jira work without suggesting unsupported lifecycle start', async () => {
    const result = await buildStatus(makeContext({
      workProviderId: 'jira',
      workProviderCapabilities: { listOpenWork: true, loadWork: true, planStatusSync: false, planLifecycleMutations: false, applyLifecycleMutations: false, commentMutations: false, reviewIntegration: false, ciMergeStatus: false },
      workItems: [makeJiraWork('ENG-123', 'Jira status command', 'ready')],
    }));

    assert.equal(result.ok, true);
    assert.deepEqual(result.decision.reasonCodes, ['read-only-work-provider']);
    assert.equal(result.decision.nextCommand, 'aie queue --json');
    assert.equal(result.queue.nextWork.displayId, 'ENG-123');
    assert.equal(result.queue.nextWork.number, null);
  });

  it('reports active Jira work without GitHub issue-number review gate conversion', async () => {
    const result = await buildStatus(makeContext({
      workProviderId: 'jira',
      workProviderCapabilities: { listOpenWork: true, loadWork: true, planStatusSync: false, planLifecycleMutations: false, applyLifecycleMutations: false, commentMutations: false, reviewIntegration: false, ciMergeStatus: false },
      workItems: [makeJiraWork('ENG-123', 'Jira active work', 'in-progress')],
    }));

    assert.equal(result.ok, true);
    assert.deepEqual(result.decision.reasonCodes, ['read-only-work-provider']);
    assert.equal(result.queue.activeWork[0].displayId, 'ENG-123');
    assert.equal(result.queue.activeWork[0].number, null);
    assert.equal(result.reviewGate, null);
  });

  it('reports active work and recommends continuing implementation when no PR is available', async () => {
    const result = await buildStatus(makeContext({ workItems: [makeWork(76, 'Status command', ['S-InProgress'])] }));

    assert.deepEqual(result.decision.reasonCodes, ['continue-active-work']);
    assert.equal(result.queue.activeWork[0].number, 76);
    assert.equal(result.review.state, 'none');
    assert.match(formatStatusHuman(result), /Next: aie branch check 76/);
    const queue = result.states.find(state => state.kind === 'work-queue');
    assert.equal(queue.activeItems[0].id, '76');
    assert.deepEqual(queue.activeItems[0].nextAction.argv, ['aie', 'branch', 'check', '76']);
  });

  it('recovers current local issue work without shipping when Continuous Shipping is off', async () => {
    const config = makeConfig({ autonomousMode: false });
    const result = await buildStatus(makeContext({ config, workItems: [makeWork(76, 'Manual current issue', ['S-InProgress'])] }));

    const policy = result.states.find(state => state.kind === 'continuation-policy');
    const queue = result.states.find(state => state.kind === 'work-queue');
    assert.deepEqual(policy.allowedModes, ['continue', 'repair', 'wait', 'stop']);
    assert.match(policy.summary, /cannot ship or start Ready work/);
    assert.equal(queue.status, 'pass');
    assert.deepEqual(queue.activeItems[0].nextAction.argv, ['aie', 'branch', 'check', '76']);
    assert.deepEqual(queue.readyItems, []);
  });

  it('reports blocked work without selecting it as next work', async () => {
    const blocker = makeWork(75, 'Blocker', ['S-InProgress']);
    const blocked = makeWork(76, 'Blocked status', ['S-Ready'], { blockers: [75] });

    const result = await buildStatus(makeContext({ workItems: [blocked, blocker] }));

    assert.equal(result.queue.blockedWork.some(item => item.number === 76), true);
    assert.deepEqual(result.queue.blockedWork.find(item => item.number === 76).openBlockers, [75]);
    assert.equal(result.queue.activeWork[0].number, 75);
  });

  it('recovers dirty local work when exactly one issue is active', async () => {
    const repoState = makeRepoState(makeRoot(), { dirty: { dirty: true, paths: ['src/status.ts'], error: null } });
    const result = await buildStatus(makeContext({ repoState, workItems: [makeWork(76, 'Status command', ['S-InProgress'])] }));

    assert.deepEqual(result.decision.reasonCodes, ['continue-dirty-active-work']);
    assert.equal(result.decision.nextCommand, 'git status');
    assert.deepEqual(result.states.find(state => state.kind === 'continuation-policy').allowedModes, ['continue', 'repair', 'wait', 'stop']);
  });

  it('does not expose a shipping action when Continuous Shipping is off', async () => {
    const config = makeConfig({ autonomousMode: false });
    const result = await buildStatus(makeContext({
      config,
      workItems: [makeWork(76, 'Manual current issue', ['S-InProgress'])],
      review: { item: makeReview(90, { state: 'merged', reviewDecision: 'approved', mergeability: 'mergeable' }), pr: null, warning: null },
    }));

    const policy = result.states.find(state => state.kind === 'continuation-policy');
    const queue = result.states.find(state => state.kind === 'work-queue');
    assert.deepEqual(result.decision.reasonCodes, ['active-work-complete']);
    assert.deepEqual(policy.allowedModes, ['stop']);
    assert.equal(queue.activeItems[0].nextAction, undefined);
  });

  it('does not let idle Umpire work bypass a dirty-checkout stop', async () => {
    const repoState = makeRepoState(makeRoot(), { dirty: { dirty: true, paths: ['src/status.ts'], error: null } });
    const result = await buildStatus(makeContext({ repoState, workItems: [] }));

    const policy = result.states.find(state => state.kind === 'continuation-policy');
    const queue = result.states.find(state => state.kind === 'work-queue');
    assert.deepEqual(policy.allowedModes, ['stop']);
    assert.equal(queue.status, 'unknown');
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
      pullRequests: [makePullRequest(90)],
    }));

    assert.deepEqual(result.decision.reasonCodes, ['open-review-before-new-work']);
    assert.equal(result.decision.nextCommand, 'aie pr gate 90 --json');
    const review = result.states.find(state => state.kind === 'review');
    assert.equal(review.reviewStatus, 'active');
    assert.deepEqual(review.nextAction.argv, ['aie', 'pr', 'gate', '90', '--json']);
  });

  it('allows new work while the current pull request is a draft', async () => {
    const result = await buildStatus(makeContext({
      workItems: [makeWork(77, 'Next issue', ['S-Ready'])],
      review: { item: makeReview(90, { state: 'draft' }), pr: null, warning: null },
      pullRequests: [makePullRequest(90, { isDraft: true })],
    }));

    assert.deepEqual(result.decision.reasonCodes, ['start-next-work']);
    assert.equal(result.openPullRequests.length, 1);
    assert.deepEqual(result.blockingPullRequests, []);
    assert.equal(result.states.some(state => state.kind === 'review'), false);
    assert.deepEqual(result.states.find(state => state.kind === 'work-queue').readyItems[0].nextAction.argv, ['aie', 'start', 'next']);
  });

  for (const configuredLogin of ['dependabot', 'dependabot[bot]', 'app/dependabot']) {
    for (const login of ['dependabot', 'dependabot[bot]', 'app/dependabot']) {
      it(`allows new work for ${login} when ${configuredLogin} is ignored`, async () => {
        const result = await buildStatus(makeContext({
          config: makeConfig({ ignoredAutomationAuthors: [configuredLogin] }),
          workItems: [makeWork(77, 'Next issue', ['S-Ready'])],
          review: { item: makeReview(90), pr: null, warning: null },
          pullRequests: [makePullRequest(90, { login, isBot: true })],
        }));

        assert.deepEqual(result.decision.reasonCodes, ['start-next-work']);
        assert.deepEqual(result.blockingPullRequests, []);
        assert.equal(result.states.some(state => state.kind === 'review'), false);
      });
    }
  }

  it('reports ready human pull requests on other branches as blockers', async () => {
    const result = await buildStatus(makeContext({
      workItems: [makeWork(77, 'Next issue', ['S-Ready'])],
      review: { item: makeReview(90, { state: 'draft' }), pr: null, warning: null },
      pullRequests: [
        makePullRequest(90, { isDraft: true }),
        makePullRequest(91, { login: 'app/dependabot', isBot: true }),
        makePullRequest(92),
        makePullRequest(93),
      ],
    }));

    assert.deepEqual(result.decision.reasonCodes, ['open-review-before-new-work']);
    assert.deepEqual(result.blockingPullRequests.map(pr => pr.number), [92, 93]);
    assert.equal(result.decision.nextCommand, 'aie pr gate 92 --json');
    assert.match(formatStatusHuman(result), /Open pull requests block new issue work: #92, #93\./);
    assert.equal(result.states.some(state => state.kind === 'review'), false);
  });

  it('allows new work with ready pull requests when blocking is disabled', async () => {
    const result = await buildStatus(makeContext({
      config: makeConfig({ blockOnOpenPRs: false }),
      workItems: [makeWork(77, 'Next issue', ['S-Ready'])],
      review: { item: makeReview(90), pr: null, warning: null },
      pullRequests: [makePullRequest(90)],
    }));

    assert.deepEqual(result.decision.reasonCodes, ['start-next-work']);
    assert.deepEqual(result.blockingPullRequests.map(pr => pr.number), [90]);
    assert.equal(result.states.some(state => state.kind === 'review'), false);
  });

  it('keeps a draft review actionable for active work', async () => {
    const result = await buildStatus(makeContext({
      workItems: [makeWork(77, 'Active work', ['S-InProgress'])],
      review: { item: makeReview(90, { state: 'draft' }), pr: null, warning: null },
      pullRequests: [makePullRequest(90, { isDraft: true })],
    }));

    assert.deepEqual(result.decision.reasonCodes, ['pending-review']);
    assert.equal(result.states.find(state => state.kind === 'review').targetId, '90');
  });

  it('does not query GitHub pull requests for another review provider', async () => {
    const config = makeConfig();
    config.providers.review.kind = 'gitlab';
    const context = makeContext({ config, workItems: [makeWork(77, 'Next issue', ['S-Ready'])] });
    context.readOpenPullRequests = async () => assert.fail('GitHub pull requests must not be queried');

    const result = await buildStatus(context);

    assert.deepEqual(result.decision.reasonCodes, ['start-next-work']);
    assert.equal(result.pullRequestError, null);
    assert.equal(result.openPullRequests, null);
    assert.equal(result.blockingPullRequests, null);
  });

  for (const state of ['open', 'draft']) {
    it(`${state === 'open' ? 'waits on an open' : 'allows new work with a draft'} current GitLab merge request`, async () => {
      const config = makeConfig({ blockOnOpenPRs: true });
      config.providers.review.kind = 'gitlab';
      const context = makeContext({
        config,
        workItems: [makeWork(77, 'Next issue', ['S-Ready'])],
        review: { item: makeReview(90, { providerId: 'gitlab', state }), pr: null, warning: null },
      });
      context.readOpenPullRequests = async () => assert.fail('GitHub pull requests must not be queried');

      const result = await buildStatus(context);

      assert.equal(result.providers.work.id, 'github');
      assert.equal(result.providers.review.id, 'gitlab');
      assert.equal(result.openPullRequests, null);
      assert.equal(result.blockingPullRequests, null);
      assert.equal(result.pullRequestError, null);
      assert.equal(result.decision.state, state === 'open' ? 'wait' : 'continue');
      assert.deepEqual(result.decision.reasonCodes, [state === 'open' ? 'open-review-before-new-work' : 'start-next-work']);
      assert.equal(result.decision.nextCommand, state === 'open' ? 'aie pr gate 90 --json' : 'aie start next');
      const review = result.states.find(entry => entry.kind === 'review');
      if (state === 'open') {
        assert.equal(review.targetId, '90');
        assert.deepEqual(review.nextAction.argv, ['aie', 'pr', 'gate', '90', '--json']);
      } else {
        assert.equal(review, undefined);
      }
    });
  }

  it('reports unknown when GitLab current review state is unavailable', async () => {
    const config = makeConfig({ blockOnOpenPRs: true });
    config.providers.review.kind = 'gitlab';
    const context = makeContext({ config, workItems: [makeWork(77, 'Next issue', ['S-Ready'])] });
    context.readCurrentReview = async () => { throw new Error('Merge request state unavailable'); };
    context.readOpenPullRequests = async () => assert.fail('GitHub pull requests must not be queried');

    const result = await buildStatus(context);

    assert.equal(result.review.state, 'unavailable');
    assert.equal(result.openPullRequests, null);
    assert.equal(result.blockingPullRequests, null);
    assert.equal(result.decision.state, 'unknown');
    assert.deepEqual(result.decision.reasonCodes, ['review-state-unavailable']);
    assert.equal(result.decision.nextCommand, 'aie doctor --json');
    assert.deepEqual(result.states.find(state => state.kind === 'continuation-policy').allowedModes, ['stop']);
  });

  it('reports an unknown state when the required pull request check fails', async () => {
    const result = await buildStatus(makeContext({
      workItems: [makeWork(77, 'Next issue', ['S-Ready'])],
      pullRequestError: 'Pull request state unavailable',
    }));

    assert.equal(result.decision.state, 'unknown');
    assert.deepEqual(result.decision.reasonCodes, ['review-state-unavailable']);
    assert.equal(result.pullRequestError, 'Pull request state unavailable');
    assert.equal(result.openPullRequests, null);
    assert.equal(result.blockingPullRequests, null);
    assert.deepEqual(result.states.find(state => state.kind === 'continuation-policy').allowedModes, ['stop']);
  });

  for (const state of ['open', 'draft']) {
    it(`reports unknown when pull request enumeration fails with an observed ${state} current review`, async () => {
      const context = makeContext({
        workItems: [makeWork(77, 'Next issue', ['S-Ready'])],
        review: { item: makeReview(90, { state }), pr: null, warning: null },
      });
      context.readOpenPullRequests = async () => { throw new Error(); };

      const result = await buildStatus(context);

      assert.equal(result.decision.state, 'unknown');
      assert.deepEqual(result.decision.reasonCodes, ['review-state-unavailable']);
      assert.equal(result.openPullRequests, null);
      assert.equal(result.blockingPullRequests, null);
      assert.equal(result.pullRequestError, '');
    });
  }

  it('allows new work when a disabled pull request check fails', async () => {
    const result = await buildStatus(makeContext({
      config: makeConfig({ blockOnOpenPRs: false }),
      workItems: [makeWork(77, 'Next issue', ['S-Ready'])],
      pullRequestError: 'Pull request state unavailable',
    }));

    assert.deepEqual(result.decision.reasonCodes, ['start-next-work']);
    assert.equal(result.pullRequestError, 'Pull request state unavailable');
  });

  it('reports merged review state as ready for issue completion', async () => {
    const result = await buildStatus(makeContext({
      workItems: [makeWork(76, 'Status command', ['S-InProgress'])],
      review: { item: makeReview(90, { state: 'merged', reviewDecision: 'approved', mergeability: 'mergeable' }), pr: null, warning: null },
    }));

    assert.deepEqual(result.decision.reasonCodes, ['active-work-complete']);
    assert.equal(result.decision.nextCommand, 'aie complete 76');
  });

  it('exposes the current review recovery command to Umpire', async () => {
    const result = await buildStatus(makeContext({
      workItems: [makeWork(76, 'Review recovery', ['S-InProgress'])],
      review: { item: makeReview(90, { state: 'open', reviewDecision: 'changes-requested' }), pr: null, warning: null },
    }));

    const review = result.states.find(state => state.kind === 'review');
    assert.deepEqual(result.decision.reasonCodes, ['review-changes-requested']);
    assert.equal(review.reviewStatus, 'changes-requested');
    assert.deepEqual(review.nextAction.argv, ['aie', 'pr', 'gate', '90', '--json']);
  });

  it('reports a blocked review as blocked even when provider approval exists', async () => {
    const result = await buildStatus(makeContext({
      workItems: [makeWork(76, 'Blocked review recovery', ['S-InProgress'])],
      review: { item: makeReview(90, { state: 'open', reviewDecision: 'approved', mergeability: 'blocked' }), pr: null, warning: null },
    }));

    const review = result.states.find(state => state.kind === 'review');
    assert.equal(review.reviewStatus, 'blocked');
    assert.equal(review.status, 'fail');
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
    assert.deepEqual(empty.states.find(state => state.kind === 'continuation-policy').allowedModes, ['continue', 'repair', 'wait', 'stop']);
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
