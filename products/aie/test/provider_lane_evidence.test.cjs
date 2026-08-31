'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { readTrustedProviderLanes, acceptedProviderLane } = require('../dist/provider_lane_evidence.js');

function record(overrides = {}) {
  return {
    head: 'abc123',
    lane: 'code-quality',
    expectedLanes: ['code-quality', 'issue-compliance'],
    profile: 'local-standard',
    runId: 'run-1',
    issueNumber: 93,
    prNumber: 12,
    host: 'grok-build',
    route: {
      source: 'configured',
      selected: { host: 'grok-build', model: 'grok-test-review', effort: 'high', tier: 'review' },
      executed: { host: 'grok-build', requestedModel: 'grok-test-review', transportModel: null, reportedModel: 'grok-test-review', modelSource: 'host-reported', effort: 'high', tier: 'review', transport: 'exec' },
      reason: null,
      substitutions: [],
      degradedReviewerSeparation: false,
    },
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

  it('rejects lanes whose only records reference other heads and fails the partial round closed', () => {
    const reuse = readTrustedProviderLanes([
      record({ lane: 'issue-compliance' }),
      record({ lane: 'code-quality', head: 'def456789012' }),
    ], gate);
    // The current-head round declared both lanes but only issue-compliance
    // published at this head, so even the well-formed record is rejected: a
    // partial round is never read as approved.
    assert.equal(reuse.accepted.length, 0);
    assert.equal(reuse.rejected.length, 2);
    const staleRejection = reuse.rejected.find(entry => entry.lane === 'code-quality');
    assert.match(staleRejection.reason, /other heads/);
    assert.match(staleRejection.reason, /def456789012/);
    const partialRejection = reuse.rejected.find(entry => entry.lane === 'issue-compliance');
    assert.match(partialRejection.reason, /incomplete review round/);
    assert.match(partialRejection.reason, /missing: code-quality/);
  });

  it('never accepts a lane from an incomplete round and names the missing lanes', () => {
    const threeLanes = ['code-quality', 'issue-compliance', 'security'];
    const reuse = readTrustedProviderLanes([
      record({ lane: 'issue-compliance', expectedLanes: threeLanes, runId: 'run-ic' }),
      record({ lane: 'code-quality', expectedLanes: threeLanes, runId: 'run-cq' }),
    ], gate);
    assert.equal(reuse.accepted.length, 0);
    assert.equal(reuse.rejected.length, 2);
    assert.ok(reuse.rejected.every(entry => /incomplete review round \(2 of 3 declared lanes published/.test(entry.reason)));
    assert.ok(reuse.rejected.every(entry => /missing: security/.test(entry.reason)));
  });

  it('rejects rounds whose records disagree on the declared expected lane set', () => {
    const reuse = readTrustedProviderLanes([
      record({ lane: 'issue-compliance', round: 'round-x', expectedLanes: ['code-quality', 'issue-compliance'] }),
      record({ lane: 'code-quality', round: 'round-x', expectedLanes: ['code-quality', 'issue-compliance', 'security'] }),
    ], gate);
    assert.equal(reuse.accepted.length, 0);
    assert.ok(reuse.rejected.every(entry => /disagree on the declared expected lane set/.test(entry.reason)));
  });

  it('rejects records with neither a round id nor an expected lane set', () => {
    const reuse = readTrustedProviderLanes([
      record({ lane: 'issue-compliance', expectedLanes: undefined }),
      record({ lane: 'code-quality', expectedLanes: undefined }),
    ], gate);
    assert.equal(reuse.accepted.length, 0);
    assert.ok(reuse.rejected.every(entry => /no round grouping/.test(entry.reason)));
  });

  it('rejects an under-declared round even when it is internally complete', () => {
    // A round declaring only its own lane is complete by its own account,
    // but it was reviewed under a different lane configuration than the
    // required set and can never seed reuse for the active one.
    const reuse = readTrustedProviderLanes([record({ lane: 'code-quality', expectedLanes: ['code-quality'] })], gate);
    assert.equal(reuse.accepted.length, 0);
    assert.equal(reuse.rejected.length, 1);
    assert.match(reuse.rejected[0].reason, /does not equal the required lane set \[code-quality, issue-compliance\]/);
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

  it('rejects records explicitly marked stale even when the head field matches', () => {
    const reuse = readTrustedProviderLanes([record({ stale: true })], gate);
    assert.equal(reuse.accepted.length, 0);
    assert.match(reuse.rejected[0].reason, /explicitly marked stale/);
  });

  it('rejects records missing required marker fields', () => {
    const reuse = readTrustedProviderLanes([record({ runId: '' })], gate);
    assert.equal(reuse.accepted.length, 0);
    assert.match(reuse.rejected[0].reason, /missing or mismatches required marker fields \(runId, host, route, or summary\)/);
  });

  it('ignores malformed entries and records for inactive lanes without crashing', () => {
    const reuse = readTrustedProviderLanes([
      null,
      42,
      'not-a-record',
      { lane: 'code-quality' },
      record({ lane: 'performance', expectedLanes: ['performance'] }),
      record({ lane: 'issue-compliance', runId: 'run-ic' }),
      record({ lane: 'code-quality', runId: 'run-cq' }),
    ], gate);
    assert.equal(reuse.accepted.length, 2);
    assert.ok(reuse.accepted.some(lane => lane.lane === 'issue-compliance'));
    assert.ok(!reuse.accepted.some(lane => lane.lane === 'performance'));
  });

  it('reports lanes with no provider records in the summary instead of silently omitting them', () => {
    const reuse = readTrustedProviderLanes([record({ lane: 'issue-compliance' })], gate);
    // The present record fails its incomplete round; the absent lane is
    // reported as uncovered rather than rejected.
    assert.equal(reuse.rejected.length, 1);
    assert.match(reuse.rejected[0].reason, /incomplete review round/);
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
    const singleLaneGate = { ...gate, requiredLanes: ['code-quality'] };
    const reuse = readTrustedProviderLanes([record({ lane: 'code-quality', issueNumber: 93, expectedLanes: ['code-quality'] })], singleLaneGate);
    assert.ok(acceptedProviderLane(reuse, 'code-quality', 93));
    assert.equal(acceptedProviderLane(reuse, 'code-quality', 94), null);
    assert.equal(acceptedProviderLane(reuse, 'issue-compliance', 93), null);
    assert.equal(acceptedProviderLane(undefined, 'code-quality', 93), null);
  });
});
