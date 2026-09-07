const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { describe, it } = require('node:test');
const {
  assert,
  localEvidence,
  localReviewConfig,
  makeGitRepo,
  promptStackForLane,
  writeLocalEvidence,
} = require('./support/pr_gate_fixture.cjs');
const { verifyPromptedReview } = require('../dist/app/prompted_review.js');
const { laneConfiguredFragments } = require('../dist/app/local_review_runner.js');
const { configuredReviewModelHost, stableLanePromptHash } = require('../dist/app/local_review_runner_support.js');

const ISSUE_NUMBER = 93;
const PR_NUMBER = 12;
const HEAD_SHA = 'a'.repeat(40);

function fixture() {
  const repoRoot = makeGitRepo();
  const config = localReviewConfig();
  const relativePath = `.qube/aie/reviews/${ISSUE_NUMBER}/${PR_NUMBER}/${HEAD_SHA}/issue-compliance.json`;
  const evidence = localEvidence({ issueNumber: ISSUE_NUMBER, prNumber: PR_NUMBER, headSha: HEAD_SHA });
  evidence.lanes.find(lane => lane.id === 'issue-compliance').runnerProvenance.promptStackHash = stableLanePromptHash({
    host: configuredReviewModelHost(config),
    lane: 'issue-compliance',
    issueNumbers: [ISSUE_NUMBER],
    prNumber: PR_NUMBER,
    headSha: HEAD_SHA,
    evidencePaths: [relativePath],
    repoRoot,
    configuredFragments: laneConfiguredFragments(config, 'issue-compliance'),
  });
  writeLocalEvidence(repoRoot, evidence, { rewritePromptHashes: false });
  const path = join(repoRoot, ...relativePath.split('/'));
  const evidenceSha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
  const review = { lane: 'issue-compliance', prNumber: PR_NUMBER, headSha: HEAD_SHA, evidenceSha256 };
  const record = { proof: { kind: 'prompted-review', promptStack: promptStackForLane('issue-compliance').map(({ id, sha256 }) => ({ id, sha256 })), review } };
  const input = { record, repoRoot, issueNumber: ISSUE_NUMBER, pr: { number: PR_NUMBER, headSha: HEAD_SHA }, issueText: 'Preserve exact acceptance behavior.', changedPaths: [], config };
  return { input, review };
}

describe('prompted criterion review', () => {
  it('accepts an existing trusted current-head issue-compliance review', () => {
    const { input } = fixture();
    assert.deepEqual(verifyPromptedReview(input), []);
  });

  it('rejects stale and forged review references', () => {
    const { input, review } = fixture();
    const stale = { ...input, record: { proof: { ...input.record.proof, review: { ...review, headSha: 'b'.repeat(40) } } } };
    assert.match(verifyPromptedReview(stale).join(' '), /current PR and head/);
    const forged = { ...input, record: { proof: { ...input.record.proof, review: { ...review, evidenceSha256: '0'.repeat(64) } } } };
    assert.match(verifyPromptedReview(forged).join(' '), /sha-?256|integrity/i);
  });

  it('rejects trusted evidence after the configured prompt changes', () => {
    const { input } = fixture();
    input.config.reviewLanes.find(lane => lane.id === 'issue-compliance').prompt = ['Inspect the revised acceptance contract.'];
    assert.match(verifyPromptedReview(input).join(' '), /current QUBE prompt stack|unverifiable/);
  });

  it('rejects a proof stack that differs from the trusted execution', () => {
    const { input } = fixture();
    input.record.proof.promptStack[0] = { ...input.record.proof.promptStack[0], sha256: 'f'.repeat(64) };
    assert.match(verifyPromptedReview(input).join(' '), /Prompt stack does not match/);
  });
});
