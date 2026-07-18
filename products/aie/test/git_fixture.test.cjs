'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { execFileSync } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { cloneGitRepo } = require('./support/git_fixture.cjs');

function head(repo) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
}

describe('git fixture templates', () => {
  it('produces the committed repository shape the subprocess ceremony produced', () => {
    const repo = cloneGitRepo('committed', 'aie-fixture-shape-');
    const branch = execFileSync('git', ['branch', '--show-current'], { cwd: repo, encoding: 'utf8' }).trim();
    assert.equal(branch, 'main');
    const originMain = execFileSync('git', ['rev-parse', 'refs/remotes/origin/main'], { cwd: repo, encoding: 'utf8' }).trim();
    assert.equal(originMain, head(repo));
    const email = execFileSync('git', ['config', 'user.email'], { cwd: repo, encoding: 'utf8' }).trim();
    assert.equal(email, 'executor@example.invalid');
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim();
    assert.equal(status, '');
  });

  it('keeps clones fully independent of the template and each other', () => {
    const first = cloneGitRepo('committed', 'aie-fixture-independent-');
    const second = cloneGitRepo('committed', 'aie-fixture-independent-');
    const baseline = head(second);
    writeFileSync(join(first, 'extra.txt'), 'mutation\n');
    execFileSync('git', ['add', 'extra.txt'], { cwd: first, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'mutation'], { cwd: first, stdio: 'ignore' });
    assert.notEqual(head(first), baseline);
    assert.equal(head(second), baseline, 'a mutation in one clone must never leak into another');
    const third = cloneGitRepo('committed', 'aie-fixture-independent-');
    assert.equal(head(third), baseline, 'a mutation in a clone must never leak into the template');
  });

  it('rejects unknown fixture shapes loudly', () => {
    assert.throws(() => cloneGitRepo('mystery', 'aie-fixture-bad-'), /unknown git fixture shape/);
  });
});
