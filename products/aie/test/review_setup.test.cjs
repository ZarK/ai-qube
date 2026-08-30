const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { generateKeyPairSync } = require('node:crypto');
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { describe, it } = require('node:test');
require('./support/compile_cache.cjs');
const { cloneGitRepo } = require('./support/git_fixture.cjs');

const { getDefaults } = require('../dist/config/index.js');
const {
  buildGitHubAppSetupGuidance,
  normalizeReviewAvatarUrl,
  runReviewDoctor,
} = require('../dist/review_setup.js');
const { formatReviewSetup, normalizeReviewPrivateKeyPath, runReviewSetup } = require('../dist/runtime_review_setup.js');

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
    assert.doesNotMatch(help.stdout, /review setup token|separate-user fine-grained token/i);
    assert.match(help.stdout, /review doctor/);
    assert.match(help.stdout, /review gate/);
    assert.match(help.stdout, /review feedback/);
    assert.equal(setupHelp.status, 0, setupHelp.stderr);
    assert.match(setupHelp.stdout, /review setup github-app/);
    assert.match(setupHelp.stdout, /current GitHub account publisher/i);
    assert.match(setupHelp.stdout, /guided QUBE Reviewer App setup/i);
    assert.doesNotMatch(setupHelp.stdout, /review setup token|separate-user fine-grained token/i);
    for (const command of ['review setup', 'review setup github-app', 'review doctor', 'review gate', 'review feedback']) {
      assert.ok(names.includes(command), `expected ${command} in schema`);
    }
    assert.equal(names.includes('review setup token'), false);
    const appSetup = schema.commands.find(command => command.name === 'review setup github-app');
    assert.equal(appSetup.flags.find(flag => flag.name === 'app-id').type, 'string');
    assert.equal(appSetup.flags.find(flag => flag.name === 'private-key-env').type, 'string');
    assert.deepEqual(appSetup.flags.find(flag => flag.name === 'config-scope').options, ['global', 'repo']);
    assert.equal(appSetup.interactions.ttyPrompt, true);
    const init = schema.commands.find(command => command.name === 'init');
    assert.deepEqual(init.flags.find(flag => flag.name === 'publisher').options, ['github-app', 'user']);
  });

  it('renders the role boundary without claiming hosted review compute', () => {
    const guidance = JSON.stringify(buildGitHubAppSetupGuidance());
    assert.match(guidance, /Review compute remains host-run through local agents\/subagents/);
    assert.match(guidance, /Never send host\/subagent credentials to GitHub/);
    assert.match(guidance, /Do not rename the app/);
    assert.doesNotMatch(guidance, /QUBE hosts review compute|upload host\/subagent credentials/i);
  });
});

