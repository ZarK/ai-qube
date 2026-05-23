const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { describe, it } = require('node:test');

const { planChecklistUpdate } = require('../dist/checklist.js');
const { updateIssueChecklist } = require('../dist/app/issue_checklist.js');

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

  it('dry-runs issue checklist mutation without editing GitHub', async () => {
    const calls = [];
    const exec = makeExec({
      [issueViewKey(93)]: success([], JSON.stringify(issue(93, '- [ ] Acceptance A\n- [x] Acceptance B'))),
    }, calls);

    const result = await updateIssueChecklist({ issueNumber: 93, selector: { index: 1 }, state: 'checked', dryRun: true, exec });

    assert.equal(result.command, 'checklist update');
    assert.equal(result.mutation.status, 'planned');
    assert.equal(result.after.checked, 2);
    assert.equal(calls.some(args => args[0] === 'issue' && args[1] === 'edit'), false);
  });

  it('updates the issue body when not in dry-run mode', async () => {
    const calls = [];
    const exec = makeExec({
      [issueViewKey(93)]: success([], JSON.stringify(issue(93, '- [ ] Acceptance A\n- [x] Acceptance B'))),
      'issue edit 93 --body - [x] Acceptance A\n- [x] Acceptance B': success([]),
    }, calls);

    const result = await updateIssueChecklist({ issueNumber: 93, selector: { text: 'Acceptance A' }, state: 'checked', dryRun: false, exec });

    assert.equal(result.mutation.status, 'completed');
    assert.ok(calls.some(args => args[0] === 'issue' && args[1] === 'edit' && args[3] === '--body' && args[4].includes('[x] Acceptance A')));
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
