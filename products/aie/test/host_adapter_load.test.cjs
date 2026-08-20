'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { getAllAgentHostProfiles } = require('../dist/agent_host_adapters.js');
const { getReviewHostAdapter, listReviewHostIds } = require('../dist/app/review_host_adapters.js');

describe('canonical agent harness registry', () => {
  it('loads every required agent harness profile from the static registry', async () => {
    const { AGENT_HOST_IDS } = await import('@tjalve/qube-core');
    const profiles = await getAllAgentHostProfiles();
    assert.deepEqual(profiles.map((profile) => profile.id), AGENT_HOST_IDS);
    for (const profile of profiles) {
      assert.ok(profile.instructionTarget.path);
      assert.ok(profile.makeItSo.path);
      assert.ok(profile.makeItSo.invocation);
      assert.equal('instructionTargets' in profile, false);
      assert.equal('commandTargets' in profile, false);
    }
  });

  it('registers isolated execution only for harnesses that implement it', async () => {
    const { AGENT_HOST_IDS } = await import('@tjalve/qube-core');
    assert.deepEqual(listReviewHostIds(), ['codex', 'grok-build', 'cursor']);
    for (const host of listReviewHostIds()) assert.equal(getReviewHostAdapter(host).id, host);
    assert.equal(AGENT_HOST_IDS.includes('grok'), false);
  });
});
