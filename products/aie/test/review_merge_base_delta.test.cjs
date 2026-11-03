const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdirSync, mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { describe, it } = require('node:test');
require('./support/compile_cache.cjs');

const { gitChangedPathsSync, gitDeltaPathsSync } = require('../dist/local_review_evidence.js');
const { evaluateCarryForwardDecision } = require('../dist/app/local_review_runner_support.js');

function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commitFile(repo, path, content, message) {
  writeFileSync(join(repo, path), content);
  git(repo, ['add', path]);
  git(repo, ['commit', '-m', message]);
  return git(repo, ['rev-parse', 'HEAD']);
}

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'aie-merge-base-delta-'));
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'executor@example.invalid']);
  git(repo, ['config', 'user.name', 'Executor Test']);
  commitFile(repo, 'a.txt', 'a base\n', 'base a');
  commitFile(repo, 'b.txt', 'b base\n', 'base b');
  commitFile(repo, 'shared.txt', 'one\ntwo\nthree\n', 'base shared');
  return repo;
}

// Branch `feature` changes a.txt; returns the feature head before any base move.
function startFeature(repo) {
  git(repo, ['checkout', '-b', 'feature']);
  return commitFile(repo, 'a.txt', 'a pull request\n', 'pull request change');
}

describe('merge-base review deltas and changed paths', () => {
  it('excludes files only the base changed when the base merges into the branch', async () => {
    const repo = makeRepo();
    const priorHead = startFeature(repo);
    git(repo, ['checkout', 'main']);
    commitFile(repo, 'b.txt', 'b from another pull request\n', 'base advance');
    git(repo, ['checkout', 'feature']);
    git(repo, ['merge', '--no-edit', 'main']);
    const head = git(repo, ['rev-parse', 'HEAD']);

    assert.deepEqual(gitDeltaPathsSync(repo, priorHead, head), []);
    assert.deepEqual(gitChangedPathsSync(repo, 'main', head), ['a.txt']);

    // The production carry-forward decision sees the same empty delta.
    const evidenceDir = join(repo, '.qube', 'aie', 'reviews', '7', '9', priorHead);
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(join(evidenceDir, 'code-quality.json'), JSON.stringify({
      version: 1,
      lane: 'code-quality',
      status: 'passed',
      recommendation: 'approve',
      headSha: priorHead,
      recordedAt: '2026-01-01T00:00:00.000Z',
    }));
    const decision = await evaluateCarryForwardDecision({
      repoRoot: repo,
      issueNumber: 7,
      prNumber: 9,
      headSha: head,
      lane: 'code-quality',
      matchPatterns: [],
      contextPatterns: [],
      expectedFragmentDigest: 'not-a-real-digest',
      expectedAdapter: 'local-host',
      requiredCommand: null,
    });
    assert.equal(decision.priorApproved, true);
    assert.deepEqual(decision.deltaPaths, []);
  });

  it('excludes base-only files from pull request changed paths when the base moves ahead', () => {
    const repo = makeRepo();
    const head = startFeature(repo);
    git(repo, ['checkout', 'main']);
    commitFile(repo, 'b.txt', 'b from another pull request\n', 'base advance');
    git(repo, ['checkout', 'feature']);

    assert.deepEqual(gitChangedPathsSync(repo, 'main', head), ['a.txt']);
    assert.deepEqual(gitChangedPathsSync(repo, 'main', git(repo, ['rev-parse', 'main'])), []);
  });

  it('includes a pull request file whose merge with the base resolves a conflict', () => {
    const repo = makeRepo();
    git(repo, ['checkout', '-b', 'feature']);
    const priorHead = commitFile(repo, 'shared.txt', 'one\ntwo pull request\nthree\n', 'pull request shared change');
    git(repo, ['checkout', 'main']);
    commitFile(repo, 'shared.txt', 'one\ntwo base\nthree\n', 'base shared change');
    commitFile(repo, 'b.txt', 'b from another pull request\n', 'base advance');
    git(repo, ['checkout', 'feature']);
    assert.throws(() => git(repo, ['merge', '--no-edit', 'main']));
    writeFileSync(join(repo, 'shared.txt'), 'one\ntwo resolved\nthree\n');
    git(repo, ['add', 'shared.txt']);
    git(repo, ['commit', '--no-edit']);
    const head = git(repo, ['rev-parse', 'HEAD']);

    assert.deepEqual(gitDeltaPathsSync(repo, priorHead, head), ['shared.txt']);
  });

  it('includes a pull request file whose merge resolves a conflict by keeping the base version', () => {
    const repo = makeRepo();
    git(repo, ['checkout', '-b', 'feature']);
    const priorHead = commitFile(repo, 'shared.txt', 'one\ntwo pull request\nthree\n', 'pull request shared change');
    git(repo, ['checkout', 'main']);
    commitFile(repo, 'shared.txt', 'one\ntwo base\nthree\n', 'base shared change');
    git(repo, ['checkout', 'feature']);
    assert.throws(() => git(repo, ['merge', '--no-edit', 'main']));
    // Resolve by keeping the base text exactly: the pull request version is
    // replaced, so the file changed for the pull request between the heads.
    writeFileSync(join(repo, 'shared.txt'), 'one\ntwo base\nthree\n');
    git(repo, ['add', 'shared.txt']);
    git(repo, ['commit', '--no-edit']);
    const head = git(repo, ['rev-parse', 'HEAD']);

    assert.deepEqual(gitDeltaPathsSync(repo, priorHead, head), ['shared.txt']);
  });

  it('keeps the plain-commit delta identical to the direct head diff', () => {
    const repo = makeRepo();
    const priorHead = startFeature(repo);
    commitFile(repo, 'a.txt', 'a pull request v2\n', 'pull request update');
    const head = commitFile(repo, 'c.txt', 'new pull request file\n', 'pull request new file');

    const direct = git(repo, ['diff', '--name-only', `${priorHead}..${head}`]).split('\n').filter(Boolean);
    assert.deepEqual(gitDeltaPathsSync(repo, priorHead, head), direct);
    assert.deepEqual(gitDeltaPathsSync(repo, priorHead, head), ['a.txt', 'c.txt']);
  });

  it('fails closed when a head or the base ref cannot be observed', () => {
    const repo = makeRepo();
    const priorHead = startFeature(repo);
    const head = commitFile(repo, 'a.txt', 'a pull request v2\n', 'pull request update');

    assert.equal(gitDeltaPathsSync(repo, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', head), null);
    assert.equal(gitChangedPathsSync(repo, 'no-such-ref', head), null);
  });
});
