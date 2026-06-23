const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { describe, it } = require('node:test');

const { planChecklistUpdate } = require('../dist/checklist.js');
const { updateIssueChecklist } = require('../dist/app/issue_checklist.js');
const { verifyIssueChecklist } = require('../dist/app/checklist_verify.js');

function issue(number, body) {
  return {
    number,
    title: 'Checklist issue',
    body,
    state: 'OPEN',
    labels: [{ name: 'S-InProgress' }],
    milestone: null,
    url: `https://github.com/example/repo/issues/${number}`,
  };
}

function issueViewKey(number) {
  return `issue view ${number} --json number,title,state,labels,body,milestone,url`;
}

function success(args, stdout = '') {
  return { args, exitCode: 0, stdout, stderr: '' };
}

function makeExec(responses, calls = []) {
  return async args => {
    calls.push(args);
    const key = args.join(' ');
    return responses[key] ?? { args, exitCode: 1, stdout: '', stderr: `unexpected gh call: ${key}` };
  };
}

describe('issue checklist mutation', () => {
  it('plans exact issue checkbox updates while preserving unrelated body text', () => {
    const body = 'Intro\n- [ ] Acceptance A\n- [x] Acceptance B\nFooter';

    const result = planChecklistUpdate(body, { text: 'Acceptance A' }, 'checked');

    assert.equal(result.changed, true);
    assert.equal(result.updatedBody, 'Intro\n- [x] Acceptance A\n- [x] Acceptance B\nFooter');
    assert.equal(result.before.unchecked, 1);
    assert.equal(result.after.unchecked, 0);
    assert.equal(result.matchedItems[0].index, 1);
  });

  it('rejects ambiguous duplicate checklist item text', () => {
    const body = '- [ ] Repeat\n- [x] Repeat';

    assert.throws(() => planChecklistUpdate(body, { text: 'Repeat' }, 'checked'), /matched multiple items: #1, #2/);
  });

  it('blocks direct checked mutation and points to evidence-backed verification', async () => {
    await assert.rejects(
      () => updateIssueChecklist({ issueNumber: 93, selector: { index: 1 }, state: 'checked', dryRun: true, exec: makeExec({}) }),
      /direct checklist checking is restricted/,
    );
  });

  it('dry-runs unchecked maintenance mutation without editing GitHub', async () => {
    const calls = [];
    const exec = makeExec({
      [issueViewKey(93)]: success([], JSON.stringify(issue(93, '- [x] Acceptance A\n- [x] Acceptance B'))),
    }, calls);

    const result = await updateIssueChecklist({ issueNumber: 93, selector: { index: 1 }, state: 'unchecked', dryRun: true, exec });

    assert.equal(result.command, 'checklist update');
    assert.equal(result.mutation.status, 'planned');
    assert.equal(result.after.checked, 1);
    assert.equal(calls.some(args => args[0] === 'issue' && args[1] === 'edit'), false);
  });

  it('updates the issue body for unchecked maintenance when not in dry-run mode', async () => {
    const calls = [];
    const exec = makeExec({
      [issueViewKey(93)]: success([], JSON.stringify(issue(93, '- [x] Acceptance A\n- [x] Acceptance B'))),
      'issue edit 93 --body - [ ] Acceptance A\n- [x] Acceptance B': success([]),
    }, calls);

    const result = await updateIssueChecklist({ issueNumber: 93, selector: { text: 'Acceptance A' }, state: 'unchecked', dryRun: false, exec });

    assert.equal(result.mutation.status, 'completed');
    assert.ok(calls.some(args => args[0] === 'issue' && args[1] === 'edit' && args[3] === '--body' && args[4].includes('[ ] Acceptance A')));
  });

  it('renders a criterion-specific acceptance verification prompt', async () => {
    const exec = makeExec({
      [issueViewKey(93)]: success([], JSON.stringify(issue(93, 'Issue body\n- [ ] Acceptance A'))),
    });

    const result = await verifyIssueChecklist({ issueNumber: 93, index: 1, state: 'checked', dryRun: true, promptOnly: true, exec });

    assert.equal(result.command, 'checklist verify');
    assert.equal(result.prompt.category.id, 'acceptance-verification');
    assert.match(result.prompt.text, /Criterion #1: Acceptance A/);
    assert.match(result.prompt.text, /Issue body/);
    assert.match(result.prompt.outputContract, /acceptance verification evidence JSON/);
  });

  it('validates evidence before planning one checked mutation', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'aie-checklist-verify-'));
    const evidence = join(repo, 'evidence.json');
    writeFileSync(evidence, JSON.stringify({
      version: 1,
      issueNumber: 93,
      criterionIndex: 1,
      criterionText: 'Acceptance A',
      headSha: 'abc123',
      reviewer: { id: 'codex' },
      reviewedSources: ['issue:93', 'pr:12:diff'],
      artifacts: ['terminal-log'],
      recommendation: 'approve',
      recordedAt: '2026-06-23T00:00:00.000Z',
      promptStack: [{ id: 'acceptance/verify-criterion' }],
      summary: 'criterion verified',
    }));
    const calls = [];
    const exec = makeExec({
      [issueViewKey(93)]: success([], JSON.stringify(issue(93, 'Intro\n- [ ] Acceptance A\n- [ ] Acceptance B\nFooter'))),
      'pr view --json number,title,url,headRefOid': success([], JSON.stringify({ number: 12, title: 'PR', url: 'https://github.com/example/repo/pull/12', headRefOid: 'abc123' })),
    }, calls);

    const result = await verifyIssueChecklist({ issueNumber: 93, index: 1, state: 'checked', evidencePath: evidence, dryRun: true, promptOnly: false, exec });

    assert.equal(result.ok, true);
    assert.equal(result.evidence.status, 'valid');
    assert.equal(result.mutation.status, 'planned');
    assert.equal(calls.some(args => args[0] === 'issue' && args[1] === 'edit'), false);
  });

  it('recommends completion after the final criterion is verified', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'aie-checklist-verify-'));
    const evidence = join(repo, 'evidence.json');
    writeFileSync(evidence, JSON.stringify({
      version: 1,
      issueNumber: 93,
      criterionIndex: 1,
      criterionText: 'Acceptance A',
      reviewer: { id: 'codex' },
      reviewedSources: ['issue:93'],
      artifacts: ['terminal-log'],
      recommendation: 'approve',
      recordedAt: '2026-06-23T00:00:00.000Z',
      promptStack: [{ id: 'acceptance/verify-criterion' }],
    }));
    const exec = makeExec({
      [issueViewKey(93)]: success([], JSON.stringify(issue(93, '- [ ] Acceptance A'))),
    });

    const result = await verifyIssueChecklist({ issueNumber: 93, index: 1, state: 'checked', evidencePath: evidence, dryRun: true, promptOnly: false, exec });

    assert.equal(result.ok, true);
    assert.equal(result.mutation.status, 'planned');
    assert.match(result.nextAction, /aie complete 93 --check-only/);
  });

  it('rejects stale or incomplete acceptance verification evidence', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'aie-checklist-verify-'));
    const evidence = join(repo, 'bad-evidence.json');
    writeFileSync(evidence, JSON.stringify({ version: 1, issueNumber: 93, criterionIndex: 1, criterionText: 'Acceptance A', headSha: 'old' }));
    const exec = makeExec({
      [issueViewKey(93)]: success([], JSON.stringify(issue(93, '- [ ] Acceptance A'))),
      'pr view --json number,title,url,headRefOid': success([], JSON.stringify({ number: 12, title: 'PR', url: 'https://github.com/example/repo/pull/12', headRefOid: 'abc123' })),
    });

    const result = await verifyIssueChecklist({ issueNumber: 93, index: 1, state: 'checked', evidencePath: evidence, dryRun: false, promptOnly: false, exec });

    assert.equal(result.ok, false);
    assert.equal(result.evidence.status, 'invalid');
    assert.ok(result.evidence.errors.some(error => error.includes('headSha')));
    assert.ok(result.evidence.errors.some(error => error.includes('reviewer')));
  });

  it('prints safe usage for incomplete checklist update command forms', () => {
    const plain = spawnSync(process.execPath, ['./bin/run', 'checklist', 'update'], { cwd: process.cwd(), encoding: 'utf8' });
    const json = spawnSync(process.execPath, ['./bin/run', 'checklist', 'update', '--json'], { cwd: process.cwd(), encoding: 'utf8' });

    assert.notEqual(plain.status, 0);
    assert.match(plain.stderr, /Missing 1 required arg/);
    assert.notEqual(json.status, 0);
    assert.equal(JSON.parse(json.stdout).command, 'checklist update');
  });
});
