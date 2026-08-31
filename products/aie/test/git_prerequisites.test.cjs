const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync } = require('node:fs');
const { homedir, tmpdir } = require('node:os');
const { join } = require('node:path');
const { describe, it } = require('node:test');

const {
  MINIMUM_GIT_VERSION,
  classifyGitTransportFailure,
  evaluateGitPrerequisites,
  notRequiredGitPrerequisites,
  prerequisiteCheck,
  redactGitError,
  redactRemoteUrl,
} = require('../dist/index.js');
const { buildInitPlan } = require('../dist/init/index.js');

const policy = {
  branch: {
    baseRemote: 'origin',
    baseBranch: 'main',
    requirePrimaryCheckout: true,
    requireFreshBase: true,
  },
};

function response(args, exitCode = 0, stdout = '', stderr = '') {
  return { args, exitCode, stdout, stderr };
}

function readyRunner(root, overrides = {}) {
  const calls = [];
  const run = async (args, options) => {
    calls.push({ args, options });
    const key = args.join(' ');
    if (Object.hasOwn(overrides, key)) {
      const value = overrides[key];
      return typeof value === 'function' ? value(args, options) : response(args, value.exitCode, value.stdout, value.stderr);
    }
    if (key === '--version') return response(args, 0, 'git version 2.55.0\n');
    if (key === 'help -a') return response(args, 0, 'available commands: init switch status config remote rev-parse branch ls-remote\n');
    if (key === 'rev-parse --show-toplevel') return response(args, 0, `${root}\n`);
    if (key.includes('config --includes --show-origin --show-scope --get')) {
      return response(args, 0, `global\tfile:${join(homedir(), '.gitconfig')}\tprivate value\n`);
    }
    if (key === 'rev-parse --verify HEAD') return response(args, 0, 'abc123\n');
    if (key === 'branch --show-current') return response(args, 0, 'main\n');
    if (key === 'rev-parse --git-dir' || key === 'rev-parse --git-common-dir') return response(args, 0, '.git\n');
    if (key === 'status --porcelain') return response(args, 0, '');
    if (key === 'rev-parse --verify main' || key === 'rev-parse --verify origin/main') return response(args, 0, 'abc123\n');
    if (key === 'remote get-url --all origin') return response(args, 0, 'https://user:secret@example.test/team/repo.git?token=secret#fragment\n');
    if (key === 'ls-remote origin HEAD') return response(args, 0, 'abc123\tHEAD\n');
    return response(args, 1, '', `unexpected command: ${key}`);
  };
  return { run, calls };
}

