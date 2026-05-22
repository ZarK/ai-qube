const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { describe, it } = require('node:test');
const { getDefaults } = require('../dist/config/index.js');
const { startIssue } = require('../dist/start/index.js');

function makeGitRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'aie-start-'));
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

describe('start service', () => {
  it('resumes the single active issue without pre-start PR reads', async () => {
    const calls = [];
    const exec = makeExec({
      [issueListKey()]: success([], JSON.stringify([
        issue(93, 'Active work', ['S-InProgress']),
        issue(94, 'Ready work', ['S-Ready']),
      ])),
    }, calls);

    const result = await startIssue({
      selection: { kind: 'next' },
      dryRun: false,
      assign: true,
      comment: true,
      exec,
      cwd: join(tmpdir(), 'missing-aie-start-resume'),
      config: getDefaults(),
    });

    assert.equal(result.ok, true);
    assert.equal(result.action, 'resumed');
    assert.equal(result.issue.number, 93);
    assert.equal(result.preStartPolicy.bypassed, true);
    assert.equal(calls.some(args => args[0] === 'pr'), false);
    assert.equal(result.plan.actions.some(action => action.kind === 'replace-status-labels'), false);
    const { formatStartHuman } = require('../dist/renderers/lifecycle_renderer.js');
    assert.match(formatStartHuman(result), /Labels: not planned/);
  });

  it('plans start-next label mutation in dry-run without mutating GitHub', async () => {
    const repo = makeGitRepo();
    const calls = [];
    const exec = makeExec({
      [issueListKey()]: success([], JSON.stringify([
        issue(93, 'Add start command', ['P2-High', 'S-Ready']),
      ])),
      'pr list --state open --json number,title,author,isDraft,url,headRefName --limit 1000': success([], '[]'),
    }, calls);

    const result = await startIssue({
      selection: { kind: 'next' },
      dryRun: true,
      assign: true,
      comment: true,
      exec,
      cwd: repo,
      config: { ...getDefaults(), noWorktree: false, blockOnOpenPRs: false },
    });

    const labelAction = result.plan.actions.find(action => action.kind === 'replace-status-labels');
    const assignAction = result.plan.actions.find(action => action.kind === 'assign-issue');
    const commentAction = result.plan.actions.find(action => action.kind === 'add-comment');
    assert.equal(result.ok, true);
    assert.equal(result.action, 'started');
    assert.equal(labelAction.status, 'planned');
    assert.equal(assignAction.status, 'planned');
    assert.equal(commentAction.status, 'planned');
    assert.deepEqual(labelAction.details.addLabels, ['S-InProgress']);
    assert.deepEqual(labelAction.details.removeLabels, ['S-Ready']);
    assert.equal(calls.some(args => args[0] === 'issue' && args[1] === 'edit'), false);
    const { formatStartHuman } = require('../dist/renderers/lifecycle_renderer.js');
    assert.match(formatStartHuman(result), /Labels: planned \(\+S-InProgress, -S-Ready\)/);
  });

  it('starts a specific issue and applies configured labels, assignment, and comment', async () => {
    const repo = makeGitRepo();
    const calls = [];
    const openIssues = JSON.stringify([issue(93, 'Specific work', ['S-Ready'])]);
    const singleIssue = JSON.stringify(issue(93, 'Specific work', ['S-Ready']));
    const exec = makeExec({
      [issueListKey()]: success([], openIssues),
      'issue view 93 --json number,title,state,labels,body,milestone,url': success([], singleIssue),
      'pr list --state open --json number,title,author,isDraft,url,headRefName --limit 1000': success([], '[]'),
      'issue edit 93 --add-label S-InProgress --remove-label S-Ready': success([]),
      'api user': success([], JSON.stringify({ login: 'octo' })),
      'issue edit 93 --add-assignee octo': success([]),
      'issue comment 93 --body Started work on #93.': success([]),
    }, calls);

    const result = await startIssue({
      selection: { kind: 'issue', issueNumber: 93 },
      dryRun: false,
      assign: true,
      comment: true,
      exec,
      cwd: repo,
      config: { ...getDefaults(), noWorktree: false, blockOnOpenPRs: false },
    });

    assert.equal(result.ok, true);
    assert.equal(result.action, 'started');
    assert.equal(result.plan.actions.find(action => action.kind === 'replace-status-labels').status, 'completed');
    assert.equal(result.plan.actions.find(action => action.kind === 'assign-issue').status, 'completed');
    assert.equal(result.plan.actions.find(action => action.kind === 'add-comment').status, 'completed');
    assert.equal(calls.some(args => args.join(' ') === 'issue edit 93 --add-assignee octo'), true);
    const { formatStartHuman } = require('../dist/renderers/lifecycle_renderer.js');
    assert.match(formatStartHuman(result), /Labels: completed \(\+S-InProgress, -S-Ready\)/);
  });

  it('honors per-invocation assignment and comment disable flags', async () => {
    const repo = makeGitRepo();
    const calls = [];
    const exec = makeExec({
      [issueListKey()]: success([], JSON.stringify([
        issue(93, 'Ready work', ['S-Ready']),
      ])),
      'pr list --state open --json number,title,author,isDraft,url,headRefName --limit 1000': success([], '[]'),
    }, calls);

    const result = await startIssue({
      selection: { kind: 'next' },
      dryRun: true,
      assign: false,
      comment: false,
      exec,
      cwd: repo,
      config: { ...getDefaults(), noWorktree: false, blockOnOpenPRs: false },
    });

    assert.equal(result.ok, true);
    assert.equal(result.plan.actions.some(action => action.kind === 'assign-issue'), false);
    assert.equal(result.plan.actions.some(action => action.kind === 'add-comment'), false);
    assert.ok(result.warnings.includes('Assignment was disabled by --no-assign.'));
    assert.ok(result.warnings.includes('Started-work comment was disabled by --no-comment.'));
  });

  it('rejects a requested issue with open blockers before mutation', async () => {
    const calls = [];
    const target = issue(93, 'Blocked work', ['S-Ready'], 'Blocked by: #17');
    const exec = makeExec({
      [issueListKey()]: success([], JSON.stringify([
        target,
        issue(17, 'Open blocker', ['S-Ready']),
      ])),
      'issue view 93 --json number,title,state,labels,body,milestone,url': success([], JSON.stringify(target)),
    }, calls);

    const result = await startIssue({
      selection: { kind: 'issue', issueNumber: 93 },
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

  it('skips mutations when pre-start open PR policy fails', async () => {
    const repo = makeGitRepo();
    const exec = makeExec({
      [issueListKey()]: success([], JSON.stringify([
        issue(93, 'Ready work', ['S-Ready']),
      ])),
      'pr list --state open --json number,title,author,isDraft,url,headRefName --limit 1000': success([], JSON.stringify([
        { number: 12, title: 'Human PR', author: { login: 'human' }, isDraft: false, url: 'https://github.com/example/repo/pull/12', headRefName: 'feature' },
      ])),
    });

    const result = await startIssue({
      selection: { kind: 'next' },
      dryRun: false,
      assign: true,
      comment: true,
      exec,
      cwd: repo,
      config: { ...getDefaults(), noWorktree: false, blockOnOpenPRs: true },
    });

    const labelAction = result.plan.actions.find(action => action.kind === 'replace-status-labels');
    assert.equal(result.ok, false);
    assert.equal(result.action, 'blocked');
    assert.match(result.errors.join('\n'), /Open pull requests block/);
    assert.equal(labelAction.status, 'skipped');
  });

  it('reports lifecycle execution failures after pre-start policy passes', async () => {
    const repo = makeGitRepo();
    const exec = makeExec({
      [issueListKey()]: success([], JSON.stringify([
        issue(93, 'Ready work', ['S-Ready']),
      ])),
      'pr list --state open --json number,title,author,isDraft,url,headRefName --limit 1000': success([], '[]'),
      'issue edit 93 --add-label S-InProgress --remove-label S-Ready': { args: [], exitCode: 1, stdout: '', stderr: 'permission denied' },
    });

    const result = await startIssue({
      selection: { kind: 'next' },
      dryRun: false,
      assign: true,
      comment: true,
      exec,
      cwd: repo,
      config: { ...getDefaults(), noWorktree: false, blockOnOpenPRs: false },
    });

    const labelAction = result.plan.actions.find(action => action.kind === 'replace-status-labels');
    assert.equal(result.ok, false);
    assert.equal(result.action, 'blocked');
    assert.equal(result.preStartPolicy.ok, true);
    assert.match(result.reason, /Lifecycle execution failed/);
    assert.match(result.errors.join('\n'), /permission denied/);
    assert.equal(labelAction.status, 'failed');
  });

  it('fails start-next when multiple active issues exist anywhere in the safety scan', async () => {
    const calls = [];
    const fillerIssues = Array.from({ length: 120 }, (_, index) => issue(index + 1, `Ready ${index + 1}`, ['S-Ready']));
    const exec = makeExec({
      [issueListKey()]: success([], JSON.stringify([
        ...fillerIssues,
        issue(201, 'Active A', ['S-InProgress']),
        issue(202, 'Active B', ['S-InProgress']),
      ])),
    }, calls);

    const result = await startIssue({
      selection: { kind: 'next' },
      dryRun: false,
      assign: true,
      comment: true,
      exec,
      config: getDefaults(),
    });

    assert.equal(result.ok, false);
    assert.equal(result.action, 'invalid');
    assert.equal(result.activeIssueState.multipleInProgress, true);
    assert.match(result.reason, /Multiple S-InProgress/);
    assert.equal(calls[0].includes('1000'), true);
    assert.equal(calls.some(args => args[0] === 'issue' && args[1] === 'edit'), false);
  });

  it('fails specific start when another active issue exists', async () => {
    const calls = [];
    const target = issue(93, 'Requested work', ['S-Ready']);
    const exec = makeExec({
      [issueListKey()]: success([], JSON.stringify([
        target,
        issue(94, 'Active work', ['S-InProgress']),
      ])),
      'issue view 93 --json number,title,state,labels,body,milestone,url': success([], JSON.stringify(target)),
    }, calls);

    const result = await startIssue({
      selection: { kind: 'issue', issueNumber: 93 },
      dryRun: false,
      assign: true,
      comment: true,
      exec,
      config: getDefaults(),
    });

    assert.equal(result.ok, false);
    assert.equal(result.action, 'blocked');
    assert.match(result.reason, /already S-InProgress/);
    assert.equal(calls.some(args => args[0] === 'issue' && args[1] === 'edit'), false);
  });

  it('starts the lower-numbered ready issue when queue ranking ties', async () => {
    const repo = makeGitRepo();
    const exec = makeExec({
      [issueListKey()]: success([], JSON.stringify([
        issue(94, '2.1 Same sequence', ['P2-High', 'S-Ready'], 'Sequence: alpha'),
        issue(93, '2.1 Same sequence', ['P2-High', 'S-Ready'], 'Sequence: alpha'),
      ])),
      'pr list --state open --json number,title,author,isDraft,url,headRefName --limit 1000': success([], '[]'),
    });

    const result = await startIssue({
      selection: { kind: 'next' },
      dryRun: true,
      assign: true,
      comment: true,
      exec,
      cwd: repo,
      config: { ...getDefaults(), noWorktree: false, blockOnOpenPRs: false },
    });

    assert.equal(result.ok, true);
    assert.equal(result.action, 'started');
    assert.equal(result.issue.number, 93);
    assert.match(result.reason, /selected by queue ordering/);
  });
});

describe('start command metadata', () => {
  it('loads the command class and publishes schema metadata', () => {
    const mod = require('../dist/commands/start.js');
    const Start = mod.default || mod;
    const { getImplementedCommands } = require('../dist/command_metadata.js');
    const metadata = getImplementedCommands().find(command => command.name === 'start');

    assert.ok(Start.description.includes('Start or resume issue work'));
    assert.ok(Start.args.issue);
    assert.ok(Start.flags.json);
    assert.ok(Start.flags['dry-run']);
    assert.equal(metadata.mutates, true);
    assert.deepEqual(metadata.mutationTargets, ['github']);
    assert.equal(metadata.supportsJson, true);
    assert.equal(metadata.supportsDryRun, true);
  });

  it('prints safe usage for incomplete start command forms', () => {
    const plain = spawnSync(process.execPath, ['./bin/run', 'start'], { cwd: process.cwd(), encoding: 'utf8' });
    const help = spawnSync(process.execPath, ['./bin/run', 'start', 'help'], { cwd: process.cwd(), encoding: 'utf8' });
    const json = spawnSync(process.execPath, ['./bin/run', 'start', '--json'], { cwd: process.cwd(), encoding: 'utf8' });

    assert.equal(plain.status, 0);
    assert.match(plain.stdout, /Usage: aie start \[next\|<issue>\]/);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /USAGE/);
    assert.equal(json.status, 0);
    assert.equal(JSON.parse(json.stdout).usage, 'aie start [next|<issue>]');
  });

  it('returns structured parse errors before GitHub access', () => {
    const result = spawnSync(process.execPath, ['./bin/run', 'start', 'not-an-issue', '--json'], { cwd: process.cwd(), encoding: 'utf8' });
    const parsed = JSON.parse(result.stdout);

    assert.equal(result.status, 1);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /Failed to parse start selector/);
  });
});
