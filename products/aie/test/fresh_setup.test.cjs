const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
require('./support/compile_cache.cjs');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { cloneGitRepo } = require('./support/git_fixture.cjs');

const { getDefaults, validateConfig } = require('../dist/config/index.js');
const {
  collectSetupDoctorRecommendations,
  detectRepositoryQualityGate,
  freshSetupConfigIdentity,
  freshSetupFirstPullRequestReadiness,
  runInit,
} = require('../dist/init/index.js');
const { defaultFreshSetupLanes, FRESH_SETUP_SECURITY_MATCH } = require('../dist/config/fresh_setup_lanes.js');
const { activeLocalReviewFocusesForConfig } = require('../dist/review_focus.js');

const GROK_MODELS = {
  review: { 'grok-build': { model: 'grok-4.5', effort: null } },
  economy: {},
  synthesis: {},
};

function makeTsRepo(scripts = { test: 'node --test' }, lockfile = 'package-lock.json') {
  const repo = cloneGitRepo('committed', 'aie-fresh-setup-');
  writeFileSync(join(repo, 'package.json'), `${JSON.stringify({ name: 'fresh-app', private: true, scripts }, null, 2)}\n`);
  writeFileSync(join(repo, lockfile), '{}\n');
  return repo;
}

async function initTypicalTs(repo, overrides = {}) {
  const { policy: policyOverrides, ...rest } = overrides;
  return runInit({
    target: '.',
    tool: 'opencode',
    dryRun: false,
    force: false,
    cwd: repo,
    yes: true,
    guide: true,
    installedHosts: ['grok-build'],
    agentBrowserAvailable: false,
    aiqAvailable: false,
    ...rest,
    policy: {
      reviewModels: GROK_MODELS,
      ...(policyOverrides ?? {}),
    },
  });
}

