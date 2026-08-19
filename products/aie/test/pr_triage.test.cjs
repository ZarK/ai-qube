'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { runPrTriageService, formatPrTriage } = require('../dist/app/pr_triage.js');
const { writeApprovedHead: writeApprovedHeadSupport, writeValidLaneEvidence: writeValidLaneEvidenceSupport } = require('./support/triage_evidence.cjs');
const { basePr, makePrExec } = require('./support/pr_gate_fixture.cjs');
const { getDefaults } = require('../dist/config/index.js');

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'aie-triage-'));
  execFileSync('git', ['init', '--initial-branch', 'main'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo, stdio: 'ignore' });
  writeFileSync(join(repo, 'README.md'), 'triage fixture\n');
  execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo, stdio: 'ignore' });
  return repo;
}

function repoHead(repo) {
  return execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
}

function advisoryFinding(id, message, { path = 'src/app.ts', line = 10, suggestion } = {}) {
  return { id, severity: 'advisory', message, location: { path, line }, ...(suggestion ? { suggestion } : {}) };
}

function fakeGh({ repo, prOverrides = {}, threads = [] }) {
  const pr = basePr({ headRefOid: repoHead(repo), closingIssuesReferences: [{ number: 93 }], ...prOverrides });
  const base = makePrExec({ prViews: [pr], threads });
  return { exec: base.exec, calls: base.calls };
}

function writeApprovedHead(repo, codeQualityFindings, options = {}) {
  writeApprovedHeadSupport(repo, codeQualityFindings, { ...options, headSha: options.headSha ?? repoHead(repo) });
}

function writeValidLaneEvidence(repo, lane, findings, options = {}) {
  writeValidLaneEvidenceSupport(repo, lane, findings, { ...options, headSha: options.headSha ?? repoHead(repo) });
}

function assertNoMutations(gh) {
  assert.equal(gh.calls.some(args => args[0] === 'issue' && args[1] === 'create'), false);
  assert.equal(gh.calls.some(args => args[0] === 'pr' && args[1] === 'comment'), false);
}

