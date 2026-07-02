const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

function jiraItem(id, tags = []) {
  return {
    key: { providerId: 'jira', id },
    displayId: id,
    title: `Jira work ${id}`,
    body: '',
    url: `https://jira.example.com/browse/${id}`,
    state: 'open',
    status: tags.includes('S-InProgress') ? 'in-progress' : 'ready',
    priority: 'none',
    tags,
    assignees: [],
    project: null,
    blockers: [],
    blockedBy: [],
    sequence: null,
    checklist: { total: 0, completed: 0 },
    trustedMetadata: { jiraKey: id },
    source: { providerId: 'jira', resourceKind: 'work-item', resourceId: id, url: `https://jira.example.com/browse/${id}`, metadata: { jiraKey: id } },
  };
}

function emptyPlan(id) {
  return {
    id,
    purpose: id,
    dryRun: true,
    actions: [],
    summary: { plannedCount: 0, completedCount: 0, failedCount: 0, skippedCount: 0 },
  };
}

function jiraProvider(items = [jiraItem('ENG-123')]) {
  return {
    id: 'jira',
    capabilities() {
      return {
        listOpenWork: true,
        loadWork: true,
        planStatusSync: false,
        planLifecycleMutations: false,
        applyLifecycleMutations: false,
        commentMutations: false,
        reviewIntegration: false,
        ciMergeStatus: false,
      };
    },
    async listOpenWorkItems() {
      return items;
    },
    async getWorkItem(key) {
      const item = items.find(candidate => candidate.key.id === key.id);
      if (!item) throw new Error(`unexpected Jira work item read for ${key.id}`);
      return item;
    },
    planStatusSync() {
      return emptyPlan('jira:status-sync');
    },
    planStart() {
      return emptyPlan('jira:start');
    },
    planPause() {
      return emptyPlan('jira:pause');
    },
    planComplete() {
      return emptyPlan('jira:complete');
    },
    async apply() {
      return [];
    },
  };
}

function context(items) {
  const { getDefaults } = require('../dist/config/index.js');
  const { configToExecutorPolicy } = require('../dist/config_policy.js');
  const config = getDefaults();
  config.providers.work = { kind: 'jira' };
  return {
    config,
    policy: configToExecutorPolicy(config),
    provider: jiraProvider(items),
  };
}

describe('lifecycle provider support', () => {
  it('blocks Jira start issue-number selection before GitHub issue-number conversion', async () => {
    const { runStartService } = require('../dist/app/lifecycle_services.js');

    const result = await runStartService({
      selection: { kind: 'issue', issueNumber: 123 },
      dryRun: true,
      assign: true,
      comment: true,
      context: context([jiraItem('ENG-123')]),
    });

    assert.equal(result.ok, false);
    assert.equal(result.action, 'blocked');
    assert.equal(result.selectedItem, null);
    assert.match(result.reason, /providers\.work\.kind=github/);
    assert.match(result.reason, /qube aie start/);
  });

  it('blocks Jira start next with provider-native keys instead of rendering issue numbers', async () => {
    const { runStartService } = require('../dist/app/lifecycle_services.js');

    const result = await runStartService({
      selection: { kind: 'next' },
      dryRun: true,
      assign: true,
      comment: true,
      context: context([jiraItem('ENG-123')]),
    });

    assert.equal(result.ok, false);
    assert.equal(result.action, 'blocked');
    assert.equal(result.selectedItem.displayId, 'ENG-123');
    assert.match(result.reason, /provider-native work item keys/);
    assert.match(result.reason, /qube aie queue --json/);
  });

  it('blocks Jira switch before reading numeric GitHub issue ids', async () => {
    const { runSwitchService } = require('../dist/app/lifecycle_services.js');

    const result = await runSwitchService({
      targetIssueNumber: 123,
      dryRun: true,
      assign: true,
      comment: true,
      context: context([jiraItem('ENG-100', ['S-InProgress']), jiraItem('ENG-123')]),
    });

    assert.equal(result.ok, false);
    assert.equal(result.action, 'blocked');
    assert.equal(result.sourceItem, null);
    assert.equal(result.targetItem, null);
    assert.match(result.reason, /qube aie switch/);
  });

  it('rejects Jira complete and view with explicit provider guidance', async () => {
    const { runCompleteService, runViewService } = require('../dist/app/lifecycle_services.js');

    await assert.rejects(
      () => runCompleteService({ issueNumber: 123, dryRun: true, checkOnly: true, force: false, context: context([jiraItem('ENG-123')]) }),
      /qube aie complete.*providers\.work\.kind=github/s,
    );
    await assert.rejects(
      () => runViewService({ issueNumber: 123, currentBranch: null, context: context([jiraItem('ENG-123')]) }),
      /qube aie view.*providers\.work\.kind=github/s,
    );
  });
});
