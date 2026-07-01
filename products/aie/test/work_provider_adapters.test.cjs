const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

describe('work provider adapter boundary', () => {
  it('lists built-in and optional work provider adapter contracts', () => {
    const { listWorkProviderAdapters, workProviderAdapterPackage } = require('../dist/providers/work_provider_adapters.js');
    const adapters = listWorkProviderAdapters();
    const byId = Object.fromEntries(adapters.map(adapter => [adapter.id, adapter]));

    assert.deepEqual(adapters.map(adapter => adapter.id), ['github', 'gitlab', 'linear', 'jira']);
    assert.equal(byId.github.installed, true);
    assert.equal(byId.github.capabilities.commentMutations, true);
    assert.equal(byId.github.capabilities.reviewIntegration, true);
    assert.equal(byId.github.capabilities.ciMergeStatus, true);
    assert.equal(byId.gitlab.installed, false);
    assert.equal(byId.gitlab.packageName, '@tjalve/qube-adapter-gitlab');
    assert.equal(byId.gitlab.capabilities.listOpenWork, true);
    assert.equal(byId.gitlab.capabilities.applyLifecycleMutations, false);
    assert.equal(byId.linear.installed, false);
    assert.equal(byId.linear.packageName, '@tjalve/qube-adapter-linear');
    assert.equal(byId.jira.installed, false);
    assert.equal(byId.jira.packageName, '@tjalve/qube-adapter-jira');
    assert.equal(workProviderAdapterPackage('linear'), '@tjalve/qube-adapter-linear');
    assert.equal(workProviderAdapterPackage('jira'), '@tjalve/qube-adapter-jira');
  });

  it('does not silently fall back to GitHub when an optional adapter is missing', async () => {
    const { createWorkProvider } = require('../dist/providers/work_provider_adapters.js');
    const provider = await createWorkProvider('linear');

    assert.equal(provider.id, 'linear');
    assert.deepEqual(provider.capabilities(), {
      listOpenWork: false,
      loadWork: false,
      planStatusSync: false,
      planLifecycleMutations: false,
      applyLifecycleMutations: false,
      commentMutations: false,
      reviewIntegration: false,
      ciMergeStatus: false,
    });
    await assert.rejects(
      () => provider.listOpenWorkItems(),
      /@tjalve\/qube-adapter-linear.*LINEAR_API_KEY.*qube install --work-provider linear/s,
    );
  });

  it('passes Jira workflow schema through the optional adapter boundary', async () => {
    const { createWorkProvider } = require('../dist/providers/work_provider_adapters.js');
    let requestedFields = [];
    const provider = await createWorkProvider('jira', {
      jql: 'project = "ENG"',
      workflowSchema: {
        statusMap: { Queued: 'ready' },
        openStatusNames: ['Queued'],
        priorityMap: { P0: 'critical' },
        sprintField: 'customfield_10020',
      },
      client: {
        async listIssues(input) {
          requestedFields = input.fields;
          return [{
            id: '10001',
            key: 'ENG-1',
            fields: {
              summary: 'Queued Jira work',
              status: { name: 'Queued' },
              priority: { name: 'P0' },
              labels: [],
              components: [],
              project: { key: 'ENG' },
              comment: { comments: [], total: 0 },
              issuelinks: [],
            },
          }];
        },
        async getIssue() {
          throw new Error('not needed');
        },
      },
    });

    const items = await provider.listOpenWorkItems();

    assert.equal(items[0].status, 'ready');
    assert.equal(items[0].priority, 'critical');
    assert.ok(requestedFields.includes('customfield_10020'));
  });
});