describe('pr triage', () => {
  it('reports residual advisories on an approved head without mutating GitHub', async () => {
    const repo = makeRepo();
    writeApprovedHead(repo, [advisoryFinding('cq-1', 'Duplicate parsing of lane evidence files on resume.')]);
    const gh = fakeGh({ repo });

    const result = await runPrTriageService(getDefaults(), { prNumber: 12, repoRoot: repo, exec: gh.exec });

    assert.equal(result.approvedHead, true);
    assert.equal(result.advisories.length, 1);
    assert.equal(result.advisories[0].disposition, 'reported');
    assert.equal(result.advisories[0].lane, 'code-quality');
    assert.equal('dryRun' in result, false);
    assert.equal('linkComment' in result, false);
    assert.equal('failures' in result, false);
    assert.equal('issueNumber' in result.advisories[0], false);
    assert.equal('issueUrl' in result.advisories[0], false);
    assertNoMutations(gh);
  });

  it('blocks advisory disposition when required lane coverage is incomplete', async () => {
    const repo = makeRepo();
    writeValidLaneEvidence(repo, 'code-quality', [advisoryFinding('cq-1', 'A single passed lane must not authorize filings.')]);
    const gh = fakeGh({ repo });

    const result = await runPrTriageService(getDefaults(), { prNumber: 12, repoRoot: repo, exec: gh.exec });

    assert.equal(result.approvedHead, false);
    assert.ok(result.missingRequiredLanes.length > 0);
    assert.ok(result.advisories.every(advisory => advisory.disposition === 'blocked'));
    assertNoMutations(gh);
    assert.match(result.nextAction, /Required lane coverage is incomplete/);
  });

  it('uses the gate changed-path lane set when conditional lanes are inactive', async () => {
    const repo = makeRepo();
    writeValidLaneEvidence(repo, 'issue-compliance', []);
    writeValidLaneEvidence(repo, 'code-quality', [advisoryFinding('cq-1', 'Keep the focused advisory visible.')]);
    writeValidLaneEvidence(repo, 'performance', [], { status: 'needs-work', recommendation: 'request-changes' });
    const gh = fakeGh({ repo });
    const defaults = getDefaults();
    const config = {
      ...defaults,
      reviewProfile: 'local-focused',
      reviewLanes: [
        { id: 'issue-compliance', required: 'always', match: [] },
        { id: 'code-quality', required: 'always', match: [] },
        { id: 'performance', required: 'when-matched', match: ['src/performance/**'] },
      ],
    };

    const result = await runPrTriageService(config, { prNumber: 12, repoRoot: repo, exec: gh.exec });

    assert.equal(result.approvedHead, true);
    assert.deepEqual(result.missingRequiredLanes, []);
    assert.equal(result.advisories[0].disposition, 'reported');
    assertNoMutations(gh);
  });

  it('fails closed when the local checkout does not match the PR head', async () => {
    const repo = makeRepo();
    writeApprovedHead(repo, []);
    const gh = fakeGh({ repo, prOverrides: { headRefOid: 'f'.repeat(40) } });

    await assert.rejects(
      runPrTriageService(getDefaults(), { prNumber: 12, repoRoot: repo, exec: gh.exec }),
      /Local checkout HEAD .* does not match PR #12 head/,
    );
    assertNoMutations(gh);
  });

  it('blocks advisory disposition when the head carries blocking lane verdicts', async () => {
    const repo = makeRepo();
    writeApprovedHead(repo, [], { except: ['code-quality'] });
    writeValidLaneEvidence(repo, 'performance', [advisoryFinding('perf-1', 'Sequential dedupe searches scale linearly with advisories.')]);
    writeValidLaneEvidence(repo, 'code-quality', [], { status: 'needs-work', recommendation: 'request-changes' });
    const gh = fakeGh({ repo });

    const result = await runPrTriageService(getDefaults(), { prNumber: 12, repoRoot: repo, exec: gh.exec });

    assert.equal(result.approvedHead, false);
    assert.deepEqual(result.blockingLanes, ['code-quality']);
    assert.ok(result.advisories.every(advisory => advisory.disposition === 'blocked'));
    assertNoMutations(gh);
    assert.match(result.nextAction, /blocking lane verdicts/);
  });

  it('reports an empty advisory list when none remain', async () => {
    const repo = makeRepo();
    writeApprovedHead(repo, []);
    const gh = fakeGh({ repo });

    const result = await runPrTriageService(getDefaults(), { prNumber: 12, repoRoot: repo, exec: gh.exec });

    assert.equal(result.advisories.length, 0);
    assert.equal(result.approvedHead, true);
    assertNoMutations(gh);
    assert.match(result.nextAction, /No residual advisories/);
  });

  it('names the local-only fields limitation when no terminal local evidence exists', async () => {
    const repo = makeRepo();
    const gh = fakeGh({ repo });

    const result = await runPrTriageService(getDefaults(), { prNumber: 12, repoRoot: repo, exec: gh.exec });

    assert.ok(result.limitation);
    assert.match(result.limitation, /local-only fields/);
    assert.match(result.nextAction, /pr gate/);
    assertNoMutations(gh);
  });

  it('blocks advisory disposition when a configured provider review source recorded a blocking finding', async () => {
    const repo = makeRepo();
    writeApprovedHead(repo, [advisoryFinding('cq-1', 'Duplicate parsing of lane evidence files on resume.')]);
    const gh = fakeGh({ repo, prOverrides: { reviewDecision: 'CHANGES_REQUESTED', latestReviews: [{ author: { login: 'coderabbitai' }, state: 'CHANGES_REQUESTED', body: 'This regresses retries.', commit: { oid: repoHead(repo) } }] } });

    const result = await runPrTriageService(getDefaults(), { prNumber: 12, repoRoot: repo, exec: gh.exec });

    assert.equal(result.approvedHead, false);
    assert.deepEqual(result.blockingProviderSources, ['provider-reviewers']);
    assert.ok(result.advisories.every(advisory => advisory.disposition === 'blocked'));
    assertNoMutations(gh);
    assert.match(result.nextAction, /blocking provider-visible review findings/);
  });

  it('reports a provider-sourced advisory finding with source attribution', async () => {
    const repo = makeRepo();
    writeApprovedHead(repo, []);
    const gh = fakeGh({
      repo,
      prOverrides: {
        reviewDecision: 'REVIEW_REQUIRED',
        comments: [{ author: { login: 'coderabbitai' }, body: 'Consider caching this lookup for repeat reads.', url: 'https://github.com/example/repo/pull/12#issuecomment-9' }],
      },
    });

    const result = await runPrTriageService(getDefaults(), { prNumber: 12, repoRoot: repo, exec: gh.exec });

    assert.equal(result.approvedHead, true);
    assert.equal(result.advisories.length, 1);
    assert.equal(result.advisories[0].lane, 'provider:provider-reviewers');
    assert.equal(result.advisories[0].disposition, 'reported');
    assertNoMutations(gh);
  });

  it('formats a human summary with reported dispositions and locations', async () => {
    const repo = makeRepo();
    writeApprovedHead(repo, [advisoryFinding('cq-1', 'Duplicate parsing of lane evidence files on resume.')]);
    const gh = fakeGh({ repo });
    const result = await runPrTriageService(getDefaults(), { prNumber: 12, repoRoot: repo, exec: gh.exec });

    const text = formatPrTriage(result);
    assert.match(text, /PR advisory triage for #12:/);
    assert.doesNotMatch(text, /dry-run/i);
    assert.match(text, /\[reported\] code-quality \(src\/app\.ts:10\)/);
    assert.doesNotMatch(text, /\[planned\]/);
  });
});
