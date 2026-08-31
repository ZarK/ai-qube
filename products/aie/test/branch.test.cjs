const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { mkdtempSync, realpathSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { describe, it } = require('node:test');
const { cloneGitRepo } = require('./support/git_fixture.cjs');
const { getDefaults } = require('../dist/config/index.js');

function portable(path) {
  return path.replace(/\\/g, '/');
}

function makeGitRepo() {
  return cloneGitRepo('committed', 'aie-branch-');
}

function issue(number, title = 'Add branch command') {
  return {
    number,
    title,
    body: '',
    state: 'OPEN',
    labels: [{ name: 'S-Ready' }],
    milestone: null,
    url: `https://github.com/example/repo/issues/${number}`,
  };
}

function success(args, stdout = '') {
  return { args, exitCode: 0, stdout, stderr: '' };
}

function makeExec(number, title = 'Add branch command', labels = [{ name: 'S-Ready' }]) {
  return async args => {
    const key = args.join(' ');
    if (key === `issue view ${number} --json number,title,state,labels,body,milestone,url`) {
      return success(args, JSON.stringify({ ...issue(number, title), labels }));
    }
    return { args, exitCode: 1, stdout: '', stderr: `unexpected gh call: ${key}` };
  };
}

function headRevision(repo, ref = 'HEAD') {
  return execFileSync('git', ['rev-parse', ref], { cwd: repo, encoding: 'utf8' }).trim();
}

function addBareOriginRemote(repo) {
  const bare = mkdtempSync(join(tmpdir(), 'aie-branch-remote-'));
  execFileSync('git', ['init', '--bare', '-b', 'main'], { cwd: bare, stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['push', 'origin', 'main'], { cwd: repo, stdio: 'ignore' });
  return bare;
}

function pushRemoteIssueBranch(repo, branchName, fileName, content) {
  execFileSync('git', ['switch', '-c', branchName], { cwd: repo, stdio: 'ignore' });
  writeFileSync(join(repo, fileName), content);
  execFileSync('git', ['add', fileName], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', `remote fixture ${fileName}`], { cwd: repo, stdio: 'ignore' });
  const revision = headRevision(repo);
  execFileSync('git', ['push', 'origin', branchName], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['switch', 'main'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['branch', '-D', branchName], { cwd: repo, stdio: 'ignore' });
  return revision;
}

function makeGit(calls = []) {
  return async (args, options) => {
    calls.push(args);
    const result = spawnSync('git', args, { cwd: options.cwd, encoding: 'utf8' });
    return { args, exitCode: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
}

describe('branch service', () => {
  const { runBranchCommand, suggestBranchName } = require('../dist/branch.js');

  it('inspects typed repository state through the local provider', async () => {
    const repo = makeGitRepo();
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/example/repo.git'], { cwd: repo, stdio: 'ignore' });
    const { createLocalGitRepositoryProvider } = require('../dist/providers/local/local_git_provider.js');
    const { configToExecutorPolicy } = require('../dist/config_policy.js');

    const state = await createLocalGitRepositoryProvider({ cwd: repo }).inspect(configToExecutorPolicy(getDefaults()));

    assert.equal(state.root, portable(realpathSync(repo)));
    assert.equal(state.activeRef.name, 'main');
    assert.equal(state.baseRef.name, 'main');
    assert.equal(state.baseRef.remoteName, 'origin');
    assert.equal(state.baseRef.upToDate, true);
    assert.deepEqual(state.remotes, [{ name: 'origin', url: 'https://github.com/example/repo.git' }]);
    assert.equal(state.worktree.linked, false);
    assert.equal(state.dirty.dirty, false);
  });

  it('does not report missing or stale remote base state when freshness is not required', async () => {
    const repo = makeGitRepo();
    execFileSync('git', ['update-ref', '-d', 'refs/remotes/origin/main'], { cwd: repo, stdio: 'ignore' });
    const { createLocalGitRepositoryProvider } = require('../dist/providers/local/local_git_provider.js');
    const { configToExecutorPolicy } = require('../dist/config_policy.js');
    const { formatBranchResult } = require('../dist/branch_command.js');
    const { getBaseRefStatus } = require('../dist/repo/index.js');
    const config = getDefaults();
    config.requireBaseBranchFreshness = false;

    const state = await createLocalGitRepositoryProvider({ cwd: repo }).inspect(configToExecutorPolicy(config), { offline: true });

    assert.equal(state.prerequisites.checks.find(check => check.id === 'base-ref').status, 'ready');
    assert.equal(state.baseRef.revision, headRevision(repo));
    assert.equal(state.baseRef.remoteRevision, null);
    assert.equal(state.baseRef.upToDate, undefined);
    assert.equal(state.baseRef.error, null);
    assert.equal(state.warnings.some(warning => /base branch|base ref/i.test(warning)), false);

    const baseRef = getBaseRefStatus(config, repo);
    assert.equal(baseRef.upToDate, null);

    const result = await runBranchCommand({ command: 'branch create', issueNumber: 93, dryRun: true, exec: makeExec(93), cwd: repo, config });
    assert.equal(result.branch.baseRef.upToDate, null);
    assert.match(formatBranchResult(result), /Base ref: origin\/main freshness not required/);
  });

  it('reports staged, modified, and deleted paths in typed repository state', async () => {
    const repo = makeGitRepo();
    writeFileSync(join(repo, 'delete-me.txt'), 'delete me\n');
    execFileSync('git', ['add', 'delete-me.txt'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'add delete fixture'], { cwd: repo, stdio: 'ignore' });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', head], { cwd: repo, stdio: 'ignore' });
    writeFileSync(join(repo, 'staged.txt'), 'staged\n');
    execFileSync('git', ['add', 'staged.txt'], { cwd: repo, stdio: 'ignore' });
    writeFileSync(join(repo, 'README.md'), 'modified\n');
    rmSync(join(repo, 'delete-me.txt'));
    const { createLocalGitRepositoryProvider } = require('../dist/providers/local/local_git_provider.js');
    const { configToExecutorPolicy } = require('../dist/config_policy.js');

    const state = await createLocalGitRepositoryProvider({ cwd: repo }).inspect(configToExecutorPolicy(getDefaults()));

    assert.equal(state.dirty.dirty, true);
    assert.ok(state.dirty.paths.some(path => path.includes('staged.txt')));
    assert.ok(state.dirty.paths.some(path => path.includes('README.md')));
    assert.ok(state.dirty.paths.some(path => path.includes('delete-me.txt')));
  });

  it('reports linked worktree state through typed repository inspection', async () => {
    const repo = makeGitRepo();
    const linked = join(mkdtempSync(join(tmpdir(), 'aie-branch-provider-linked-')), 'worktree');
    execFileSync('git', ['worktree', 'add', '-b', 'linked-state', linked], { cwd: repo, stdio: 'ignore' });
    const { createLocalGitRepositoryProvider } = require('../dist/providers/local/local_git_provider.js');
    const { configToExecutorPolicy } = require('../dist/config_policy.js');

    const state = await createLocalGitRepositoryProvider({ cwd: linked }).inspect(configToExecutorPolicy(getDefaults()));

    assert.equal(state.root, portable(realpathSync(linked)));
    assert.equal(state.worktree.linked, true);
    assert.match(state.worktree.gitDir, /worktrees/);
  });

  it('does not report gitfile checkouts as linked worktrees without worktree git dirs', () => {
    const repo = makeGitRepo();
    const parent = mkdtempSync(join(tmpdir(), 'aie-branch-gitfile-'));
    const checkout = join(parent, 'checkout');
    const gitDir = join(parent, 'git-dir');
    execFileSync('git', ['clone', '--separate-git-dir', gitDir, repo, checkout], { stdio: 'ignore' });
    const { inspectWorktree } = require('../dist/providers/local/local_git_provider.js');

    const worktree = inspectWorktree(checkout);

    assert.equal(worktree.linked, false);
    assert.ok(worktree.gitDir);
  });

  it('uses the configured base remote for branch creation plans', async () => {
    const repo = makeGitRepo();
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    execFileSync('git', ['remote', 'add', 'upstream', 'https://github.com/example/upstream.git'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['update-ref', 'refs/remotes/upstream/main', head], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['update-ref', '-d', 'refs/remotes/origin/main'], { cwd: repo, stdio: 'ignore' });
    const config = { ...getDefaults(), baseRemote: 'upstream' };

    const result = await runBranchCommand({ command: 'branch create', issueNumber: 93, dryRun: true, exec: makeExec(93), cwd: repo, config });

    assert.equal(result.ok, true);
    assert.equal(result.branch.baseRef.remote, 'upstream');
    assert.equal(result.branch.baseRef.upToDate, true);
    assert.equal(result.plan.dryRun, true);
    assert.equal(result.plan.actions[0].mutation, 'repository-provider');
    assert.equal(result.plan.actions[0].details.baseRemote, 'upstream');
  });

  it('suggests the policy branch without mutating git', async () => {
    const calls = [];
    const git = async (args, options) => {
      calls.push(args);
      if (args[0] === 'check-ref-format') return success(args);
      return makeGit()(args, options);
    };

    const result = await runBranchCommand({
      command: 'branch suggest',
      issueNumber: 93,
      exec: makeExec(93, 'Add real view command!'),
      git,
      cwd: join(tmpdir(), 'missing-aie-branch-repo'),
    });

    assert.equal(result.ok, true);
    assert.equal(result.branch.suggested, 'issue/93-add-real-view-command');
    assert.equal(calls.some(args => args[0] === 'switch'), false);
  });

  it('keeps view and branch naming policy aligned', () => {
    const { suggestBranchName: viewSuggestBranchName } = require('../dist/view.js');
    const sample = { number: 93, title: 'Branch helper parity!', body: '', state: 'OPEN', labels: [], milestone: null, url: '', declaredBlockers: [] };

    assert.equal(suggestBranchName(sample, getDefaults()), viewSuggestBranchName(sample, getDefaults()));
    assert.equal(suggestBranchName(sample, { ...getDefaults(), branchNaming: 'work/<number>/<slug>' }), 'work/93/branch-helper-parity');
    assert.equal(suggestBranchName(sample, { ...getDefaults(), branchNaming: 'work/<number>/<slug>/<number>-<slug>' }), 'work/93/branch-helper-parity/93-branch-helper-parity');
    assert.equal(suggestBranchName({ ...sample, title: 'Fix: UI 🚀 -- déjà vu!!!' }, getDefaults()), 'issue/93-fix-ui-dj-vu');
  });

  it('maps supply-chain-sensitive gate commands into executor policy', () => {
    const { configToExecutorPolicy } = require('../dist/config_policy.js');
    const policy = configToExecutorPolicy({
      ...getDefaults(),
      gates: [{ name: 'install-check', kind: 'custom', command: 'npm ci --ignore-scripts', stage: 'pre-pr', required: true, timeoutSeconds: 600, workingDirectory: '.', env: {}, externalService: false }],
    });

    assert.equal(policy.gates.definitions[0].supplyChainSensitive, true);
  });

  it('checks whether the current branch matches the issue branch', async () => {
    const repo = makeGitRepo();
    execFileSync('git', ['switch', '-c', 'issue/93-add-branch-command'], { cwd: repo, stdio: 'ignore' });

    const result = await runBranchCommand({ command: 'branch check', issueNumber: 93, exec: makeExec(93), cwd: repo });

    assert.equal(result.ok, true);
    assert.equal(result.branch.current, 'issue/93-add-branch-command');
    assert.equal(result.branch.matches, true);
    assert.equal(result.plan.actions[0].mutation, 'none');
  });

  it('reports branch check mismatch without planning mutation', async () => {
    const repo = makeGitRepo();
    execFileSync('git', ['switch', '-c', 'issue/94-other-change'], { cwd: repo, stdio: 'ignore' });

    const result = await runBranchCommand({ command: 'branch check', issueNumber: 93, exec: makeExec(93), cwd: repo });

    assert.equal(result.ok, false);
    assert.equal(result.branch.current, 'issue/94-other-change');
    assert.equal(result.branch.matches, false);
    assert.equal(result.plan.actions[0].mutation, 'none');
  });

  it('blocks provider-native work providers before branch lifecycle reads or git mutation', async () => {
    const repo = makeGitRepo();
    const config = { ...getDefaults(), providers: { ...getDefaults().providers, work: { kind: 'jira' } } };
    const calls = [];

    await assert.rejects(
      () => runBranchCommand({ command: 'branch create', issueNumber: 93, dryRun: false, git: makeGit(calls), cwd: repo, config }),
      /qube aie branch create.*providers\.work\.kind=github/s,
    );

    assert.equal(calls.some(args => args[0] === 'switch' || args[0] === 'checkout'), false);
  });

  it('plans branch creation in dry-run without switching branches', async () => {
    const repo = makeGitRepo();
    const calls = [];

    const result = await runBranchCommand({ command: 'branch create', issueNumber: 93, dryRun: true, exec: makeExec(93), git: makeGit(calls), cwd: repo });

    const current = execFileSync('git', ['branch', '--show-current'], { cwd: repo, encoding: 'utf8' }).trim();
    assert.equal(result.ok, true);
    assert.equal(result.plan.actions[0].status, 'planned');
    assert.equal(current, 'main');
    assert.equal(calls.some(args => args[0] === 'switch'), false);
    assert.equal(calls.filter(args => args[0] === 'status').length, 1);
  });

  it('creates a branch using non-destructive git commands', async () => {
    const repo = makeGitRepo();
    const calls = [];

    const result = await runBranchCommand({ command: 'branch create', issueNumber: 93, dryRun: false, exec: makeExec(93), git: makeGit(calls), cwd: repo });
    const current = execFileSync('git', ['branch', '--show-current'], { cwd: repo, encoding: 'utf8' }).trim();

    assert.equal(result.ok, true);
    assert.equal(result.plan.actions[0].status, 'completed');
    assert.equal(current, 'issue/93-add-branch-command');
    assert.deepEqual(calls.find(args => args[0] === 'switch'), ['switch', '-c', 'issue/93-add-branch-command', 'main']);
    assert.equal(calls.some(args => args.includes('reset') || args.includes('clean') || args.includes('-D') || args.includes('--force')), false);
  });

  it('recovers a remote-only issue branch as a local tracking branch at the remote head', async () => {
    const repo = makeGitRepo();
    const calls = [];
    const baseRevision = headRevision(repo);
    addBareOriginRemote(repo);
    const remoteRevision = pushRemoteIssueBranch(repo, 'issue/93-add-branch-command', 'remote-work.md', 'existing implementation\n');

    const result = await runBranchCommand({ command: 'branch create', issueNumber: 93, dryRun: false, exec: makeExec(93), git: makeGit(calls), cwd: repo });
    const current = execFileSync('git', ['branch', '--show-current'], { cwd: repo, encoding: 'utf8' }).trim();

    assert.equal(result.ok, true);
    assert.equal(result.branch.remoteBranch.exists, true);
    assert.equal(result.branch.remoteBranch.revision, remoteRevision);
    assert.equal(current, 'issue/93-add-branch-command');
    // The branch lands on the remote implementation head, never on the base.
    assert.equal(headRevision(repo), remoteRevision);
    assert.notEqual(headRevision(repo), baseRevision);
    const upstream = execFileSync('git', ['rev-parse', '--abbrev-ref', 'issue/93-add-branch-command@{upstream}'], { cwd: repo, encoding: 'utf8' }).trim();
    assert.equal(upstream, 'origin/issue/93-add-branch-command');
    assert.ok(calls.some(args => args[0] === 'switch' && args.includes('--track')));
    assert.equal(calls.some(args => args[0] === 'switch' && args.includes('main')), false);
  });

  it('recovers a remote branch found by live lookup when the tracking ref is absent', async () => {
    const repo = makeGitRepo();
    const calls = [];
    const transportOptions = [];
    addBareOriginRemote(repo);
    const remoteRevision = pushRemoteIssueBranch(repo, 'issue/93-add-branch-command', 'remote-work.md', 'existing implementation\n');
    // A clean-machine continuation has no remote-tracking ref yet.
    execFileSync('git', ['update-ref', '-d', 'refs/remotes/origin/issue/93-add-branch-command'], { cwd: repo, stdio: 'ignore' });

    const executeGit = makeGit(calls);
    const result = await runBranchCommand({
      command: 'branch create',
      issueNumber: 93,
      dryRun: false,
      exec: makeExec(93),
      git: async (args, options) => {
        if (args[0] === 'ls-remote' && args.includes('--heads')) transportOptions.push(options);
        return executeGit(args, options);
      },
      cwd: repo,
    });
    const current = execFileSync('git', ['branch', '--show-current'], { cwd: repo, encoding: 'utf8' }).trim();

    assert.equal(result.ok, true);
    assert.equal(result.branch.remoteBranch.trackingRefPresent, false);
    assert.equal(result.branch.remoteBranch.revision, remoteRevision);
    assert.equal(current, 'issue/93-add-branch-command');
    assert.equal(headRevision(repo), remoteRevision);
    assert.ok(calls.some(args => args[0] === 'ls-remote'));
    assert.ok(calls.some(args => args[0] === 'fetch' && args.includes('issue/93-add-branch-command')));
    assert.equal(transportOptions[0]?.timeoutMs, 10_000);
    assert.equal(transportOptions[0]?.env?.GIT_TERMINAL_PROMPT, '0');
    assert.equal(transportOptions[0]?.env?.GCM_INTERACTIVE, 'Never');
    assert.match(transportOptions[0]?.env?.GIT_SSH_COMMAND ?? '', /BatchMode=yes/);
  });

  it('stops with both revisions when local and remote issue branches diverge', async () => {
    const repo = makeGitRepo();
    const calls = [];
    addBareOriginRemote(repo);
    const remoteRevision = pushRemoteIssueBranch(repo, 'issue/93-add-branch-command', 'remote-work.md', 'remote divergence\n');
    execFileSync('git', ['switch', '-c', 'issue/93-add-branch-command', 'main'], { cwd: repo, stdio: 'ignore' });
    writeFileSync(join(repo, 'local-work.md'), 'local divergence\n');
    execFileSync('git', ['add', 'local-work.md'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'local divergence'], { cwd: repo, stdio: 'ignore' });
    const localRevision = headRevision(repo);
    execFileSync('git', ['switch', 'main'], { cwd: repo, stdio: 'ignore' });

    const result = await runBranchCommand({ command: 'branch create', issueNumber: 93, dryRun: false, exec: makeExec(93), git: makeGit(calls), cwd: repo });
    const current = execFileSync('git', ['branch', '--show-current'], { cwd: repo, encoding: 'utf8' }).trim();

    assert.equal(result.ok, false);
    assert.equal(result.branch.remoteBranch.relation, 'diverged');
    assert.ok(result.errors.some(error => error.includes(localRevision) && error.includes(remoteRevision)));
    assert.ok(result.errors.some(error => /merge or rebase/.test(error) && /do not recreate the branch or force-push/.test(error)));
    assert.equal(current, 'main', 'a diverged branch pair must not mutate the checkout');
    assert.equal(calls.some(args => args[0] === 'switch' || args[0] === 'fetch'), false);
  });

  it('fails closed when the remote lookup is unavailable for an in-progress issue', async () => {
    const repo = makeGitRepo();
    const calls = [];

    const result = await runBranchCommand({ command: 'branch create', issueNumber: 93, dryRun: false, exec: makeExec(93, 'Add branch command', [{ name: 'S-InProgress' }]), git: makeGit(calls), cwd: repo });
    const current = execFileSync('git', ['branch', '--show-current'], { cwd: repo, encoding: 'utf8' }).trim();

    assert.equal(result.ok, false);
    assert.equal(result.branch.remoteBranch.exists, null);
    assert.ok(result.errors.some(error => /in progress/.test(error) && /parallel branch/.test(error)));
    assert.equal(current, 'main');
    assert.equal(calls.some(args => args[0] === 'switch'), false);
  });

  it('creates from base with a warning when the remote lookup is unavailable for a ready issue', async () => {
    const repo = makeGitRepo();
    const calls = [];

    const result = await runBranchCommand({ command: 'branch create', issueNumber: 93, dryRun: false, exec: makeExec(93), git: makeGit(calls), cwd: repo });
    const current = execFileSync('git', ['branch', '--show-current'], { cwd: repo, encoding: 'utf8' }).trim();

    assert.equal(result.ok, true);
    assert.equal(result.branch.remoteBranch.exists, null);
    assert.equal(current, 'issue/93-add-branch-command');
    const warnings = result.plan.actions.flatMap(action => Array.isArray(action.details.warnings) ? action.details.warnings : []);
    assert.ok(warnings.some(warning => /could not be queried/.test(warning)));
    assert.deepEqual(calls.find(args => args[0] === 'switch'), ['switch', '-c', 'issue/93-add-branch-command', 'main']);
  });

  it('follows the safe create-from-base path when the remote branch is genuinely absent', async () => {
    const repo = makeGitRepo();
    const calls = [];
    addBareOriginRemote(repo);

    const result = await runBranchCommand({ command: 'branch create', issueNumber: 93, dryRun: false, exec: makeExec(93), git: makeGit(calls), cwd: repo });
    const current = execFileSync('git', ['branch', '--show-current'], { cwd: repo, encoding: 'utf8' }).trim();

    assert.equal(result.ok, true);
    assert.equal(result.branch.remoteBranch.exists, false);
    assert.equal(current, 'issue/93-add-branch-command');
    const warnings = result.plan.actions.flatMap(action => Array.isArray(action.details.warnings) ? action.details.warnings : []);
    assert.equal(warnings.length, 0);
    assert.deepEqual(calls.find(args => args[0] === 'switch'), ['switch', '-c', 'issue/93-add-branch-command', 'main']);
  });

  it('switches to an existing issue branch without recreating it', async () => {
    const repo = makeGitRepo();
    const calls = [];
    execFileSync('git', ['switch', '-c', 'issue/93-add-branch-command'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['switch', 'main'], { cwd: repo, stdio: 'ignore' });

    const result = await runBranchCommand({ command: 'branch create', issueNumber: 93, dryRun: false, exec: makeExec(93), git: makeGit(calls), cwd: repo });

    assert.equal(result.ok, true);
    assert.deepEqual(calls.find(args => args[0] === 'switch'), ['switch', 'issue/93-add-branch-command']);
  });

  it('allows existing branch checkout when the base ref is stale', async () => {
    const repo = makeGitRepo();
    execFileSync('git', ['switch', '-c', 'issue/93-add-branch-command'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['switch', 'main'], { cwd: repo, stdio: 'ignore' });
    writeFileSync(join(repo, 'README.md'), 'advanced\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'advance main'], { cwd: repo, stdio: 'ignore' });

    const result = await runBranchCommand({ command: 'branch create', issueNumber: 93, dryRun: false, exec: makeExec(93), cwd: repo });

    assert.equal(result.ok, true);
    assert.equal(result.branch.exists, true);
    assert.equal(result.plan.actions[0].status, 'completed');
  });

  it('refuses dirty checkouts before branch creation', async () => {
    const repo = makeGitRepo();
    writeFileSync(join(repo, 'scratch.txt'), 'untracked\n');

    const result = await runBranchCommand({ command: 'branch create', issueNumber: 93, dryRun: false, exec: makeExec(93), cwd: repo });

    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /Working tree has uncommitted or untracked changes/);
    assert.equal(result.plan.actions[0].status, 'failed');
  });

  it('refuses branch names rejected by git ref validation', async () => {
    const repo = makeGitRepo();
    const calls = [];
    const config = { ...getDefaults(), branchNaming: 'issue/<number>-<slug>.lock' };

    const result = await runBranchCommand({ command: 'branch create', issueNumber: 93, dryRun: false, exec: makeExec(93), git: makeGit(calls), cwd: repo, config });

    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /is not valid for git|must be a valid branch name|not a valid branch name/);
    assert.equal(result.plan.actions[0].status, 'failed');
    assert.equal(calls.some(args => args[0] === 'switch'), false);
  });

  it('refuses linked worktrees when policy disables them', async () => {
    const repo = makeGitRepo();
    const calls = [];
    const linked = join(mkdtempSync(join(tmpdir(), 'aie-branch-linked-')), 'worktree');
    execFileSync('git', ['worktree', 'add', '-b', 'linked-work', linked], { cwd: repo, stdio: 'ignore' });

    const result = await runBranchCommand({ command: 'branch create', issueNumber: 93, dryRun: false, exec: makeExec(93), git: makeGit(calls), cwd: linked });
    const current = execFileSync('git', ['branch', '--show-current'], { cwd: linked, encoding: 'utf8' }).trim();

    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /Linked git worktree detected/);
    assert.equal(current, 'linked-work');
    assert.equal(calls.some(args => args[0] === 'switch' || args[0] === 'checkout'), false);
  });

  it('refuses existing branch checkout from linked worktrees', async () => {
    const repo = makeGitRepo();
    const calls = [];
    execFileSync('git', ['switch', '-c', 'issue/93-add-branch-command'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['switch', 'main'], { cwd: repo, stdio: 'ignore' });
    const linked = join(mkdtempSync(join(tmpdir(), 'aie-branch-linked-existing-')), 'worktree');
    execFileSync('git', ['worktree', 'add', '-b', 'linked-work', linked], { cwd: repo, stdio: 'ignore' });

    const result = await runBranchCommand({ command: 'branch create', issueNumber: 93, dryRun: false, exec: makeExec(93), git: makeGit(calls), cwd: linked });
    const current = execFileSync('git', ['branch', '--show-current'], { cwd: linked, encoding: 'utf8' }).trim();

    assert.equal(result.ok, false);
    assert.equal(result.branch.exists, true);
    assert.match(result.errors.join('\n'), /Linked git worktree detected/);
    assert.equal(current, 'linked-work');
    assert.equal(calls.some(args => args[0] === 'switch' || args[0] === 'checkout'), false);
  });

  it('refuses stale local base branches', async () => {
    const repo = makeGitRepo();
    writeFileSync(join(repo, 'README.md'), 'changed\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'advance main'], { cwd: repo, stdio: 'ignore' });

    const result = await runBranchCommand({ command: 'branch create', issueNumber: 93, dryRun: false, exec: makeExec(93), cwd: repo });

    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /Base branch origin\/main is not current locally/);
  });

  it('refuses branch creation when the configured remote base is ahead of local base', async () => {
    const repo = makeGitRepo();
    execFileSync('git', ['switch', '-c', 'remote-main'], { cwd: repo, stdio: 'ignore' });
    writeFileSync(join(repo, 'remote.txt'), 'remote\n');
    execFileSync('git', ['add', 'remote.txt'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'advance remote'], { cwd: repo, stdio: 'ignore' });
    const remoteHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    execFileSync('git', ['switch', 'main'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', remoteHead], { cwd: repo, stdio: 'ignore' });

    const result = await runBranchCommand({ command: 'branch create', issueNumber: 93, dryRun: false, exec: makeExec(93), cwd: repo });

    assert.equal(result.ok, false);
    assert.equal(result.branch.baseRef.upToDate, false);
    assert.match(result.errors.join('\n'), /Base branch origin\/main is not current locally/);
  });
});

describe('branch command metadata', () => {
  it('publishes registry-backed schema metadata', () => {
    const { getImplementedCommands, getCommandMetadata } = require('../dist/command_metadata.js');
    const commands = getImplementedCommands();
    const branch = getCommandMetadata('branch');
    const branchSuggest = getCommandMetadata('branch suggest');
    const branchCheck = getCommandMetadata('branch check');
    const branchCreate = getCommandMetadata('branch create');

    assert.ok(branch.examples.some(example => example.includes('branch create')));
    assert.ok(branchSuggest.flags.includes('--json'));
    assert.ok(branchCheck.flags.includes('--json'));
    assert.ok(branchCreate.flags.includes('--dry-run'));
    assert.equal(commands.find(command => command.name === 'branch suggest').mutates, false);
    assert.equal(commands.find(command => command.name === 'branch check').mutates, false);
    assert.deepEqual(commands.find(command => command.name === 'branch create').mutationTargets, ['git']);
  });

  it('prints branch topic and subcommand usage safely', () => {
    const topic = spawnSync(process.execPath, ['./bin/run', 'branch'], { cwd: process.cwd(), encoding: 'utf8' });
    const suggest = spawnSync(process.execPath, ['./bin/run', 'branch', 'suggest'], { cwd: process.cwd(), encoding: 'utf8' });
    const suggestJson = spawnSync(process.execPath, ['./bin/run', 'branch', 'suggest', '--json'], { cwd: process.cwd(), encoding: 'utf8' });

    assert.equal(topic.status, 0);
    assert.match(topic.stdout, /aie branch suggest/);
    assert.equal(suggest.status, 0);
    assert.match(suggest.stdout, /Usage: aie branch suggest <issue>/);
    assert.equal(JSON.parse(suggestJson.stdout).usage, 'aie branch suggest <issue>');
  });
});
