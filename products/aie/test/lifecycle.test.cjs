const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { describe, it } = require('node:test');
const { getDefaults } = require('../dist/config/index.js');

function makeIssue(number, labels = []) {
  return {
    number,
    title: `Issue ${number}`,
    body: '',
    state: 'OPEN',
    labels,
    milestone: null,
    url: `https://github.com/example/repo/issues/${number}`,
    declaredBlockers: [],
  };
}

function makeQueue(issues) {
  return {
    items: issues.map(issue => ({
      issue,
      effectiveStatus: issue.labels.includes('S-InProgress') ? 'InProgress' : 'Ready',
      openBlockers: [],
      drifted: false,
    })),
    inProgressCount: issues.filter(issue => issue.labels.includes('S-InProgress')).length,
    readyCount: issues.filter(issue => !issue.labels.includes('S-InProgress')).length,
    blockedCount: 0,
    driftCount: 0,
    multipleInProgress: issues.filter(issue => issue.labels.includes('S-InProgress')).length > 1,
  };
}

function makeGitRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'aie-lifecycle-'));
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

describe('lifecycle issue selection', () => {
  const { parseLifecycleIssueSelection } = require('../dist/lifecycle.js');

  it('treats help forms as non-mutating help requests', () => {
    assert.deepEqual(parseLifecycleIssueSelection('help'), { kind: 'help' });
    assert.deepEqual(parseLifecycleIssueSelection('--help'), { kind: 'help' });
    assert.deepEqual(parseLifecycleIssueSelection('-h'), { kind: 'help' });
  });

  it('accepts next, bare issue numbers, and shell-safe issue numbers', () => {
    assert.deepEqual(parseLifecycleIssueSelection(undefined), { kind: 'next' });
    assert.deepEqual(parseLifecycleIssueSelection('next'), { kind: 'next' });
    assert.deepEqual(parseLifecycleIssueSelection('93'), { kind: 'issue', issueNumber: 93 });
    assert.deepEqual(parseLifecycleIssueSelection('#93'), { kind: 'issue', issueNumber: 93 });
  });

  it('rejects invalid mutating positional input with an actionable message', () => {
    assert.throws(() => parseLifecycleIssueSelection('branch-name'), /Run `aie start --help`/);
  });
});

