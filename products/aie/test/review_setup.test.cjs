const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { describe, it } = require('node:test');
require('./support/compile_cache.cjs');

const { getDefaults } = require('../dist/config/index.js');
const {
  buildGitHubAppSetupGuidance,
  buildTokenSetupGuidance,
  runReviewDoctor,
} = require('../dist/review_setup.js');
const { runReviewSetup } = require('../dist/runtime_review_setup.js');

function binRun(args, cwd = process.cwd()) {
  return spawnSync(process.execPath, [join(__dirname, '..', 'bin/run'), ...args], { cwd, encoding: 'utf8' });
}

function makeDirectory() {
  return mkdtempSync(join(tmpdir(), 'aie-review-setup-'));
}

function readyResolver(config, options = {}) {
  const mode = config?.mode ?? 'user';
  return Promise.resolve({
    accessToken: options.mint ? 'fixture-access-token' : null,
    identity: {
      mode,
      identityClass: mode === 'github-app' ? 'github-app-installation' : mode === 'token' ? 'fine-grained-token' : 'user',
      login: mode === 'github-app' ? 'review-app[bot]' : mode === 'token' ? 'reviewer-bot' : null,
      permissionStatus: options.mint ? 'ok' : 'unknown',
      formalEventCapability: true,
      fallbackReason: null,
      publishTransport: 'pull-request-review',
      authSource: mode === 'github-app' ? 'github-app-installation' : mode === 'token' ? 'token-env' : 'gh-user',
    },
  });
}

function successfulRepositoryProbe() {
  return Promise.resolve({
    repository: 'owner/repository',
    accessible: true,
    pullRequestPermission: 'write',
    fallbackReason: null,
  });
}

describe('review publisher setup guidance', () => {
  it('publishes setup and doctor paths in help and schema while retaining review gate', () => {
    const help = binRun(['review', '--help']);
    const setupHelp = binRun(['review', 'setup', '--help']);
    const schemaResult = binRun(['schema', '--json']);
    const schema = JSON.parse(schemaResult.stdout);
    const names = schema.commands.map(command => command.name);

    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /review setup github-app/);
    assert.match(help.stdout, /review setup token/);
    assert.match(help.stdout, /review doctor/);
    assert.match(help.stdout, /review gate/);
    assert.equal(setupHelp.status, 0, setupHelp.stderr);
    assert.match(setupHelp.stdout, /review setup github-app/);
    assert.match(setupHelp.stdout, /review setup token/);
    for (const command of ['review setup', 'review setup github-app', 'review setup token', 'review doctor', 'review gate']) {
      assert.ok(names.includes(command), `expected ${command} in schema`);
    }
    const appSetup = schema.commands.find(command => command.name === 'review setup github-app');
    const tokenSetup = schema.commands.find(command => command.name === 'review setup token');
    assert.equal(appSetup.flags.find(flag => flag.name === 'app-id').type, 'string');
    assert.equal(appSetup.flags.find(flag => flag.name === 'private-key-env').type, 'string');
    assert.equal(tokenSetup.flags.find(flag => flag.name === 'token-env').type, 'string');
  });

  it('renders the role boundary without claiming hosted review compute', () => {
    const guidance = `${JSON.stringify(buildGitHubAppSetupGuidance())}\n${JSON.stringify(buildTokenSetupGuidance())}`;
    assert.match(guidance, /Review compute remains host-run through local agents\/subagents/);
    assert.match(guidance, /Never send host\/subagent credentials to GitHub/);
    assert.doesNotMatch(guidance, /QUBE hosts review compute|upload host\/subagent credentials/i);
  });
});

