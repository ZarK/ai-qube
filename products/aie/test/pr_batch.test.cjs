'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { runPrBatchService, formatPrBatch } = require('../dist/app/pr_batch.js');
const { writeValidLaneEvidence } = require('./support/triage_evidence.cjs');
const { getDefaults } = require('../dist/config/index.js');

const HEAD = 'abc123';

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'aie-batch-'));
  execFileSync('git', ['init', '--initial-branch', 'main'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo, stdio: 'ignore' });
  writeFileSync(join(repo, 'README.md'), 'batch fixture\n');
  execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo, stdio: 'ignore' });
  return repo;
}

function fakeGh() {
  const calls = [];
  const exec = async args => {
    calls.push(args);
    if (args[0] === 'pr' && args[1] === 'view') {
      return { args, exitCode: 0, stdout: JSON.stringify({ number: 12, headRefOid: HEAD, closingIssuesReferences: [{ number: 93 }] }), stderr: '' };
    }
    return { args, exitCode: 1, stdout: '', stderr: `unexpected gh call: ${args.join(' ')}` };
  };
  return { exec, calls };
}

function finding(id, severity, message, line) {
  return { id, severity, message, location: { path: 'src/app.ts', line } };
}

describe('pr batch', () => {
  it('merges the same defect across lanes and ranks blocking first over partial evidence', async () => {
    const repo = makeRepo();
    const shared = 'Duplicate evidence parsing on resume wastes filesystem round-trips.';
    writeValidLaneEvidence(repo, 'code-quality', [
      finding('cq-1', 'advisory', shared, 40),
      finding('cq-2', 'blocking', 'False success on empty verdicts.', 10),
    ], { status: 'needs-work', recommendation: 'request-changes' });
    writeValidLaneEvidence(repo, 'tests-quality', [finding('perf-1', 'advisory', shared, 40)]);
    const gh = fakeGh();

    const result = await runPrBatchService(getDefaults(), { prNumber: 12, repoRoot: repo, exec: gh.exec });

    assert.equal(result.batch.findings.length, 2);
    assert.equal(result.batch.findings[0].severity, 'blocking');
    const merged = result.batch.findings.find(entry => entry.message === shared);
    assert.ok(merged);
    assert.deepEqual(merged.lanes, ['code-quality', 'tests-quality']);
    assert.ok(result.lanesWithEvidence.includes('code-quality'));
    assert.ok(result.lanesWithEvidence.includes('tests-quality'));
    assert.equal(gh.calls.length, 1);
    assert.equal(gh.calls[0][0], 'pr');
    assert.equal(gh.calls[0][1], 'view');
    assert.match(result.nextAction, /one commit/);
  });

  it('reports the limitation and an empty batch without current-head evidence', async () => {
    const repo = makeRepo();
    const gh = fakeGh();

    const result = await runPrBatchService(getDefaults(), { prNumber: 12, repoRoot: repo, exec: gh.exec });

    assert.equal(result.batch.findings.length, 0);
    assert.ok(result.limitation);
    assert.equal(gh.calls.length, 1);
  });

  it('formats merged lane provenance in the human output', async () => {
    const repo = makeRepo();
    const shared = 'Duplicate evidence parsing on resume wastes filesystem round-trips.';
    writeValidLaneEvidence(repo, 'code-quality', [finding('cq-1', 'advisory', shared, 40)]);
    writeValidLaneEvidence(repo, 'tests-quality', [finding('perf-1', 'advisory', shared, 40)]);
    const gh = fakeGh();

    const result = await runPrBatchService(getDefaults(), { prNumber: 12, repoRoot: repo, exec: gh.exec });
    const text = formatPrBatch(result);

    assert.match(text, /code-quality\+tests-quality \(src\/app\.ts:40\)/);
  });
});