describe('lifecycle action model', () => {
  const {
    buildLifecyclePlan,
    createLifecycleAction,
    executeLifecyclePlan,
    formatLifecycleAction,
    summarizeLifecycleActions,
  } = require('../dist/lifecycle.js');

  it('declares GitHub, git, and read-only mutation scopes per planned action', () => {
    const actions = [
      createLifecycleAction({ id: 'label:93', kind: 'add-labels', targetType: 'issue', targetId: '93', description: 'Add S-InProgress', expectedResult: 'Issue has S-InProgress' }),
      createLifecycleAction({ id: 'branch:93', kind: 'create-branch', targetType: 'branch', targetId: 'issue/93-work', description: 'Create branch', expectedResult: 'Branch exists' }),
      createLifecycleAction({ id: 'check:93', kind: 'check-base-branch', targetType: 'repository', targetId: 'current', description: 'Check base branch', expectedResult: 'Base branch is current' }),
    ];

    assert.deepEqual(actions.map(action => action.mutation), ['github', 'git', 'none']);
    assert.match(formatLifecycleAction(actions[0]), /mutates github/);
  });

  it('uses the same action model for dry-run and execution output', async () => {
    const action = createLifecycleAction({ id: 'label:93', kind: 'add-labels', targetType: 'issue', targetId: '93', description: 'Add S-InProgress', expectedResult: 'Issue has S-InProgress' });
    const dryRunPlan = buildLifecyclePlan({ command: 'start', dryRun: true, actions: [action] });
    const executedPlan = await executeLifecyclePlan(buildLifecyclePlan({ command: 'start', dryRun: false, actions: [action] }), {
      dryRun: false,
      recoveryCommand: 'aie start 93 --dry-run',
      handlers: { 'add-labels': async () => {} },
    });

    assert.equal(dryRunPlan.actions[0].id, executedPlan.actions[0].id);
    assert.equal(dryRunPlan.actions[0].kind, executedPlan.actions[0].kind);
    assert.equal(dryRunPlan.actions[0].mutation, executedPlan.actions[0].mutation);
    assert.equal(executedPlan.actions[0].status, 'completed');
  });

  it('reports completed, failed, and skipped actions after partial failure', async () => {
    const actions = [
      createLifecycleAction({ id: 'comment:93', kind: 'add-comment', targetType: 'issue', targetId: '93', description: 'Comment on issue', expectedResult: 'Comment exists' }),
      createLifecycleAction({ id: 'assign:93', kind: 'assign-issue', targetType: 'issue', targetId: '93', description: 'Assign issue', expectedResult: 'Issue assigned' }),
      createLifecycleAction({ id: 'close:93', kind: 'close-issue', targetType: 'issue', targetId: '93', description: 'Close issue', expectedResult: 'Issue closed' }),
    ];
    const plan = buildLifecyclePlan({ command: 'complete', dryRun: false, actions });
    const result = await executeLifecyclePlan(plan, {
      dryRun: false,
      recoveryCommand: 'aie complete 93 --dry-run',
      handlers: {
        'add-comment': async () => {},
        'assign-issue': async () => { throw new Error('permission denied'); },
        'close-issue': async () => {},
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.summary.completedCount, 1);
    assert.equal(result.summary.failedCount, 1);
    assert.equal(result.summary.skippedCount, 1);
    assert.equal(result.summary.failedActions[0].failure.cause, 'permission denied');
    assert.equal(result.summary.recoveryCommand, 'aie complete 93 --dry-run');
  });

  it('keeps stable JSON-shaped summary fields', () => {
    const summary = summarizeLifecycleActions([
      createLifecycleAction({ id: 'check:93', kind: 'check-worktree', targetType: 'repository', targetId: 'current', description: 'Check worktree', expectedResult: 'Primary checkout', status: 'completed' }),
    ]);

    assert.deepEqual(Object.keys(summary), [
      'ok',
      'plannedCount',
      'completedCount',
      'failedCount',
      'skippedCount',
      'completedActions',
      'failedActions',
      'skippedActions',
      'recoveryCommand',
    ]);
  });
});

describe('pre-start lifecycle policy', () => {
  const { buildLifecyclePlan, canBypassPreStartPolicyForResume, createLifecycleAction } = require('../dist/lifecycle.js');
  const { buildPreStartPolicy } = require('../dist/app/pre_start_policy.js');

  function success(args, stdout) {
    return { args, exitCode: 0, stdout, stderr: '' };
  }

  it('blocks mutation when blocking pull requests exist', async () => {
    const config = { ...getDefaults(), noWorktree: false, blockOnOpenPRs: true };
    const issue = makeIssue(93, ['S-Ready']);
    const exec = async args => {
      if (args[0] === 'pr') {
        return success(args, JSON.stringify([
          { number: 12, title: 'Open work', author: { login: 'human' }, isDraft: false, url: 'https://github.com/example/repo/pull/12', headRefName: 'feature' },
        ]));
      }
      return success(args, '[]');
    };

    const policy = await buildPreStartPolicy({ config, issueNumber: issue.number, bypassForResume: false, exec, cwd: process.cwd() });
    const plan = buildLifecyclePlan({
      command: 'start',
      dryRun: false,
      preStartPolicy: policy,
      actions: [createLifecycleAction({ id: 'label:93', kind: 'add-labels', targetType: 'issue', targetId: '93', description: 'Add S-InProgress', expectedResult: 'Issue has S-InProgress' })],
    });

    assert.equal(policy.ok, false);
    assert.match(policy.blockers.join('\n'), /Open pull requests block/);
    assert.equal(plan.actions[0].status, 'skipped');
    assert.match(plan.actions[0].failure.cause, /Pre-start policy blocked mutation/);
  });

  it('blocks mutation when base branch freshness fails', async () => {
    const config = { ...getDefaults(), noWorktree: false, blockOnOpenPRs: false };
    const issue = makeIssue(93, ['S-Ready']);
    const policy = await buildPreStartPolicy({ config, issueNumber: issue.number, bypassForResume: false, exec: async args => success(args, '[]'), cwd: join(tmpdir(), 'missing-aie-lifecycle-repo') });

    assert.equal(policy.ok, false);
    assert.match(policy.blockers.join('\n'), /Base branch origin\/main is not resolved/);
    assert.equal(policy.checks.find(check => check.name === 'base-ref').action.status, 'failed');
  });

  it('uses provider-backed repository state for configured base remote checks', async () => {
    const repo = makeGitRepo();
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    execFileSync('git', ['remote', 'add', 'upstream', 'https://github.com/example/upstream.git'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['update-ref', 'refs/remotes/upstream/main', head], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['update-ref', '-d', 'refs/remotes/origin/main'], { cwd: repo, stdio: 'ignore' });
    const config = { ...getDefaults(), baseRemote: 'upstream', noWorktree: false, blockOnOpenPRs: false };
    const issue = makeIssue(93, ['S-Ready']);

    const policy = await buildPreStartPolicy({ config, issueNumber: issue.number, bypassForResume: false, exec: async args => success(args, '[]'), cwd: repo });
    const baseRefCheck = policy.checks.find(check => check.name === 'base-ref');

    assert.equal(policy.ok, true);
    assert.equal(policy.baseRef.remote, 'upstream');
    assert.equal(policy.baseRef.upToDate, true);
    assert.equal(baseRefCheck.action.status, 'completed');
    assert.equal(baseRefCheck.action.details.remote, 'upstream');
  });

  it('blocks mutation from a linked git worktree', async () => {
    const repo = makeGitRepo();
    const linkedParent = mkdtempSync(join(tmpdir(), 'aie-lifecycle-linked-'));
    const linked = join(linkedParent, 'worktree');
    execFileSync('git', ['worktree', 'add', '-b', 'issue-93', linked], { cwd: repo, stdio: 'ignore' });
    const config = { ...getDefaults(), noWorktree: true, blockOnOpenPRs: false };
    const issue = makeIssue(93, ['S-Ready']);

    const policy = await buildPreStartPolicy({ config, issueNumber: issue.number, bypassForResume: false, exec: async args => success(args, '[]'), cwd: linked });

    assert.equal(policy.ok, false);
    assert.match(policy.blockers.join('\n'), /Linked git worktree detected/);
    assert.equal(policy.worktree.isWorktree, true);
  });

  it('does not attach blocker failures when configured policies are disabled', async () => {
    const repo = makeGitRepo();
    const linkedParent = mkdtempSync(join(tmpdir(), 'aie-lifecycle-linked-'));
    const linked = join(linkedParent, 'worktree');
    execFileSync('git', ['worktree', 'add', '-b', 'issue-94', linked], { cwd: repo, stdio: 'ignore' });
    const config = { ...getDefaults(), noWorktree: false, blockOnOpenPRs: false };
    const issue = makeIssue(94, ['S-Ready']);
    const exec = async args => {
      if (args[0] === 'pr') {
        return success(args, JSON.stringify([
          { number: 12, title: 'Open work', author: { login: 'human' }, isDraft: false, url: 'https://github.com/example/repo/pull/12', headRefName: 'feature' },
        ]));
      }
      return success(args, '[]');
    };

    const policy = await buildPreStartPolicy({ config, issueNumber: issue.number, bypassForResume: false, exec, cwd: linked });
    const plan = buildLifecyclePlan({
      command: 'start',
      dryRun: false,
      preStartPolicy: policy,
      actions: [createLifecycleAction({ id: 'label:94', kind: 'add-labels', targetType: 'issue', targetId: '94', description: 'Add S-InProgress', expectedResult: 'Issue has S-InProgress' })],
    });

    const worktreeCheck = policy.checks.find(check => check.name === 'worktree');
    const openPullRequestsCheck = policy.checks.find(check => check.name === 'open-pull-requests');

    assert.equal(policy.ok, true);
    assert.deepEqual(policy.blockers, []);
    assert.equal(worktreeCheck.action.status, 'completed');
    assert.equal(worktreeCheck.reason, undefined);
    assert.equal(worktreeCheck.action.failure, undefined);
    assert.equal(openPullRequestsCheck.action.status, 'completed');
    assert.equal(openPullRequestsCheck.reason, undefined);
    assert.equal(openPullRequestsCheck.action.failure, undefined);
    assert.equal(plan.actions[0].status, 'planned');
    assert.equal(plan.actions[0].failure, undefined);
  });

  it('bypasses pre-start checks when resuming the single active issue', async () => {
    const config = { ...getDefaults(), noWorktree: true, blockOnOpenPRs: true };
    const issue = makeIssue(94, ['S-InProgress']);
    const exec = async () => {
      throw new Error('pull requests should not be read during resume bypass');
    };

    const policy = await buildPreStartPolicy({ config, issueNumber: issue.number, bypassForResume: true, exec, cwd: join(tmpdir(), 'missing-aie-lifecycle-resume-repo') });

    assert.equal(policy.ok, true);
    assert.equal(policy.bypassed, true);
    assert.equal(policy.blockingPullRequests.length, 0);
    assert.deepEqual(policy.checks.map(check => check.skipped), [true, true, true]);
    assert.deepEqual(policy.checks.map(check => check.action.failure), [undefined, undefined, undefined]);
    assert.match(policy.reason, /Resuming the single active S-InProgress issue #94/);
  });

  it('preserves the resume exception for the single active issue', () => {
    const active = makeIssue(94, ['S-InProgress']);
    const ready = makeIssue(95, ['S-Ready']);
    const secondActive = makeIssue(96, ['S-InProgress']);
    assert.equal(canBypassPreStartPolicyForResume(makeQueue([active, ready]), 94), true);
    assert.equal(canBypassPreStartPolicyForResume(makeQueue([active, ready]), 95), false);
    assert.equal(canBypassPreStartPolicyForResume(makeQueue([active, secondActive, ready]), 94), false);
  });
});

describe('shared command metadata', () => {
  const { getImplementedCommands, isHelpToken } = require('../dist/command_metadata.js');

  it('derives mutation labels and help forms from one metadata source', () => {
    const commands = getImplementedCommands();
    const depsFix = commands.find(command => command.name === 'deps fix');
    const queue = commands.find(command => command.name === 'queue');

    assert.equal(depsFix.mutates, true);
    assert.deepEqual(depsFix.mutationTargets, ['github']);
    assert.ok(depsFix.helpForms.includes('aie deps fix help'));
    assert.equal(queue.mutates, false);
    assert.deepEqual(queue.mutationTargets, []);
  });

  it('keeps toolkit registry metadata synchronized with the schema adapter', async () => {
    const { EXECUTOR_COMMAND_REGISTRY } = await import('../dist/command_registry.js');
    const { listCommands } = await import('@tjalve/qube-cli/registry');
    const adapterCommands = getImplementedCommands();
    const registryCommands = listCommands(EXECUTOR_COMMAND_REGISTRY);

    assert.deepEqual(adapterCommands.map(command => command.name).sort(), registryCommands.map(command => command.name).sort());

    for (const registryCommand of registryCommands) {
      const metadata = adapterCommands.find(command => command.name === registryCommand.name);
      assert.ok(metadata, `missing metadata for ${registryCommand.name}`);
      assert.equal(registryCommand.description, metadata.description, `description drift for ${metadata.name}`);
      assert.deepEqual((registryCommand.examples ?? []).map(example => example.command), metadata.examples, `examples drift for ${metadata.name}`);
      assert.deepEqual((registryCommand.arguments ?? []).map(argument => argument.name).sort(), [...metadata.args].sort(), `args drift for ${metadata.name}`);
      assert.ok(metadata.flags.every(flag => flag.startsWith('--')), `schema flags must use CLI tokens for ${metadata.name}`);
    }
  });

  it('publishes implemented lifecycle commands while keeping later lifecycle commands hidden', () => {
    const commandNames = getImplementedCommands().map(command => command.name);
    assert.equal(commandNames.includes('start'), true);
    assert.equal(commandNames.includes('branch create'), true);
    assert.equal(commandNames.includes('complete'), true);
    assert.equal(commandNames.includes('init'), true);
    assert.equal(getImplementedCommands().find(command => command.name === 'complete').supportsCheckOnly, true);
    assert.deepEqual(getImplementedCommands().find(command => command.name === 'init').mutationTargets, ['local-files']);
  });

  it('recognizes canonical help tokens before positional parsing', () => {
    assert.equal(isHelpToken('help'), true);
    assert.equal(isHelpToken('--help'), true);
    assert.equal(isHelpToken('-h'), true);
    assert.equal(isHelpToken('93'), false);
  });
});

describe('doctor lifecycle diagnostics', () => {
  it('reports lifecycle readiness, active issue branch matching, PR, worktree, and base branch state', () => {
    const { buildLifecycleDiagnostics } = require('../dist/doctor.js');
    const config = { ...getDefaults(), noWorktree: true, blockOnOpenPRs: true };
    const active = makeIssue(93, ['S-InProgress']);
    active.title = 'Ship lifecycle command';

    const ready = buildLifecycleDiagnostics({
      config,
      currentBranch: 'issue/93-ship-lifecycle-command',
      isWorktree: false,
      openIssues: [active],
      queueDriftCount: 0,
      queueMultipleInProgress: false,
      baseRef: { remote: 'origin', branch: 'main', resolved: true, upToDate: true },
      blockingPullRequestCount: 0,
    });

    assert.equal(ready.branchNamingValid, true);
    assert.equal(ready.inProgressIssueCount, 1);
    assert.equal(ready.activeIssueNumber, 93);
    assert.equal(ready.currentBranchMatchesActiveIssue, true);
    assert.equal(ready.lifecycleCommandsReady, true);

    const blocked = buildLifecycleDiagnostics({
      config: { ...config, branchNaming: 'issue/<number>' },
      currentBranch: 'main',
      isWorktree: true,
      openIssues: [active],
      queueDriftCount: 1,
      queueMultipleInProgress: false,
      baseRef: { remote: 'origin', branch: 'main', resolved: true, upToDate: false },
      blockingPullRequestCount: 1,
    });

    assert.equal(blocked.branchNamingValid, false);
    assert.equal(blocked.linkedWorktreeBlocked, true);
    assert.equal(blocked.baseBranchFresh, false);
    assert.equal(blocked.lifecycleCommandsReady, false);

    const worktreeAllowed = buildLifecycleDiagnostics({
      config: { ...config, noWorktree: false },
      currentBranch: 'issue/93-ship-lifecycle-command',
      isWorktree: true,
      openIssues: [active],
      queueDriftCount: 0,
      queueMultipleInProgress: false,
      baseRef: { remote: 'origin', branch: 'main', resolved: true, upToDate: true },
      blockingPullRequestCount: 0,
    });

    assert.equal(worktreeAllowed.linkedWorktreeBlocked, false);
    assert.equal(worktreeAllowed.lifecycleCommandsReady, true);

    const whitespacePattern = buildLifecycleDiagnostics({
      config: { ...config, branchNaming: 'issue/<number> <slug>' },
      currentBranch: 'issue/93-ship-lifecycle-command',
      isWorktree: false,
      openIssues: [active],
      queueDriftCount: 0,
      queueMultipleInProgress: false,
      baseRef: { remote: 'origin', branch: 'main', resolved: true, upToDate: true },
      blockingPullRequestCount: 0,
    });

    assert.equal(whitespacePattern.branchNamingValid, false);
    assert.equal(whitespacePattern.lifecycleCommandsReady, false);

    const queueFailed = buildLifecycleDiagnostics({
      config,
      currentBranch: 'issue/93-ship-lifecycle-command',
      isWorktree: false,
      openIssues: [active],
      queueDriftCount: 0,
      queueMultipleInProgress: false,
      queueError: 'gh issue list failed',
      baseRef: { remote: 'origin', branch: 'main', resolved: true, upToDate: true },
      blockingPullRequestCount: 0,
    });

    assert.equal(queueFailed.queueError, 'gh issue list failed');
    assert.equal(queueFailed.lifecycleCommandsReady, false);
  });
});
