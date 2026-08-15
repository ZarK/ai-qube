const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
require('./support/compile_cache.cjs');

const { computePrGateNextAction, twoRoundMergeConditionMet } = require('../dist/app/pr_gate_next_action.js');

describe('pr gate next-action table', () => {
  it('says merge when ship-ready or the two-round merge condition is met', () => {
    assert.equal(computePrGateNextAction({
      shipReady: true,
      twoRoundMergeMet: false,
      hostRequestRecorded: true,
      inconclusiveLanes: [],
      prNumber: 12,
      fallback: 'Wait for pending reviewers.',
    }), 'Merge this pull request.');
    assert.equal(computePrGateNextAction({
      shipReady: false,
      twoRoundMergeMet: true,
      hostRequestRecorded: true,
      inconclusiveLanes: ['code-quality'],
      prNumber: 12,
      fallback: 'Wait for pending reviewers.',
    }), 'Merge this pull request.');
    assert.equal(twoRoundMergeConditionMet({
      completedRoundCount: 2,
      unresolvedBlockers: 0,
      requiredChecksGreen: true,
      unresolvedThreads: 0,
    }), true);
    assert.equal(twoRoundMergeConditionMet({
      completedRoundCount: 1,
      unresolvedBlockers: 0,
      requiredChecksGreen: true,
      unresolvedThreads: 0,
    }), false);
  });

  it('names a single-lane rerun when a lane is inconclusive and merge is not met', () => {
    assert.equal(computePrGateNextAction({
      shipReady: false,
      twoRoundMergeMet: false,
      hostRequestRecorded: true,
      inconclusiveLanes: ['code-quality', 'security'],
      prNumber: 12,
      fallback: 'Wait for pending reviewers.',
    }), 'Run `aie pr lane rerun 12 code-quality` once, then rerun `aie pr gate 12`.');
  });

  it('does not ask to post a reviewer request that already exists', () => {
    assert.equal(computePrGateNextAction({
      shipReady: false,
      twoRoundMergeMet: false,
      hostRequestRecorded: true,
      inconclusiveLanes: [],
      prNumber: 12,
      fallback: 'Post the configured QUBEReview review request on the pull request, then rerun the PR gate.',
    }), 'Reviewer request is already recorded for this head. Inspect lane results, then rerun `aie pr gate 12`.');
  });

  it('keeps the fallback when no special state applies', () => {
    assert.equal(computePrGateNextAction({
      shipReady: false,
      twoRoundMergeMet: false,
      hostRequestRecorded: false,
      inconclusiveLanes: [],
      prNumber: 12,
      fallback: 'Wait for pending reviewers.',
    }), 'Wait for pending reviewers.');
  });
});
