const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { describe, it } = require('node:test');
require('./support/compile_cache.cjs');

const { getCriterionIdentity, planChecklistUpdate } = require('../dist/checklist.js');
const { updateIssueChecklist } = require('../dist/app/issue_checklist.js');
const { getImplementedCommands } = require('../dist/command_metadata.js');

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

it('keeps the full criterion identity unchanged', () => {
  const text = `${'Exact criterion. '.repeat(40)}!`;
  assert.deepEqual(getCriterionIdentity(93, { index: 7, text }), { issueNumber: 93, index: 7, text });
});
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
  it('exposes optional gate capture and both mutation targets through CLI discovery', () => {
    const command = getImplementedCommands().find(command => command.name === 'checklist verify');
    assert.deepEqual(command.mutationTargets, ['github', 'local-files']);
    assert.equal(command.flags.includes('--run-gate'), true);
    assert.equal(command.supportsDryRun, true);
  });

  it('plans exact issue checkbox updates while preserving unrelated body text', () => {
    const body = 'Intro\n- [ ] Acceptance A\n- [x] Acceptance B\nFooter';

    const result = planChecklistUpdate(body, { text: 'Acceptance A' }, 'checked');

    assert.equal(result.changed, true);
    assert.equal(result.updatedBody, 'Intro\n- [x] Acceptance A\n- [x] Acceptance B\nFooter');
    assert.equal(result.before.unchecked, 1);
    assert.equal(result.after.unchecked, 0);
    assert.equal(result.matchedItems[0].index, 1);
  });

  it('preserves CRLF and mixed line endings byte-for-byte outside the selected token', () => {
    const body = 'Intro\r\n- [ ] Acceptance A\nContext\r- [x] Acceptance B\r\nFooter';
    const result = planChecklistUpdate(body, { index: 1 }, 'checked');
    assert.equal(result.updatedBody, 'Intro\r\n- [x] Acceptance A\nContext\r- [x] Acceptance B\r\nFooter');
    assert.equal(result.after.checked, 2);
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

  it('prints safe usage for incomplete checklist update command forms', () => {
    const plain = spawnSync(process.execPath, ['./bin/run', 'checklist', 'update'], { cwd: process.cwd(), encoding: 'utf8' });
    const json = spawnSync(process.execPath, ['./bin/run', 'checklist', 'update', '--json'], { cwd: process.cwd(), encoding: 'utf8' });

    assert.notEqual(plain.status, 0);
    assert.match(plain.stderr, /Missing 1 required arg/);
    assert.notEqual(json.status, 0);
    assert.equal(JSON.parse(json.stdout).command, 'checklist update');
  });
});
