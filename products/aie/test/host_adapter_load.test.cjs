'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { describe, it, afterEach } = require('node:test');
const { REVIEW_MODEL_HOST_IDS } = require('../dist/core/policy.js');
const { MODEL_ROUTING_HOSTS } = require('../dist/core/model_routing.js');
const {
  AGENT_HOST_IDS,
  RETIRED_GROK_HOST_ID,
  getReviewHostAdapter,
  isRegisteredReviewHost,
  listReviewHostIds,
  loadReviewHostAdapterPackage,
  registerReviewHostAdapterForTests,
  resetReviewHostAdaptersForTests,
  retiredGrokHostIdMessage,
} = require('../dist/app/review_host_adapters.js');
const {
  getAgentHostProfile,
  loadHostProfileFromPackage,
  registerAgentHostProfileForTests,
  resetAgentHostProfilesForTests,
} = require('../dist/agent_host_adapters.js');
const { probeModelRoute } = require('../dist/app/model_route_probe.js');
const { createDoubleHostAdapter, createDoubleHostProfile } = require('./support/double-host-adapter.cjs');

describe('host adapter package loading', () => {
  afterEach(() => {
    resetReviewHostAdaptersForTests();
    resetAgentHostProfilesForTests();
  });

  it('does not treat a host as available when adapter package import fails', async () => {
    const missingPackage = '@tjalve/qube-adapter-not-installed-host';
    assert.equal(loadReviewHostAdapterPackage(missingPackage), null);
    assert.equal(await loadHostProfileFromPackage(missingPackage, 'hostProfile'), null);
    assert.equal(isRegisteredReviewHost('not-installed-host'), false);
    assert.ok(!listReviewHostIds().includes('not-installed-host'));
    assert.equal(probeModelRoute('not-installed-host', 'any-model', () => '', () => 'unused').status, 'blocked');
  });

  it('registers a test-double host profile and review runner through the core contract', async () => {
    const adapter = createDoubleHostAdapter('double-host');
    const profile = createDoubleHostProfile('double-host');
    registerReviewHostAdapterForTests(adapter);
    registerAgentHostProfileForTests(profile);

    assert.equal(isRegisteredReviewHost('double-host'), true);
    assert.equal(getReviewHostAdapter('double-host').id, 'double-host');
    const loaded = await getAgentHostProfile('double-host');
    assert.equal(loaded.displayName, 'Double Host');

    const probe = probeModelRoute('double-host', 'double-1', (_executable, args) => {
      if (args[0] === '--version') return 'double-host 1.0.0';
      throw new Error(`unexpected ${args.join(' ')}`);
    }, () => 'double-host');
    assert.equal(probe.status, 'ready');
    assert.equal(probe.modelListed, true);
    assert.equal(probe.executable, 'double-host');
  });

  it('fails if policy, routing, or core still treat grok as a host id', () => {
    assert.equal(RETIRED_GROK_HOST_ID, 'grok');
    assert.match(retiredGrokHostIdMessage(), /grok-build/);
    assert.ok(AGENT_HOST_IDS.includes('grok-build'));
    assert.ok(!AGENT_HOST_IDS.includes('grok'));
    assert.ok(REVIEW_MODEL_HOST_IDS.includes('grok-build'));
    assert.ok(!REVIEW_MODEL_HOST_IDS.includes('grok'));
    assert.ok(MODEL_ROUTING_HOSTS.includes('grok-build'));
    assert.ok(!MODEL_ROUTING_HOSTS.includes('grok'));

    const repoRoot = join(__dirname, '..', '..', '..');
    const policy = readFileSync(join(repoRoot, 'products', 'aie', 'src', 'core', 'policy.ts'), 'utf8');
    const routing = readFileSync(join(repoRoot, 'products', 'aie', 'src', 'core', 'model_routing.ts'), 'utf8');
    const schema = readFileSync(join(repoRoot, 'products', 'aie', 'src', 'config', 'schema.ts'), 'utf8');
    const coreHost = readFileSync(join(repoRoot, 'packages', 'qube-core', 'src', 'agent_host.ts'), 'utf8');
    assert.match(policy, /REVIEW_MODEL_HOST_IDS = \['codex', 'claude-code', 'opencode', 'grok-build', 'cursor'\]/);
    assert.doesNotMatch(policy, /ReviewModelHostId = '[^']*'grok'/);
    assert.match(routing, /MODEL_ROUTING_HOSTS = Object\.freeze\(\['codex', 'claude-code', 'opencode', 'grok-build', 'cursor'\]/);
    assert.match(schema, /retiredGrokHostIdMessage/);
    assert.match(coreHost, /"grok-build"/);
    assert.doesNotMatch(coreHost, /AGENT_HOST_IDS = \["opencode", "codex", "claude-code"\]/);
  });
});
