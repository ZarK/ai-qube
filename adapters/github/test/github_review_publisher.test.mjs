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
});
