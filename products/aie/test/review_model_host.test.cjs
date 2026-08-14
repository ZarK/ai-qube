'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { configuredReviewModelHost, resolveReviewModelTier } = require('../dist/app/local_review_runner_support.js');

describe('configured review model host', () => {
  it('honors a non-codex configured review route host', () => {
    const host = configuredReviewModelHost({
      reviewRoute: { host: 'grok' },
      reviewLanes: [],
      localReviewAgents: ['codex'],
      reviewModels: {
        review: {
          grok: { model: 'grok-4.5', effort: null },
          codex: { model: 'gpt-5.5-codex', effort: 'high' },
        },
        economy: {},
        synthesis: {},
      },
    });
    assert.equal(host, 'grok');
    const review = resolveReviewModelTier({
      review: {
        grok: { model: 'grok-4.5', effort: null },
        codex: { model: 'gpt-5.5-codex', effort: 'high' },
      },
      economy: {},
      synthesis: {},
    }, 'review', host);
    assert.equal(review.model, 'grok-4.5');
    assert.equal(review.substitution, null);
  });

  it('does not invent a model when the configured host has no binding', () => {
    const host = configuredReviewModelHost({
      reviewRoute: { host: 'grok' },
      reviewLanes: [],
      localReviewAgents: ['codex'],
      reviewModels: {
        review: { codex: { model: 'gpt-5.5-codex', effort: 'high' } },
        economy: {},
        synthesis: {},
      },
    });
    assert.equal(host, 'grok');
    const review = resolveReviewModelTier({
      review: { codex: { model: 'gpt-5.5-codex', effort: 'high' } },
      economy: {},
      synthesis: {},
    }, 'review', host);
    assert.equal(review.model, null);
    assert.match(review.substitution, /not configured for grok/);
  });
});
