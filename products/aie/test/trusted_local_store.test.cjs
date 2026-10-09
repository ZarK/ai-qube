const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');
const { describe, it } = require('node:test');
const { cloneGitRepo } = require('./support/git_fixture.cjs');
const { resolveTrustedLocalStore } = require('../dist/trusted_local_store.js');
const { localReviewEvidenceSha256, readTrustedStoreJson } = require('../dist/local_review_evidence.js');
const {
  clearRouteFault, laneEvidencePath, mkdirTrustedStoreSync, readRouteFaults,
  recordRouteFault, routeFaultLedgerPath, runExternalLane, verifyReviewWriteContainment,
  writeLane, writeReviewFileGuarded, writeTrustedRoutedProvenance,
} = require('../dist/app/local_review_runner_support.js');

function linkedRepos(t) {
  const primary = cloneGitRepo('committed', 'aie-trusted-store-');
  const directory = mkdtempSync(join(tmpdir(), 'aie-linked-stores-'));
  const worktrees = ['first', 'second'].map(name => join(directory, name));
  for (const worktree of worktrees) {
    execFileSync('git', ['worktree', 'add', '--detach', worktree, 'HEAD'], { cwd: primary, stdio: 'ignore' });
  }
  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
    rmSync(primary, { recursive: true, force: true });
  });
  return { primary, worktrees };
}

describe('trusted local store', () => {
  it('isolates route faults, review inputs, and host provenance in each checkout git directory', async t => {
    const { primary, worktrees } = linkedRepos(t);
    const roots = [primary, ...worktrees];
    for (const [index, repo] of roots.entries()) {
      const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: repo, encoding: 'utf8' }).trim();
      const store = resolveTrustedLocalStore(repo);
      assert.equal(store.path, join(gitDir, 'qube', 'aie'));
      if (index === 0) assert.equal(store.path, join(primary, '.git', 'qube', 'aie'));
      else assert.equal(lstatSync(join(repo, '.git')).isFile(), true);
      assert.deepEqual(readRouteFaults(repo, 21, 22), { version: 1, lanes: {} });
      assert.equal(recordRouteFault(repo, 21, 22, 'code-quality', 'process-failed', `route-${index}`), 1);
      const ledgerPath = routeFaultLedgerPath(store, 21, 22);
      assert.equal(ledgerPath, join(gitDir, 'qube', 'aie', 'route-faults', '21', '22.json'));
      assert.equal(readRouteFaults(repo, 21, 22).lanes['code-quality'].routeKey, `route-${index}`);
      assert.equal(readTrustedStoreJson(store.root, store.subtree, ledgerPath).version, 1);

      const evidencePath = laneEvidencePath(repo, 21, 22, 'abc123', 'code-quality');
      let reviewInput;
      await runExternalLane('review', 'code-quality', 21, 22, 'abc123', 'local-focused', 'local-host', 'prompt-hash', repo, evidencePath, [], async args => {
        const path = args[args.indexOf('--review-bundle') + 1];
        assert.equal(path, join(store.path, 'review-inputs', '21', '22', 'abc123', 'code-quality.json'));
        reviewInput = readTrustedStoreJson(store.root, store.subtree, path);
        return { args, exitCode: 1, stdout: '', stderr: 'Review stopped.' };
      }, [], { host: 'codex' });
      assert.equal(reviewInput.evidencePath, evidencePath);
      assert.equal(reviewInput.promptStackHash, 'prompt-hash');

      const lane = {
        id: 'code-quality', status: 'passed', severity: 'none', recommendation: 'approve',
        summary: 'Review complete.', blockers: [], findings: [], artifacts: [], commands: [],
        surfaces: [], contextReviewed: [], promptStack: [], toolsUsed: [], completeness: 'Complete.', preconditions: [],
        runnerProvenance: { runnerKind: 'local-host', host: 'codex', freshContext: true, promptOnly: false, promptStackHash: 'prompt-hash' },
      };
      writeLane(repo, 21, 22, 'abc123', 'local-focused', lane, 'local-host');
      const provenancePath = writeTrustedRoutedProvenance(repo, 21, 22, 'abc123', lane);
      assert.equal(provenancePath, join(store.path, 'host-provenance', '21', '22', 'abc123', 'code-quality.json'));
      const provenance = readTrustedStoreJson(store.root, store.subtree, provenancePath);
      assert.equal(provenance.evidenceSha256, localReviewEvidenceSha256(JSON.parse(readFileSync(evidencePath, 'utf8'))));
      assert.equal(provenance.promptStackHash, 'prompt-hash');
    }
    clearRouteFault(worktrees[0], 21, 22, 'code-quality');
    assert.deepEqual(readRouteFaults(worktrees[0], 21, 22).lanes, {});
    assert.equal(readRouteFaults(primary, 21, 22).lanes['code-quality'].count, 1);
    assert.equal(readRouteFaults(worktrees[1], 21, 22).lanes['code-quality'].count, 1);
  });

  it('refuses symlinked store components in a linked worktree', t => {
    const { primary, worktrees } = linkedRepos(t);
    const repo = worktrees[0];
    const outside = join(primary, 'outside');
    mkdirSync(outside);
    const store = resolveTrustedLocalStore(repo);
    mkdirSync(dirname(store.path), { recursive: true });
    symlinkSync(outside, join(dirname(store.path), 'aie'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => recordRouteFault(repo, 21, 22, 'code-quality', 'failed', 'route'), /symlink|junction/);
    assert.throws(() => readRouteFaults(repo, 21, 22), /symlink|junction/);
    const path = join(store.path, 'review-inputs', 'input.json');
    assert.throws(() => mkdirTrustedStoreSync(dirname(path), store), /symlink|junction/);
    assert.throws(() => writeReviewFileGuarded(path, '{}', store), /containment|symlink|junction/);
    assert.throws(() => readTrustedStoreJson(store.root, store.subtree, path), /symlink|junction/);
    assert.deepEqual(readdirSync(outside), []);
  });

  it('rejects paths outside the resolved store and invalid git markers without a fallback', t => {
    const { primary } = linkedRepos(t);
    const store = resolveTrustedLocalStore(primary);
    mkdirTrustedStoreSync(store.path, store);
    const outside = join(primary, 'outside.json');
    assert.throws(() => verifyReviewWriteContainment(outside, store), /outside|containment/);
    assert.throws(() => writeReviewFileGuarded(outside, '{}', store), /outside|containment/);
    assert.equal(existsSync(outside), false);
    const invalid = join(primary, 'invalid');
    mkdirSync(invalid);
    writeFileSync(join(invalid, '.git'), 'gitdir: missing\n');
    assert.throws(() => resolveTrustedLocalStore(invalid), /Cannot resolve the trusted local store git directory/);
    assert.throws(() => recordRouteFault(invalid, 21, 22, 'code-quality', 'failed', 'route'), /Cannot resolve/);
    assert.equal(readFileSync(join(invalid, '.git'), 'utf8'), 'gitdir: missing\n');
  });
});
