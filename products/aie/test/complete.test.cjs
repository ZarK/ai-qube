const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { describe, it } = require('node:test');
const { getDefaults } = require('../dist/config/index.js');
const { completeIssue } = require('../dist/complete/index.js');

function issue(number, title, labels, body = '', state = 'OPEN', milestone = null) {
  return {
    number,
    title,
    body,
    state,
    labels: labels.map(name => ({ name })),
    milestone,
    url: `https://github.com/example/repo/issues/${number}`,
  };
}

function issueListKey(limit = 1000) {
  return `issue list --state open --json number,title,state,labels,body,milestone,url --limit ${limit}`;
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
    if (responses[key]) return responses[key];
    return { args, exitCode: 1, stdout: '', stderr: `unexpected gh call: ${key}` };
  };
}

describe('complete service', () => {
  it('verifies completion readiness in check-only mode without mutation', async () => {
    const calls = [];
    const target = issue(93, 'Active work', ['S-InProgress'], '- [x] done');
    const dependent = issue(94, 'Dependent work', ['S-Blocked'], 'Blocked by: #93');
    const exec = makeExec({
      [issueViewKey(93)]: success([], JSON.stringify(target)),
      [issueListKey()]: success([], JSON.stringify([target, dependent])),
    }, calls);

    const result = await completeIssue({ issueNumber: 93, dryRun: false, checkOnly: true, force: false, exec, config: getDefaults() });

    assert.equal(result.ok, true);
    assert.equal(result.action, 'checked');
    assert.equal(result.plan.checkOnly, true);
    assert.equal(result.plan.actions.find(action => action.kind === 'close-issue').status, 'planned');
    assert.equal(result.dependentRefresh.unblocked[0].issue.number, 94);
    assert.equal(calls.some(args => args[0] === 'issue' && (args[1] === 'edit' || args[1] === 'close')), false);
  });

  it('blocks unchecked checklist items unless force is supplied', async () => {
    const calls = [];
    const target = issue(93, 'Active work', ['S-InProgress'], '- [ ] acceptance item');
    const exec = makeExec({
      [issueViewKey(93)]: success([], JSON.stringify(target)),
      [issueListKey()]: success([], JSON.stringify([target])),
    }, calls);

    const blocked = await completeIssue({ issueNumber: 93, dryRun: false, checkOnly: false, force: false, exec, config: getDefaults() });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.action, 'blocked');
    assert.match(blocked.reason, /unchecked checklist/);
    assert.equal(blocked.plan.actions.find(action => action.id === 'complete-status:93').status, 'skipped');
    assert.equal(blocked.plan.actions.find(action => action.id === 'close-issue:93').status, 'skipped');
    assert.match(blocked.plan.actions.find(action => action.id === 'close-issue:93').failure.cause, /unchecked checklist/);
    assert.equal(calls.some(args => args[0] === 'issue' && (args[1] === 'edit' || args[1] === 'close')), false);

    const forced = await completeIssue({ issueNumber: 93, dryRun: true, checkOnly: false, force: true, exec, config: getDefaults() });
    assert.equal(forced.ok, true);
    assert.equal(forced.action, 'planned');
    assert.equal(forced.forced, true);
    assert.match(forced.warnings.join('\n'), /Force enabled/);
  });

  it('rejects open issues that are not active completion targets', async () => {
    const calls = [];
    const target = issue(94, 'Future work', ['S-Ready'], '- [x] ready');
    const exec = makeExec({
      [issueViewKey(94)]: success([], JSON.stringify(target)),
      [issueListKey()]: success([], JSON.stringify([target])),
    }, calls);

    const result = await completeIssue({ issueNumber: 94, dryRun: false, checkOnly: false, force: true, exec, config: getDefaults() });

    assert.equal(result.ok, false);
    assert.equal(result.action, 'blocked');
    assert.match(result.reason, /not S-InProgress/);
    assert.equal(result.plan.actions.find(action => action.id === 'complete-status:94').status, 'skipped');
    assert.equal(result.plan.actions.find(action => action.id === 'close-issue:94').status, 'skipped');
    assert.equal(calls.some(args => args[0] === 'issue' && (args[1] === 'edit' || args[1] === 'close')), false);
  });

  it('removes status labels, closes open issues, unblocks dependents, and reports milestone context', async () => {
    const calls = [];
    const milestone = { number: 3, title: 'Product', state: 'OPEN', dueOn: null };
    const target = issue(93, 'Active work', ['S-InProgress'], '- [x] done', 'OPEN', milestone);
    const readyDependent = issue(94, 'Dependent ready', ['S-Blocked'], 'Blocked by: #93');
    const blockedDependent = issue(95, 'Dependent blocked', ['S-Blocked'], 'Blocked by: #93\nBlocked by: #92');
    const otherBlocker = issue(92, 'Other blocker', ['S-Ready']);
    const exec = makeExec({
      [issueViewKey(93)]: success([], JSON.stringify(target)),
      [issueListKey()]: success([], JSON.stringify([target, readyDependent, blockedDependent, otherBlocker])),
      'repo view --json nameWithOwner,url': success([], JSON.stringify({ nameWithOwner: 'example/repo', url: 'https://github.com/example/repo' })),
      'api repos/example/repo/milestones --method GET -F state=all -F per_page=100': success([], JSON.stringify([{ number: 3, title: 'Product', state: 'open', due_on: null, open_issues: 4, closed_issues: 9 }])),
      'issue edit 93 --remove-label S-InProgress': success([]),
      'issue close 93 --reason completed': success([]),
      'issue edit 94 --add-label S-Ready --remove-label S-Blocked': success([]),
    }, calls);

    const result = await completeIssue({ issueNumber: 93, dryRun: false, checkOnly: false, force: false, exec, config: getDefaults() });

    assert.equal(result.ok, true);
    assert.equal(result.action, 'completed');
    assert.equal(result.plan.actions.find(action => action.id === 'complete-status:93').status, 'completed');
    assert.equal(result.plan.actions.find(action => action.id === 'close-issue:93').status, 'completed');
    assert.deepEqual(result.dependentRefresh.unblocked.map(item => item.issue.number), [94]);
    assert.deepEqual(result.dependentRefresh.stillBlocked.map(item => item.issue.number), [95]);
    assert.equal(result.milestoneContext.remainingOpenIssues, 3);
    assert.equal(calls.some(args => args.join(' ') === 'issue close 93 --reason completed'), true);
    const { formatCompleteHuman } = require('../dist/renderers/lifecycle_renderer.js');
    assert.match(formatCompleteHuman(result), /Milestone: Product; remaining open issues after completion: 3/);
    assert.match(formatCompleteHuman(result), /Next: Run `aie next --json` or `aie queue`/);
  });

  it('refreshes dependents when the completed issue is already closed', async () => {
    const calls = [];
    const target = issue(93, 'Closed work', [], '- [x] done', 'CLOSED');
    const dependent = issue(94, 'Dependent ready', ['S-Blocked'], 'Blocked by: #93');
    const exec = makeExec({
      [issueViewKey(93)]: success([], JSON.stringify(target)),
      [issueListKey()]: success([], JSON.stringify([dependent])),
      'issue edit 94 --add-label S-Ready --remove-label S-Blocked': success([]),
    }, calls);

    const result = await completeIssue({ issueNumber: 93, dryRun: false, checkOnly: false, force: false, exec, config: getDefaults() });

    assert.equal(result.ok, true);
    assert.equal(result.completion.alreadyClosed, true);
    assert.equal(result.plan.actions.some(action => action.kind === 'close-issue'), false);
    assert.equal(calls.some(args => args[0] === 'issue' && args[1] === 'close'), false);
    assert.equal(calls.some(args => args.join(' ') === 'issue edit 94 --add-label S-Ready --remove-label S-Blocked'), true);
  });

  it('reports partial failures with completed, failed, and skipped actions', async () => {
    const target = issue(93, 'Active work', ['S-InProgress'], '- [x] done');
    const dependent = issue(94, 'Dependent ready', ['S-Blocked'], 'Blocked by: #93');
    const exec = makeExec({
      [issueViewKey(93)]: success([], JSON.stringify(target)),
      [issueListKey()]: success([], JSON.stringify([target, dependent])),
      'issue edit 93 --remove-label S-InProgress': success([]),
      'issue close 93 --reason completed': { args: [], exitCode: 1, stdout: '', stderr: 'close denied' },
    });

    const result = await completeIssue({ issueNumber: 93, dryRun: false, checkOnly: false, force: false, exec, config: getDefaults() });

    assert.equal(result.ok, false);
    assert.equal(result.action, 'failed');
    assert.equal(result.plan.summary.completedCount, 1);
    assert.equal(result.plan.summary.failedCount, 1);
    assert.equal(result.plan.summary.skippedCount, 1);
    assert.match(result.errors.join('\n'), /close denied/);
  });
});

