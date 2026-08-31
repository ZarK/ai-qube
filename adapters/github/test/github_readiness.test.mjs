import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateGitHubReadiness,
  parseGitHubRemote,
} from '../dist/index.js';

function fixture(responses) {
  const calls = [];
  const exec = async (args, _cwd, options) => {
    calls.push({ args, options });
    for (const response of responses) {
      if (response.match(args)) return {
        args,
        exitCode: response.exitCode ?? 0,
        stdout: response.stdout ?? '',
        stderr: response.stderr ?? '',
      };
    }
    throw new Error(`Unexpected gh call: ${args.join(' ')}`);
  };
  return { calls, exec };
}

const version = {
  match: args => args.join(' ') === '--version',
  stdout: 'gh version 2.99.0 (test)\n',
};

function auth(login = 'octocat', state = 'success', tokenSource = 'keyring') {
  return {
    match: args => args[0] === 'auth',
    stdout: JSON.stringify({ hosts: { 'github.com': [{ state, active: true, host: 'github.com', login, tokenSource, scopes: 'repo, read:org' }] } }),
  };
}

const repository = {
  match: args => args.includes('repos/acme/widgets'),
  stdout: JSON.stringify({ full_name: 'acme/widgets', has_issues: true, permissions: { pull: true, push: true } }),
};

test('global and offline readiness do not spawn gh', async () => {
  const globalFixture = fixture([]);
  const global = await evaluateGitHubReadiness({ scope: 'global', roles: ['work'], exec: globalFixture.exec });
  assert.equal(global.status, 'not-required');
  assert.equal(global.reasonCode, 'not-required');
  assert.deepEqual(globalFixture.calls, []);

  const offlineFixture = fixture([]);
  const offline = await evaluateGitHubReadiness({ offline: true, repository: 'acme/widgets', roles: ['work'], exec: offlineFixture.exec });
  assert.equal(offline.status, 'unverified');
  assert.equal(offline.reasonCode, 'unverified');
  assert.deepEqual(offlineFixture.calls, []);
});

test('non-GitHub selection is not required and does not spawn gh', async () => {
  const probe = fixture([]);
  const result = await evaluateGitHubReadiness({ exec: probe.exec });
  assert.equal(result.status, 'not-required');
  assert.deepEqual(probe.calls, []);
});

test('work readiness reports official environment precedence and unproven writes', async () => {
  const probe = fixture([version, auth('octocat', 'success', 'GH_TOKEN'), repository]);
  const result = await evaluateGitHubReadiness({
    repository: 'acme/widgets',
    roles: ['work'],
    env: { GH_TOKEN: 'secret-first', GITHUB_TOKEN: 'secret-second' },
    exec: probe.exec,
  });
  assert.equal(result.status, 'unverified');
  assert.equal(result.cliVersion, '2.99.0');
  assert.equal(result.host, 'github.com');
  assert.equal(result.repository, 'acme/widgets');
  assert.equal(result.accountLogin, 'octocat');
  assert.deepEqual(result.credentialSource, { kind: 'environment', name: 'GH_TOKEN' });
  assert.equal(result.capabilities.find(row => row.capability === 'issues-read').status, 'ready');
  assert.equal(result.capabilities.find(row => row.capability === 'issues-write').status, 'unverified');
  assert.doesNotMatch(JSON.stringify(result), /secret-first|secret-second/);
});

test('structured auth state overrides the zero exit code', async () => {
  const probe = fixture([version, auth('octocat', 'failure')]);
  const result = await evaluateGitHubReadiness({ repository: 'acme/widgets', roles: ['work'], exec: probe.exec });
  assert.equal(result.status, 'needs-action');
  assert.equal(result.reasonCode, 'credential-invalid');
  assert.equal(probe.calls.some(call => call.args[0] === 'api'), false);
});

test('account mismatch is reported without switching accounts', async () => {
  const probe = fixture([version, auth('octocat')]);
  const result = await evaluateGitHubReadiness({
    repository: 'acme/widgets',
    expectedLogin: 'hubot',
    roles: ['review'],
    exec: probe.exec,
  });
  assert.equal(result.reasonCode, 'wrong-account');
  assert.match(result.nextAction, /gh auth switch --hostname github\.com --user hubot/);
  assert.equal(probe.calls.some(call => call.args.includes('switch')), false);
});

test('named publisher token does not require a stored login', async () => {
  const probe = fixture([
    version,
    repository,
    { match: args => args.at(-1) === 'user', stdout: JSON.stringify({ login: 'review-bot' }) },
  ]);
  const result = await evaluateGitHubReadiness({
    repository: 'acme/widgets',
    roles: ['review'],
    publisher: { mode: 'token', token: { env: 'QUBE_REVIEW_TOKEN', login: 'review-bot' } },
    env: { QUBE_REVIEW_TOKEN: 'publisher-secret' },
    exec: probe.exec,
  });
  assert.equal(result.status, 'unverified');
  assert.deepEqual(result.credentialSource, { kind: 'named-token', name: 'QUBE_REVIEW_TOKEN' });
  assert.equal(probe.calls.some(call => call.args[0] === 'auth'), false);
  assert.ok(probe.calls.filter(call => call.args[0] === 'api').every(call => call.options.token === 'publisher-secret'));
  assert.doesNotMatch(JSON.stringify(result), /publisher-secret/);
});

