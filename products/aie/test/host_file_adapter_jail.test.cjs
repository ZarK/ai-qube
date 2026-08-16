'use strict';

const assert = require('node:assert/strict');
const { afterEach, describe, it } = require('node:test');
const { buildInitPlan } = require('../dist/init/index.js');
const {
  omitHostProfilePackagesForTests,
  resetAgentHostProfilesForTests,
} = require('../dist/agent_hosts.js');
const { cloneGitRepo } = require('./support/git_fixture.cjs');

describe('host file adapter jail', () => {
  afterEach(() => {
    resetAgentHostProfilesForTests();
  });

  it('does not mention or write Grok Build files for --tool all when the adapter is missing', async () => {
    omitHostProfilePackagesForTests(['@tjalve/qube-adapter-grok-build']);
    const repo = cloneGitRepo('committed', 'aie-host-files-');
    const result = await buildInitPlan({
      target: '.',
      tool: 'all',
      dryRun: true,
      force: false,
      cwd: repo,
    });
    assert.equal(result.ok, true);
    assert.ok(!result.selectedTools.includes('grok-build'));
    assert.ok(!result.actions.some((action) => String(action.path || '').replaceAll('\\', '/').includes('.grok/')));
  });

  it('fails closed for explicit --tool grok-build when the adapter is missing', async () => {
    omitHostProfilePackagesForTests(['@tjalve/qube-adapter-grok-build']);
    const repo = cloneGitRepo('committed', 'aie-host-files-explicit-');
    const result = await buildInitPlan({
      target: '.',
      tool: 'grok-build',
      dryRun: true,
      force: false,
      cwd: repo,
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => /@tjalve\/qube-adapter-grok-build/.test(error)));
  });
});
