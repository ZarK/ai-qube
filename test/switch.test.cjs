const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { describe, it } = require('node:test');
const { getDefaults } = require('../dist/config/index.js');
const { switchIssue } = require('../dist/switch/index.js');

function makeGitRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'aie-switch-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'executor@example.invalid'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Executor Test'], { cwd: repo, stdio: 'ignore' });
  writeFileSync(join(repo, 'README.md'), 'fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: repo, stdio: 'ignore' });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  execFileSync('git', ['update-ref', 'refs/remotes/origin/main', head], { cwd: repo, stdio: 'ignore' });
  return repo;
}

function issue(number, title, labels, body = '') {
  return {
    number,
    title,
    body,
    state: 'OPEN',
    labels: labels.map(name => ({ name })),
    milestone: null,
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

describe('switch service', () => {
  it('switches from the single active source to a ready target', async () => {
    const repo = makeGitRepo();
    const calls = [];
    const source = issue(93, 'Active work', ['S-InProgress']);
    const target = issue(94, 'Ready work', ['S-Ready']);
    const exec = makeExec({
      [issueListKey()]: success([], JSON.stringify([source, target])),
      [issueViewKey(94)]: success([], JSON.stringify(target)),
      'pr list --state open --json number,title,author,isDraft,url,headRefName --limit 1000': success([], '[]'),
      'issue edit 93 --add-label S-Ready --remove-label S-InProgress': success([]),
      'issue edit 94 --add-label S-InProgress --remove-label S-Ready': success([]),
      'api user': success([], JSON.stringify({ login: 'octo' })),
      'issue edit 94 --add-assignee octo': success([]),
      'issue comment 94 --body Switched work from #93 to #94.': success([]),
    }, calls);

    const result = await switchIssue({
      targetIssueNumber: 94,
      dryRun: false,
      assign: true,
      comment: true,
      exec,
      cwd: repo,
      config: { ...getDefaults(), noWorktree: false, blockOnOpenPRs: false },
    });

    assert.equal(result.ok, true);
    assert.equal(result.action, 'switched');
    assert.equal(result.sourceIssue.number, 93);
    assert.equal(result.targetIssue.number, 94);
    assert.equal(result.plan.actions.find(action => action.id === 'pause-source:93').status, 'completed');
    assert.equal(result.plan.actions.find(action => action.id === 'start-target:94').status, 'completed');
    assert.equal(result.plan.actions.find(action => action.id === 'assign-issue:94').status, 'completed');
    assert.equal(result.plan.actions.find(action => action.id === 'add-comment:94').status, 'completed');
    assert.equal(calls.some(args => args.join(' ') === 'issue edit 93 --add-label S-Ready --remove-label S-InProgress'), true);
    const { formatSwitchHuman } = require('../dist/renderers/lifecycle_renderer.js');
    assert.match(formatSwitchHuman(result), /Source labels: completed \(\+S-Ready, -S-InProgress\)/);
    assert.match(formatSwitchHuman(result), /Target labels: completed \(\+S-InProgress, -S-Ready\)/);
  });

  it('plans switch in dry-run without mutating GitHub', async () => {
    const repo = makeGitRepo();
    const calls = [];
    const source = issue(93, 'Active work', ['S-InProgress']);
    const target = issue(94, 'Ready work', ['S-Ready']);
    const exec = makeExec({
      [issueListKey()]: success([], JSON.stringify([source, target])),
      [issueViewKey(94)]: success([], JSON.stringify(target)),
      'pr list --state open --json number,title,author,isDraft,url,headRefName --limit 1000': success([], '[]'),
    }, calls);

    const result = await switchIssue({
      targetIssueNumber: 94,
      dryRun: true,
      assign: true,
      comment: true,
      exec,
      cwd: repo,
      config: { ...getDefaults(), noWorktree: false, blockOnOpenPRs: false },
    });

    assert.equal(result.ok, true);
    assert.equal(result.dryRun, true);
    assert.equal(result.plan.actions.find(action => action.id === 'pause-source:93').status, 'planned');
    assert.equal(result.plan.actions.find(action => action.id === 'start-target:94').status, 'planned');
    assert.equal(calls.some(args => args[0] === 'issue' && args[1] === 'edit'), false);
  });

  it('pauses source as blocked when it has open blockers', async () => {
    const repo = makeGitRepo();
    const source = issue(93, 'Blocked active work', ['S-InProgress'], 'Blocked by: #17');
    const blocker = issue(17, 'Open blocker', ['S-Ready']);
    const target = issue(94, 'Ready work', ['S-Ready']);
    const exec = makeExec({
      [issueListKey()]: success([], JSON.stringify([source, blocker, target])),
      [issueViewKey(94)]: success([], JSON.stringify(target)),
      'pr list --state open --json number,title,author,isDraft,url,headRefName --limit 1000': success([], '[]'),
    });

    const result = await switchIssue({
      targetIssueNumber: 94,
      dryRun: true,
      assign: true,
      comment: true,
      exec,
      cwd: repo,
      config: { ...getDefaults(), noWorktree: false, blockOnOpenPRs: false },
    });

    const pause = result.plan.actions.find(action => action.id === 'pause-source:93');
    assert.deepEqual(pause.details.addLabels, ['S-Blocked']);
    assert.deepEqual(pause.details.removeLabels, ['S-InProgress']);
  });

  it('maintains S-Blocking for paused source dependents', async () => {
    const repo = makeGitRepo();
    const source = issue(93, 'Active blocker', ['S-InProgress']);
    const dependent = issue(95, 'Dependent work', ['S-Blocked'], 'Blocked by: #93');
    const target = issue(94, 'Ready work', ['S-Ready']);
    const exec = makeExec({
      [issueListKey()]: success([], JSON.stringify([source, dependent, target])),
      [issueViewKey(94)]: success([], JSON.stringify(target)),
      'pr list --state open --json number,title,author,isDraft,url,headRefName --limit 1000': success([], '[]'),
    });

    const result = await switchIssue({
      targetIssueNumber: 94,
      dryRun: true,
      assign: true,
      comment: true,
      exec,
      cwd: repo,
      config: { ...getDefaults(), noWorktree: false, blockOnOpenPRs: false },
    });

    const pause = result.plan.actions.find(action => action.id === 'pause-source:93');
    assert.deepEqual(pause.details.addLabels, ['S-Ready', 'S-Blocking']);
    assert.deepEqual(pause.details.removeLabels, ['S-InProgress']);
  });

  it('rejects blocked target before mutation', async () => {
    const calls = [];
    const source = issue(93, 'Active work', ['S-InProgress']);
    const target = issue(94, 'Blocked target', ['S-Ready'], 'Blocked by: #17');
    const blocker = issue(17, 'Open blocker', ['S-Ready']);
    const exec = makeExec({
      [issueListKey()]: success([], JSON.stringify([source, target, blocker])),
      [issueViewKey(94)]: success([], JSON.stringify(target)),
    }, calls);

    const result = await switchIssue({
      targetIssueNumber: 94,
      dryRun: false,
      assign: true,
      comment: true,
      exec,
      config: getDefaults(),
    });

    assert.equal(result.ok, false);
    assert.equal(result.action, 'blocked');
    assert.deepEqual(result.blockers, [17]);
    assert.equal(calls.some(args => args[0] === 'issue' && args[1] === 'edit'), false);
  });

  it('requires --from when multiple active issues exist', async () => {
    const calls = [];
    const target = issue(94, 'Ready work', ['S-Ready']);
    const exec = makeExec({
      [issueListKey()]: success([], JSON.stringify([
        issue(91, 'Active A', ['S-InProgress']),
        issue(92, 'Active B', ['S-InProgress']),
        target,
      ])),
      [issueViewKey(94)]: success([], JSON.stringify(target)),
    }, calls);

    const result = await switchIssue({
      targetIssueNumber: 94,
      dryRun: false,
      assign: true,
      comment: true,
      exec,
      config: getDefaults(),
    });

    assert.equal(result.ok, false);
    assert.equal(result.action, 'invalid');
    assert.match(result.reason, /Multiple S-InProgress/);
    assert.equal(calls.some(args => args[0] === 'issue' && args[1] === 'edit'), false);
  });

  it('uses --from to pause source when target is already active', async () => {
    const calls = [];
    const source = issue(93, 'Source work', ['S-InProgress']);
    const target = issue(94, 'Already active target', ['S-InProgress']);
    const exec = makeExec({
      [issueListKey()]: success([], JSON.stringify([source, target])),
      [issueViewKey(94)]: success([], JSON.stringify(target)),
      [issueViewKey(93)]: success([], JSON.stringify(source)),
      'issue edit 93 --add-label S-Ready --remove-label S-InProgress': success([]),
    }, calls);

    const result = await switchIssue({
      targetIssueNumber: 94,
      fromIssueNumber: 93,
      dryRun: false,
      assign: true,
      comment: true,
      exec,
      cwd: join(tmpdir(), 'missing-aie-switch-resume'),
      config: getDefaults(),
    });

    assert.equal(result.ok, true);
    assert.equal(result.action, 'resumed');
    assert.equal(result.preStartPolicy.bypassed, true);
    assert.equal(calls.some(args => args[0] === 'pr'), false);
    assert.equal(result.plan.actions.some(action => action.id === 'start-target:94'), false);
  });

  it('rejects --from when an unrelated issue remains active', async () => {
    const calls = [];
    const source = issue(93, 'Source work', ['S-InProgress']);
    const target = issue(94, 'Ready work', ['S-Ready']);
    const exec = makeExec({
      [issueListKey()]: success([], JSON.stringify([
        issue(91, 'Unrelated active', ['S-InProgress']),
        source,
        target,
      ])),
      [issueViewKey(94)]: success([], JSON.stringify(target)),
      [issueViewKey(93)]: success([], JSON.stringify(source)),
    }, calls);

    const result = await switchIssue({
      targetIssueNumber: 94,
      fromIssueNumber: 93,
      dryRun: false,
      assign: true,
      comment: true,
      exec,
      config: getDefaults(),
    });

    assert.equal(result.ok, false);
    assert.equal(result.action, 'invalid');
    assert.match(result.reason, /unrelated S-InProgress/);
    assert.equal(calls.some(args => args[0] === 'issue' && args[1] === 'edit'), false);
  });

  it('skips all mutations when pre-start policy blocks switch', async () => {
    const repo = makeGitRepo();
    const source = issue(93, 'Active work', ['S-InProgress']);
    const target = issue(94, 'Ready work', ['S-Ready']);
    const exec = makeExec({
      [issueListKey()]: success([], JSON.stringify([source, target])),
      [issueViewKey(94)]: success([], JSON.stringify(target)),
      'pr list --state open --json number,title,author,isDraft,url,headRefName --limit 1000': success([], JSON.stringify([
        { number: 12, title: 'Human PR', author: { login: 'human' }, isDraft: false, url: 'https://github.com/example/repo/pull/12', headRefName: 'feature' },
      ])),
    });

    const result = await switchIssue({
      targetIssueNumber: 94,
      dryRun: false,
      assign: true,
      comment: true,
      exec,
      cwd: repo,
      config: { ...getDefaults(), noWorktree: false, blockOnOpenPRs: true },
    });

    assert.equal(result.ok, false);
    assert.equal(result.action, 'blocked');
    assert.match(result.errors.join('\n'), /Open pull requests block/);
    assert.equal(result.plan.actions.find(action => action.id === 'pause-source:93').status, 'skipped');
    assert.equal(result.plan.actions.find(action => action.id === 'start-target:94').status, 'skipped');
  });

  it('skips mutations when linked worktree policy blocks switch', async () => {
    const repo = makeGitRepo();
    const linked = join(mkdtempSync(join(tmpdir(), 'aie-switch-linked-')), 'worktree');
    execFileSync('git', ['worktree', 'add', '-b', 'linked-work', linked], { cwd: repo, stdio: 'ignore' });
    const source = issue(93, 'Active work', ['S-InProgress']);
    const target = issue(94, 'Ready work', ['S-Ready']);
    const exec = makeExec({
      [issueListKey()]: success([], JSON.stringify([source, target])),
      [issueViewKey(94)]: success([], JSON.stringify(target)),
      'pr list --state open --json number,title,author,isDraft,url,headRefName --limit 1000': success([], '[]'),
    });

    const result = await switchIssue({
      targetIssueNumber: 94,
      dryRun: false,
      assign: true,
      comment: true,
      exec,
      cwd: linked,
      config: { ...getDefaults(), noWorktree: true, blockOnOpenPRs: false },
    });

    assert.equal(result.ok, false);
    assert.equal(result.action, 'blocked');
    assert.match(result.errors.join('\n'), /Linked git worktree detected/);
    assert.equal(result.plan.actions.find(action => action.id === 'pause-source:93').status, 'skipped');
    assert.equal(result.plan.actions.find(action => action.id === 'start-target:94').status, 'skipped');
  });

  it('skips mutations when base branch freshness blocks switch', async () => {
    const repo = makeGitRepo();
    writeFileSync(join(repo, 'README.md'), 'advanced\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'advance main'], { cwd: repo, stdio: 'ignore' });
    const source = issue(93, 'Active work', ['S-InProgress']);
    const target = issue(94, 'Ready work', ['S-Ready']);
    const exec = makeExec({
      [issueListKey()]: success([], JSON.stringify([source, target])),
      [issueViewKey(94)]: success([], JSON.stringify(target)),
      'pr list --state open --json number,title,author,isDraft,url,headRefName --limit 1000': success([], '[]'),
    });

    const result = await switchIssue({
      targetIssueNumber: 94,
      dryRun: false,
      assign: true,
      comment: true,
      exec,
      cwd: repo,
      config: { ...getDefaults(), noWorktree: false, blockOnOpenPRs: false },
    });

    assert.equal(result.ok, false);
    assert.equal(result.action, 'blocked');
    assert.match(result.errors.join('\n'), /Base branch origin\/main is not current locally/);
    assert.equal(result.plan.actions.find(action => action.id === 'pause-source:93').status, 'skipped');
    assert.equal(result.plan.actions.find(action => action.id === 'start-target:94').status, 'skipped');
  });
});

describe('switch command metadata', () => {
  it('loads the command class and publishes schema metadata', () => {
    const mod = require('../dist/commands/switch.js');
    const Switch = mod.default || mod;
    const { getImplementedCommands } = require('../dist/command_metadata.js');
    const metadata = getImplementedCommands().find(command => command.name === 'switch');

    assert.ok(Switch.description.includes('Pause the current in-progress issue'));
    assert.ok(Switch.args.issue);
    assert.ok(Switch.flags.from);
    assert.ok(Switch.flags['dry-run']);
    assert.equal(Switch.flags.force, undefined);
    assert.equal(metadata.mutates, true);
    assert.deepEqual(metadata.mutationTargets, ['github']);
    assert.equal(metadata.supportsJson, true);
    assert.equal(metadata.supportsDryRun, true);
    assert.equal(metadata.flags.includes('--from'), true);
    assert.equal(metadata.flags.includes('--force'), false);
  });

  it('prints safe usage for incomplete switch command forms', () => {
    const plain = spawnSync(process.execPath, ['./bin/run', 'switch'], { cwd: process.cwd(), encoding: 'utf8' });
    const json = spawnSync(process.execPath, ['./bin/run', 'switch', '--json'], { cwd: process.cwd(), encoding: 'utf8' });
    const jsonWithFrom = spawnSync(process.execPath, ['./bin/run', 'switch', '--from', '93', '--json'], { cwd: process.cwd(), encoding: 'utf8' });

    assert.equal(plain.status, 0);
    assert.match(plain.stdout, /Usage: aie switch <issue> \[--from <issue>\]/);
    assert.equal(json.status, 0);
    assert.equal(JSON.parse(json.stdout).usage, 'aie switch <issue> [--from <issue>]');
    assert.equal(jsonWithFrom.status, 0);
    assert.equal(JSON.parse(jsonWithFrom.stdout).usage, 'aie switch <issue> [--from <issue>]');
  });

  it('returns structured parse errors before GitHub access', () => {
    const result = spawnSync(process.execPath, ['./bin/run', 'switch', 'not-an-issue', '--json'], { cwd: process.cwd(), encoding: 'utf8' });
    const parsed = JSON.parse(result.stdout);

    assert.equal(result.status, 1);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /Failed to parse switch selector/);
  });

  it('validates empty --from before GitHub access', () => {
    const result = spawnSync(process.execPath, ['./bin/run', 'switch', '94', '--from', '', '--json'], { cwd: process.cwd(), encoding: 'utf8' });
    const parsed = JSON.parse(result.stdout);

    assert.equal(result.status, 1);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /Missing source issue number/);
  });
});
