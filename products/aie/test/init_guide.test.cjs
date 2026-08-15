const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
require('./support/compile_cache.cjs');
const { spawnSync } = require('node:child_process');
const { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { cloneGitRepo } = require('./support/git_fixture.cjs');

const {
  buildInitPlan,
  runInit,
  collectSetupDoctorRecommendations,
  resolveContainedFromPath,
  parseAdoptedConfig,
  classifyFromSpec,
} = require('../dist/init/index.js');
const { applyQuestionAnswersToPolicy, buildInitQuestions } = require('../dist/init/questions.js');
const { configToFileShape, getDefaults, validateConfig } = require('../dist/config/index.js');

function makeGitRepo() {
  const repo = cloneGitRepo('committed', 'aie-init-guide-');
  mkdirSync(join(repo, '.qube', 'aie'), { recursive: true });
  return repo;
}

function binRun(args, cwd = process.cwd()) {
  return spawnSync(process.execPath, [join(process.cwd(), 'bin/run'), ...args], { cwd, encoding: 'utf8' });
}

function writeSourceConfig(root, relativeDir, overrides = {}) {
  const dir = join(root, relativeDir, '.qube', 'aie');
  mkdirSync(dir, { recursive: true });
  const base = configToFileShape(getDefaults());
  const record = {
    ...base,
    ...overrides,
    policy: {
      ...base.policy,
      ...(overrides.policy ?? {}),
      reviews: {
        ...base.policy.reviews,
        ...(overrides.policy?.reviews ?? {}),
      },
      audit: {
        ...base.policy.audit,
        ...(overrides.policy?.audit ?? {}),
      },
      gates: {
        ...base.policy.gates,
        ...(overrides.policy?.gates ?? {}),
      },
    },
  };
  const path = join(dir, 'config.json');
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  return { path, record };
}

describe('init guide questions', () => {
  it('emits a machine-readable question set without writing files', async () => {
    const repo = makeGitRepo();
    const result = await buildInitPlan({
      target: '.',
      tool: 'opencode',
      dryRun: false,
      force: false,
      cwd: repo,
      guide: true,
      installedHosts: ['grok'],
      agentBrowserAvailable: false,
      aiqAvailable: false,
    });

    assert.equal(result.ok, true);
    assert.equal(result.awaitingAnswers, true);
    assert.equal(existsSync(join(repo, '.qube/aie/config.json')), false);
    assert.deepEqual(result.questions.map(item => item.id), ['review-mode', 'reviewers', 'review-models', 'publisher', 'quality-gate', 'ui-audit']);
    assert.ok(result.questions.every(item => item.prompt && item.recommendation && Array.isArray(item.options)));
    assert.deepEqual(result.unansweredQuestionIds, ['review-mode', 'reviewers', 'review-models', 'publisher', 'quality-gate', 'ui-audit']);
    assert.equal(result.setupSummary.manualUiAudit, false);
    assert.equal(result.setupSummary.qualityControl, false);
    assert.equal(result.setupSummary.reviewMode, 'isolated');
  });

  it('consumes invocation answers without re-asking those questions', async () => {
    const repo = makeGitRepo();
    const result = await buildInitPlan({
      target: '.',
      tool: 'opencode',
      dryRun: true,
      force: false,
      cwd: repo,
      guide: true,
      installedHosts: ['grok'],
      agentBrowserAvailable: false,
      aiqAvailable: false,
      policy: { reviewMode: 'host', manualUiAudit: false },
    });

    const reviewMode = result.questions.find(item => item.id === 'review-mode');
    const uiAudit = result.questions.find(item => item.id === 'ui-audit');
    assert.equal(reviewMode.answered, true);
    assert.equal(reviewMode.value, 'host');
    assert.equal(uiAudit.answered, true);
    assert.equal(uiAudit.value, 'false');
    assert.ok(result.unansweredQuestionIds.includes('publisher'));
    assert.ok(!result.unansweredQuestionIds.includes('review-mode'));
    assert.equal(result.setupSummary.reviewMode, 'host');
  });

  it('includes live host models in the review-models question, not reviewers', () => {
    const questions = buildInitQuestions({
      machine: {
        installedHosts: ['grok'],
        agentBrowserAvailable: false,
        aiqAvailable: false,
        hasUserFacingUi: false,
        liveModels: { grok: ['grok-4.5'] },
      },
      answers: {},
    });
    const models = questions.find(item => item.id === 'review-models');
    assert.ok(models.options.some(option => option.value === 'grok:grok-4.5'));
    assert.ok(!questions.find(item => item.id === 'reviewers').options.some(option => option.value === 'grok:grok-4.5'));
  });

  it('writes live host models to reviewModels and never to reviewAgents', () => {
    const policy = applyQuestionAnswersToPolicy({}, [
      { id: 'reviewers', answered: true, value: ['coderabbitai', 'grok:grok-4.5'] },
      { id: 'review-models', answered: true, value: ['grok:grok-4.5'] },
    ]);
    assert.deepEqual(policy.reviewAgents, ['coderabbitai']);
    assert.deepEqual(policy.reviewModels.review.grok, { model: 'grok-4.5', effort: null });
    const empty = applyQuestionAnswersToPolicy({}, [
      { id: 'review-models', answered: true, value: [] },
    ]);
    assert.equal(empty.reviewModels, undefined);
  });

  it('does not recommend isolated when no review host is installed', () => {
    const questions = buildInitQuestions({
      machine: { installedHosts: [], agentBrowserAvailable: false, aiqAvailable: false, hasUserFacingUi: false },
      answers: {},
    });
    const reviewMode = questions.find(item => item.id === 'review-mode');
    assert.equal(reviewMode.recommendedValue, 'external');
    assert.equal(reviewMode.options.find(option => option.value === 'isolated').available, false);
    for (const item of questions) {
      if (typeof item.recommendedValue !== 'string') continue;
      assert.ok(
        item.options.some(option => option.value === item.recommendedValue),
        `${item.id} recommendedValue must match an option value`,
      );
    }
  });

  it('rejects isolated mode when the invocation asked for it without an installed host', async () => {
    const repo = makeGitRepo();
    const result = await buildInitPlan({
      target: '.',
      tool: 'opencode',
      dryRun: true,
      force: false,
      cwd: repo,
      guide: true,
      installedHosts: [],
      policy: { reviewMode: 'isolated' },
    });
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /isolated requires an installed review host/);
  });
});

