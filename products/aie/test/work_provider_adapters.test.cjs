const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

describe('work provider adapter boundary', () => {
  it('lists built-in and optional work provider adapter contracts', () => {
    const { listWorkProviderAdapters, workProviderAdapterPackage } = require('../dist/providers/work_provider_adapters.js');
    const adapters = listWorkProviderAdapters();
    const byId = Object.fromEntries(adapters.map(adapter => [adapter.id, adapter]));

    assert.deepEqual(adapters.map(adapter => adapter.id), ['github', 'gitlab', 'linear']);
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
    assert.equal(workProviderAdapterPackage('linear'), '@tjalve/qube-adapter-linear');
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
});
