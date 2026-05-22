const assert = require('node:assert/strict');
const { existsSync, readdirSync, readFileSync, statSync } = require('node:fs');
const { join, relative } = require('node:path');
const { describe, it } = require('node:test');

const { createAction, createActionPlan } = require('../dist/core/action_plan.js');
const { normalizeGateEvidence, isVerifiedGateEvidence } = require('../dist/core/gate_evidence.js');
const { normalizeExecutorPolicy } = require('../dist/core/policy.js');
const { normalizeProviderSource, sourceKey } = require('../dist/core/provider_source.js');
const { err, ok } = require('../dist/core/result.js');
const { normalizeRepoState } = require('../dist/core/repo_state.js');
const { normalizeReviewFeedback, normalizeReviewItem, normalizeReviewItemKey } = require('../dist/core/review_item.js');
const { maybeWorkItemKeyNumber, normalizeWorkItem, normalizeWorkItemKey, sameWorkItemKey, uniqueWorkItemKeys, workItemNumber } = require('../dist/core/work_item.js');

function coreFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) files.push(...coreFiles(fullPath));
    else if (fullPath.endsWith('.ts')) files.push(fullPath);
  }
  return files;
}

describe('core model boundaries', () => {
  it('keeps source modules provider-neutral and side-effect free', () => {
    const coreDir = join(process.cwd(), 'src', 'core');
    assert.equal(existsSync(coreDir), true);

    const forbidden = [
      { pattern: /from ['"](?:node:)?fs(?:\/promises)?['"]/, label: 'filesystem APIs' },
      { pattern: /from ['"](?:node:)?child_process['"]/, label: 'child process APIs' },
      { pattern: /from ['"]@oclif\/core['"]/, label: 'command parser APIs' },
      { pattern: /from ['"].*(?:^|\/)gh['"]/, label: 'GitHub CLI execution code' },
      { pattern: /from ['"].*(?:^|\/)github['"]/, label: 'GitHub provider code' },
      { pattern: /from ['"].*(?:commands|init_content|managed_file)['"]/, label: 'host or command renderers' },
    ];

    for (const filePath of coreFiles(coreDir)) {
      const source = readFileSync(filePath, 'utf8');
      const name = relative(process.cwd(), filePath);
      for (const { pattern, label } of forbidden) {
        assert.doesNotMatch(source, pattern, `${name} must not import ${label}`);
      }
    }
  });
});

describe('core provider source model', () => {
  it('normalizes stable provider source identity', () => {
    const source = normalizeProviderSource({ providerId: ' github ', resourceKind: 'work-item', resourceId: ' 93 ', url: null });

    assert.equal(source.providerId, 'github');
    assert.equal(source.resourceId, '93');
    assert.equal(sourceKey(source), '["github","work-item","93"]');
  });

  it('rejects empty provider source identifiers', () => {
    assert.throws(() => normalizeProviderSource({ providerId: ' ', resourceKind: 'work-item' }), /providerId was empty or whitespace-only/);
  });

  it('keeps provider source keys collision resistant for null and literal ids', () => {
    const nullSource = normalizeProviderSource({ providerId: 'github', resourceKind: 'work-item', resourceId: null });
    const literalSource = normalizeProviderSource({ providerId: 'github', resourceKind: 'work-item', resourceId: 'unknown' });

    assert.notEqual(sourceKey(nullSource), sourceKey(literalSource));
  });
});

describe('core work and review models', () => {
  const source = normalizeProviderSource({ providerId: 'github', resourceKind: 'work-item', resourceId: '93', url: 'https://example.invalid/93' });
  const workKey = normalizeWorkItemKey('github', '93');

  it('constructs work items with deduped provider-neutral references', () => {
    const blocker = { providerId: ' github ', id: ' 12 ' };
    const work = normalizeWorkItem({
      key: workKey,
      displayId: '#93',
      title: 'Add queue model',
      body: 'Body',
      url: source.url,
      state: 'open',
      status: 'ready',
      priority: 'high',
      tags: ['C-Backend', 'C-Backend'],
      assignees: ['octo', 'octo'],
      project: { id: 'project-1', title: 'Current work', state: 'open', dueOn: null },
      blockers: [blocker, blocker],
      blockedBy: [],
      sequence: 'alpha',
      source,
    });

    assert.equal(work.tags.length, 1);
    assert.equal(work.assignees.length, 1);
    assert.deepEqual(work.blockers, [normalizeWorkItemKey('github', '12')]);
    assert.equal(sameWorkItemKey(work.key, normalizeWorkItemKey('github', '93')), true);
    assert.deepEqual(uniqueWorkItemKeys([work.key, work.key]), [work.key]);
  });

  it('renders issue numbers only from canonical safe work item keys', () => {
    function workWithId(id) {
      return normalizeWorkItem({
        key: normalizeWorkItemKey('github', id),
        displayId: `#${id}`,
        title: 'Render issue number',
        body: 'Body',
        url: null,
        state: 'open',
        status: 'ready',
        priority: 'none',
        project: null,
        blockers: [],
        blockedBy: [],
        sequence: null,
        source,
      });
    }

    assert.equal(workItemNumber(workWithId('93')), 93);
    assert.equal(maybeWorkItemKeyNumber(normalizeWorkItemKey('github', '93')), 93);
    assert.equal(maybeWorkItemKeyNumber(normalizeWorkItemKey('github', '9007199254740993')), null);
    assert.throws(() => workItemNumber(workWithId('093')), /canonical positive base-10 integer/);
    assert.throws(() => workItemNumber(workWithId('9007199254740993')), /safe integer range/);
  });

  it('constructs review items with untrusted feedback by default', () => {
    const reviewSource = normalizeProviderSource({ providerId: 'github', resourceKind: 'review-item', resourceId: '12', url: 'https://example.invalid/pull/12' });
    const review = normalizeReviewItem({
      key: normalizeReviewItemKey('github', '12'),
      displayId: '#12',
      title: 'Review queue model',
      url: reviewSource.url,
      sourceRef: 'issue/93-core-model',
      targetRef: 'main',
      linkedWorkItems: [workKey, workKey],
      state: 'open',
      reviewDecision: 'review-required',
      mergeability: 'unknown',
      feedback: [{ source: 'comment', author: 'reviewer', summary: 'Looks good', url: null, state: null }],
      checks: [{
        key: 'typecheck',
        name: 'typecheck',
        stage: 'pre-pr',
        result: 'passed',
        source: 'configured-gate',
        trust: 'local-evidence',
        command: 'npm run typecheck',
        providerRunId: null,
        path: null,
        summary: 'Passed',
        recordedAt: null,
      }],
      source: reviewSource,
    });

    assert.deepEqual(review.linkedWorkItems, [workKey]);
    assert.equal(review.feedback[0].trust, 'untrusted');
    assert.deepEqual(review.checks[0].metadata, {});
    assert.equal(normalizeReviewFeedback({ source: 'review', author: 'bot', summary: 'Approved', url: null, state: 'APPROVED' }).trust, 'untrusted');
  });

  it('rejects invalid work and review identity invariants', () => {
    assert.throws(() => normalizeWorkItem({
      key: { providerId: ' ', id: '93' },
      displayId: '#93',
      title: 'Add queue model',
      body: 'Body',
      url: source.url,
      state: 'open',
      status: 'ready',
      priority: 'high',
      project: null,
      blockers: [],
      blockedBy: [],
      sequence: null,
      source,
    }), /providerId must be a non-empty string/);

    assert.throws(() => normalizeReviewItem({
      key: { providerId: 'github', id: ' ' },
      displayId: '#12',
      title: 'Review queue model',
      url: null,
      sourceRef: 'issue/93-core-model',
      targetRef: 'main',
      state: 'open',
      reviewDecision: 'review-required',
      mergeability: 'unknown',
      source,
    }), /id must be a non-empty string/);
  });

  it('rejects impossible checklist counts', () => {
    const baseWork = {
      key: workKey,
      displayId: '#93',
      title: 'Add queue model',
      body: 'Body',
      url: source.url,
      state: 'open',
      status: 'ready',
      priority: 'high',
      project: null,
      blockers: [],
      blockedBy: [],
      sequence: null,
      source,
    };

    assert.throws(() => normalizeWorkItem({ ...baseWork, checklist: { total: 1, completed: 2 } }), /checklist.completed must not exceed checklist.total/);
    assert.throws(() => normalizeWorkItem({ ...baseWork, checklist: { total: -1, completed: 0 } }), /checklist.total must not be negative/);
    assert.throws(() => normalizeWorkItem({ ...baseWork, checklist: { total: 1, completed: -1 } }), /checklist.completed must not be negative/);
    assert.throws(() => normalizeWorkItem({ ...baseWork, checklist: { total: Number.NaN, completed: 0 } }), /checklist.total must be a finite integer/);
    assert.throws(() => normalizeWorkItem({ ...baseWork, checklist: { total: 1, completed: 0.5 } }), /checklist.completed must be a finite integer/);
  });

  it('keeps work item key dedupe collision resistant', () => {
    const keys = uniqueWorkItemKeys([
      normalizeWorkItemKey('a:b', 'c'),
      normalizeWorkItemKey('a', 'b:c'),
    ]);

    assert.equal(keys.length, 2);
  });
});

describe('core policy model', () => {
  it('constructs executor policy with milestone ordering and deduped review authors', () => {
    const policy = normalizeExecutorPolicy({
      labels: {
        priorities: [{ name: 'P2-High', description: 'High priority', color: 'ff0000' }],
        statuses: [{ name: 'S-Ready', description: 'Ready for work', color: '00ff00' }],
        components: [{ name: 'C-Backend', description: 'Backend work', color: '0000ff' }],
      },
      milestoneOrdering: { enabled: true, order: ['M7', 'M7'], missingAssignment: 'block' },
      branch: {
        pattern: 'issue/<number>-<slug>',
        baseRemote: 'origin',
        baseBranch: 'main',
        requirePrimaryCheckout: true,
        requireFreshBase: true,
        blockOnOpenReviews: true,
        ignoredReviewAuthors: ['dependabot[bot]', 'dependabot[bot]'],
      },
      lifecycle: { assignOnStart: false, commentOnStart: false, autonomousMode: true },
      shipping: { autonomousMode: false, mergeStrategy: 'squash' },
      reviews: { reviewers: ['oracle', 'oracle'], waitMinutes: 10, requestText: 'Review this change.' },
      gates: {
        definitions: [{
          key: 'typecheck',
          name: 'typecheck',
          stage: 'pre-pr',
          required: true,
          command: 'npm run typecheck',
          externalService: false,
          supplyChainSensitive: true,
        }],
      },
      audit: { manualUiAudit: false, appLaunch: '', target: '' },
      instructions: { opencodeCommandAlias: false, namingRules: false, promptInjectionWarning: true, noCreditWarning: true, implementationGuardrails: true, supplyChainSafety: true },
      migration: { legacyScripts: 'preserve', compatibilityWrappers: false, cleanupKnownHelpers: false },
      supplyChain: {
        exactVersions: true,
        intentionalLockfileChanges: true,
        disableLifecycleScripts: true,
        pinCiActions: true,
        packageAgeDays: 7,
        highRiskPackageAgeDays: 14,
        requireApprovalForUnverifiedRisk: true,
        writePackageManagerDefaults: false,
      },
    });

    assert.deepEqual(policy.milestoneOrdering, { enabled: true, order: ['M7'], missingAssignment: 'block' });
    assert.deepEqual(policy.branch.ignoredReviewAuthors, ['dependabot[bot]']);
    assert.deepEqual(policy.reviews.reviewers, ['oracle']);
    assert.equal(policy.lifecycle.autonomousMode, false);
  });

  it('rejects invalid policy numeric ranges', () => {
    const policy = {
      labels: { priorities: [], statuses: [], components: [] },
      milestoneOrdering: { enabled: false, order: [], missingAssignment: 'warn' },
      branch: {
        pattern: 'issue/<number>-<slug>',
        baseRemote: 'origin',
        baseBranch: 'main',
        requirePrimaryCheckout: true,
        requireFreshBase: true,
        blockOnOpenReviews: true,
        ignoredReviewAuthors: [],
      },
      lifecycle: { assignOnStart: false, commentOnStart: false, autonomousMode: true },
      shipping: { autonomousMode: true, mergeStrategy: 'squash' },
      reviews: { reviewers: [], waitMinutes: -1, requestText: '' },
      gates: { definitions: [] },
      audit: { manualUiAudit: false, appLaunch: '', target: '' },
      instructions: { opencodeCommandAlias: false, namingRules: false, promptInjectionWarning: true, noCreditWarning: true, implementationGuardrails: true, supplyChainSafety: true },
      migration: { legacyScripts: 'preserve', compatibilityWrappers: false, cleanupKnownHelpers: false },
      supplyChain: {
        exactVersions: true,
        intentionalLockfileChanges: true,
        disableLifecycleScripts: true,
        pinCiActions: true,
        packageAgeDays: 7,
        highRiskPackageAgeDays: 14,
        requireApprovalForUnverifiedRisk: true,
        writePackageManagerDefaults: false,
      },
    };

    assert.throws(() => normalizeExecutorPolicy(policy), /reviews.waitMinutes must be a finite non-negative number/);
    assert.throws(() => normalizeExecutorPolicy({ ...policy, reviews: { ...policy.reviews, waitMinutes: 0 }, supplyChain: { ...policy.supplyChain, packageAgeDays: Number.POSITIVE_INFINITY } }), /supplyChain.packageAgeDays must be a finite non-negative number/);
    assert.throws(
      () => normalizeExecutorPolicy({ ...policy, reviews: { ...policy.reviews, waitMinutes: 0 }, supplyChain: { ...policy.supplyChain, packageAgeDays: 14, highRiskPackageAgeDays: 7 } }),
      /supplyChain.highRiskPackageAgeDays must be greater than or equal to supplyChain.packageAgeDays/,
    );
  });
});

describe('core repository and evidence models', () => {
  it('normalizes repository state consistency', () => {
    const state = normalizeRepoState({
      root: '/repo',
      remotes: [{ name: 'origin', url: 'https://example.invalid/repo.git' }],
      baseRef: { name: 'main', kind: 'branch', revision: 'abc' },
      activeRef: { name: 'issue/93-core-model', kind: 'branch', revision: 'def' },
      dirty: { dirty: false, paths: ['src/core/work_item.ts', 'src/core/work_item.ts'], error: null },
      worktree: { linked: false, gitDir: null, error: null },
      projectRoots: [{ path: '.', kind: 'package' }],
      packageManagers: [{ kind: 'npm', manifestPath: 'package.json', lockfilePath: 'package-lock.json' }],
      ciSignals: [{ kind: 'github-actions', path: '.github/workflows/test.yml' }],
      generatedPathSignals: [{ path: 'dist', reason: 'build output' }],
      warnings: ['check base', 'check base'],
    });

    assert.equal(state.dirty.dirty, true);
    assert.deepEqual(state.dirty.paths, ['src/core/work_item.ts']);
    assert.deepEqual(state.warnings, ['check base']);
  });

  it('distinguishes reported evidence from verified evidence', () => {
    const reported = normalizeGateEvidence({
      key: 'typecheck',
      name: 'typecheck',
      stage: 'pre-pr',
      result: 'passed',
      source: 'configured-gate',
      trust: 'agent-reported',
      command: 'npm run typecheck',
      providerRunId: null,
      path: null,
      summary: 'Agent reported pass',
      recordedAt: null,
    });
    const verified = { ...reported, trust: 'local-evidence' };
    const { reasonCode, stale: wasStale, metadata, ...reportedInput } = reported;
    const stale = normalizeGateEvidence({ ...reportedInput, result: 'stale' });
    const staleProviderCheck = normalizeGateEvidence({ ...reportedInput, result: 'stale', source: 'provider-check', trust: 'trusted-provider' });

    assert.equal(isVerifiedGateEvidence(reported), false);
    assert.equal(isVerifiedGateEvidence(verified), true);
    assert.equal(reported.reasonCode, 'agent-reported-result');
    assert.equal(stale.reasonCode, 'stale-evidence');
    assert.equal(staleProviderCheck.reasonCode, 'provider-check-stale');
    assert.equal(stale.stale, true);
    assert.equal(isVerifiedGateEvidence({ ...verified, stale: true }), false);
  });
});

describe('core action and result models', () => {
  it('summarizes action plans from normalized actions', () => {
    const planned = createAction({
      id: 'work:93:start',
      kind: 'start-work',
      target: { kind: 'work-item', id: 'github:93' },
      mutation: 'work-provider',
      description: 'Mark work active',
      expectedResult: 'Work item is active',
    });
    const completed = createAction({ ...planned, id: 'branch:create', kind: 'create-branch', target: { kind: 'repository', id: 'local' }, mutation: 'repository-provider', status: 'completed' });
    const plan = createActionPlan({ id: 'start:93', purpose: 'Start work item', dryRun: true, actions: [planned, completed] });

    assert.deepEqual(plan.summary, { plannedCount: 1, completedCount: 1, failedCount: 0, skippedCount: 0 });
  });

  it('represents success and failure results without exceptions', () => {
    assert.deepEqual(ok({ value: 1 }), { ok: true, value: { value: 1 } });
    assert.deepEqual(err({ kind: 'invalid-input', operation: 'normalize work item', message: 'Bad key', nextAction: 'Provide a non-empty key.' }), {
      ok: false,
      error: { kind: 'invalid-input', operation: 'normalize work item', message: 'Bad key', nextAction: 'Provide a non-empty key.', details: {} },
    });
  });
});