describe('Git repository prerequisites', () => {
  it('stops standalone repository init before questions or writes for a non-repository target', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aie-init-prerequisite-'));
    const result = await buildInitPlan({ target: '.', cwd: root, tool: 'codex', dryRun: false, force: false, yes: true });

    assert.equal(result.ok, false);
    assert.equal(prerequisiteCheck(result.prerequisites, 'repository').reasonCode, 'not-a-repository');
    assert.deepEqual(result.questions, []);
    assert.deepEqual(result.actions, []);
    assert.match(result.nextCommand, /git-init|initialize Git/i);
  });

  it('constructs global not-required results without invoking Git', async () => {
    let calls = 0;
    const result = await evaluateGitPrerequisites({
      cwd: tmpdir(),
      policy,
      scope: 'global',
      git: async () => { calls += 1; throw new Error('Git must not run'); },
    });

    assert.deepEqual(result, notRequiredGitPrerequisites());
    assert.equal(result.status, 'not-required');
    assert.equal(result.checks.every(check => check.status === 'not-required'), true);
    assert.equal(calls, 0);
  });

  it('distinguishes a missing executable before repository inspection', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aie-missing-git-marker-'));
    mkdirSync(join(root, '.git'));
    const calls = [];
    const result = await evaluateGitPrerequisites({
      cwd: root,
      policy,
      git: async args => {
        calls.push(args);
        return response(args, 127, '', 'spawn git ENOENT');
      },
    });

    assert.equal(result.status, 'needs-action');
    assert.equal(prerequisiteCheck(result, 'git').reasonCode, 'git-not-found');
    assert.equal(prerequisiteCheck(result, 'git').safeDetails.minimumVersion, MINIMUM_GIT_VERSION);
    assert.deepEqual(calls, [['--version']]);
  });

  it('distinguishes a non-repository target from unreadable Git metadata', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'aie-not-repo-'));
    const plainRunner = readyRunner(plain, {
      'rev-parse --show-toplevel': { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' },
    });
    const notRepository = await evaluateGitPrerequisites({ cwd: plain, policy, git: plainRunner.run });
    assert.equal(prerequisiteCheck(notRepository, 'repository').reasonCode, 'not-a-repository');

    const broken = mkdtempSync(join(tmpdir(), 'aie-unreadable-repo-'));
    mkdirSync(join(broken, '.git'));
    const brokenRunner = readyRunner(broken, {
      'rev-parse --show-toplevel': { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' },
    });
    const unreadable = await evaluateGitPrerequisites({ cwd: broken, policy, git: brokenRunner.run });
    assert.equal(prerequisiteCheck(unreadable, 'repository').reasonCode, 'repository-unreadable');
  });

  it('rejects an old version or missing required command capability', async () => {
    const old = await evaluateGitPrerequisites({
      cwd: tmpdir(),
      policy,
      git: async args => response(args, 0, 'git version 2.27.0\n'),
    });
    assert.equal(prerequisiteCheck(old, 'git').reasonCode, 'git-unsupported');

    const missingSwitch = await evaluateGitPrerequisites({
      cwd: tmpdir(),
      policy,
      git: async args => args[0] === '--version'
        ? response(args, 0, 'git version 2.55.0\n')
        : response(args, 0, 'available commands: init status\n'),
    });
    assert.equal(prerequisiteCheck(missingSwitch, 'git').reasonCode, 'git-unsupported');
    assert.equal(prerequisiteCheck(missingSwitch, 'git').safeDetails.switchCommand, false);
  });

  it('runs every local observation offline and leaves only transport unverified', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aie-git-prerequisites-'));
    const runner = readyRunner(root);
    const result = await evaluateGitPrerequisites({ cwd: root, policy, offline: true, git: runner.run });

    assert.equal(prerequisiteCheck(result, 'git').status, 'ready');
    assert.equal(prerequisiteCheck(result, 'repository').status, 'ready');
    assert.equal(prerequisiteCheck(result, 'identity-name').safeDetails.source, 'user-global');
    assert.equal(prerequisiteCheck(result, 'head').status, 'ready');
    assert.equal(prerequisiteCheck(result, 'base-ref').status, 'ready');
    assert.equal(prerequisiteCheck(result, 'remote-transport').status, 'unverified');
    assert.equal(runner.calls.some(call => call.args[0] === 'ls-remote'), false);
    assert.equal(JSON.stringify(result).includes('private value'), false);
    assert.equal(JSON.stringify(result).includes('secret'), false);
  });

  it('reports repository and included identity sources without serializing values', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aie-git-identity-source-'));
    const runner = readyRunner(root, {
      'config --includes --show-origin --show-scope --get user.name': { exitCode: 0, stdout: 'local\tfile:.git/config\tRepository Person\n', stderr: '' },
      'config --includes --show-origin --show-scope --get user.email': { exitCode: 0, stdout: `global\tfile:${join(root, 'identity.inc')}\tprivate@example.test\n`, stderr: '' },
    });
    const result = await evaluateGitPrerequisites({ cwd: root, policy, offline: true, git: runner.run });

    assert.equal(prerequisiteCheck(result, 'identity-name').safeDetails.source, 'repository');
    assert.equal(prerequisiteCheck(result, 'identity-email').safeDetails.source, 'included');
    assert.equal(JSON.stringify(result).includes('Repository Person'), false);
    assert.equal(JSON.stringify(result).includes('private@example.test'), false);
  });

  it('keeps unborn and remote-less local setup observable without inventing identity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aie-git-unborn-'));
    const runner = readyRunner(root, {
      'config --includes --show-origin --show-scope --get user.name': { exitCode: 1, stdout: '', stderr: '' },
      'config --includes --show-origin --show-scope --get user.email': { exitCode: 1, stdout: '', stderr: '' },
      'rev-parse --verify HEAD': { exitCode: 1, stdout: '', stderr: 'Needed a single revision' },
      'branch --show-current': { exitCode: 0, stdout: '', stderr: '' },
      'remote get-url --all origin': { exitCode: 2, stdout: '', stderr: 'No such remote' },
      'remote -v': { exitCode: 0, stdout: '', stderr: '' },
      'rev-parse --verify main': { exitCode: 1, stdout: '', stderr: '' },
      'rev-parse --verify origin/main': { exitCode: 1, stdout: '', stderr: '' },
    });
    const result = await evaluateGitPrerequisites({ cwd: root, policy, offline: true, git: runner.run });

    assert.equal(prerequisiteCheck(result, 'repository').status, 'ready');
    assert.equal(prerequisiteCheck(result, 'identity-name').reasonCode, 'identity-name-missing');
    assert.equal(prerequisiteCheck(result, 'identity-email').reasonCode, 'identity-email-missing');
    assert.equal(prerequisiteCheck(result, 'head').reasonCode, 'head-missing');
    assert.equal(prerequisiteCheck(result, 'branch').status, 'unverified');
    assert.equal(prerequisiteCheck(result, 'branch').safeDetails.branch, null);
    assert.equal(prerequisiteCheck(result, 'remote').reasonCode, 'remote-missing');
    assert.equal(runner.calls.some(call => call.args[0] === 'config' && call.args.includes('--add')), false);
  });

  it('does not coerce failed worktree or dirty-state inspection into a clean primary checkout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aie-git-local-inspection-'));
    const runner = readyRunner(root, {
      'rev-parse --git-dir': { exitCode: 1, stdout: '', stderr: 'metadata unavailable' },
      'rev-parse --git-common-dir': { exitCode: 1, stdout: '', stderr: 'metadata unavailable' },
      'status --porcelain': { exitCode: 1, stdout: '', stderr: 'status unavailable' },
    });
    const result = await evaluateGitPrerequisites({ cwd: root, policy, offline: true, git: runner.run });

    assert.equal(prerequisiteCheck(result, 'worktree').status, 'unverified');
    assert.equal(prerequisiteCheck(result, 'worktree').safeDetails.inspectionError, true);
    assert.equal(prerequisiteCheck(result, 'dirty-worktree').status, 'needs-action');
    assert.match(prerequisiteCheck(result, 'dirty-worktree').summary, /could not be inspected/);
  });

  it('reports detached HEAD, stale base state, and a safe selected remote independently', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aie-git-detached-'));
    const runner = readyRunner(root, {
      'branch --show-current': { exitCode: 0, stdout: '', stderr: '' },
      'rev-parse --verify origin/main': { exitCode: 0, stdout: 'different\n', stderr: '' },
      'remote get-url --all origin': { exitCode: 2, stdout: '', stderr: 'No such remote' },
      'remote -v': { exitCode: 0, stdout: 'upstream\tgit@example.test:team/repo.git (fetch)\nupstream\tgit@example.test:team/repo.git (push)\nmirror\thttps://mirror.example.test/repo.git (fetch)\n', stderr: '' },
      'ls-remote upstream HEAD': { exitCode: 0, stdout: 'abc123\tHEAD\n', stderr: '' },
    });
    const result = await evaluateGitPrerequisites({ cwd: root, policy, git: runner.run });

    assert.equal(prerequisiteCheck(result, 'branch').reasonCode, 'detached-head');
    assert.equal(prerequisiteCheck(result, 'base-ref').reasonCode, 'base-ref-stale');
    assert.equal(prerequisiteCheck(result, 'remote').safeDetails.name, 'upstream');
    assert.equal(prerequisiteCheck(result, 'remote').safeDetails.url, 'ssh://example.test/team/repo.git');
  });

  it('bounds remote probes, disables prompts, classifies auth failure, and redacts output', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aie-git-remote-'));
    const runner = readyRunner(root, {
      'ls-remote origin HEAD': {
        exitCode: 128,
        stdout: '',
        stderr: 'fatal: Authentication failed for https://alice:topsecret@example.test/team/repo.git?token=topsecret',
      },
    });
    const result = await evaluateGitPrerequisites({ cwd: root, policy, git: runner.run });
    const transport = prerequisiteCheck(result, 'remote-transport');
    const probe = runner.calls.find(call => call.args[0] === 'ls-remote');

    assert.equal(transport.reasonCode, 'remote-auth-failed');
    assert.equal(transport.safeDetails.category, 'authentication');
    assert.equal(probe.options.timeoutMs, 10_000);
    assert.equal(probe.options.env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(probe.options.env.GCM_INTERACTIVE, 'Never');
    assert.equal(runner.calls.some(call => call.args.includes('push')), false);
    assert.equal(JSON.stringify(result).includes('topsecret'), false);
    assert.equal(JSON.stringify(result).includes('alice'), false);
  });

  it('treats an accessible empty remote as readable without claiming write access', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aie-git-empty-remote-'));
    const runner = readyRunner(root, {
      'ls-remote origin HEAD': { exitCode: 0, stdout: '', stderr: '' },
    });
    const result = await evaluateGitPrerequisites({ cwd: root, policy, git: runner.run });
    const transport = prerequisiteCheck(result, 'remote-transport');

    assert.equal(transport.status, 'ready');
    assert.equal(transport.safeDetails.readAccess, true);
    assert.equal(transport.safeDetails.writeAccess, null);
  });

  it('redacts URL user information, queries, fragments, scp users, and token-shaped errors', () => {
    assert.deepEqual(redactRemoteUrl('https://alice:secret@example.test/team/repo.git?token=secret#fragment'), {
      url: 'https://example.test/team/repo.git',
      transport: 'https',
    });
    assert.deepEqual(redactRemoteUrl('git@example.test:team/repo.git'), {
      url: 'ssh://example.test/team/repo.git',
      transport: 'ssh',
    });
    const redacted = redactGitError('fatal https://alice:secret@example.test/repo.git token=github_pat_abcdefghijk');
    assert.equal(redacted.includes('alice'), false);
    assert.equal(redacted.includes('secret'), false);
    assert.equal(redacted.includes('abcdefghijk'), false);
    const connectionError = redactGitError("fatal: unable to access 'https://alice:secret@127.0.0.1:9/team/repo.git?token=secret': Failed to connect to 127.0.0.1 port 9");
    assert.match(connectionError, /https:\/\/127\.0\.0\.1:9\/team\/repo\.git/);
    assert.match(connectionError, /connect to 127\.0\.0\.1 port 9/);
    assert.doesNotMatch(connectionError, /alice|secret|ssh:\/\//);
  });

  it('classifies transport failures without changing the stable public reason families', () => {
    const cases = [
      ['Authentication failed', false, 'authentication', 'remote-auth-failed'],
      ['HTTP 403 access denied', false, 'authorization', 'remote-auth-failed'],
      ['Host key verification failed', false, 'host-key', 'remote-auth-failed'],
      ['Repository not found', false, 'repository-not-found', 'remote-unreachable'],
      ['Could not resolve host example.test', false, 'network', 'remote-unreachable'],
      ['operation timed out', true, 'timeout', 'remote-unreachable'],
    ];
    for (const [stderr, timedOut, category, reasonCode] of cases) {
      const classified = classifyGitTransportFailure(stderr, timedOut);
      assert.equal(classified.category, category);
      assert.equal(classified.reasonCode, reasonCode);
    }
  });
});
