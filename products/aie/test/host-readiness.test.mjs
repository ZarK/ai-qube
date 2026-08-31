import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AGENT_HOST_CAPABILITY_PROFILES } from '@tjalve/qube-core';
import { observeAgentHostReadiness } from '../dist/index.js';

describe('agent host readiness observation', () => {
  it('keeps a PATH candidate unknown until identity and authentication are proved', () => {
    const report = observeAgentHostReadiness(
      AGENT_HOST_CAPABILITY_PROFILES.opencode,
      '2026-08-31T12:00:00.000Z',
      (command) => ({ command, status: 'found', resolvedPath: 'C:\\Users\\person\\secret\\opencode.exe', reasonCode: 'found' }),
    );
    assert.equal(report.version, 1);
    assert.equal(report.facts.adapter.state, 'ready');
    assert.equal(report.facts.executable.state, 'unknown');
    assert.equal(report.facts.version.state, 'unknown');
    assert.equal(report.facts.authentication.state, 'unknown');
    assert.equal(JSON.stringify(report).includes('C:\\Users\\person\\secret'), false);
  });

  it('reports a missing CLI separately from the registered adapter', () => {
    const report = observeAgentHostReadiness(
      AGENT_HOST_CAPABILITY_PROFILES.codex,
      '2026-08-31T12:00:00.000Z',
      (command) => ({ command, status: 'missing', resolvedPath: null, reasonCode: 'missing' }),
    );
    assert.equal(report.facts.adapter.state, 'ready');
    assert.equal(report.facts.executable.state, 'blocked');
    assert.equal(report.facts['version-compatibility'].state, 'blocked');
    assert.match(report.facts.executable.nextAction, /outside QUBE/);
  });
});
