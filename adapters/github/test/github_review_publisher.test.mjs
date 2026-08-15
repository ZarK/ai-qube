import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it, before, after } from 'node:test';

import {
  createGitHubAppJwt,
  resolveGitHubReviewPublisher,
} from '../dist/github_review_publisher.js';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

describe('github review publisher', () => {
  const previousEnv = { ...process.env };

  after(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key];
    }
    Object.assign(process.env, previousEnv);
  });

  it('creates a signed GitHub App JWT', () => {
    const jwt = createGitHubAppJwt('12345', privateKey, 1_700_000_000);
    const parts = jwt.split('.');
    assert.equal(parts.length, 3);
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    assert.equal(payload.iss, '12345');
    assert.equal(payload.iat, 1_700_000_000 - 60);
    assert.equal(payload.exp, 1_700_000_000 + 9 * 60);
  });

  it('mints an installation token for github-app mode and submits identity without secrets', async () => {
    process.env.QUBE_TEST_APP_KEY = privateKey;
    const withKey = await resolveGitHubReviewPublisher({
      mode: 'github-app',
      githubApp: {
        appId: '99',
        installationId: '1001',
        privateKeyEnv: 'QUBE_TEST_APP_KEY',
      },
    }, {
      mint: true,
      fetchInstallationToken: async ({ appId, installationId, jwt }) => {
        assert.equal(appId, '99');
        assert.equal(installationId, '1001');
        assert.equal(jwt.split('.').length, 3);
        return {
          token: 'ghs_test_installation_token_value_not_for_output',
          permissions: { pull_requests: 'write' },
          accountLogin: 'review-bot[bot]',
        };
      },
      fetchTokenIdentity: async (token) => {
        assert.equal(token, 'ghs_test_installation_token_value_not_for_output');
        return { login: 'review-bot[bot]', type: 'Bot' };
      },
    });

    assert.equal(withKey.identity.mode, 'github-app');
    assert.equal(withKey.identity.identityClass, 'github-app-installation');
    assert.equal(withKey.identity.login, 'review-bot[bot]');
    assert.equal(withKey.identity.formalEventCapability, true);
    assert.equal(withKey.identity.permissionStatus, 'ok');
    assert.equal(withKey.identity.fallbackReason, null);
    assert.equal(withKey.accessToken, 'ghs_test_installation_token_value_not_for_output');
    assert.equal(JSON.stringify(withKey.identity).includes('ghs_'), false);
    assert.equal(JSON.stringify(withKey.identity).includes('BEGIN'), false);
  });

  it('resolves github-app bot login from the signed app slug', async () => {
    process.env.QUBE_TEST_APP_KEY = privateKey;
    const resolved = await resolveGitHubReviewPublisher({
      mode: 'github-app',
      githubApp: {
        appId: '99',
        installationId: '1001',
        privateKeyEnv: 'QUBE_TEST_APP_KEY',
        login: 'QUBE-Review-Publisher[bot]',
      },
    }, {
      mint: true,
      fetchInstallationToken: async () => ({
        token: 'ghs_test_installation_token_value_not_for_output',
        permissions: { pull_requests: 'write' },
        accountLogin: 'alice',
      }),
      fetchAppIdentity: async ({ jwt, appId, installationId }) => {
        assert.equal(appId, '99');
        assert.equal(installationId, '1001');
        assert.equal(jwt.split('.').length, 3);
        return { login: 'qube-review[bot]', type: 'Bot' };
      },
    });

    assert.equal(resolved.identity.login, 'qube-review[bot]');
    assert.equal(resolved.identity.credentialVerified, true);
    assert.equal(resolved.identity.permissionStatus, 'ok');
    assert.equal(resolved.identity.formalEventCapability, true);
  });

  it('resolves github-app identity via /installation without a known-invalid /user call', async () => {
    process.env.QUBE_TEST_APP_KEY = privateKey;
    const calls = [];
    const resolved = await resolveGitHubReviewPublisher({
      mode: 'github-app',
      githubApp: {
        appId: '99',
        installationId: '1001',
        privateKeyEnv: 'QUBE_TEST_APP_KEY',
      },
    }, {
      mint: true,
      fetchInstallationToken: async () => ({
        token: 'ghs_test_installation_token_value_not_for_output',
        permissions: { pull_requests: 'write' },
        accountLogin: 'review-bot[bot]',
      }),
      fetchAppIdentity: async () => ({ login: null, type: null }),
      // Installation tokens use /installation only; /user is not a valid endpoint for them.
      exec: async (args) => {
        calls.push(args.join(' '));
        if (args.includes('user')) {
          const error = new Error('gh api user failed');
          error.status = 1;
          error.stderr = 'HTTP 403: Resource not accessible by integration';
          throw error;
        }
        if (args.includes('installation')) {
          return {
            args,
            exitCode: 0,
            stdout: JSON.stringify({ account: { login: 'review-bot' }, app_slug: 'review-bot' }),
            stderr: '',
          };
        }
        return { args, exitCode: 0, stdout: '{}', stderr: '' };
      },
    });

    assert.equal(calls.some(call => call.includes('user')), false);
    assert.ok(calls.some(call => call.includes('installation')));
    assert.equal(resolved.identity.mode, 'github-app');
    assert.equal(resolved.identity.identityClass, 'github-app-installation');
    // Bot actor comes from app_slug, not the installation target account login.
    assert.equal(resolved.identity.login, 'review-bot[bot]');
    assert.equal(resolved.identity.permissionStatus, 'ok');
    assert.equal(resolved.identity.formalEventCapability, true);
    assert.equal(resolved.accessToken, 'ghs_test_installation_token_value_not_for_output');
  });

  it('does not use the installation account login when bot identity is missing', async () => {
    process.env.QUBE_TEST_APP_KEY = privateKey;
    const resolved = await resolveGitHubReviewPublisher({
      mode: 'github-app',
      githubApp: {
        appId: '99',
        installationId: '1001',
        privateKeyEnv: 'QUBE_TEST_APP_KEY',
      },
    }, {
      mint: true,
      fetchInstallationToken: async () => ({
        token: 'ghs_test_installation_token_value_not_for_output',
        permissions: { pull_requests: 'write' },
        accountLogin: 'alice',
      }),
      fetchTokenIdentity: async () => ({ login: null, type: null }),
    });

    assert.equal(resolved.identity.login, null);
    assert.equal(resolved.identity.formalEventCapability, false);
    assert.match(resolved.identity.fallbackReason ?? '', /did not resolve the bot login/i);
  });

  it('uses the configured app login when identity lookup misses and never the account login', async () => {
    process.env.QUBE_TEST_APP_KEY = privateKey;
    const resolved = await resolveGitHubReviewPublisher({
      mode: 'github-app',
      githubApp: {
        appId: '99',
        installationId: '1001',
        privateKeyEnv: 'QUBE_TEST_APP_KEY',
        login: 'review-bot[bot]',
      },
    }, {
      mint: true,
      fetchInstallationToken: async () => ({
        token: 'ghs_test_installation_token_value_not_for_output',
        permissions: { pull_requests: 'write' },
        accountLogin: 'alice',
      }),
      fetchTokenIdentity: async () => ({ login: null, type: null }),
    });

    assert.equal(resolved.identity.login, 'review-bot[bot]');
    assert.equal(resolved.identity.formalEventCapability, true);
    assert.equal(resolved.identity.credentialVerified, false);
    assert.equal(resolved.identity.fallbackReason, null);
  });

  it('does not fall back to the installation account when /installation omits app_slug', async () => {
    process.env.QUBE_TEST_APP_KEY = privateKey;
    const resolved = await resolveGitHubReviewPublisher({
      mode: 'github-app',
      githubApp: {
        appId: '99',
        installationId: '1001',
        privateKeyEnv: 'QUBE_TEST_APP_KEY',
      },
    }, {
      mint: true,
      fetchInstallationToken: async () => ({
        token: 'ghs_test_installation_token_value_not_for_output',
        permissions: { pull_requests: 'write' },
        accountLogin: 'alice',
      }),
      fetchAppIdentity: async () => ({ login: null, type: null }),
      exec: async (args) => {
        if (args.includes('installation')) {
          return {
            args,
            exitCode: 0,
            stdout: JSON.stringify({ account: { login: 'alice', type: 'User' } }),
            stderr: '',
          };
        }
        return { args, exitCode: 0, stdout: '{}', stderr: '' };
      },
    });

    assert.equal(resolved.identity.login, null);
    assert.equal(resolved.identity.formalEventCapability, false);
    assert.match(resolved.identity.fallbackReason ?? '', /did not resolve the bot login/i);
  });

  it('prefers app slug bot identity over installation target account login', async () => {
    process.env.QUBE_TEST_APP_KEY = privateKey;
    const resolved = await resolveGitHubReviewPublisher({
      mode: 'github-app',
      githubApp: {
        appId: '99',
        installationId: '1001',
        privateKeyEnv: 'QUBE_TEST_APP_KEY',
      },
    }, {
      mint: true,
      prAuthorLogin: 'alice',
      fetchInstallationToken: async () => ({
        token: 'ghs_test_installation_token_value_not_for_output',
        permissions: { pull_requests: 'write' },
      }),
      fetchAppIdentity: async () => ({ login: null, type: null }),
      exec: async (args) => {
        if (args.includes('user')) {
          const error = new Error('HTTP 403');
          error.status = 1;
          error.stderr = 'Resource not accessible by integration';
          throw error;
        }
        if (args.includes('installation')) {
          return {
            args,
            exitCode: 0,
            stdout: JSON.stringify({ account: { login: 'alice', type: 'User' }, app_slug: 'review-bot' }),
            stderr: '',
          };
        }
        return { args, exitCode: 0, stdout: '{}', stderr: '' };
      },
    });

    assert.equal(resolved.identity.login, 'review-bot[bot]');
    assert.equal(resolved.identity.permissionStatus, 'ok');
    assert.equal(resolved.identity.formalEventCapability, true);
    assert.equal(resolved.accessToken, 'ghs_test_installation_token_value_not_for_output');
  });

  it('uses fine-grained token env and reports same-author downgrade', async () => {
    process.env.QUBE_TEST_REVIEW_TOKEN = 'github_pat_test_token_value_not_for_output_abcdefghijklmnop';
    const resolved = await resolveGitHubReviewPublisher({
      mode: 'token',
      token: { env: 'QUBE_TEST_REVIEW_TOKEN' },
    }, {
      mint: true,
      prAuthorLogin: 'alice',
      fetchTokenIdentity: async (token) => {
        assert.match(token, /^github_pat_/);
        return { login: 'alice', type: 'User' };
      },
    });

    assert.equal(resolved.identity.mode, 'token');
    assert.equal(resolved.identity.identityClass, 'fine-grained-token');
    assert.equal(resolved.identity.login, 'alice');
    assert.equal(resolved.identity.permissionStatus, 'same-author');
    assert.equal(resolved.identity.formalEventCapability, false);
    assert.equal(resolved.identity.publishTransport, 'issue-comment');
    assert.match(resolved.identity.fallbackReason ?? '', /pull request author/i);
    assert.equal(JSON.stringify(resolved.identity).includes('github_pat_'), false);
  });

  it('reports missing permission downgrade for github-app without pull_requests write', async () => {
    process.env.QUBE_TEST_APP_KEY = privateKey;
    const resolved = await resolveGitHubReviewPublisher({
      mode: 'github-app',
      githubApp: {
        appId: '99',
        installationId: '1001',
        privateKeyEnv: 'QUBE_TEST_APP_KEY',
      },
    }, {
      mint: true,
      fetchInstallationToken: async () => ({
        token: 'ghs_test_installation_token_value_not_for_output',
        permissions: { pull_requests: 'read' },
        accountLogin: 'review-bot[bot]',
      }),
      fetchTokenIdentity: async () => ({ login: 'review-bot[bot]', type: 'Bot' }),
    });

    assert.equal(resolved.identity.permissionStatus, 'missing');
    assert.equal(resolved.identity.formalEventCapability, false);
    assert.equal(resolved.identity.publishTransport, 'issue-comment');
    assert.match(resolved.identity.fallbackReason ?? '', /permission/i);
  });

  it('treats omitted pull_requests permission as missing review capability', async () => {
    process.env.QUBE_TEST_APP_KEY = privateKey;
    const resolved = await resolveGitHubReviewPublisher({
      mode: 'github-app',
      githubApp: {
        appId: '99',
        installationId: '1001',
        privateKeyEnv: 'QUBE_TEST_APP_KEY',
      },
    }, {
      mint: true,
      fetchInstallationToken: async () => ({
        token: 'ghs_test_installation_token_value_not_for_output',
        // Only contents is granted; omitted permissions are not granted.
        permissions: { contents: 'read' },
        accountLogin: 'review-bot[bot]',
      }),
      fetchTokenIdentity: async () => ({ login: 'review-bot[bot]', type: 'Bot' }),
    });

    assert.equal(resolved.identity.permissionStatus, 'missing');
    assert.equal(resolved.identity.formalEventCapability, false);
    assert.equal(resolved.identity.publishTransport, 'issue-comment');
    assert.match(resolved.identity.fallbackReason ?? '', /permission/i);
  });

  it('falls back to user mode without minting secrets into status-only probes', async () => {
    const resolved = await resolveGitHubReviewPublisher({ mode: 'user' }, { mint: false });
    assert.equal(resolved.identity.mode, 'user');
    assert.equal(resolved.identity.identityClass, 'user');
    assert.equal(resolved.accessToken, null);
    assert.match(resolved.identity.fallbackReason ?? '', /authenticated gh user/i);
  });

  it('reports missing fine-grained token env without exposing values', async () => {
    delete process.env.QUBE_MISSING_REVIEW_TOKEN;
    const resolved = await resolveGitHubReviewPublisher({
      mode: 'token',
      token: { env: 'QUBE_MISSING_REVIEW_TOKEN' },
    }, { mint: true });
    assert.equal(resolved.identity.permissionStatus, 'missing');
    assert.equal(resolved.identity.formalEventCapability, false);
    assert.match(resolved.identity.fallbackReason ?? '', /QUBE_MISSING_REVIEW_TOKEN/);
    assert.equal(JSON.stringify(resolved).includes('github_pat_'), false);
  });

  it('forwards probe deadlines into user-mode gh identity lookups', async () => {
    const controller = new AbortController();
    let seen;
    await resolveGitHubReviewPublisher({ mode: 'user' }, {
      mint: true,
      timeoutMs: 17,
      signal: controller.signal,
      exec: async (args, _cwd, options) => {
        seen = options;
        return {
          args,
          exitCode: 0,
          stdout: JSON.stringify({ login: 'ambient-user' }),
          stderr: '',
        };
      },
    });
    assert.equal(seen?.timeoutMs, 17);
    assert.equal(seen?.signal, controller.signal);
  });

  it('status-only mint=false skips token secret and private-key reads', async () => {
    delete process.env.QUBE_MISSING_REVIEW_TOKEN;
    const tokenStatus = await resolveGitHubReviewPublisher({
      mode: 'token',
      token: { env: 'QUBE_MISSING_REVIEW_TOKEN', login: 'reviewer-bot' },
    }, { mint: false });
    assert.equal(tokenStatus.identity.permissionStatus, 'unknown');
    assert.equal(tokenStatus.identity.login, 'reviewer-bot');
    assert.equal(tokenStatus.accessToken, null);

    const appStatus = await resolveGitHubReviewPublisher({
      mode: 'github-app',
      githubApp: {
        appId: '99',
        installationId: '1001',
        privateKeyPath: 'C:\\does\\not\\exist\\review-app.pem',
        login: 'review-bot[bot]',
      },
    }, { mint: false });
    assert.equal(appStatus.identity.permissionStatus, 'unknown');
    assert.equal(appStatus.identity.login, 'review-bot[bot]');
    assert.equal(appStatus.accessToken, null);
  });

  it('succeeds for a distinct fine-grained token identity with formal events', async () => {
    process.env.QUBE_TEST_REVIEW_TOKEN = 'github_pat_test_token_value_not_for_output_abcdefghijklmnop';
    const resolved = await resolveGitHubReviewPublisher({
      mode: 'token',
      token: { env: 'QUBE_TEST_REVIEW_TOKEN' },
    }, {
      mint: true,
      prAuthorLogin: 'pr-author',
      fetchTokenIdentity: async () => ({ login: 'reviewer-bot', type: 'User' }),
    });
    assert.equal(resolved.identity.identityClass, 'fine-grained-token');
    assert.equal(resolved.identity.login, 'reviewer-bot');
    assert.equal(resolved.identity.permissionStatus, 'ok');
    assert.equal(resolved.identity.formalEventCapability, true);
    assert.equal(resolved.identity.publishTransport, 'pull-request-review');
    assert.equal(resolved.identity.fallbackReason, null);
    assert.ok(resolved.accessToken);
  });

  it('mints an app token and posts a pull request review on a mocked transport', async () => {
    process.env.QUBE_TEST_APP_KEY = privateKey;
    const calls = [];
    const resolved = await resolveGitHubReviewPublisher({
      mode: 'github-app',
      githubApp: {
        appId: '99',
        installationId: '1001',
        privateKeyEnv: 'QUBE_TEST_APP_KEY',
      },
    }, {
      mint: true,
      prAuthorLogin: 'pr-author',
      fetchInstallationToken: async () => ({
        token: 'ghs_test_installation_token_value_not_for_output',
        permissions: { pull_requests: 'write' },
        accountLogin: 'review-bot[bot]',
      }),
      fetchTokenIdentity: async () => ({ login: 'review-bot[bot]', type: 'Bot' }),
    });
    assert.equal(resolved.identity.formalEventCapability, true);
    assert.ok(resolved.accessToken);

    // Fixture/mock transport: submit a formal PR review using the minted token.
    const transport = async (args, _cwd, options = {}) => {
      calls.push({ args, token: options.token ?? null });
      if (args[0] === 'api' && String(args[1]).includes('/pulls/') && String(args[1]).includes('/reviews') && args.includes('POST')) {
        assert.equal(options.token, resolved.accessToken);
        return {
          args,
          exitCode: 0,
          stdout: JSON.stringify({ id: 42, html_url: 'https://example.test/review/42', event: 'APPROVE' }),
          stderr: '',
        };
      }
      return { args, exitCode: 1, stdout: '', stderr: `unexpected ${args.join(' ')}` };
    };

    const { runGh } = await import('../dist/gh.js');
    const publish = await runGh(
      ['api', 'repos/o/r/pulls/12/reviews', '--method', 'POST', '--input', '-'],
      { exec: transport, token: resolved.accessToken },
    );
    assert.equal(publish.exitCode, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].token, resolved.accessToken);
    assert.match(calls[0].args.join(' '), /pulls\/12\/reviews/);
    assert.equal(JSON.stringify(resolved.identity).includes('ghs_'), false);
  });
});