describe('review publisher setup execution', () => {
  it('writes complete user-global defaults outside the repository without credential material', async () => {
    const root = makeDirectory();
    const home = makeDirectory();
    const repositoryConfigPath = join(root, '.qube', 'aie', 'config.json');
    const writes = [];
    const result = await runReviewSetup({
      mode: 'github-app', scope: 'global', config: getDefaults(), configPath: repositoryConfigPath, root, homeDirectory: home,
      appId: '123', installationId: '456', privateKeyEnv: 'QUBE_REVIEW_APP_KEY', login: 'review-app[bot]',
      yes: true, noProbe: true, resolvePublisher: readyResolver,
      writeConfig: async (path, content) => writes.push({ path, content }),
    });

    assert.equal(result.ok, true);
    assert.equal(result.applied, true);
    assert.equal(result.scope, 'global');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].path, join(home, '.qube', 'aie', 'review-publisher.json'));
    assert.notEqual(writes[0].path, repositoryConfigPath);
    assert.deepEqual(JSON.parse(writes[0].content).publisher.githubApp, {
      appId: '123', installationId: '456', privateKeyEnv: 'QUBE_REVIEW_APP_KEY', login: 'review-app[bot]',
    });
    assert.doesNotMatch(JSON.stringify(result) + writes[0].content, /BEGIN PRIVATE KEY|github_pat_|ghp_/);
  });

  it('keeps global and repository next actions in the selected scope', async () => {
    const root = makeDirectory();
    const global = await runReviewSetup({ mode: 'github-app', scope: 'global', config: null, configPath: join(root, 'config.json'), root, appId: '123' });
    const repository = await runReviewSetup({ mode: 'github-app', scope: 'repo', config: null, configPath: join(root, 'config.json'), root, appId: '123' });

    assert.match(global.nextAction, /review setup github-app --config-scope global/);
    assert.doesNotMatch(global.nextAction, /review setup github-app`/);
    assert.match(repository.nextAction, /review setup github-app`/);
    assert.doesNotMatch(repository.nextAction, /--config-scope global/);
  });

  it('discovers zero, one, and multiple named App installations safely', async () => {
    const root = makeDirectory();
    const candidate = (id, login) => ({ installationId: id, accountLogin: login, accountType: 'Organization', targetType: 'Organization', repositorySelection: 'selected', permissions: { pullRequests: 'write' }, label: `${login} · selected repositories · installation ${id}` });
    const base = { mode: 'github-app', scope: 'global', config: getDefaults(), configPath: join(root, 'config.json'), root, appId: '123', privateKeyEnv: 'QUBE_KEY', dryRun: true, yes: true, json: true, resolvePublisher: readyResolver };
    const zero = await runReviewSetup({ ...base, discoverInstallations: async () => [] });
    const one = await runReviewSetup({ ...base, discoverInstallations: async () => [candidate(456, 'one-owner')] });
    const multiple = await runReviewSetup({ ...base, discoverInstallations: async () => [candidate(456, 'one-owner'), candidate(789, 'two-owner')] });

    assert.equal(zero.ok, false);
    assert.equal(zero.discovery.status, 'unavailable');
    assert.equal(one.discovery.status, 'selected');
    assert.equal(one.publisher.githubApp.installationId, '456');
    assert.equal(multiple.ok, false);
    assert.equal(multiple.discovery.status, 'multiple');
    assert.match(multiple.nextAction, /terminal.*named installation|named installation.*terminal/i);
  });

  it('keeps a cancelled installation choice distinct from a missing App installation', async () => {
    const root = makeDirectory();
    const candidates = [
      { installationId: 456, accountLogin: 'one-owner', accountType: 'Organization', targetType: 'Organization', repositorySelection: 'selected', permissions: {}, label: 'one-owner · selected repositories · installation 456' },
      { installationId: 789, accountLogin: 'two-owner', accountType: 'Organization', targetType: 'Organization', repositorySelection: 'selected', permissions: {}, label: 'two-owner · selected repositories · installation 789' },
    ];
    const presenter = {
      askText: async () => { throw new Error('unexpected text prompt'); },
      choose: async () => ({ status: 'cancelled', reason: 'operator cancelled', writeAllowed: false }),
      confirm: async () => { throw new Error('unexpected confirmation'); },
      progress: async (_options, operation) => operation(),
      cancel: reason => ({ status: 'cancelled', reason, writeAllowed: false }),
      summarize: () => {}, fail: () => {},
    };

    const previousKey = process.env.QUBE_KEY;
    process.env.QUBE_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
    let result;
    try {
      result = await runReviewSetup({
        mode: 'github-app', scope: 'global', config: getDefaults(), configPath: join(root, 'config.json'), root,
        appId: '123', privateKeyEnv: 'QUBE_KEY', isTTY: true, presenter, resolvePublisher: readyResolver,
        discoverInstallations: async () => candidates,
      });
    } finally {
      if (previousKey === undefined) delete process.env.QUBE_KEY;
      else process.env.QUBE_KEY = previousKey;
    }

    assert.equal(result.ok, false);
    assert.equal(result.discovery.status, 'cancelled');
    assert.match(result.nextAction, /rerun .*review setup github-app --config-scope global.*ready/i);
    assert.doesNotMatch(result.nextAction, /settings\/installations|install the GitHub App/i);
  });

  it('filters repository discovery to installations that can access the repository', async () => {
    const root = makeDirectory();
    const candidates = [
      { installationId: 456, accountLogin: 'wrong-owner', accountType: 'Organization', targetType: 'Organization', repositorySelection: 'all', permissions: {}, label: 'wrong-owner · all repositories · installation 456' },
      { installationId: 789, accountLogin: 'right-owner', accountType: 'Organization', targetType: 'Organization', repositorySelection: 'selected', permissions: {}, label: 'right-owner · selected repositories · installation 789' },
    ];
    const result = await runReviewSetup({
      mode: 'github-app', scope: 'repo', config: getDefaults(), configPath: join(root, 'config.json'), root,
      appId: '123', privateKeyEnv: 'QUBE_KEY', dryRun: true, yes: true, json: true, resolvePublisher: readyResolver,
      discoverInstallations: async () => candidates,
      matchRepositoryInstallations: async values => values.filter(value => value.accountLogin === 'right-owner'),
    });

    assert.equal(result.ok, true);
    assert.equal(result.discovery.status, 'selected');
    assert.equal(result.publisher.githubApp.installationId, '789');
  });

  it('normalizes balanced quoted paths with spaces and rejects unbalanced quotes', () => {
    const root = makeDirectory();
    const home = makeDirectory();
    assert.equal(normalizeReviewPrivateKeyPath('"keys/review app.pem"', root, home), join(root, 'keys', 'review app.pem'));
    assert.equal(normalizeReviewPrivateKeyPath('"~/.qube/review app.pem"', root, home), join(home, '.qube', 'review app.pem'));
    assert.throws(() => normalizeReviewPrivateKeyPath('"keys/review app.pem', root, home), /unbalanced surrounding quotes/);
  });

  it('corrects Client IDs and unavailable key references at the affected guided question', async () => {
    const root = makeDirectory();
    const config = getDefaults();
    config.providers.review.publisher = { mode: 'github-app', githubApp: { appId: 'Iv1.client', installationId: '456', privateKeyEnv: 'MISSING_REVIEW_KEY' } };
    const questions = [];
    const presenter = {
      askText: async question => {
        questions.push(question);
        return { status: 'answered', value: question.label === 'GitHub App ID' ? '123' : 'WORKING_REVIEW_KEY', source: 'prompt' };
      },
      choose: async () => { throw new Error('unexpected choice'); },
      confirm: async question => { questions.push(question); return { status: 'answered', value: true, source: 'prompt' }; },
      progress: async (_options, operation) => operation(),
      cancel: reason => ({ status: 'cancelled', reason, writeAllowed: false }),
      summarize: () => {}, fail: () => {},
    };
    const previousKey = process.env.WORKING_REVIEW_KEY;
    process.env.WORKING_REVIEW_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
    let result;
    try {
      result = await runReviewSetup({ mode: 'github-app', config, configPath: join(root, 'config.json'), root, isTTY: true, presenter, noProbe: true, resolvePublisher: readyResolver });
    } finally {
      if (previousKey === undefined) delete process.env.WORKING_REVIEW_KEY;
      else process.env.WORKING_REVIEW_KEY = previousKey;
    }

    assert.equal(result.ok, true);
    assert.deepEqual(questions.map(question => question.label), ['GitHub App ID', 'Private-key environment variable', 'Write repository Reviewer App config?']);
    assert.match(await questions[0].validation.check('Iv1.client'), /looks like a GitHub Client ID/);
    assert.equal(questions[1].validation.state, 'invalid');
    assert.match(questions[1].validation.message, /missing or empty/);

    const installationClientId = await runReviewSetup({
      mode: 'github-app', config: null, configPath: join(root, 'other.json'), root,
      appId: '123', installationId: 'Iv1.client', privateKeyEnv: 'WORKING_REVIEW_KEY', yes: true, noProbe: true,
    });
    assert.equal(installationClientId.ok, false);
    assert.match(installationClientId.validationErrors.join('\n'), /looks like a GitHub Client ID/);
  });

  it('preserves an unchanged inherited publisher without prompts, writes, or verbose output', async () => {
    const root = makeDirectory();
    const publisher = { mode: 'github-app', githubApp: { appId: '123', installationId: '456', privateKeyEnv: 'QUBE_KEY' } };
    const config = getDefaults();
    config.providers.review.publisher = publisher;
    let writes = 0;
    const presenter = {
      askText: async () => { throw new Error('unexpected text prompt'); },
      choose: async () => { throw new Error('unexpected choice prompt'); },
      confirm: async () => { throw new Error('unexpected confirmation'); },
      progress: async (_options, operation) => operation(),
      cancel: reason => ({ status: 'cancelled', reason, writeAllowed: false }),
      summarize: () => {}, fail: () => {},
    };
    const previousKey = process.env.QUBE_KEY;
    process.env.QUBE_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
    let result;
    try {
      result = await runReviewSetup({
        mode: 'github-app', scope: 'repo', config, configPath: join(root, 'config.json'), root,
        publisherSource: 'user-global', publisherFieldSources: { mode: 'user-global', 'githubApp.appId': 'user-global', 'githubApp.installationId': 'user-global', 'githubApp.privateKeyEnv': 'user-global' },
        isTTY: true, presenter, noProbe: true, resolvePublisher: readyResolver,
        writeConfig: async () => { writes += 1; },
      });
    } finally {
      if (previousKey === undefined) delete process.env.QUBE_KEY;
      else process.env.QUBE_KEY = previousKey;
    }
    const output = formatReviewSetup(result);

    assert.equal(result.ok, true);
    assert.equal(result.changed, false);
    assert.equal(writes, 0);
    assert.match(output, /already configured/);
    assert.doesNotMatch(output, /App ID:|Installation:|Review publisher readiness:/);
  });

  it('reports a written config separately from unavailable publisher verification', async () => {
    const root = makeDirectory();
    const result = await runReviewSetup({
      mode: 'github-app', config: null, configPath: join(root, 'config.json'), root,
      appId: '123', installationId: '456', privateKeyEnv: 'QUBE_KEY', yes: true,
      resolvePublisher: async () => { throw new Error('The installation cannot access this repository.'); },
    });

    assert.equal(result.ok, false);
    assert.equal(result.applied, true);
    assert.equal(result.readiness, 'unavailable');
    assert.match(result.nextAction, /review setup github-app/);
  });

  it('writes only the repository layer and never flattens machine-local overlay values', async () => {
    const root = makeDirectory();
    const config = getDefaults();
    config.providers.review.connection = { machineOnly: 'local-overlay-value' };
    let written = '';
    const result = await runReviewSetup({
      mode: 'github-app', scope: 'repo', config, configPath: join(root, '.qube', 'aie', 'config.json'), root,
      repositoryConfig: { version: 1 },
      appId: '123', installationId: '456', privateKeyEnv: 'QUBE_KEY', yes: true, noProbe: true, resolvePublisher: readyResolver,
      writeConfig: async (_path, content) => { written = content; },
    });

    assert.equal(result.applied, true);
    assert.doesNotMatch(written, /machineOnly|local-overlay-value/);
    assert.equal(JSON.parse(written).providers.review.publisher.githubApp.installationId, '456');
  });

  it('rejects an invalid config scope through the packed command without prompting', () => {
    const result = binRun(['review', 'setup', 'github-app', '--config-scope', 'machine', '--json']);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout || result.stderr, /config-scope.*repo, global/);
  });

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
    assert.equal(rejectedPem.ok, false);
    assert.match(rejectedPem.validationErrors.join('\n'), /environment variable name/);

    const rejectedLogin = await runReviewSetup({
      mode: 'github-app', config: null, configPath, root,
      appId: '123', installationId: '456', privateKeyEnv: 'QUBE_REVIEW_APP_KEY',
      login: 'gho_FAKE_LOGIN_TOKEN_1234567890', yes: true,
    });
    assert.equal(rejectedLogin.ok, false);
    assert.match(rejectedLogin.validationErrors.join('\n'), /public identifier|credential/i);
  });

  it('completes interactive setup through the shared guided presenter without requesting secrets', async () => {
    const root = makeDirectory();
    const configPath = join(root, '.qube', 'aie', 'config.json');
    const questions = [];
    const presenter = {
      askText: async question => {
        questions.push(question);
        return { status: 'answered', value: question.label === 'GitHub App ID' ? '321' : 'QUBE_INTERACTIVE_APP_KEY', source: 'prompt' };
      },
      choose: async (question) => {
        questions.push(question);
        return { status: 'answered', value: question.label === 'Private-key reference' ? 'environment' : 'installation-654', source: 'prompt' };
      },
      confirm: async question => { questions.push(question); return { status: 'answered', value: true, source: 'prompt' }; },
      progress: async (_options, operation) => operation(),
      cancel: reason => ({ status: 'cancelled', reason, writeAllowed: false }),
      summarize: () => {}, fail: () => {},
    };
    const previousKey = process.env.QUBE_INTERACTIVE_APP_KEY;
    process.env.QUBE_INTERACTIVE_APP_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
    let result;
    try {
      result = await runReviewSetup({
        mode: 'github-app', config: getDefaults(), configPath, root, isTTY: true, presenter,
        discoverInstallations: async () => [{ installationId: 654, accountLogin: 'review-owner', accountType: 'Organization', targetType: 'Organization', repositorySelection: 'all', permissions: {}, label: 'review-owner · all repositories · installation 654' }],
        matchRepositoryInstallations: async candidates => candidates,
        noProbe: true,
        resolvePublisher: readyResolver,
      });
    } finally {
      if (previousKey === undefined) delete process.env.QUBE_INTERACTIVE_APP_KEY;
      else process.env.QUBE_INTERACTIVE_APP_KEY = previousKey;
    }

    assert.equal(result.applied, true);
    assert.deepEqual(questions.map(question => question.label), ['GitHub App ID', 'Private-key reference', 'Private-key environment variable', 'Write repository Reviewer App config?']);
    assert.ok(questions.every(question => !/private key PEM$|token value/i.test(question.label)));
    assert.ok(questions.every(question => question.explanation && question.recommendation?.reason));
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
  it('reports GitLab token scope and approval permission diagnostics', async () => {
    const config = getDefaults();
    config.providers.review.kind = 'gitlab';
    const missingToken = await runReviewDoctor({
      config,
      mintProbe: true,
      probeGitLabReview: async () => ({
        login: null,
        tokenPresent: false,
        apiScope: 'missing',
        approvalPermission: 'missing',
        failure: 'GITLAB_TOKEN is not set. Set a project or group access token with api scope.',
      }),
    });
    assert.equal(missingToken.readiness, 'unconfigured');
    assert.match(missingToken.nextAction, /GITLAB_TOKEN/);
    assert.ok(missingToken.missingFields.includes('GITLAB_TOKEN'));

    const missingApproval = await runReviewDoctor({
      config,
      mintProbe: true,
      probeGitLabReview: async () => ({
        login: 'executor',
        tokenPresent: true,
        apiScope: 'ok',
        approvalPermission: 'missing',
        failure: 'GitLab token cannot approve merge requests.',
      }),
    });
    assert.equal(missingApproval.readiness, 'degraded');
    assert.match(missingApproval.nextAction, /approve merge requests/);
    assert.match(JSON.stringify(missingApproval), /approval permission/);
  });

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
    assert.equal(ready.probe.avatar.status, 'not-run');
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
    assert.match(result.nextAction, /current authenticated GitHub account|review setup github-app/i);
    assert.doesNotMatch(result.nextAction, /review setup token|separate-user/i);
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
    assert.equal(result.probe.avatar.status, 'not-run');
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
    assert.match(gate.stdout, /configured real-harness review prompt/i);
    assert.match(gate.stdout, /harness capabilities/i);
  });

  it('review doctor reads a working-tree publisher from a local, never-committed config overlay', () => {
    const repo = cloneGitRepo('configured', 'aie-review-doctor-overlay-');
    mkdirSync(join(repo, '.qube', 'aie'), { recursive: true });
    writeFileSync(join(repo, '.qube', 'aie', 'config.json'), `${JSON.stringify({ version: 1, providers: { review: { kind: 'github' } } }, null, 2)}\n`);
    writeFileSync(join(repo, '.qube', 'aie', 'config.local.json'), `${JSON.stringify({
      providers: {
        review: {
          publisher: {
            mode: 'github-app',
            githubApp: { appId: '4573671', installationId: '153271303', privateKeyEnv: 'QUBE_REVIEW_PUBLISHER_PRIVATE_KEY' },
          },
        },
      },
    }, null, 2)}\n`);

    const result = binRun(['review', 'doctor', '--json', '--no-probe'], repo);
    assert.equal(result.status, 0, result.stderr);
    const doctor = JSON.parse(result.stdout);

    assert.equal(doctor.mode, 'github-app');
    assert.notEqual(doctor.readiness, 'unconfigured');
    assert.deepEqual(doctor.missingFields, []);
    assert.equal(doctor.secretReferences.privateKeyEnv, 'QUBE_REVIEW_PUBLISHER_PRIVATE_KEY');
    assert.equal(doctor.probe.avatar.status, 'not-run');
  });
});

