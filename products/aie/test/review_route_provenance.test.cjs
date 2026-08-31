'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { buildReviewRouteProvenance, reviewRouteReasonMessage, sameReviewRouteIdentity } = require('../dist/review_route_provenance.js');

const selected = { host: 'cursor', model: 'cursor-grok-4.6-high-fast', effort: 'high', tier: 'review' };

describe('Review route provenance', () => {
  it('keeps requested, transport-resolved, and host-reported model identities distinct', () => {
    const route = buildReviewRouteProvenance({
      selected,
      executed: selected,
      source: 'configured',
      reasonCode: null,
      transport: 'acp',
      transportModel: 'grok-4.6[effort=high,fast=true]',
      reportedModel: 'grok-4.6-2026-08-30',
      implementationHost: 'grok-build',
    });
    assert.equal(route.executed.requestedModel, 'cursor-grok-4.6-high-fast');
    assert.equal(route.executed.transportModel, 'grok-4.6[effort=high,fast=true]');
    assert.equal(route.executed.reportedModel, 'grok-4.6-2026-08-30');
    assert.equal(route.executed.modelSource, 'host-reported');
    assert.equal(route.source, 'configured');
    assert.equal(route.reason, null);
  });

  it('uses host default when an unpinned host reports no model', () => {
    const unpinned = { host: 'codex', model: null, effort: null, tier: 'review' };
    const route = buildReviewRouteProvenance({
      selected,
      executed: unpinned,
      source: 'fallback',
      reasonCode: 'model-route-model-unsupported',
      transport: 'exec',
      transportModel: null,
      reportedModel: null,
      implementationHost: 'grok-build',
    });
    assert.equal(route.executed.modelSource, 'host-default');
    assert.equal(route.executed.requestedModel, null);
    assert.equal(route.executed.transportModel, null);
    assert.equal(route.executed.reportedModel, null);
    assert.equal(route.reason.message, reviewRouteReasonMessage('model-route-model-unsupported'));
  });

  it('marks fallback to the implementation host as degraded reviewer separation', () => {
    const implementationRoute = { host: 'grok-build', model: 'grok-4.6', effort: 'high', tier: 'review' };
    const route = buildReviewRouteProvenance({
      selected,
      executed: implementationRoute,
      source: 'fallback',
      reasonCode: 'model-route-process-failed',
      transport: 'exec',
      transportModel: null,
      reportedModel: 'grok-4.6',
      implementationHost: 'grok-build',
    });
    assert.equal(route.degradedReviewerSeparation, true);
    assert.deepEqual(route.substitutions.map(substitution => substitution.kind), ['route']);
  });

  it('normalizes an untrusted fallback diagnostic to a stable safe reason code', () => {
    const route = buildReviewRouteProvenance({
      selected,
      executed: { host: 'codex', model: 'gpt-test', effort: null, tier: 'review' },
      source: 'fallback',
      reasonCode: 'token=ghp_abcdefghijklmnopqrstuvwxyz and C:\\private\\prompt.txt',
      transport: 'exec',
      transportModel: null,
      reportedModel: null,
      implementationHost: null,
    });
    assert.deepEqual(route.reason, {
      code: 'model-route-unavailable',
      message: 'The selected Review route could not produce accepted lane evidence.',
    });
    assert.doesNotMatch(JSON.stringify(route), /ghp_|private|prompt\.txt/);
  });

  it('compares the complete configured route identity', () => {
    assert.equal(sameReviewRouteIdentity(selected, { ...selected }), true);
    assert.equal(sameReviewRouteIdentity(selected, { ...selected, effort: 'medium' }), false);
    assert.equal(sameReviewRouteIdentity(selected, { ...selected, tier: 'economy' }), false);
  });
});
