const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { configToFileShape, getDefaults } = require('../dist/config/index.js');
const { validateConfig } = require('../dist/config/schema.js');
const { computeQueueFromWorkItems } = require('../dist/queue/index.js');
const { linearIssueToWorkItem } = require('../dist/providers/linear/linear_work_codec.js');
const { createLinearWorkProvider } = require('../dist/providers/linear/linear_work_provider.js');

function makeLinearIssue(overrides = {}) {
  return {
    id: 'lin-issue-1',
    identifier: 'ENG-123',
    number: 123,
    title: 'Ship Linear support',
    description: 'Blocked by: ENG-100\n- [x] map issue\n- [ ] wire provider',
    url: 'https://linear.app/acme/issue/ENG-123/ship-linear-support',
    priority: 2,
    archivedAt: null,
    team: { id: 'team-1', key: 'ENG', name: 'Engineering' },
    state: { id: 'state-1', name: 'In Progress', type: 'started' },
    assignee: { id: 'user-1', displayName: 'Ada' },
    labels: { nodes: [{ id: 'label-1', name: 'backend' }] },
    project: { id: 'project-1', name: 'Provider expansion', targetDate: '2026-07-01', status: { name: 'Active', type: 'started' } },
    relations: { nodes: [] },
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

describe('Linear work provider', () => {
  it('maps Linear issues without GitHub-shaped status labels or milestones', () => {
    const item = linearIssueToWorkItem(makeLinearIssue({
      relations: {
        nodes: [
          { type: 'blocks', relatedIssue: { id: 'lin-issue-200', identifier: 'ENG-200' } },
          { type: 'blockedBy', relatedIssue: { id: 'lin-issue-101', identifier: 'ENG-101' } },
        ],
      },
    }));

    assert.equal(item.key.providerId, 'linear');
    assert.equal(item.key.id, 'ENG-123');
    assert.equal(item.displayId, 'ENG-123');
    assert.equal(item.status, 'in-progress');
    assert.equal(item.priority, 'high');
    assert.deepEqual(item.assignees, ['Ada']);
    assert.deepEqual(item.blockers, [{ providerId: 'linear', id: 'ENG-101' }, { providerId: 'linear', id: 'ENG-100' }]);
    assert.deepEqual(item.blockedBy, [{ providerId: 'linear', id: 'ENG-200' }]);
    assert.deepEqual(item.checklist, { total: 2, completed: 1 });
    assert.deepEqual(item.project, { id: 'project-1', title: 'Provider expansion', state: 'open', dueOn: '2026-07-01' });
    assert.equal(item.trustedMetadata.linearIdentifier, 'ENG-123');
    assert.equal(item.trustedMetadata.githubIssueNumber, undefined);
    assert.ok(item.tags.includes('backend'));
    assert.ok(item.tags.includes('linear:state-type:started'));
  });

  it('lists and queues Linear issues through provider-neutral work items', async () => {
    const issues = [
      makeLinearIssue({ identifier: 'ENG-100', state: { id: 'todo', name: 'Todo', type: 'unstarted' }, priority: 1, description: '' }),
      makeLinearIssue({ identifier: 'ENG-123', state: { id: 'todo', name: 'Todo', type: 'unstarted' }, description: 'Blocked by: ENG-100', priority: 3 }),
    ];
    const provider = createLinearWorkProvider({
      teamId: 'team-1',
      client: {
        async listOpenIssues() {
          return issues;
        },
        async getIssue(id) {
          return issues.find(issue => issue.identifier === id || issue.id === id);
        },
      },
    });

    const items = await provider.listOpenWorkItems();
    const queue = computeQueueFromWorkItems(items);

    assert.equal(provider.capabilities().listOpenWork, true);
    assert.equal(provider.capabilities().applyLifecycleMutations, false);
    assert.deepEqual(items.find(item => item.key.id === 'ENG-100').blockedBy, [{ providerId: 'linear', id: 'ENG-123' }]);
    assert.deepEqual(queue.items.map(item => item.issue.displayId), ['ENG-100', 'ENG-123']);
    assert.deepEqual(queue.items.map(item => item.effectiveStatus), ['Ready', 'Blocked']);
  });

  it('reports unsupported lifecycle mutations instead of falling back to GitHub labels', async () => {
    const issue = makeLinearIssue();
    const provider = createLinearWorkProvider({
      teamId: 'team-1',
      client: {
        async listOpenIssues() {
          return [issue];
        },
        async getIssue() {
          return issue;
        },
      },
    });
    const item = await provider.getWorkItem({ providerId: 'linear', id: 'ENG-123' });
    const plan = provider.planStart(item, statusPolicy());
    const result = (await provider.apply(plan))[0];

    assert.equal(plan.actions[0].kind, 'start-work');
    assert.equal(plan.actions[0].details.providerId, 'linear');
    assert.equal(result.status, 'failed');
    assert.match(result.failure.cause, /not implemented/);
    assert.match(result.failure.nextAction, /Linear workflow-state/);
  });

  it('accepts Linear as a configured work provider only for the work surface', () => {
    const raw = configToFileShape(getDefaults());
    raw.providers.work = { kind: 'linear' };
    const result = validateConfig(raw);

    assert.equal(result.ok, true);
    assert.equal(result.config.providers.work.kind, 'linear');
  });
});