describe('review publisher avatar doctor', () => {
  function githubAppConfig() {
    const config = getDefaults();
    config.providers.review.publisher = {
      mode: 'github-app',
      githubApp: { appId: '123', installationId: '456', privateKeyEnv: 'QUBE_REVIEW_APP_KEY' },
    };
    return config;
  }

  it('strips avatar query strings before comparing identities', () => {
    assert.equal(
      normalizeReviewAvatarUrl('https://avatars.githubusercontent.com/in/4573671?v=4'),
      'https://avatars.githubusercontent.com/in/4573671',
    );
    assert.equal(
      normalizeReviewAvatarUrl('https://avatars.githubusercontent.com/u/39051?v=4'),
      'https://avatars.githubusercontent.com/u/39051',
    );
    assert.equal(normalizeReviewAvatarUrl('not a url'), null);
  });

  it('warns when the github-app avatar falls back to the repository owner avatar', async () => {
    const result = await runReviewDoctor({
      config: githubAppConfig(),
      resolvePublisher: readyResolver,
      mintProbe: true,
      probeRepositoryAccess: successfulRepositoryProbe,
      probePublisherAvatar: async () => ({
        botAvatarUrl: 'https://avatars.githubusercontent.com/u/39051?v=4',
        ownerAvatarUrl: 'https://avatars.githubusercontent.com/u/39051?s=200',
      }),
    });
    assert.equal(result.readiness, 'ready');
    assert.equal(result.probe.avatar.status, 'warning');
    assert.equal(result.probe.avatar.ownerFallback, true);
    assert.equal(result.probe.avatar.botAvatarUrl, 'https://avatars.githubusercontent.com/u/39051');
    assert.equal(result.probe.avatar.ownerAvatarUrl, 'https://avatars.githubusercontent.com/u/39051');
    assert.match(result.nextAction, /GitHub App display settings/);
    assert.match(result.nextAction, /Do not rename the app/);
    assert.doesNotMatch(result.nextAction, /rename the app to/);
  });

  it('passes the avatar diagnostic when the bot and owner avatars differ', async () => {
    const result = await runReviewDoctor({
      config: githubAppConfig(),
      resolvePublisher: readyResolver,
      mintProbe: true,
      probeRepositoryAccess: successfulRepositoryProbe,
      probePublisherAvatar: async () => ({
        botAvatarUrl: 'https://avatars.githubusercontent.com/in/4573671?v=4',
        ownerAvatarUrl: 'https://avatars.githubusercontent.com/u/39051?v=4',
      }),
    });
    assert.equal(result.readiness, 'ready');
    assert.equal(result.probe.avatar.status, 'ok');
    assert.equal(result.probe.avatar.ownerFallback, false);
    assert.match(result.nextAction, /Publisher is ready/);
  });

  it('keeps avatar status unknown when a github-app avatar field cannot be read', async () => {
    const result = await runReviewDoctor({
      config: githubAppConfig(),
      resolvePublisher: readyResolver,
      mintProbe: true,
      probeRepositoryAccess: successfulRepositoryProbe,
      probePublisherAvatar: async () => ({
        botAvatarUrl: null,
        ownerAvatarUrl: 'https://avatars.githubusercontent.com/u/39051?v=4',
      }),
    });
    assert.equal(result.readiness, 'ready');
    assert.equal(result.probe.avatar.status, 'unknown');
    assert.equal(result.probe.avatar.ownerFallback, null);
    assert.notEqual(result.probe.avatar.status, 'ok');
    assert.match(result.nextAction, /could not be compared/);
  });

  it('does not run the avatar diagnostic for token publishers or --no-probe', async () => {
    const tokenConfig = getDefaults();
    tokenConfig.providers.review.publisher = {
      mode: 'token',
      token: { env: 'QUBE_REVIEW_TOKEN', login: 'reviewer-bot' },
    };
    const token = await runReviewDoctor({
      config: tokenConfig,
      resolvePublisher: readyResolver,
      mintProbe: true,
      probeRepositoryAccess: successfulRepositoryProbe,
      probePublisherAvatar: async () => {
        throw new Error('token publishers must not probe avatars');
      },
    });
    assert.equal(token.probe.avatar.status, 'not-run');

    const skipped = await runReviewDoctor({
      config: githubAppConfig(),
      resolvePublisher: readyResolver,
      mintProbe: false,
      probePublisherAvatar: async () => {
        throw new Error('--no-probe must not probe avatars');
      },
    });
    assert.equal(skipped.probe.avatar.status, 'not-run');
    assert.equal(skipped.login, 'review-app[bot]');
  });

  it('warns when a github-app publisher lacks Contents write', async () => {
    const result = await runReviewDoctor({
      config: githubAppConfig(),
      mintProbe: true,
      probeRepositoryAccess: successfulRepositoryProbe,
      probePublisherAvatar: async () => ({
        botAvatarUrl: 'https://avatars.githubusercontent.com/in/4573671?v=4',
        ownerAvatarUrl: 'https://avatars.githubusercontent.com/u/39051?v=4',
      }),
      resolvePublisher: async () => ({
        accessToken: 'fixture-access-token',
        identity: {
          mode: 'github-app',
          identityClass: 'github-app-installation',
          login: 'review-app[bot]',
          permissionStatus: 'ok',
          formalEventCapability: true,
          fallbackReason: null,
          publishTransport: 'pull-request-review',
          authSource: 'github-app-installation',
          credentialVerified: true,
          contentsPermission: 'missing',
        },
      }),
    });
    assert.equal(result.readiness, 'ready');
    assert.equal(result.probe.contentsPermission, 'missing');
    assert.match(result.nextAction, /Contents write/);
  });
});
