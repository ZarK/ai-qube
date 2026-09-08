'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');

const {
  REVIEW_LEARNINGS_RENDER_LIMIT,
  appendReviewLearning,
  loadReviewLearnings,
  loadReviewLearningsFragment,
  renderReviewLearningsText,
  resolveReviewLearningsPath,
} = require('../dist/review_learnings.js');
const { promptStack } = require('../dist/app/local_review_runner_support.js');

function tempRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'aie-learnings-'));
  fs.mkdirSync(path.join(repo, '.qube', 'aie'), { recursive: true });
  return repo;
}

function learning(id, overrides = {}) {
  return {
    id,
    disposition: 'guidance',
    findingId: null,
    lane: null,
    message: id,
    guidance: '',
    paths: [],
    prNumber: null,
    headSha: null,
    recordedAt: '2026-08-13T00:00:00.000Z',
    ...overrides,
  };
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

  it('rejects a symlink or junction parent of the learnings file', () => {
    const repo = tempRepo();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'aie-learnings-outside-'));
    const aieDir = path.join(repo, '.qube', 'aie');
    fs.rmSync(aieDir, { recursive: true, force: true });
    try {
      fs.symlinkSync(outside, aieDir, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return;
    }
    assert.throws(() => resolveReviewLearningsPath(repo), /symlink or junction/);
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
    const fragment = loadReviewLearningsFragment(repo, 'code-quality', ['src/app.ts']);
    assert.equal(fragment.source, 'repo-configured');
    assert.equal(fragment.trust, 'repo-doc');
    assert.match(fragment.text, /Do not re-raise brace-style nits as blockers/);
    assert.match(fragment.text, /cannot approve a lane/);
    const rendered = promptStack('codex', 'code-quality', ['Run local review lane code-quality.'], [], repo, undefined, ['src/app.ts']);
    assert.ok(rendered.promptStack.some(entry => entry.id === 'repo-configured/review-learnings' && entry.trust === 'repo-doc'));
    assert.match(rendered.text, /Do not re-raise brace-style nits as blockers/);
  });

  it('selects review learnings by lane and changed path before applying the limit', () => {
    const unrelated = Array.from({ length: REVIEW_LEARNINGS_RENDER_LIMIT + 5 }, (_, index) => learning(`learning:unrelated-${index}`, {
      lane: 'security',
      message: `Unrelated ${index}`,
      paths: ['src/other.ts'],
      recordedAt: `2026-09-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
    }));
    const file = { version: 1, entries: [
      learning('learning:old-match', { lane: 'code-quality', message: 'Keep the parser boundary.', paths: ['src/app.ts'], recordedAt: '2025-01-01T00:00:00.000Z' }),
      learning('learning:global', { message: 'Check concrete regressions.', recordedAt: '2025-01-02T00:00:00.000Z' }),
      learning('learning:wrong-path', { lane: 'code-quality', message: 'Wrong path.', paths: ['src/missing.ts'] }),
      learning('learning:wrong-lane', { lane: 'security', message: 'Wrong lane.', paths: ['src/app.ts'] }),
      ...unrelated,
    ] };

    const selected = renderReviewLearningsText(file, 'code-quality', ['src/app.ts']);
    assert.match(selected, /Keep the parser boundary/);
    assert.match(selected, /Check concrete regressions/);
    assert.doesNotMatch(selected, /Unrelated|Wrong path|Wrong lane/);

    const emptyDelta = renderReviewLearningsText(file, 'code-quality', []);
    assert.match(emptyDelta, /Check concrete regressions/);
    assert.doesNotMatch(emptyDelta, /Keep the parser boundary|Wrong path|Wrong lane/);

  });

  it('orders selected review learnings by parsed recency and stable id', () => {
    const entries = Array.from({ length: REVIEW_LEARNINGS_RENDER_LIMIT + 2 }, (_, index) => learning(`learning:${String(index).padStart(2, '0')}`, {
      message: `Selected ${index}`,
      recordedAt: `2026-07-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
    }));
    entries.push(
      learning('learning:tie-b', { message: 'Tie B', recordedAt: '2026-09-01T10:00:00+02:00' }),
      learning('learning:tie-a', { message: 'Tie A', recordedAt: '2026-09-01T08:00:00Z' }),
    );
    const text = renderReviewLearningsText({ version: 1, entries }, 'code-quality', []);
    assert.equal(renderReviewLearningsText({ version: 1, entries: [...entries].reverse() }, 'code-quality', []), text);
    assert.ok(text.indexOf('Tie A') < text.indexOf('Tie B'));
    assert.ok(text.indexOf('Tie B') < text.indexOf('Selected 21'));
    assert.doesNotMatch(text, /Selected 0\b|Selected 1\b|Selected 2\b|Selected 3\b/);
  });

  it('keeps selected review learning text and hash stable when an omitted entry changes', () => {
    const repo = tempRepo();
    appendReviewLearning(repo, learning('learning:selected', {
      disposition: 'rejected',
      lane: 'code-quality',
      message: 'Do not report formatting preference as a blocker.',
      paths: ['src/app.ts'],
    }));
    appendReviewLearning(repo, learning('learning:omitted', {
      lane: 'security',
      message: 'Omitted text one.',
      paths: ['src/other.ts'],
    }));
    const before = loadReviewLearningsFragment(repo, 'code-quality', ['src/app.ts']);
    assert.match(before.text, /Rejected entries[\s\S]*concrete (?:defect|bug)/);
    assert.match(before.text, /Do not report formatting preference as a blocker/);

    appendReviewLearning(repo, learning('learning:omitted', {
      lane: 'security',
      message: 'Omitted text two.',
      paths: ['src/other.ts'],
    }));
    const after = loadReviewLearningsFragment(repo, 'code-quality', ['src/app.ts']);
    assert.equal(after.text, before.text);
    assert.equal(after.sha256, before.sha256);
  });

  it('omits the fragment when no learnings file exists', () => {
    const repo = tempRepo();
    assert.equal(loadReviewLearnings(repo), null);
    const rendered = promptStack('codex', 'code-quality', ['Run local review lane code-quality.'], [], repo, undefined, []);
    assert.equal(rendered.promptStack.some(entry => entry.id === 'repo-configured/review-learnings'), false);
  });
});
