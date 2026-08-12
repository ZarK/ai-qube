'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { execFileSync } = require('node:child_process');
const { mkdirSync, mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { runPrTriageService, formatPrTriage } = require('../dist/app/pr_triage.js');
const { writeApprovedHead: writeApprovedHeadSupport, writeValidLaneEvidence } = require('./support/triage_evidence.cjs');
const { basePr, makePrExec } = require('./support/pr_gate_fixture.cjs');
const { getDefaults } = require('../dist/config/index.js');

const HEAD = 'abc123';

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

function writeLaneEvidence(repo, lane, findings, { issueNumber = 93, prNumber = 12, status = 'passed', recommendation = 'approve' } = {}) {
  const directory = join(repo, '.qube', 'aie', 'reviews', String(issueNumber), String(prNumber), HEAD);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${lane}.json`), `${JSON.stringify({
    version: 1,
    issueNumber,
    prNumber,
    headSha: HEAD,
    lane,
    status,
    recommendation,
    summary: `${lane} reviewed`,
    findings,
  }, null, 2)}\n`);
}

function advisoryFinding(id, message, { path = 'src/app.ts', line = 10, suggestion } = {}) {
  return { id, severity: 'advisory', message, location: { path, line }, ...(suggestion ? { suggestion } : {}) };
}

function fakeGh({ existingSearchHits = {}, createdUrls = [], prOverrides = {}, threads = [] } = {}) {
  let createIndex = 0;
  const pr = basePr({ headRefOid: HEAD, closingIssuesReferences: [{ number: 93 }], ...prOverrides });
  const base = makePrExec({ prViews: [pr], threads });
  const exec = async args => {
    if (args[0] === 'issue' && args[1] === 'list') {
      const searchIndex = args.indexOf('--search');
      const query = searchIndex >= 0 ? args[searchIndex + 1] : '';
      const hit = Object.entries(existingSearchHits).find(([key]) => query.includes(key));
      const result = { args, exitCode: 0, stdout: JSON.stringify(hit ? [{ ...hit[1], body: hit[1].body ?? `Dedupe key: ${hit[0]}` }] : []), stderr: '' };
      base.calls.push(args);
      return result;
    }
    if (args[0] === 'issue' && args[1] === 'create') {
      const url = createdUrls[createIndex] ?? `https://github.com/example/repo/issues/${900 + createIndex}`;
      createIndex += 1;
      const result = { args, exitCode: 0, stdout: `${url}\n`, stderr: '' };
      base.calls.push(args);
      return result;
    }
    return base.exec(args);
  };
  return { exec, calls: base.calls };
}

function writeApprovedHead(repo, codeQualityFindings, options = {}) {
  writeApprovedHeadSupport(repo, codeQualityFindings, options);
}

function repoHead(repo) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
}