describe('review publisher setup execution', () => {
  it('plans non-interactive GitHub App setup with safe references only', async () => {
    const root = makeDirectory();
    const result = await runReviewSetup({
      mode: 'github-app',
      config: getDefaults(),
      configPath: join(root, '.qube', 'aie', 'config.json'),
      root,
      appId: '123',
      installationId: '456',
      privateKeyEnv: 'QUBE_REVIEW_APP_KEY',
      login: 'review-app[bot]',
      dryRun: true,
      yes: true,
      json: true,
      resolvePublisher: readyResolver,
    });
    const serialized = JSON.stringify(result);

    assert.equal(result.ok, true);
    assert.equal(result.applied, false);
    assert.deepEqual(result.secretReferences, { privateKeyEnv: 'QUBE_REVIEW_APP_KEY' });
    assert.equal(result.publisher.githubApp.privateKeyEnv, 'QUBE_REVIEW_APP_KEY');
    assert.doesNotMatch(serialized, /BEGIN PRIVATE KEY|ghp_|github_pat_/);
    assert.match(result.nextAction, /Remove --dry-run/);
  });

  it('applies GitHub App config and rejects embedded credential material', async () => {
    const root = makeDirectory();
    const configPath = join(root, '.qube', 'aie', 'config.json');
    const result = await runReviewSetup({
      mode: 'github-app', config: null, configPath, root,
      appId: '123', installationId: '456', privateKeyPath: join(root, 'review-app.pem'),
      yes: true, noProbe: true, resolvePublisher: readyResolver,
    });
    const written = JSON.parse(readFileSync(configPath, 'utf8'));

    assert.equal(result.ok, true);
    assert.equal(result.applied, true);
    assert.equal(written.providers.review.kind, 'github');
    assert.equal(written.providers.review.publisher.mode, 'github-app');
    assert.equal(written.providers.review.publisher.githubApp.privateKeyPath, join(root, 'review-app.pem'));

    const rejectedPem = await runReviewSetup({
      mode: 'github-app', config: null, configPath, root,
      appId: '123', installationId: '456', privateKeyEnv: '-----BEGIN PRIVATE KEY-----fixture', yes: true,
    });
    const rejectedToken = await runReviewSetup({
      mode: 'token', config: null, configPath, root, tokenEnv: 'github_pat_fixture_value', yes: true,
    });
    const rejectedOauthToken = await runReviewSetup({
      mode: 'token', config: null, configPath, root, tokenEnv: 'gho_FAKE_REVIEW_CREDENTIAL_1234567890', yes: true,
    });
    const rejectedAppToken = await runReviewSetup({
      mode: 'token', config: null, configPath, root, tokenEnv: 'ghs_FAKE_INSTALLATION_TOKEN_1234567890', yes: true,
    });
    assert.equal(rejectedPem.ok, false);
    assert.equal(rejectedToken.ok, false);
    assert.equal(rejectedOauthToken.ok, false);
    assert.equal(rejectedAppToken.ok, false);
    assert.match(rejectedPem.validationErrors.join('\n'), /environment variable name/);
    assert.match(rejectedToken.validationErrors.join('\n'), /environment variable name/);
    assert.match(rejectedOauthToken.validationErrors.join('\n'), /environment variable name/);
    assert.match(rejectedAppToken.validationErrors.join('\n'), /environment variable name/);

    const rejectedLogin = await runReviewSetup({
      mode: 'token', config: null, configPath, root, tokenEnv: 'QUBE_REVIEW_TOKEN', login: 'gho_FAKE_LOGIN_TOKEN_1234567890', yes: true,
    });
    assert.equal(rejectedLogin.ok, false);
    assert.match(rejectedLogin.validationErrors.join('\n'), /public identifier|credential/i);
  });

  it('explains token fallback and stores only the environment variable name', async () => {
    const root = makeDirectory();
    const configPath = join(root, '.qube', 'aie', 'config.json');
    const result = await runReviewSetup({
      mode: 'token', config: getDefaults(), configPath, root,
      tokenEnv: 'QUBE_REVIEW_TOKEN', login: 'reviewer-bot', yes: true, noProbe: true,
      resolvePublisher: readyResolver,
    });
    const written = readFileSync(configPath, 'utf8');

    assert.equal(result.applied, true);
    assert.deepEqual(result.secretReferences, { tokenEnv: 'QUBE_REVIEW_TOKEN' });
    assert.match(result.guidance.limitation, /pull request author|formal review event/i);
    assert.match(written, /QUBE_REVIEW_TOKEN/);
    assert.doesNotMatch(written, /ghp_|github_pat_|token value/i);
  });

  it('completes interactive setup through an injected prompt without requesting secrets', async () => {
    const root = makeDirectory();
    const configPath = join(root, '.qube', 'aie', 'config.json');
    const questions = [];
    const answers = { appId: '321', installationId: '654', privateKeyEnv: 'QUBE_INTERACTIVE_APP_KEY' };
    const result = await runReviewSetup({
      mode: 'github-app', config: getDefaults(), configPath, root, isTTY: true,
      prompt: async question => {
        questions.push(question);
        return answers[question.id] ?? '';
      },
      noProbe: true,
      resolvePublisher: readyResolver,
    });

    assert.equal(result.applied, true);
    assert.deepEqual(questions.map(question => question.id), ['appId', 'installationId', 'privateKeyEnv']);
    assert.ok(questions.every(question => !/private key PEM$|token value/i.test(question.message)));
    assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).providers.review.publisher.githubApp.privateKeyEnv, 'QUBE_INTERACTIVE_APP_KEY');
  });

  it('returns guidance with missing flags non-interactively without writing config', async () => {
    const root = makeDirectory();
    const configPath = join(root, '.qube', 'aie', 'config.json');
    const guidanceOnly = await runReviewSetup({ mode: 'github-app', config: null, configPath, root, appId: '123' });
    assert.equal(guidanceOnly.ok, true);
    assert.equal(guidanceOnly.applied, false);
    assert.deepEqual(guidanceOnly.missingFields, ['--installation-id', '--private-key-env or --private-key-path']);

    const applyIntended = await runReviewSetup({ mode: 'github-app', config: null, configPath, root, yes: true, appId: '123' });
    assert.equal(applyIntended.ok, false);
    assert.equal(applyIntended.applied, false);
    assert.deepEqual(applyIntended.missingFields, ['--installation-id', '--private-key-env or --private-key-path']);
    assert.match(applyIntended.nextAction, /--installation-id/);
    assert.throws(() => readFileSync(configPath, 'utf8'));
  });
});

