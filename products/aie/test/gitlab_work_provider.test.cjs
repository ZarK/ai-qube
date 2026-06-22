const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { configToFileShape, getDefaults } = require('../dist/config/index.js');
const { validateConfig } = require('../dist/config/schema.js');
const { computeQueueFromWorkItems } = require('../dist/queue/index.js');
const { gitLabIssueToWorkItem } = require('../dist/providers/gitlab/gitlab_work_codec.js');
const { createGitLabWorkProvider } = require('../dist/providers/gitlab/gitlab_work_provider.js');

function makeGitLabIssue(overrides = {}) {
  return {
    id: 1001,
    iid: 42,
    project_id: 7,
    title: 'Ship GitLab support',
    description: 'Blocked by: #8\nSequence: 20\n- [x] map issue\n- [ ] wire provider',
    state: 'opened',
    labels: ['S-InProgress', 'P2-High', 'backend'],
    assignees: [{ id: 1, name: 'Ada', username: 'ada' }],
    milestone: { id: 3, iid: 1, title: 'Provider expansion', state: 'active', due_date: '2026-08-01' },
    web_url: 'https://gitlab.example.com/acme/qube/-/issues/42',
    references: { short: '#42', relative: '#42', full: 'acme/qube#42' },
    task_completion_status: { count: 2, completed_count: 1 },
    issue_type: 'issue',
    weight: 3,
    links: [],
    ...overrides,
  };
}

function statusPolicy() {
  const config = getDefaults();
  return {
    labels: {
      priorities: config.priorityLabels.map(name => ({ name, description: '', color: '' })),
      statuses: config.statusLabels.map(name => ({ name, description: '', color: '' })),
      components: config.componentLabels.map(name => ({ name, description: '', color: '' })),
    },
    milestoneOrdering: config.milestoneOrdering,
    branch: {
      pattern: config.branchNaming,
      baseRemote: config.baseRemote,
      baseBranch: config.baseBranch,
      requirePrimaryCheckout: config.noWorktree,
      requireFreshBase: config.requireBaseBranchFreshness,
      blockOnOpenReviews: config.blockOnOpenPRs,
      ignoredReviewAuthors: config.ignoredAutomationAuthors,
    },
    lifecycle: { assignOnStart: config.assignOnStart, commentOnStart: config.commentOnStart, autonomousMode: config.autonomousMode },
    shipping: { autonomousMode: config.autonomousMode, mergeStrategy: config.normalizedPolicy.shipping.mergeStrategy },
    reviews: { reviewers: config.reviewAgents, waitMinutes: config.reviewWaitMinutes, requestText: config.reviewRequestText },
    gates: { definitions: [] },
    audit: { manualUiAudit: config.manualUiAudit, appLaunch: config.uiAuditAppLaunch, target: config.uiAuditTarget },
    instructions: { ...config.instructions, opencodeCommandAlias: config.opencodeCommandAlias },
    migration: { ...config.migration },
    supplyChain: config.supplyChain,
  };
}