describe('pr triage', () => {
  it('plans follow-up issues in dry-run without provider mutation or head changes', async () => {
    const repo = makeRepo();
    writeApprovedHead(repo, [advisoryFinding('cq-1', 'Duplicate parsing of lane evidence files on resume.')]);
    const gh = fakeGh();
    const headBefore = repoHead(repo);

    const result = await runPrTriageService(getDefaults(), { prNumber: 12, repoRoot: repo, dryRun: true, exec: gh.exec });

    assert.equal(result.dryRun, true);
    assert.equal(result.advisories.length, 1);
    assert.equal(result.advisories[0].disposition, 'planned');
    assert.equal(result.linkComment, 'planned');
    assert.equal(gh.calls.some(args => args[0] === 'issue' && args[1] === 'create'), false);
    assert.equal(gh.calls.some(args => args[0] === 'pr' && args[1] === 'comment'), false);
    assert.equal(repoHead(repo), headBefore);
  });

  it('files deduplicated follow-up issues with provenance and links them on the pull request', async () => {
    const repo = makeRepo();
    writeApprovedHead(repo, [
      advisoryFinding('cq-1', 'Duplicate parsing of lane evidence files on resume.', { suggestion: 'Cache parsed evidence per head.' }),
      advisoryFinding('cq-2', 'Runner summary omits reuse counts in planned mode.', { path: 'src/runner.ts', line: 42 }),
    ]);
    const gh = fakeGh();

    const result = await runPrTriageService(getDefaults(), { prNumber: 12, repoRoot: repo, dryRun: false, exec: gh.exec });

    assert.equal(result.advisories.length, 2);
    assert.ok(result.advisories.every(advisory => advisory.disposition === 'created' && advisory.issueUrl));
    const createCalls = gh.calls.filter(args => args[0] === 'issue' && args[1] === 'create');
    assert.equal(createCalls.length, 2);
    const firstBody = createCalls[0][createCalls[0].indexOf('--body') + 1];
    assert.match(firstBody, /Lane: code-quality/);
    assert.match(firstBody, /src\/app\.ts:10/);
    assert.match(firstBody, /Dedupe key: `qube-advisory:[0-9a-f]{16}`/);
    assert.match(firstBody, /pull\/12/);
    assert.equal(result.linkComment, 'posted');
    const commentCall = gh.calls.find(args => args[0] === 'pr' && args[1] === 'comment');
    assert.ok(commentCall);
    assert.match(commentCall[commentCall.indexOf('--body') + 1], /follow-up issues instead of new commits/);
  });

  it('dedupes advisories already tracked by open issues', async () => {
    const repo = makeRepo();
    writeApprovedHead(repo, [advisoryFinding('cq-1', 'Duplicate parsing of lane evidence files on resume.')]);
    const probe = fakeGh();
    const planned = await runPrTriageService(getDefaults(), { prNumber: 12, repoRoot: repo, dryRun: true, exec: probe.exec });
    const dedupeKey = planned.advisories[0].dedupeKey;
    const gh = fakeGh({ existingSearchHits: { [dedupeKey]: { number: 777, url: 'https://github.com/example/repo/issues/777' } } });

    const result = await runPrTriageService(getDefaults(), { prNumber: 12, repoRoot: repo, dryRun: false, exec: gh.exec });

    assert.equal(result.advisories[0].disposition, 'existing');
    assert.equal(result.advisories[0].issueNumber, 777);
    assert.equal(gh.calls.some(args => args[0] === 'issue' && args[1] === 'create'), false);
    assert.equal(gh.calls.some(args => args[0] === 'pr' && args[1] === 'comment'), false);
    assert.equal(result.linkComment, 'skipped');
  });

  it('refuses to file follow-up issues when required lane coverage is incomplete', async () => {
    const repo = makeRepo();
    writeValidLaneEvidence(repo, 'code-quality', [advisoryFinding('cq-1', 'A single passed lane must not authorize filings.')]);
    const gh = fakeGh();

    const result = await runPrTriageService(getDefaults(), { prNumber: 12, repoRoot: repo, dryRun: false, exec: gh.exec });

    assert.equal(result.approvedHead, false);
    assert.ok(result.missingRequiredLanes.length > 0);
    assert.equal(gh.calls.some(args => args[0] === 'issue' && args[1] === 'create'), false);
    assert.equal(gh.calls.some(args => args[0] === 'pr' && args[1] === 'comment'), false);
    assert.match(result.nextAction, /Required lane coverage is incomplete/);
  });

  it('refuses to file follow-up issues when the head carries blocking lane verdicts', async () => {
    const repo = makeRepo();
    writeApprovedHead(repo, [], { except: ['code-quality'] });
    writeValidLaneEvidence(repo, 'performance', [advisoryFinding('perf-1', 'Sequential dedupe searches scale linearly with advisories.')]);
    writeValidLaneEvidence(repo, 'code-quality', [], { status: 'needs-work', recommendation: 'request-changes' });
    const gh = fakeGh();

    const result = await runPrTriageService(getDefaults(), { prNumber: 12, repoRoot: repo, dryRun: false, exec: gh.exec });

    assert.equal(result.approvedHead, false);
    assert.deepEqual(result.blockingLanes, ['code-quality']);
    assert.ok(result.advisories.every(advisory => advisory.disposition === 'blocked'));
    assert.equal(gh.calls.some(args => args[0] === 'issue' && args[1] === 'create'), false);
    assert.equal(gh.calls.some(args => args[0] === 'pr' && args[1] === 'comment'), false);
    assert.match(result.nextAction, /blocking lane verdicts/);
  });

  it('continues past a failed issue creation and reports the partial state', async () => {
    const repo = makeRepo();
    writeApprovedHead(repo, [
      advisoryFinding('cq-1', 'First advisory that fails to file.'),
      advisoryFinding('cq-2', 'Second advisory that files cleanly.', { path: 'src/runner.ts', line: 7 }),
    ]);
    const gh = fakeGh();
    let createAttempts = 0;
    const exec = async args => {
      if (args[0] === 'issue' && args[1] === 'create') {
        createAttempts += 1;
        if (createAttempts === 1) return { args, exitCode: 1, stdout: '', stderr: 'rate limited' };
      }
      return gh.exec(args);
    };

    const result = await runPrTriageService(getDefaults(), { prNumber: 12, repoRoot: repo, dryRun: false, exec });

    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0], /rate limited|gh issue create/);
    assert.equal(result.advisories.filter(advisory => advisory.disposition === 'created').length, 1);
    assert.equal(result.advisories.filter(advisory => advisory.disposition === 'blocked').length, 1);
    assert.match(result.nextAction, /rerun/i);
  });

  it('reports an empty plan when no advisories remain', async () => {
    const repo = makeRepo();
    writeApprovedHead(repo, []);
    const gh = fakeGh();

    const result = await runPrTriageService(getDefaults(), { prNumber: 12, repoRoot: repo, dryRun: false, exec: gh.exec });

    assert.equal(result.advisories.length, 0);
    assert.equal(result.linkComment, 'skipped');
    assert.match(result.nextAction, /No residual advisories/);
  });

  it('names the local-only fields limitation when no terminal local evidence exists', async () => {
    const repo = makeRepo();
    const gh = fakeGh();

    const result = await runPrTriageService(getDefaults(), { prNumber: 12, repoRoot: repo, dryRun: true, exec: gh.exec });

    assert.ok(result.limitation);
    assert.match(result.limitation, /local-only fields/);
    assert.match(result.nextAction, /pr gate/);
  });

  it('refuses to file follow-up issues when a configured provider review source recorded a blocking finding', async () => {
    const repo = makeRepo();
    writeApprovedHead(repo, [advisoryFinding('cq-1', 'Duplicate parsing of lane evidence files on resume.')]);
    const gh = fakeGh({ prOverrides: { reviewDecision: 'CHANGES_REQUESTED', latestReviews: [{ author: { login: 'coderabbitai' }, state: 'CHANGES_REQUESTED', body: 'This regresses retries.', commit: { oid: HEAD } }] } });

    const result = await runPrTriageService(getDefaults(), { prNumber: 12, repoRoot: repo, dryRun: false, exec: gh.exec });

    assert.equal(result.approvedHead, false);
    assert.deepEqual(result.blockingProviderSources, ['provider-reviewers']);
    assert.ok(result.advisories.every(advisory => advisory.disposition === 'blocked'));
    assert.equal(gh.calls.some(args => args[0] === 'issue' && args[1] === 'create'), false);
    assert.match(result.nextAction, /blocking provider-visible review findings/);
  });

  it('files a provider-sourced advisory finding as a follow-up issue with source attribution', async () => {
    const repo = makeRepo();
    writeApprovedHead(repo, []);
    const gh = fakeGh({
      prOverrides: {
        reviewDecision: 'REVIEW_REQUIRED',
        comments: [{ author: { login: 'coderabbitai' }, body: 'Consider caching this lookup for repeat reads.', url: 'https://github.com/example/repo/pull/12#issuecomment-9' }],
      },
    });

    const result = await runPrTriageService(getDefaults(), { prNumber: 12, repoRoot: repo, dryRun: false, exec: gh.exec });

    assert.equal(result.approvedHead, true);
    assert.equal(result.advisories.length, 1);
    assert.equal(result.advisories[0].lane, 'provider:provider-reviewers');
    assert.equal(result.advisories[0].disposition, 'created');
    const createCalls = gh.calls.filter(args => args[0] === 'issue' && args[1] === 'create');
    assert.equal(createCalls.length, 1);
  });

  it('formats a human summary with dispositions and locations', async () => {
    const repo = makeRepo();
    writeApprovedHead(repo, [advisoryFinding('cq-1', 'Duplicate parsing of lane evidence files on resume.')]);
    const gh = fakeGh();
    const result = await runPrTriageService(getDefaults(), { prNumber: 12, repoRoot: repo, dryRun: true, exec: gh.exec });

    const text = formatPrTriage(result);
    assert.match(text, /PR advisory triage for #12 \(dry-run\)/);
    assert.match(text, /\[planned\] code-quality \(src\/app\.ts:10\)/);
  });
});