test('combined work and named publisher token validate both credentials', async () => {
  const probe = fixture([
    version,
    auth('worker'),
    repository,
    { match: args => args.at(-1) === 'user', stdout: JSON.stringify({ login: 'review-bot' }) },
  ]);
  await evaluateGitHubReadiness({
    repository: 'acme/widgets',
    roles: ['work', 'review'],
    publisher: { mode: 'token', token: { env: 'QUBE_REVIEW_TOKEN' } },
    env: { QUBE_REVIEW_TOKEN: 'publisher-secret' },
    exec: probe.exec,
  });
  assert.equal(probe.calls.filter(call => call.args[0] === 'auth').length, 1);
  const repositoryCalls = probe.calls.filter(call => call.args.includes('repos/acme/widgets'));
  assert.equal(repositoryCalls.length, 2);
  assert.equal(repositoryCalls.some(call => call.options.token === 'publisher-secret'), true);
  assert.equal(repositoryCalls.some(call => call.options.token === undefined), true);
});

test('remote parsing supports GitHub.com and Enterprise without retaining credentials', () => {
  assert.deepEqual(parseGitHubRemote('git@github.com:acme/widgets.git'), {
    host: 'github.com', repository: 'acme/widgets', transport: 'ssh',
  });
  assert.deepEqual(parseGitHubRemote('https://github.example.test/acme/widgets.git'), {
    host: 'github.example.test', repository: 'acme/widgets', transport: 'https',
  });
  assert.equal(parseGitHubRemote('https://user:secret@github.com/acme/widgets.git'), null);
  assert.equal(parseGitHubRemote('https://user@github.com/acme/widgets.git'), null);
});

test('Enterprise environment credentials use the official precedence without exposing values', async () => {
  const enterpriseAuth = {
    match: args => args[0] === 'auth',
    stdout: JSON.stringify({ hosts: { 'github.example.test': [{ state: 'success', active: true, login: 'enterprise-user', tokenSource: 'GH_ENTERPRISE_TOKEN' }] } }),
  };
  const enterpriseRepository = {
    match: args => args.includes('repos/acme/widgets'),
    stdout: JSON.stringify({ full_name: 'acme/widgets', has_issues: true }),
  };
  const probe = fixture([version, enterpriseAuth, enterpriseRepository]);
  const result = await evaluateGitHubReadiness({
    host: 'github.example.test',
    repository: 'acme/widgets',
    roles: ['ci'],
    env: { GH_ENTERPRISE_TOKEN: 'enterprise-first', GITHUB_ENTERPRISE_TOKEN: 'enterprise-second' },
    exec: probe.exec,
  });
  assert.deepEqual(result.credentialSource, { kind: 'environment', name: 'GH_ENTERPRISE_TOKEN' });
  assert.doesNotMatch(JSON.stringify(result), /enterprise-first|enterprise-second/);
});

test('failure text maps to stable repository, permission, SSO, network, and timeout reasons', async () => {
  const cases = [
    ['repository not found (404)', 'repo-inaccessible'],
    ['resource not accessible by integration (403)', 'insufficient-permission'],
    ['organization SAML SSO authorization required', 'sso-required'],
    ['network connection reset', 'network'],
    ['request timed out', 'timeout'],
  ];
  for (const [message, reasonCode] of cases) {
    const probe = fixture([
      version,
      auth(),
      { match: args => args.includes('repos/acme/widgets'), exitCode: 1, stderr: message },
    ]);
    const result = await evaluateGitHubReadiness({ repository: 'acme/widgets', roles: ['work'], exec: probe.exec });
    assert.equal(result.reasonCode, reasonCode, message);
    assert.ok(result.nextAction);
  }
});

test('Enterprise App publication fails precisely before authentication or repository writes', async () => {
  const probe = fixture([version]);
  const result = await evaluateGitHubReadiness({
    host: 'github.example.test',
    repository: 'acme/widgets',
    roles: ['review'],
    publisher: { mode: 'github-app' },
    exec: probe.exec,
  });
  assert.equal(result.status, 'needs-action');
  assert.equal(result.reasonCode, 'host-unresolved');
  assert.match(result.summary, /not supported end to end/);
  assert.deepEqual(probe.calls.map(call => call.args), [['--version']]);
});

test('an explicit host mismatch is rejected before authentication', async () => {
  const probe = fixture([version]);
  const result = await evaluateGitHubReadiness({
    host: 'github.example.test',
    remoteUrl: 'https://github.com/acme/widgets.git',
    roles: ['work'],
    exec: probe.exec,
  });
  assert.equal(result.reasonCode, 'host-unresolved');
  assert.equal(probe.calls.some(call => call.args[0] === 'auth'), false);
});
