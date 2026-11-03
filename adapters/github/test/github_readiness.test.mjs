import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
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

test('work readiness reports official environment precedence and proven writes', async () => {
  const probe = fixture([version, auth('octocat', 'success', 'GH_TOKEN'), repository]);
  const result = await evaluateGitHubReadiness({
    repository: 'acme/widgets',
    roles: ['work'],
    env: { GH_TOKEN: 'secret-first', GITHUB_TOKEN: 'secret-second' },
    exec: probe.exec,
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.cliVersion, '2.99.0');
  assert.equal(result.host, 'github.com');
  assert.equal(result.repository, 'acme/widgets');
  assert.equal(result.accountLogin, 'octocat');
  assert.deepEqual(result.credentialSource, { kind: 'environment', name: 'GH_TOKEN' });
  assert.equal(result.capabilities.find(row => row.capability === 'issues-read').status, 'ready');
  assert.equal(result.capabilities.find(row => row.capability === 'issues-write').status, 'ready');
  assert.equal(result.capabilities.find(row => row.capability === 'labels-write').status, 'ready');
  assert.doesNotMatch(JSON.stringify(result), /secret-first|secret-second/);
});

function repositoryWith(permissions) {
  return {
    match: args => args.includes('repos/acme/widgets'),
    stdout: JSON.stringify({ full_name: 'acme/widgets', has_issues: true, ...(permissions ? { permissions } : {}) }),
  };
}

async function workWrites(permissions) {
  const probe = fixture([version, auth(), repositoryWith(permissions)]);
  const result = await evaluateGitHubReadiness({ repository: 'acme/widgets', roles: ['work'], exec: probe.exec });
  return {
    result,
    issues: result.capabilities.find(row => row.capability === 'issues-write'),
    labels: result.capabilities.find(row => row.capability === 'labels-write'),
  };
}

test('repository permissions of triage or higher prove issue and label writes', async () => {
  for (const level of ['triage', 'push', 'maintain', 'admin']) {
    const { result, issues, labels } = await workWrites({ pull: true, [level]: true });
    assert.equal(issues.status, 'ready', level);
    assert.equal(labels.status, 'ready', level);
    assert.equal(result.status, 'ready', level);
  }
});

test('repository permissions with only pull name the missing permission', async () => {
  const { result, issues, labels } = await workWrites({ pull: true, triage: false, push: false, maintain: false, admin: false });
  for (const row of [issues, labels]) {
    assert.equal(row.status, 'needs-action');
    assert.equal(row.reasonCode, 'insufficient-permission');
    assert.match(row.summary, /pull only/);
    assert.match(row.summary, /Issues write/);
    assert.match(row.summary, /triage/);
  }
  assert.equal(result.status, 'needs-action');
});

test('a repository response without permission data leaves writes unverified and says so', async () => {
  const { result, issues } = await workWrites(undefined);
  assert.equal(issues.status, 'unverified');
  assert.match(issues.summary, /no permission data/);
  assert.doesNotMatch(JSON.stringify(result), /read-only probe cannot prove/);
  assert.equal(result.status, 'unverified');
});

const { privateKey: appPrivateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const appPublisher = {
  mode: 'github-app',
  githubApp: { appId: '99', installationId: '1001', privateKeyEnv: 'QUBE_TEST_READINESS_APP_KEY' },
};

const appEnv = { QUBE_TEST_READINESS_APP_KEY: appPrivateKey };

async function withInstallationPermissions(installationPermissions, run) {
  const realFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method ?? 'GET' });
    if (String(url).endsWith('/access_tokens')) {
      return new Response(JSON.stringify({
        token: 'ghs_readiness_fixture_installation_token',
        ...(installationPermissions ? { permissions: installationPermissions } : {}),
      }), { status: 201 });
    }
    if (String(url) === 'https://api.github.com/app') return new Response(JSON.stringify({ slug: 'qube-reviewer' }), { status: 200 });
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    return await run(requests);
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('an App publisher with a user work credential reports ready and makes only read requests', async () => {
  await withInstallationPermissions({ pull_requests: 'write', contents: 'write', issues: 'write' }, async requests => {
    const probe = fixture([version, auth(), repositoryWith({ pull: true, push: true })]);
    const result = await evaluateGitHubReadiness({
      repository: 'acme/widgets',
      roles: ['work', 'review'],
      capabilities: ['repository-read', 'issues-read', 'issues-write', 'labels-write', 'pull-requests-read', 'pull-request-reviews-write', 'review-threads-write'],
      publisher: appPublisher,
      env: appEnv,
      exec: probe.exec,
    });
    assert.equal(result.status, 'ready', JSON.stringify(result.capabilities));
    assert.equal(result.capabilities.every(row => row.status === 'ready'), true);
    const apiCalls = probe.calls.filter(entry => entry.args[0] === 'api');
    assert.equal(apiCalls.length > 0, true);
    for (const call of apiCalls) {
      assert.equal(call.args.some(arg => /^(-X|--method|-f|-F|--field|--raw-field|--input)$/.test(arg)), false, call.args.join(' '));
    }
    assert.equal(requests.every(request => request.method === 'GET' || request.url.endsWith('/access_tokens')), true);
  });
});

async function appIssueWrites(installationPermissions) {
  return withInstallationPermissions(installationPermissions, async () => {
    const probe = fixture([version, repositoryWith({ pull: true })]);
    const result = await evaluateGitHubReadiness({
      repository: 'acme/widgets',
      roles: ['review'],
      capabilities: ['repository-read', 'issues-write', 'labels-write'],
      publisher: appPublisher,
      env: appEnv,
      exec: probe.exec,
    });
    return {
      result,
      issues: result.capabilities.find(row => row.capability === 'issues-write'),
      labels: result.capabilities.find(row => row.capability === 'labels-write'),
    };
  });
}

test('an App credential doing issue writes uses the installation issues permission', async () => {
  const write = await appIssueWrites({ pull_requests: 'write', issues: 'write' });
  assert.equal(write.issues.status, 'ready');
  assert.equal(write.labels.status, 'ready');
  assert.equal(write.result.status, 'ready');

  const read = await appIssueWrites({ pull_requests: 'write', issues: 'read' });
  assert.equal(read.issues.status, 'needs-action');
  assert.match(read.issues.summary, /Issues write/);
  assert.match(read.labels.summary, /read/);

  const absent = await appIssueWrites({ pull_requests: 'write' });
  assert.equal(absent.issues.status, 'needs-action');
  assert.equal(absent.labels.status, 'needs-action');
  assert.equal(absent.result.status, 'needs-action');

  const noData = await appIssueWrites(undefined);
  assert.equal(noData.issues.status, 'unverified');
  assert.match(noData.issues.summary, /no permission data/);
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