describe('fresh setup defaults', () => {
  it('ships isolated local-focused lanes that a maintainer can read from the named-modes page', () => {
    const lanes = defaultFreshSetupLanes();
    const docs = readFileSync(join(__dirname, '../docs/review-modes.md'), 'utf8');
    const pkg = require('../package.json');

    assert.deepEqual(lanes.map(lane => `${lane.id}:${lane.required}`), [
      'issue-compliance:always',
      'code-quality:always',
      'performance:when-matched',
      'api-contract-compatibility:when-matched',
      'ui-ux-accessibility:when-matched',
      'security:when-matched',
    ]);
    assert.deepEqual(lanes.find(lane => lane.id === 'security').match, [...FRESH_SETUP_SECURITY_MATCH]);
    assert.ok(pkg.files.includes('docs/review-modes.md'));

    const requiredPhrases = [
      'policy.reviews.mode` is `isolated`',
      'policy.reviews.adapter` is `local`',
      'policy.reviews.profile` is `local-focused`',
      'policy.reviews.severityThreshold` is `high`',
      'Advisory findings never block',
      'issue-compliance',
      'code-quality',
      'performance',
      'api-contract-compatibility',
      'ui-ux-accessibility',
      'security',
      'when-matched',
      'package.json',
      'qualityControl',
      'qube aiq --up-to 2',
      'grok-4.6',
      'waitMinutes` is `0`',
      'localAgents` is empty',
      'two rounds',
      'manualUiAudit',
      'user publisher',
      'external',
      'noCreditWarning',
      'attribution hygiene',
    ];
    for (const phrase of requiredPhrases) {
      assert.ok(docs.includes(phrase), `named-modes docs must include ${phrase}`);
    }
  });

  it('wires a detectable package test script as the quality gate', () => {
    const repo = makeTsRepo({ test: 'node --test' }, 'pnpm-lock.yaml');
    const gate = detectRepositoryQualityGate(repo);
    assert.deepEqual(gate, {
      name: 'test',
      kind: 'unit',
      command: 'pnpm run test',
      stage: 'pre-pr',
      required: true,
      timeoutSeconds: 600,
      workingDirectory: '.',
      env: {},
      externalService: false,
    });
    assert.equal(detectRepositoryQualityGate(cloneGitRepo('committed', 'aie-fresh-no-pkg-')), null);
  });

  it('plain init on a typical TypeScript repo writes a first-PR-ready isolated setup without config edits', async () => {
    const repo = makeTsRepo();
    const result = await initTypicalTs(repo);
    assert.equal(result.ok, true, result.errors.join('\n'));
    const written = JSON.parse(readFileSync(join(repo, '.qube/aie/config.json'), 'utf8'));
    const loaded = validateConfig(written);
    assert.equal(loaded.ok, true, (loaded.errors ?? []).map(error => error.message).join('\n'));
    const config = loaded.config;

    assert.equal(config.reviewMode, 'isolated');
    assert.equal(config.reviewAdapter, 'local');
    assert.equal(config.reviewProfile, 'local-focused');
    assert.deepEqual(config.reviewAgents, []);
    assert.deepEqual(config.localReviewAgents, []);
    assert.equal(config.reviewRoute.host, 'grok-build');
    assert.equal(config.reviewModels.review['grok-build'].model, 'grok-4.5');
    assert.equal(config.manualUiAudit, false);
    assert.equal(config.qualityControl, false);
    assert.equal(config.gates[0].command, 'npm run test');
    assert.deepEqual(collectSetupDoctorRecommendations(repo, config), []);

    const sourceReady = freshSetupFirstPullRequestReadiness(config, ['src/index.ts']);
    assert.equal(sourceReady.ready, true, sourceReady.reasons.join('\n'));
    assert.deepEqual(sourceReady.activatedLanes, ['issue-compliance', 'code-quality']);
    assert.equal(activeLocalReviewFocusesForConfig(config, ['src/index.ts']).includes('security'), false);

    const lockReady = freshSetupFirstPullRequestReadiness(config, ['package.json']);
    assert.equal(lockReady.ready, true, lockReady.reasons.join('\n'));
    assert.ok(lockReady.activatedLanes.includes('security'));
    assert.ok(activeLocalReviewFocusesForConfig(config, ['.github/workflows/ci.yml']).includes('security'));
    assert.ok(activeLocalReviewFocusesForConfig(config, ['src/auth.ts']).includes('security'));
  });

  it('does not report first-PR ready when lanes, route, or model are missing', () => {
    const empty = getDefaults();
    const emptyReady = freshSetupFirstPullRequestReadiness(empty, ['src/index.ts']);
    assert.equal(emptyReady.ready, false);
    assert.ok(emptyReady.reasons.some(reason => /no isolated model route|No validated review model/.test(reason)));

    const noLanes = getDefaults();
    noLanes.reviewLanes = [];
    noLanes.reviewRoute = { host: 'grok-build', tier: 'review', timeoutSeconds: 900, maxTurns: 16 };
    noLanes.reviewModels.review['grok-build'] = { model: 'grok-4.5', effort: null };
    const noLaneReady = freshSetupFirstPullRequestReadiness(noLanes, ['src/index.ts']);
    assert.equal(noLaneReady.ready, false);
    assert.ok(noLaneReady.reasons.some(reason => reason.includes('issue-compliance is not configured as an always-on lane')));
  });

  it('binds first-PR readiness to the written config identity, not a reused verdict', async () => {
    const repo = makeTsRepo();
    const result = await initTypicalTs(repo);
    assert.equal(result.ok, true, result.errors.join('\n'));
    const config = validateConfig(JSON.parse(readFileSync(join(repo, '.qube/aie/config.json'), 'utf8'))).config;
    const first = freshSetupFirstPullRequestReadiness(config, ['src/index.ts']);
    assert.equal(first.ready, true, first.reasons.join('\n'));
    const identity = first.configIdentity;

    config.reviewModels.review['grok-build'] = { model: 'grok-other', effort: null };
    const second = freshSetupFirstPullRequestReadiness(config, ['src/index.ts']);
    assert.notEqual(second.configIdentity, identity);
    assert.equal(freshSetupConfigIdentity(config).includes('grok-other'), true);
  });

  it('rejects isolated without a host and stays doctor-clean for the external fallback', async () => {
    const repo = makeTsRepo();
    const isolated = await runInit({
      target: '.',
      tool: 'opencode',
      dryRun: true,
      force: false,
      cwd: repo,
      yes: true,
      guide: true,
      installedHosts: [],
      policy: { reviewMode: 'isolated' },
    });
    assert.equal(isolated.ok, false);
    assert.match(isolated.errors[0], /isolated requires an installed review host/);
    assert.equal(existsSync(join(repo, '.qube/aie/config.json')), false);

    const fallback = await runInit({
      target: '.',
      tool: 'opencode',
      dryRun: false,
      force: false,
      cwd: repo,
      yes: true,
      guide: true,
      installedHosts: [],
      agentBrowserAvailable: false,
      aiqAvailable: false,
    });
    assert.equal(fallback.ok, true, fallback.errors.join('\n'));
    const config = validateConfig(JSON.parse(readFileSync(join(repo, '.qube/aie/config.json'), 'utf8'))).config;
    assert.equal(config.reviewMode, 'external');
    assert.equal(config.reviewAdapter, 'github');
    assert.deepEqual(config.reviewAgents, []);
    assert.deepEqual(config.reviewLanes, []);
    assert.equal(freshSetupFirstPullRequestReadiness(config, ['src/index.ts']).ready, false);
    assert.deepEqual(collectSetupDoctorRecommendations(repo, config), []);
  });

  it('does not let --defaults write the old remote-compatible CodeRabbit setup when a host exists', async () => {
    const repo = makeTsRepo();
    const result = await initTypicalTs(repo, { useDefaults: true });
    assert.equal(result.ok, true, result.errors.join('\n'));
    const config = validateConfig(JSON.parse(readFileSync(join(repo, '.qube/aie/config.json'), 'utf8'))).config;
    assert.equal(config.reviewMode, 'isolated');
    assert.equal(config.reviewAdapter, 'local');
    assert.ok(!config.reviewAgents.includes('coderabbitai'));
    assert.equal(freshSetupFirstPullRequestReadiness(config, ['src/index.ts']).ready, true);
    assert.deepEqual(collectSetupDoctorRecommendations(repo, config), []);
  });

  it('enables UI audit only when the repository looks like UI and agent-browser is present', async () => {
    const repo = makeTsRepo();
    writeFileSync(join(repo, 'index.html'), '<html></html>\n');
    const withBrowser = await initTypicalTs(repo, { agentBrowserAvailable: true });
    assert.equal(withBrowser.ok, true, withBrowser.errors.join('\n'));
    const enabled = validateConfig(JSON.parse(readFileSync(join(repo, '.qube/aie/config.json'), 'utf8'))).config;
    assert.equal(enabled.manualUiAudit, true);

    const noBrowserRepo = makeTsRepo();
    writeFileSync(join(noBrowserRepo, 'index.html'), '<html></html>\n');
    const withoutBrowser = await initTypicalTs(noBrowserRepo, { agentBrowserAvailable: false });
    assert.equal(withoutBrowser.ok, true, withoutBrowser.errors.join('\n'));
    const disabled = validateConfig(JSON.parse(readFileSync(join(noBrowserRepo, '.qube/aie/config.json'), 'utf8'))).config;
    assert.equal(disabled.manualUiAudit, false);
    assert.deepEqual(collectSetupDoctorRecommendations(noBrowserRepo, disabled), []);
  });

  it('keeps the default lane factory aligned with the written isolated lanes', () => {
    assert.deepEqual(defaultFreshSetupLanes().map(lane => lane.id), [
      'issue-compliance',
      'code-quality',
      'performance',
      'api-contract-compatibility',
      'ui-ux-accessibility',
      'security',
    ]);
    const routed = defaultFreshSetupLanes('grok-build');
    assert.equal(routed.find(lane => lane.id === 'security').route.host, 'grok-build');
    const activated = activeLocalReviewFocusesForConfig({
      reviewProfile: 'local-focused',
      reviewLanes: routed,
    }, [
      'src/queue/worker.ts',
      'src/api/routes.ts',
      'apps/web/App.tsx',
      'package.json',
    ]);
    assert.deepEqual([...activated], [
      'issue-compliance',
      'code-quality',
      'performance',
      'api-contract-compatibility',
      'ui-ux-accessibility',
      'security',
    ]);
  });

  it('writes catalog-backed Codex and Grok efforts and turns Quality Control on when AIQ is available', async () => {
    const repo = makeTsRepo();
    const { applyFreshSetupPolicy, defaultAiqLintFormatGate } = require('../dist/init/fresh_setup.js');
    const policy = applyFreshSetupPolicy({
      policy: {},
      machine: {
        installedHosts: ['grok-build', 'codex'],
        agentBrowserAvailable: false,
        aiqAvailable: true,
        hasUserFacingUi: false,
        liveModels: {
          'grok-build': ['grok-4.6', 'grok-4.5'],
          codex: ['gpt-5.6-terra', 'gpt-5.6-luna'],
        },
      },
      repoRoot: repo,
      fromAdopted: false,
    });
    assert.equal(policy.reviewMode, 'isolated');
    assert.equal(policy.qualityControl, true);
    assert.deepEqual(policy.reviewModels.review['grok-build'], { model: 'grok-4.6', effort: 'medium' });
    assert.deepEqual(policy.reviewModels.economy['grok-build'], { model: 'grok-4.6', effort: 'low' });
    assert.deepEqual(policy.reviewModels.review.codex, { model: 'gpt-5.6-terra', effort: 'medium' });
    assert.deepEqual(policy.reviewModels.economy.codex, { model: 'gpt-5.6-luna', effort: 'high' });
    assert.ok(policy.gates.some(gate => gate.kind === 'aiq' && gate.command === defaultAiqLintFormatGate().command));
    assert.ok(!policy.gates.some(gate => /changed-files|git diff --name-only/.test(gate.command)));
  });

  it('does not default Grok review to grok-4.5 and leaves Quality Control off without AIQ', () => {
    const { applyFreshSetupPolicy } = require('../dist/init/fresh_setup.js');
    const policy = applyFreshSetupPolicy({
      policy: {},
      machine: {
        installedHosts: ['grok-build'],
        agentBrowserAvailable: false,
        aiqAvailable: false,
        hasUserFacingUi: false,
        liveModels: { 'grok-build': ['grok-4.5'] },
      },
      repoRoot: null,
      fromAdopted: false,
    });
    assert.equal(policy.qualityControl, false);
    assert.equal(policy.reviewModels, undefined);
  });

  it('does not rewrite an adopted existing config', () => {
    const { applyFreshSetupPolicy } = require('../dist/init/fresh_setup.js');
    const policy = applyFreshSetupPolicy({
      policy: { reviewMode: 'external', qualityControl: false, reviewLanes: [] },
      machine: {
        installedHosts: ['grok-build'],
        agentBrowserAvailable: false,
        aiqAvailable: true,
        hasUserFacingUi: false,
        liveModels: { 'grok-build': ['grok-4.6'] },
      },
      repoRoot: null,
      fromAdopted: true,
    });
    assert.equal(policy.reviewMode, 'external');
    assert.deepEqual(policy.reviewLanes, []);
    assert.equal(policy.qualityControl, false);
  });
});
