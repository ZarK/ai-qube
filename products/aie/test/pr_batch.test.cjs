'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { runPrBatchService, formatPrBatch } = require('../dist/app/pr_batch.js');
const { writeValidLaneEvidence } = require('./support/triage_evidence.cjs');
const { basePr, makePrExec } = require('./support/pr_gate_fixture.cjs');
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

function fakeGh({ threads, ...overrides } = {}) {
  const pr = basePr({ headRefOid: HEAD, closingIssuesReferences: [{ number: 93 }], ...overrides });
  return makePrExec({ prViews: [pr], threads: threads ?? [] });
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
    const { exec } = fakeGh();

    const result = await runPrBatchService(getDefaults(), { prNumber: 12, repoRoot: repo, exec });

    assert.equal(result.batch.findings.length, 2);
    assert.equal(result.batch.findings[0].severity, 'blocking');
    const merged = result.batch.findings.find(entry => entry.message === shared);
    assert.ok(merged);
    assert.deepEqual(merged.lanes, ['code-quality', 'tests-quality']);
    assert.deepEqual(merged.sources, ['local:code-quality', 'local:tests-quality']);
    assert.ok(result.lanesWithEvidence.includes('code-quality'));
    assert.ok(result.lanesWithEvidence.includes('tests-quality'));
    assert.match(result.nextAction, /one commit/);
  });

  it('reports the limitation and an empty batch without current-head evidence', async () => {
    const repo = makeRepo();
    const { exec } = fakeGh();

    const result = await runPrBatchService(getDefaults(), { prNumber: 12, repoRoot: repo, exec });

    assert.equal(result.batch.findings.length, 0);
    assert.ok(result.limitation);
  });

  it('formats merged lane provenance in the human output', async () => {
    const repo = makeRepo();
    const shared = 'Duplicate evidence parsing on resume wastes filesystem round-trips.';
    writeValidLaneEvidence(repo, 'code-quality', [finding('cq-1', 'advisory', shared, 40)]);
    writeValidLaneEvidence(repo, 'tests-quality', [finding('perf-1', 'advisory', shared, 40)]);
    const { exec } = fakeGh();

    const result = await runPrBatchService(getDefaults(), { prNumber: 12, repoRoot: repo, exec });
    const text = formatPrBatch(result);

    assert.match(text, /code-quality\+tests-quality \(src\/app\.ts:40\)/);
  });

  it('enters a blocking finding present only in the provider record (not local evidence) into the fix batch', async () => {
    const repo = makeRepo();
    const { exec } = fakeGh({
      reviewDecision: 'CHANGES_REQUESTED',
      latestReviews: [{ author: { login: 'coderabbitai' }, state: 'CHANGES_REQUESTED', body: 'This breaks the retry loop under load.', commit: { oid: HEAD } }],
    });

    const result = await runPrBatchService(getDefaults(), { prNumber: 12, repoRoot: repo, exec });

    assert.equal(result.batch.findings.length, 1);
    const providerFinding = result.batch.findings[0];
    assert.equal(providerFinding.severity, 'blocking');
    assert.deepEqual(providerFinding.lanes, []);
    assert.deepEqual(providerFinding.sources, ['provider:provider-reviewers']);
    assert.match(providerFinding.message, /retry loop/);
    assert.equal(result.limitation, null);
  });

  it('yields one deduplicated findings set with source attribution from mixed local and provider sources', async () => {
    const repo = makeRepo();
    const shared = 'Duplicate evidence parsing on resume wastes filesystem round-trips.';
    writeValidLaneEvidence(repo, 'code-quality', [finding('cq-1', 'advisory', shared, 40)]);
    const threads = [{ isResolved: false, comments: { nodes: [{ author: { login: 'coderabbitai' }, body: 'Unrelated inline defect.', url: 'https://github.com/example/repo/pull/12#discussion_r1', path: 'src/other.ts', line: 5 }] } }];
    const { exec } = fakeGh({ reviewDecision: 'REVIEW_REQUIRED', threads });

    const result = await runPrBatchService(getDefaults(), { prNumber: 12, repoRoot: repo, exec });

    assert.equal(result.batch.findings.length, 2);
    const localFinding = result.batch.findings.find(entry => entry.message === shared);
    const providerFinding = result.batch.findings.find(entry => entry.message !== shared);
    assert.ok(localFinding);
    assert.deepEqual(localFinding.sources, ['local:code-quality']);
    assert.ok(providerFinding);
    assert.equal(providerFinding.severity, 'blocking');
    assert.deepEqual(providerFinding.sources, ['provider:provider-reviewers']);
    assert.equal(providerFinding.location.path, 'src/other.ts');
  });
});
