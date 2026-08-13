'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');

const { getDefaults } = require('../dist/config/index.js');
const { formatReviewFeedback, runReviewFeedback } = require('../dist/app/review_feedback.js');
const { loadReviewLearnings } = require('../dist/review_learnings.js');

function tempRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'aie-review-feedback-'));
  fs.mkdirSync(path.join(repo, '.qube', 'aie'), { recursive: true });
  return repo;
}

describe('review feedback', () => {
  it('lists an empty learnings file without writing', async () => {
    const repo = tempRepo();
    const result = await runReviewFeedback(getDefaults(), { list: true, repoRoot: repo });
    assert.equal(result.action, 'list');
    assert.equal(result.entries.length, 0);
    assert.equal(loadReviewLearnings(repo), null);
    assert.match(formatReviewFeedback(result), /No review learnings/);
  });

  it('requires a pull request number when recording', async () => {
    await assert.rejects(
      () => runReviewFeedback(getDefaults(), { guidance: 'Keep this.', repoRoot: tempRepo() }),
      /pull request number/,
    );
  });

  it('rejects combining accept and reject', async () => {
    await assert.rejects(
      () => runReviewFeedback(getDefaults(), { prNumber: 12, accept: 'CQ-001', reject: 'CQ-002', guidance: 'No', repoRoot: tempRepo() }),
      /only one of --accept or --reject/,
    );
  });

  it('requires guidance when rejecting a finding', async () => {
    await assert.rejects(
      () => runReviewFeedback(getDefaults(), { prNumber: 12, reject: 'CQ-001', repoRoot: tempRepo() }),
      /--reject requires --guidance/,
    );
  });

  it('records rejected current-head findings into the repo-owned learnings file', async () => {
    const repo = tempRepo();
    const result = await runReviewFeedback(getDefaults(), {
      prNumber: 12,
      reject: 'CQ-001',
      guidance: 'Do not re-raise brace-style nits as blockers.',
      repoRoot: repo,
      resolveFinding: async findingId => ({
        findingId,
        message: 'Prefer a different brace style.',
        laneId: 'code-quality',
        path: 'src/app.ts',
        headSha: 'abc123',
      }),
    });
    assert.equal(result.action, 'rejected');
    assert.equal(result.entry.disposition, 'rejected');
    assert.equal(result.entry.findingId, 'CQ-001');
    assert.equal(result.entry.headSha, 'abc123');
    const file = loadReviewLearnings(repo);
    assert.equal(file.entries.length, 1);
    assert.equal(file.entries[0].guidance, 'Do not re-raise brace-style nits as blockers.');
    assert.match(formatReviewFeedback(result), /Recorded rejected/);
  });

  it('does not write on dry-run', async () => {
    const repo = tempRepo();
    const result = await runReviewFeedback(getDefaults(), {
      prNumber: 12,
      guidance: 'Prefer the existing naming.',
      dryRun: true,
      repoRoot: repo,
    });
    assert.equal(result.dryRun, true);
    assert.equal(result.action, 'guidance');
    assert.equal(loadReviewLearnings(repo), null);
  });

  it('redacts tokens from persisted guidance and finding messages', async () => {
    const repo = tempRepo();
    const result = await runReviewFeedback(getDefaults(), {
      prNumber: 12,
      reject: 'SEC-001',
      guidance: 'Do not store ghp_abcdefghijklmnopqrstuvwxyz012345 in learnings.',
      repoRoot: repo,
      resolveFinding: async findingId => ({
        findingId,
        message: 'Token ghp_abcdefghijklmnopqrstuvwxyz012345 leaked.',
        laneId: 'security',
        path: 'src/app.ts',
        headSha: 'abc123',
      }),
    });
    assert.match(result.entry.message, /\[REDACTED\]/);
    assert.doesNotMatch(result.entry.message, /ghp_abcdefghijklmnopqrstuvwxyz012345/);
    assert.match(result.entry.guidance, /\[REDACTED\]/);
    assert.doesNotMatch(result.entry.guidance, /ghp_abcdefghijklmnopqrstuvwxyz012345/);
    const file = loadReviewLearnings(repo);
    assert.match(file.entries[0].guidance, /\[REDACTED\]/);
    assert.doesNotMatch(file.entries[0].guidance, /ghp_abcdefghijklmnopqrstuvwxyz012345/);
  });

  it('fails closed when a finding id is not on the current head', async () => {
    await assert.rejects(
      () => runReviewFeedback(getDefaults(), {
        prNumber: 12,
        accept: 'missing',
        repoRoot: tempRepo(),
        resolveFinding: async () => null,
      }),
      /No current-head finding missing/,
    );
  });
});
