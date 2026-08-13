'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { classifyApprovedLaneDelta } = require('../dist/review_delta_triage.js');

describe('economy delta triage', () => {
  it('classifies an untouched scope as not-relevant without escalation', () => {
    const result = classifyApprovedLaneDelta({
      lane: 'code-quality',
      deltaPaths: ['docs/notes.md', 'README.md'],
      matchPatterns: ['src/**'],
      contextPatterns: ['AGENTS.md'],
      contextMode: 'scope',
    });

    assert.equal(result.verdict, 'not-relevant');
    assert.equal(result.escalate, false);
    assert.equal(result.modelTier, 'economy');
    assert.equal(result.lane, 'code-quality');
  });

  it('classifies a touched scope as relevant and escalates', () => {
    const result = classifyApprovedLaneDelta({
      lane: 'code-quality',
      deltaPaths: ['src/app.ts'],
      matchPatterns: ['src/**'],
      contextPatterns: [],
      contextMode: 'scope',
    });

    assert.equal(result.verdict, 'relevant');
    assert.equal(result.escalate, true);
    assert.equal(result.modelTier, 'economy');
  });

  it('classifies an uncomputable delta as unsure and escalates', () => {
    const result = classifyApprovedLaneDelta({
      lane: 'code-quality',
      deltaPaths: null,
      matchPatterns: ['src/**'],
      contextPatterns: [],
    });

    assert.equal(result.verdict, 'unsure');
    assert.equal(result.escalate, true);
    assert.equal(result.modelTier, 'economy');
    assert.match(result.reason, /could not be computed/);
  });
});