describe('GitLab work provider', () => {
  it('maps GitLab issues without inventing GitHub issue semantics', () => {
    const item = gitLabIssueToWorkItem(makeGitLabIssue({
      links: [
        {
          link_type: 'is_blocked_by',
          source_issue: { iid: 42, project_id: 7 },
          target_issue: { iid: 7, project_id: 7 },
        },
        {
          link_type: 'blocks',
          source_issue: { iid: 42, project_id: 7 },
          target_issue: { iid: 99, project_id: 7 },
        },
      ],
    }));

    assert.equal(item.key.providerId, 'gitlab');
    assert.equal(item.key.id, '42');
    assert.equal(item.displayId, '#42');
    assert.equal(item.status, 'in-progress');
    assert.equal(item.priority, 'high');
    assert.deepEqual(item.assignees, ['Ada']);
    assert.deepEqual(item.blockers, [{ providerId: 'gitlab', id: '7' }, { providerId: 'gitlab', id: '8' }]);
    assert.deepEqual(item.blockedBy, [{ providerId: 'gitlab', id: '99' }]);
    assert.deepEqual(item.checklist, { total: 2, completed: 1 });
    assert.deepEqual(item.project, { id: '3', title: 'Provider expansion', state: 'open', dueOn: '2026-08-01' });
    assert.equal(item.sequence, '20');
    assert.equal(item.trustedMetadata.gitlabIssueIid, 42);
    assert.equal(item.trustedMetadata.githubIssueNumber, undefined);
    assert.ok(item.tags.includes('backend'));
    assert.ok(item.tags.includes('gitlab:state:opened'));
  });

  it('lists and queues GitLab issues through provider-neutral work items', async () => {
    const issues = [
      makeGitLabIssue({ iid: 8, id: 1008, labels: ['S-Ready', 'P3-Medium'], description: '', references: { short: '#8', relative: '#8', full: 'acme/qube#8' }, task_completion_status: { count: 0, completed_count: 0 } }),
      makeGitLabIssue({ iid: 42, id: 1042, labels: ['S-Ready', 'P3-Medium'], description: 'Blocked by: #8', task_completion_status: { count: 0, completed_count: 0 } }),
    ];
    const provider = createGitLabWorkProvider({
      projectId: 'acme/qube',
      client: {
        async listOpenIssues() {
          return issues;
        },
        async getIssue({ iid }) {
          const issue = issues.find(issue => String(issue.iid) === iid || `#${issue.iid}` === iid);
          if (!issue) throw new Error(`missing fixture issue ${iid}`);
          return issue;
        },
      },
    });

    const items = await provider.listOpenWorkItems();
    const queue = computeQueueFromWorkItems(items);
    const blockedItem = queue.items.find(item => item.issue.displayId === '#42');

    assert.equal(provider.capabilities().listOpenWork, true);
    assert.equal(provider.capabilities().applyLifecycleMutations, false);
    assert.deepEqual(items.find(item => item.key.id === '8').blockedBy, [{ providerId: 'gitlab', id: '42' }]);
    assert.deepEqual(queue.items.map(item => item.issue.displayId), ['#8', '#42']);
    assert.deepEqual(queue.items.map(item => item.effectiveStatus), ['Ready', 'Blocked']);
    assert.deepEqual(blockedItem.openBlockers, [8]);
    assert.deepEqual(blockedItem.issue.declaredBlockers, [8]);
  });

  it('reports unsupported lifecycle mutations instead of falling back to GitHub labels', async () => {
    const issue = makeGitLabIssue();
    const provider = createGitLabWorkProvider({
      projectId: 'acme/qube',
      client: {
        async listOpenIssues() {
          return [issue];
        },
        async getIssue() {
          return issue;
        },
      },
    });
    const item = await provider.getWorkItem({ providerId: 'gitlab', id: '42' });
    const plan = provider.planStart(item, statusPolicy());
    const result = (await provider.apply(plan))[0];

    assert.equal(plan.actions[0].kind, 'start-work');
    assert.equal(plan.actions[0].details.providerId, 'gitlab');
    assert.equal(result.status, 'failed');
    assert.match(result.failure.cause, /unsupported/);
    assert.match(result.failure.nextAction, /GitLab issue state/);
  });

  it('handles unknown GitLab status labels and rejects non-GitLab work item keys', async () => {
    const item = gitLabIssueToWorkItem(makeGitLabIssue({ labels: [], state: 'opened', description: 'No blockers here.', task_completion_status: null }));
    const provider = createGitLabWorkProvider({
      projectId: 'acme/qube',
      client: {
        async listOpenIssues() {
          return [];
        },
        async getIssue() {
          return makeGitLabIssue();
        },
      },
    });

    assert.equal(item.status, 'ready');
    assert.equal(item.priority, 'none');
    assert.deepEqual(item.blockers, []);
    await assert.rejects(
      () => provider.getWorkItem({ providerId: 'github', id: '42' }),
      /providerId github is unsupported/,
    );
  });

  it('times out stalled GitLab API requests with a diagnostic error', async () => {
    const originalFetch = globalThis.fetch;
    let capturedSignal = null;
    try {
      globalThis.fetch = async (_url, options) => {
        capturedSignal = options.signal;
        throw new DOMException('The operation timed out.', 'TimeoutError');
      };
      const provider = createGitLabWorkProvider({
        token: 'gitlab-token',
        projectId: 'acme/qube',
        requestTimeoutMs: 25,
      });

      await assert.rejects(
        () => provider.listOpenWorkItems(),
        /GitLab API request timed out after 25ms\. Service may be stalling or unreachable\. Verify GITLAB_TOKEN, GITLAB_BASE_URL, and GITLAB_PROJECT_ID, then retry\./,
      );
      assert.ok(capturedSignal instanceof AbortSignal);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('accepts GitLab as a configured work provider only for the work surface', () => {
    const raw = configToFileShape(getDefaults());
    raw.providers.work = { kind: 'gitlab' };
    const result = validateConfig(raw);

    assert.equal(result.ok, true);
    assert.equal(result.config.providers.work.kind, 'gitlab');
  });
});