describe('complete command metadata', () => {
  it('publishes registry-backed schema metadata', () => {
    const { getCommandMetadata } = require('../dist/command_metadata.js');
    const metadata = getCommandMetadata('complete');

    assert.ok(metadata.description.includes('Complete post-merge issue work'));
    assert.ok(metadata.flags.includes('--check-only'));
    assert.ok(metadata.flags.includes('--force'));
    assert.equal(metadata.mutates, true);
    assert.deepEqual(metadata.mutationTargets, ['github']);
    assert.equal(metadata.supportsJson, true);
    assert.equal(metadata.supportsDryRun, true);
    assert.equal(metadata.supportsCheckOnly, true);
  });

  it('prints safe usage for incomplete complete command forms', () => {
    const plain = spawnSync(process.execPath, ['./bin/run', 'complete'], { cwd: process.cwd(), encoding: 'utf8' });
    const json = spawnSync(process.execPath, ['./bin/run', 'complete', '--json'], { cwd: process.cwd(), encoding: 'utf8' });

    assert.equal(plain.status, 0);
    assert.match(plain.stdout, /Usage: aie complete <issue>/);
    assert.equal(json.status, 0);
    assert.equal(JSON.parse(json.stdout).usage, 'aie complete <issue> [--check-only] [--dry-run] [--force] [--json]');
  });

  it('returns structured parse errors before GitHub access', () => {
    const result = spawnSync(process.execPath, ['./bin/run', 'complete', 'not-an-issue', '--json'], { cwd: process.cwd(), encoding: 'utf8' });
    const parsed = JSON.parse(result.stdout);

    assert.equal(result.status, 1);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /Failed to parse complete selector/);
  });
});