describe('init --from', () => {
  it('adopts a relative source and reports machine adjustments', async () => {
    const repo = makeGitRepo();
    writeSourceConfig(repo, 'known-good', {
      policy: {
        reviews: { mode: 'isolated', agents: ['review-bot'] },
        audit: { manualUiAudit: true, appLaunch: '', target: '' },
        gates: { qualityControl: true, qualityGates: [], definitions: [], focusedSelectors: [] },
      },
    });

    const result = await runInit({
      target: '.',
      tool: 'opencode',
      dryRun: false,
      force: false,
      cwd: repo,
      guide: true,
      yes: true,
      from: 'known-good',
      installedHosts: ['grok'],
      agentBrowserAvailable: false,
      aiqAvailable: false,
    });

    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.equal(result.awaitingAnswers, false);
    assert.equal(result.from.kind, 'path');
    assert.equal(result.from.source, 'known-good/.qube/aie/config.json');
    assert.ok(result.from.sourceDigest);
    assert.ok(result.from.adjustments.some(item => /Disabled manual UI audit/.test(item)));
    assert.ok(result.from.adjustments.some(item => /Disabled Quality Control/.test(item)));
    const config = JSON.parse(readFileSync(join(repo, '.qube/aie/config.json'), 'utf8'));
    assert.equal(config.policy.reviews.mode, 'isolated');
    assert.deepEqual(config.policy.reviews.agents, ['review-bot']);
    assert.equal(config.policy.audit.manualUiAudit, false);
    assert.equal(config.policy.gates.qualityControl, false);
  });

  it('adopts an owner/repo slug through the injected fetcher', async () => {
    const repo = makeGitRepo();
    const source = configToFileShape(getDefaults());
    source.policy.reviews.mode = 'host';
    source.policy.reviews.agents = ['slug-bot'];
    const first = await runInit({
      target: '.',
      tool: 'opencode',
      dryRun: true,
      force: false,
      cwd: repo,
      guide: true,
      yes: true,
      from: 'owner/good-repo',
      fetchRepoConfig: async () => JSON.stringify(source),
      installedHosts: ['grok'],
      agentBrowserAvailable: false,
      aiqAvailable: false,
    });
    assert.equal(first.ok, true, first.errors.join('\n'));
    assert.equal(first.from.kind, 'repo');
    assert.equal(first.from.source, 'owner/good-repo');
    assert.equal(first.setupSummary.reviewMode, 'host');
    assert.deepEqual(first.setupSummary.reviewers, ['slug-bot']);

    const changed = { ...source, policy: { ...source.policy, reviews: { ...source.policy.reviews, agents: ['other-bot'] } } };
    const second = await runInit({
      target: '.',
      tool: 'opencode',
      dryRun: true,
      force: false,
      cwd: repo,
      guide: true,
      yes: true,
      from: 'owner/good-repo',
      fetchRepoConfig: async () => JSON.stringify(changed),
      installedHosts: ['grok'],
      agentBrowserAvailable: false,
      aiqAvailable: false,
    });
    assert.notEqual(second.from.sourceDigest, first.from.sourceDigest);
    assert.deepEqual(second.setupSummary.reviewers, ['other-bot']);
  });

  it('rejects absolute, parent-directory, url, and symlink-escape --from values', async () => {
    const repo = makeGitRepo();
    const outsideDir = join(tmpdir(), `aie-from-outside-${process.pid}`);
    mkdirSync(join(outsideDir, '.qube', 'aie'), { recursive: true });
    writeFileSync(join(outsideDir, '.qube', 'aie', 'config.json'), '{}\n');
    mkdirSync(join(repo, 'inside'), { recursive: true });
    symlinkSync(outsideDir, join(repo, 'inside', 'escape'), 'junction');

    assert.equal(classifyFromSpec('https://example.com/repo'), 'url');
    assert.equal(resolveContainedFromPath(repo, '/etc/passwd').failure, 'absolute-path');
    assert.equal(resolveContainedFromPath(repo, '..\\secret').failure, 'parent-directory');
    assert.equal(resolveContainedFromPath(repo, 'inside/escape').failure, 'symlink-escape');

    const absolute = await buildInitPlan({ target: '.', tool: 'opencode', dryRun: true, force: false, cwd: repo, guide: true, from: join(repo, 'known-good') });
    assert.equal(absolute.ok, false);
    assert.match(absolute.errors[0], /Absolute paths are rejected/);

    const parent = await buildInitPlan({ target: '.', tool: 'opencode', dryRun: true, force: false, cwd: repo, guide: true, from: '../outside' });
    assert.equal(parent.ok, false);
    assert.match(parent.errors[0], /parent-directory/);

    const url = await buildInitPlan({ target: '.', tool: 'opencode', dryRun: true, force: false, cwd: repo, guide: true, from: 'https://github.com/owner/repo' });
    assert.equal(url.ok, false);
    assert.match(url.errors[0], /does not accept URLs/);

    const escaped = await buildInitPlan({ target: '.', tool: 'opencode', dryRun: true, force: false, cwd: repo, guide: true, from: 'inside/escape' });
    assert.equal(escaped.ok, false);
    assert.match(escaped.errors[0], /symlink or junction/);
    assert.equal(existsSync(join(repo, '.qube/aie/config.json')), false);
  });

  it('rejects a forged approval marker and invalid source JSON without writing', async () => {
    const repo = makeGitRepo();
    mkdirSync(join(repo, 'forged', '.qube', 'aie'), { recursive: true });
    writeFileSync(join(repo, 'forged', '.qube', 'aie', 'config.json'), `${JSON.stringify({ ok: true, approved: true, policy: {} })}\n`);
    const forged = parseAdoptedConfig(JSON.stringify({ ok: true, policy: {} }));
    assert.equal(forged.ok, false);
    assert.equal(forged.failure, 'forged-marker');

    const result = await runInit({
      target: '.',
      tool: 'opencode',
      dryRun: false,
      force: false,
      cwd: repo,
      guide: true,
      yes: true,
      from: 'forged',
    });
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /does not trust approval or ok markers/);
    assert.equal(existsSync(join(repo, 'AGENTS.md')), false);
  });
});