describe('review publisher doctor', () => {
  it('reports secret-free readiness, missing fields, probe results, and exact next action', async () => {
    const config = getDefaults();
    config.providers.review.publisher = {
      mode: 'github-app',
      githubApp: { appId: '123', installationId: '', privateKeyEnv: 'QUBE_REVIEW_APP_KEY' },
    };
    const missing = await runReviewDoctor({ config, resolvePublisher: readyResolver, mintProbe: true });
    assert.equal(missing.readiness, 'unavailable');
    assert.deepEqual(missing.missingFields, ['--installation-id']);
    assert.match(missing.nextAction, /--installation-id/);
    assert.deepEqual(missing.secretReferences, { privateKeyEnv: 'QUBE_REVIEW_APP_KEY' });

    config.providers.review.publisher = {
      mode: 'token',
      token: { env: 'QUBE_REVIEW_TOKEN', login: 'reviewer-bot' },
    };
    const ready = await runReviewDoctor({
      config,
      resolvePublisher: readyResolver,
      probeRepositoryAccess: successfulRepositoryProbe,
      mintProbe: true,
    });
    assert.equal(ready.readiness, 'ready');
    assert.equal(ready.probe.attempted, true);
    assert.equal(ready.probe.permissionStatus, 'ok');
    assert.equal(ready.probe.repository.status, 'ok');
    assert.equal(ready.probe.repository.repository, 'owner/repository');
    assert.equal(ready.probe.repository.pullRequestPermission, 'write');
    assert.equal(ready.formalEventCapability, true);
    assert.doesNotMatch(JSON.stringify(ready), /ghp_|github_pat_|BEGIN PRIVATE KEY/);

    const sameAuthor = await runReviewDoctor({
      config,
      mintProbe: true,
      resolvePublisher: async () => ({
        accessToken: 'fixture-access-token',
        identity: {
          mode: 'token', identityClass: 'fine-grained-token', login: 'author-user',
          permissionStatus: 'same-author', formalEventCapability: false,
          fallbackReason: 'Configured reviewer identity is the pull request author; formal PR review events are unavailable.',
          publishTransport: 'issue-comment', authSource: 'token-env',
        },
      }),
      probeRepositoryAccess: successfulRepositoryProbe,
    });
    assert.equal(sameAuthor.readiness, 'degraded');
    assert.match(sameAuthor.nextAction, /different from the pull request author/);
  });

  it('reports unavailable when the configured publisher cannot access the current repository', async () => {
    const config = getDefaults();
    config.providers.review.publisher = {
      mode: 'token',
      token: { env: 'QUBE_REVIEW_TOKEN', login: 'reviewer-bot' },
    };
    const result = await runReviewDoctor({
      config,
      resolvePublisher: readyResolver,
      mintProbe: true,
      probeRepositoryAccess: async () => ({
        repository: 'owner/repository',
        accessible: false,
        pullRequestPermission: 'unknown',
        fallbackReason: 'Configured publisher cannot access the current repository owner/repository.',
      }),
    });

    assert.equal(result.readiness, 'unavailable');
    assert.equal(result.permissionStatus, 'missing');
    assert.equal(result.formalEventCapability, false);
    assert.equal(result.probe.repository.status, 'failed');
    assert.equal(result.probe.repository.accessible, false);
    assert.match(result.nextAction, /Grant the configured publisher access to the current repository/);
  });

  it('reports degraded when repository access is read-only for pull requests', async () => {
    const config = getDefaults();
    config.providers.review.publisher = {
      mode: 'token',
      token: { env: 'QUBE_REVIEW_TOKEN', login: 'reviewer-bot' },
    };
    const result = await runReviewDoctor({
      config,
      resolvePublisher: readyResolver,
      mintProbe: true,
      probeRepositoryAccess: async () => ({
        repository: 'owner/repository',
        accessible: true,
        pullRequestPermission: 'read',
        fallbackReason: 'Pull requests permission is read-only for owner/repository.',
      }),
    });

    assert.equal(result.readiness, 'degraded');
    assert.equal(result.permissionStatus, 'missing');
    assert.equal(result.formalEventCapability, false);
    assert.equal(result.probe.repository.status, 'degraded');
    assert.equal(result.probe.repository.pullRequestPermission, 'read');
    assert.match(result.nextAction, /Pull requests read\/write permission/);
  });

  it('preserves unknown fine-grained-token PR permission instead of coercing to missing', async () => {
    const config = getDefaults();
    config.providers.review.publisher = {
      mode: 'token',
      token: { env: 'QUBE_REVIEW_TOKEN', login: 'reviewer-bot' },
    };
    const result = await runReviewDoctor({
      config,
      resolvePublisher: readyResolver,
      mintProbe: true,
      // Production default token probe can prove repository access but not PR write.
      probeRepositoryAccess: async () => ({
        repository: 'owner/repository',
        accessible: true,
        pullRequestPermission: 'unknown',
        fallbackReason: null,
      }),
    });

    assert.equal(result.readiness, 'degraded');
    assert.equal(result.permissionStatus, 'unknown');
    assert.equal(result.formalEventCapability, false);
    assert.equal(result.probe.permissionStatus, 'unknown');
    assert.equal(result.probe.repository.pullRequestPermission, 'unknown');
    assert.equal(result.probe.repository.accessible, true);
    assert.match(result.nextAction, /could not be proven|Confirm the token has Pull requests/i);
    assert.doesNotMatch(result.nextAction, /^Grant the fine-grained token Pull requests/);
  });

  it('bounds stalled publisher probes with a deadline and aborts active work', async () => {
    const config = getDefaults();
    config.providers.review.publisher = {
      mode: 'token',
      token: { env: 'QUBE_REVIEW_TOKEN', login: 'reviewer-bot' },
    };
    let aborted = false;
    const started = Date.now();
    const result = await runReviewDoctor({
      config,
      mintProbe: true,
      resolvePublisher: (_config, options = {}) => new Promise((resolve) => {
        const timer = setTimeout(() => {
          resolve({
            accessToken: 'fixture-access-token',
            identity: {
              mode: 'token', identityClass: 'fine-grained-token', login: 'reviewer-bot',
              permissionStatus: 'ok', formalEventCapability: true, fallbackReason: null,
              publishTransport: 'pull-request-review', authSource: 'token-env',
            },
          });
        }, 5_000);
        const onAbort = () => {
          aborted = true;
          clearTimeout(timer);
          // Leave the promise unsettled after abort so the doctor deadline rejection owns the race.
        };
        if (options.signal?.aborted) onAbort();
        else options.signal?.addEventListener('abort', onAbort, { once: true });
      }),
      probeRepositoryAccess: () => new Promise(() => {}),
      probeTimeoutMs: 50,
    });
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 1_000, `expected probe deadline well under 1s, took ${elapsed}ms`);
    assert.equal(aborted, true);
    assert.equal(result.readiness, 'unavailable');
    assert.equal(result.probe.attempted, true);
    assert.equal(result.probe.status, 'failed');
    assert.match(result.fallbackReason ?? '', /timed out|Publisher identity probe/i);
  });

  it('skips live publisher resolution when no distinct publisher is configured', async () => {
    let resolverCalls = 0;
    const result = await runReviewDoctor({
      config: getDefaults(),
      mintProbe: true,
      resolvePublisher: async () => {
        resolverCalls += 1;
        throw new Error('unconfigured doctor must not resolve a live publisher');
      },
      probeTimeoutMs: 50,
    });
    assert.equal(resolverCalls, 0);
    assert.equal(result.readiness, 'unconfigured');
    assert.equal(result.probe.attempted, false);
    assert.match(result.nextAction, /review setup github-app|review setup token/i);
  });

  it('does not treat missing credential secrets as failures under --no-probe', async () => {
    const config = getDefaults();
    config.providers.review.publisher = {
      mode: 'token',
      token: { env: 'QUBE_REVIEW_ABSENT_ENV', login: 'reviewer-bot' },
    };
    const result = await runReviewDoctor({
      config,
      mintProbe: false,
      resolvePublisher: async (publisherConfig, options = {}) => {
        assert.equal(options.mint, false);
        // Status-only path must not require secret material.
        return {
          accessToken: null,
          identity: {
            mode: 'token',
            identityClass: 'fine-grained-token',
            login: 'reviewer-bot',
            permissionStatus: 'unknown',
            formalEventCapability: true,
            fallbackReason: null,
            publishTransport: 'pull-request-review',
            authSource: 'token-env',
          },
        };
      },
    });

    assert.equal(result.probe.attempted, false);
    assert.equal(result.permissionStatus, 'unknown');
    assert.notEqual(result.permissionStatus, 'missing');
    assert.match(result.nextAction, /without --no-probe|credential is available/i);
  });

  it('prioritizes missing credential remediation over repository access messaging', async () => {
    const config = getDefaults();
    config.providers.review.publisher = {
      mode: 'token',
      token: { env: 'QUBE_REVIEW_MISSING_TOKEN', login: 'reviewer-bot' },
    };
    const result = await runReviewDoctor({
      config,
      mintProbe: true,
      resolvePublisher: async () => ({
        accessToken: null,
        identity: {
          mode: 'token',
          identityClass: 'none',
          login: null,
          permissionStatus: 'missing',
          formalEventCapability: false,
          fallbackReason: 'Fine-grained token env QUBE_REVIEW_MISSING_TOKEN is missing or empty.',
          publishTransport: 'issue-comment',
          authSource: 'none',
        },
      }),
      probeRepositoryAccess: async () => {
        throw new Error('repository probe should not run without an access token');
      },
    });

    assert.equal(result.probe.repository.attempted, false);
    assert.equal(result.permissionStatus, 'missing');
    assert.match(result.nextAction, /QUBE_REVIEW_MISSING_TOKEN is missing or empty/);
    assert.doesNotMatch(result.nextAction, /Grant the configured publisher access to the current repository/);
  });

  it('rejects non-numeric GitHub App and installation ids', async () => {
    const root = makeDirectory();
    const rejected = await runReviewSetup({
      mode: 'github-app',
      config: null,
      configPath: join(root, '.qube', 'aie', 'config.json'),
      root,
      appId: 'not-an-id',
      installationId: 'also_bad',
      privateKeyEnv: 'QUBE_REVIEW_APP_KEY',
      dryRun: true,
      yes: true,
      resolvePublisher: readyResolver,
    });
    assert.equal(rejected.ok, false);
    assert.match(rejected.validationErrors.join('\n'), /positive decimal/);
  });

  it('keeps existing review gate help available', () => {
    const gate = binRun(['review', 'gate', '--help']);
    assert.equal(gate.status, 0, gate.stderr);
    assert.match(gate.stdout, /review-agent gate/i);
  });
});
