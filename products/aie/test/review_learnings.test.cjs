'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');

const {
  appendReviewLearning,
  loadReviewLearnings,
  loadReviewLearningsFragment,
  resolveReviewLearningsPath,
} = require('../dist/review_learnings.js');
const { promptStack } = require('../dist/app/local_review_runner_support.js');

function tempRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'aie-learnings-'));
  fs.mkdirSync(path.join(repo, '.qube', 'aie'), { recursive: true });
  return repo;
}

describe('review learnings', () => {
  it('rejects absolute, parent-directory, and symlink learnings paths', () => {
    const repo = tempRepo();
    assert.throws(() => resolveReviewLearningsPath(repo, '/etc/passwd'), /repository-relative|absolute/);
    assert.throws(() => resolveReviewLearningsPath(repo, '../secrets.json'), /under \.qube\/aie|parent/);
    if (process.platform !== 'win32') {
      const target = path.join(repo, 'outside.json');
      fs.writeFileSync(target, '{}\n');
      fs.symlinkSync(target, path.join(repo, '.qube', 'aie', 'review-learnings.json'));
      assert.throws(() => resolveReviewLearningsPath(repo), /symlink/);
    }
  });

  it('fails closed on malformed learnings JSON', () => {
    const repo = tempRepo();
    fs.writeFileSync(path.join(repo, '.qube', 'aie', 'review-learnings.json'), '{not-json');
    assert.throws(() => loadReviewLearnings(repo), /not valid JSON/);
  });

  it('fails closed on an invalid learnings entry', () => {
    const repo = tempRepo();
    fs.writeFileSync(path.join(repo, '.qube', 'aie', 'review-learnings.json'), `${JSON.stringify({
      version: 1,
      entries: [{ id: 'learning:bad', disposition: 'maybe', message: 'Nope', guidance: '', recordedAt: '2026-08-13T00:00:00.000Z' }],
    })}\n`);
    assert.throws(() => loadReviewLearnings(repo), /invalid entry/);
  });

  it('injects recorded guidance into later lane prompts as a repo-doc fragment', () => {
    const repo = tempRepo();
    appendReviewLearning(repo, {
      id: 'learning:test',
      disposition: 'rejected',
      findingId: 'CQ-001',
      lane: 'code-quality',
      message: 'Prefer a different brace style.',
      guidance: 'Do not re-raise brace-style nits as blockers.',
      paths: ['src/app.ts'],
      prNumber: 12,
      headSha: null,
      recordedAt: '2026-08-13T00:00:00.000Z',
    });
    const fragment = loadReviewLearningsFragment(repo);
    assert.equal(fragment.source, 'repo-configured');
    assert.equal(fragment.trust, 'repo-doc');
    assert.match(fragment.text, /Do not re-raise brace-style nits as blockers/);
    assert.match(fragment.text, /cannot approve a lane/);
    const rendered = promptStack('code-quality', ['Run local review lane code-quality.'], [], repo);
    assert.ok(rendered.promptStack.some(entry => entry.id === 'repo-configured/review-learnings' && entry.trust === 'repo-doc'));
    assert.match(rendered.text, /Do not re-raise brace-style nits as blockers/);
  });

  it('omits the fragment when no learnings file exists', () => {
    const repo = tempRepo();
    assert.equal(loadReviewLearnings(repo), null);
    const rendered = promptStack('code-quality', ['Run local review lane code-quality.'], [], repo);
    assert.equal(rendered.promptStack.some(entry => entry.id === 'repo-configured/review-learnings'), false);
  });
});