describe('init guide CLI and doctor-clean setup', () => {
  it('CLI without --yes emits questions and does not write', () => {
    const repo = makeGitRepo();
    const result = binRun(['init', '.', '--json'], repo);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.awaitingAnswers, true);
    assert.ok(parsed.questions.length >= 5);
    assert.equal(existsSync(join(repo, '.qube/aie/config.json')), false);
    assert.equal(existsSync(join(repo, 'AGENTS.md')), false);
  });

  it('CLI --yes writes a fresh repository setup that passes doctor with no setup warnings', async () => {
    const repo = makeGitRepo();
    const preview = binRun(['init', '.', '--review-mode', 'host', '--json'], repo);
    const previewParsed = JSON.parse(preview.stdout);
    assert.equal(previewParsed.questions.find(item => item.id === 'review-mode').answered, true);
    assert.equal(previewParsed.questions.find(item => item.id === 'review-mode').value, 'host');
    assert.equal(existsSync(join(repo, '.qube/aie/config.json')), false);

    const written = binRun(['init', '.', '--yes', '--json'], repo);
    assert.equal(written.status, 0, written.stderr);
    const parsed = JSON.parse(written.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.awaitingAnswers, false);
    assert.equal(existsSync(join(repo, '.qube/aie/config.json')), true);
    assert.equal(existsSync(join(repo, 'AGENTS.md')), true);
    const config = validateConfig(JSON.parse(readFileSync(join(repo, '.qube/aie/config.json'), 'utf8')));
    assert.equal(config.ok, true);
    const recommendations = collectSetupDoctorRecommendations(repo, config.config);
    assert.deepEqual(recommendations, [], 'fresh repository setup must pass doctor with no setup warnings');
    if (parsed.setupSummary.reviewMode === 'isolated') {
      assert.equal(config.config.reviewAdapter, 'local');
      assert.equal(config.config.reviewProfile, 'local-focused');
      assert.deepEqual(config.config.reviewLanes.map(lane => lane.id), ['issue-compliance', 'code-quality', 'security']);
      assert.equal(config.config.reviewLanes.find(lane => lane.id === 'security').required, 'when-matched');
    } else {
      assert.equal(parsed.setupSummary.reviewMode, 'external');
      assert.equal(config.config.reviewAdapter, 'github');
    }
  });

  it('publishes --from, --review-mode, and --publisher in schema metadata', () => {
    const { getCommandMetadata } = require('../dist/command_metadata.js');
    const metadata = getCommandMetadata('init');
    assert.ok(metadata.flags.includes('--from'));
    assert.ok(metadata.flags.includes('--review-mode'));
    assert.ok(metadata.flags.includes('--publisher'));
  });
});
