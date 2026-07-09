const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { describe, it } = require('node:test');

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
    accessToken: null,
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
    assert.equal(rejectedPem.ok, false);
    assert.equal(rejectedToken.ok, false);
    assert.match(rejectedPem.validationErrors.join('\n'), /environment variable name/);
    assert.match(rejectedToken.validationErrors.join('\n'), /environment variable name/);
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

  it('returns guidance with missing flags non-interactively without failing or writing config', async () => {
    const root = makeDirectory();
    const configPath = join(root, '.qube', 'aie', 'config.json');
    const result = await runReviewSetup({ mode: 'github-app', config: null, configPath, root, yes: true, appId: '123' });

    assert.equal(result.ok, true);
    assert.equal(result.applied, false);
    assert.deepEqual(result.missingFields, ['--installation-id', '--private-key-env or --private-key-path']);
    assert.match(result.nextAction, /--installation-id/);
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
    const ready = await runReviewDoctor({ config, resolvePublisher: readyResolver, mintProbe: true });
    assert.equal(ready.readiness, 'ready');
    assert.equal(ready.probe.attempted, true);
    assert.equal(ready.probe.permissionStatus, 'ok');
    assert.equal(ready.formalEventCapability, true);
    assert.doesNotMatch(JSON.stringify(ready), /ghp_|github_pat_|BEGIN PRIVATE KEY/);

    const sameAuthor = await runReviewDoctor({
      config,
      mintProbe: true,
      resolvePublisher: async () => ({
        accessToken: null,
        identity: {
          mode: 'token', identityClass: 'fine-grained-token', login: 'author-user',
          permissionStatus: 'same-author', formalEventCapability: false,
          fallbackReason: 'Configured reviewer identity is the pull request author; formal PR review events are unavailable.',
          publishTransport: 'issue-comment', authSource: 'token-env',
        },
      }),
    });
    assert.equal(sameAuthor.readiness, 'degraded');
    assert.match(sameAuthor.nextAction, /different from the pull request author/);
  });

  it('keeps existing review gate help available', () => {
    const gate = binRun(['review', 'gate', '--help']);
    assert.equal(gate.status, 0, gate.stderr);
    assert.match(gate.stdout, /review-agent gate/i);
  });
});
