'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { readTrustedProviderLanes, acceptedProviderLane } = require('../dist/provider_lane_evidence.js');

function record(overrides = {}) {
  return {
    head: 'abc123',
    lane: 'code-quality',
    profile: 'local-standard',
    runId: 'run-1',
    issueNumber: 93,
    prNumber: 12,
    host: 'grok',
    recommendation: 'approve',
    status: 'passed',
    summary: 'Lane approved at the current head.',
    findingDigest: null,
    stale: false,
    author: 'executor',
    url: 'https://github.com/example/repo/pull/12#issuecomment-1',
    ...overrides,
  };
}

const gate = { headSha: 'abc123', prNumber: 12, profile: 'local-standard', requiredLanes: ['issue-compliance', 'code-quality'], issueNumbers: [93] };

describe('readTrustedProviderLanes', () => {
  it('accepts a complete valid current-head record set', () => {
    const reuse = readTrustedProviderLanes([
      record({ lane: 'issue-compliance', runId: 'run-ic' }),
      record({ lane: 'code-quality', runId: 'run-cq' }),
    ], gate);
    assert.equal(reuse.accepted.length, 2);
    assert.equal(reuse.rejected.length, 0);
    assert.deepEqual(reuse.accepted.map(lane => lane.lane).sort(), ['code-quality', 'issue-compliance']);
    assert.ok(reuse.accepted.every(lane => lane.recommendation === 'approve' && lane.status === 'passed' && lane.head === 'abc123'));
  });

  it('rejects lanes whose only records reference other heads with an actionable reason', () => {
    const reuse = readTrustedProviderLanes([
      record({ lane: 'issue-compliance' }),
      record({ lane: 'code-quality', head: 'def456789012' }),
    ], gate);
    assert.equal(reuse.accepted.length, 1);
    assert.equal(reuse.rejected.length, 1);
    assert.equal(reuse.rejected[0].lane, 'code-quality');
    assert.match(reuse.rejected[0].reason, /other heads/);
    assert.match(reuse.rejected[0].reason, /def456789012/);
  });

  it('rejects profile-incompatible records', () => {
    const reuse = readTrustedProviderLanes([record({ profile: 'local-comprehensive' })], gate);
    assert.equal(reuse.accepted.length, 0);
    assert.match(reuse.rejected[0].reason, /incompatible with the configured profile local-standard/);
  });

  it('rejects records bound to a different pull request', () => {
    const reuse = readTrustedProviderLanes([record({ prNumber: 99 })], gate);
    assert.equal(reuse.accepted.length, 0);
    assert.match(reuse.rejected[0].reason, /PR #99 instead of PR #12/);
  });

  it('rejects unknown verdict vocabulary', () => {
    const reuse = readTrustedProviderLanes([record({ recommendation: 'ship-it' })], gate);
    assert.equal(reuse.accepted.length, 0);
    assert.match(reuse.rejected[0].reason, /unrecognized verdict/);
  });

  it('rejects non-approve records and names the local-only fields', () => {
    const reuse = readTrustedProviderLanes([record({ recommendation: 'request-changes', status: 'needs-work' })], gate);
    assert.equal(reuse.accepted.length, 0);
    assert.match(reuse.rejected[0].reason, /request-changes\/needs-work/);
    assert.match(reuse.rejected[0].reason, /findings, severities, prompt stack, and runner provenance are local-only fields/);
  });

  it('rejects records missing required marker fields', () => {
    const reuse = readTrustedProviderLanes([record({ runId: '' })], gate);
    assert.equal(reuse.accepted.length, 0);
    assert.match(reuse.rejected[0].reason, /missing required marker fields \(runId, host, or summary\)/);
  });

  it('ignores malformed entries and records for inactive lanes without crashing', () => {
    const reuse = readTrustedProviderLanes([
      null,
      42,
      'not-a-record',
      { lane: 'code-quality' },
      record({ lane: 'performance' }),
      record({ lane: 'issue-compliance' }),
    ], gate);
    assert.equal(reuse.accepted.length, 1);
    assert.equal(reuse.accepted[0].lane, 'issue-compliance');
    assert.ok(!reuse.accepted.some(lane => lane.lane === 'performance'));
  });

  it('reports lanes with no provider records in the summary instead of rejecting them', () => {
    const reuse = readTrustedProviderLanes([record({ lane: 'issue-compliance' })], gate);
    assert.equal(reuse.rejected.length, 0);
    assert.match(reuse.summary, /No trusted provider review found for: code-quality/);
  });

  it('returns an empty result for missing metadata and names every uncovered lane', () => {
    const reuse = readTrustedProviderLanes(undefined, gate);
    assert.equal(reuse.accepted.length, 0);
    assert.equal(reuse.rejected.length, 0);
    assert.match(reuse.summary, /No trusted provider review found for: issue-compliance, code-quality/);
  });
});

describe('readTrustedProviderLanes with multiple linked issues', () => {
  it('accepts per-issue records for the same lane without shadowing', () => {
    const multiGate = { ...gate, issueNumbers: [93, 94] };
    const reuse = readTrustedProviderLanes([
      record({ lane: 'issue-compliance', issueNumber: 93, runId: 'run-93' }),
      record({ lane: 'issue-compliance', issueNumber: 94, runId: 'run-94' }),
      record({ lane: 'code-quality', issueNumber: 93, runId: 'run-cq-93' }),
      record({ lane: 'code-quality', issueNumber: 94, runId: 'run-cq-94' }),
    ], multiGate);
    assert.equal(reuse.accepted.length, 4);
    assert.ok(acceptedProviderLane(reuse, 'issue-compliance', 93));
    assert.ok(acceptedProviderLane(reuse, 'issue-compliance', 94));
    assert.ok(acceptedProviderLane(reuse, 'code-quality', 93));
    assert.ok(acceptedProviderLane(reuse, 'code-quality', 94));
  });

  it('does not let one issue record cover another linked issue', () => {
    const multiGate = { ...gate, issueNumbers: [93, 94] };
    const reuse = readTrustedProviderLanes([
      record({ lane: 'issue-compliance', issueNumber: 93 }),
      record({ lane: 'code-quality', issueNumber: 93 }),
    ], multiGate);
    assert.equal(acceptedProviderLane(reuse, 'issue-compliance', 94), null);
    assert.equal(acceptedProviderLane(reuse, 'code-quality', 94), null);
  });

  it('ignores current-head records without a valid issue number', () => {
    const reuse = readTrustedProviderLanes([record({ issueNumber: null })], gate);
    assert.equal(reuse.accepted.length, 0);
  });
});

describe('acceptedProviderLane', () => {
  it('matches lane and issue number exactly', () => {
    const reuse = readTrustedProviderLanes([record({ lane: 'code-quality', issueNumber: 93 })], gate);
    assert.ok(acceptedProviderLane(reuse, 'code-quality', 93));
    assert.equal(acceptedProviderLane(reuse, 'code-quality', 94), null);
    assert.equal(acceptedProviderLane(reuse, 'issue-compliance', 93), null);
    assert.equal(acceptedProviderLane(undefined, 'code-quality', 93), null);
  });
});
